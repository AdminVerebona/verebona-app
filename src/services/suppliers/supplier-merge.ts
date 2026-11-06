/**
 * Lot 113G (ticket #706) — FUSION de deux fiches fournisseur décidée par
 * l'utilisateur (« Oui » de la carte « S'agit-il du même fournisseur ? », ou
 * « Fusionner » d'une revue existante). Procédure unique, dans UNE transaction
 * (celle de l'appelant) : jamais de fusion « à moitié ».
 *
 * La fiche CONSERVÉE (`toId`, « fournisseur déjà connu ») garde son
 * identifiant de référence, son nom et ses valeurs ; la fiche fusionnée
 * (`fromId`) est archivée avec `merged_into_supplier_id` (identifiant retrouvé).
 *
 *   1. coordonnées : un champ VIDE de la fiche conservée est complété depuis
 *      l'autre (`consolidateCoordinates`, protection par champ 111X : un champ
 *      effacé volontairement n'est jamais réintroduit) ; une valeur
 *      DIFFÉRENTE n'écrase rien et ouvre une revue `contact_conflict` sourcée
 *      (aucun écrasement silencieux) ; décisions et provenance par champ
 *      suivent la valeur reprise ; portée Duo conservée ;
 *   2. relations : documents (fiabilité réelle de chaque lien conservée —
 *      jamais promue —, base `MERGED`), biens, équipements, observations,
 *      Agenda (103E), Opérations (109A, dans la même transaction) ;
 *   3. revues : conflits de coordonnées reportés et réévalués ; revues de
 *      doublon de la fiche fusionnée re-pointées sur la fiche conservée
 *      (autres candidats gardés, paire par paire) ou closes ;
 *   4. décisions de paire : la fusion est mémorisée (SAME) ; une décision
 *      « distinctes » prise sur la fiche fusionnée vaut pour la fiche conservée ;
 *   5. cartes SUPPLIER-IDENTITY devenues sans objet fermées (OBSOLETE, tracé).
 * Isolation : les deux fiches doivent être ACTIVES et du compte, sinon rien.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { db } from '@/db';
import { supplierReviewItems, suppliers, toProcessActionEvents, toProcessActions } from '@/db/schema';
import { consolidateCoordinates, openContactConflicts, type ExtractedSupplierData, type SupplierQueryRunner, type UserFieldDecisions } from './supplier-service';
import { loadPairDecisions, recordPairDecision, reviewCandidateIds } from './supplier-identity-reviews';
import { pairKey } from './supplier-identity';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class SupplierMergeError extends Error {
  constructor(public code: 'NOT_FOUND' | 'SAME_SUPPLIER' | 'INACTIVE') { super(code); }
}

export interface SupplierMergeResult {
  keptId: number;
  mergedId: number;
  documentIds: number[];
  conflictsOpened: number;
  /** Événements Opération à publier APRÈS le commit (109A). */
  operationEvents: unknown[];
}

const COORDONNEES: Array<keyof ExtractedSupplierData> = [
  'email', 'phone', 'website', 'addressLine1', 'addressLine2', 'postalCode', 'city', 'country', 'siren', 'siret', 'vatNumber', 'iban', 'ibanHolderName',
];

const n = (v: unknown) => Number(v);
const rows = async <T>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> => (await tx.execute(q)) as unknown as T[];

/** Fusionne `fromId` dans `toId` (voir l'en-tête). Lève `SupplierMergeError`. */
export async function mergeSuppliersInTx(tx: Tx, p: {
  accountId: number; fromId: number; toId: number; actorUserId: number | null; reviewId?: number | null;
  /** Carte qui porte la décision (fermée par l'appelant) : exclue de la fermeture OBSOLETE. */
  actionId?: number | null;
}): Promise<SupplierMergeResult> {
  if (p.fromId === p.toId) throw new SupplierMergeError('SAME_SUPPLIER');
  const q = tx as unknown as SupplierQueryRunner;
  const { SUPPLIER_REFERENTIAL_LOCK } = await import('./supplier-from-analysis');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SUPPLIER_REFERENTIAL_LOCK}, ${p.accountId})`);
  const fiches = await tx.select().from(suppliers)
    .where(and(eq(suppliers.accountId, p.accountId), sql`${suppliers.id} IN (${p.fromId}, ${p.toId})`))
    .for('update');
  const from = fiches.find((f) => f.id === p.fromId);
  const to = fiches.find((f) => f.id === p.toId);
  if (!from || !to) throw new SupplierMergeError('NOT_FOUND');
  if (from.status !== 'active' || to.status !== 'active') throw new SupplierMergeError('INACTIVE');
  const now = new Date();

  // 1. Coordonnées : champs vides complétés, valeurs différentes en revue sourcée (aucun écrasement).
  const observation: ExtractedSupplierData = { name: from.name };
  for (const k of COORDONNEES) (observation as unknown as Record<string, unknown>)[k] = (from as unknown as Record<string, unknown>)[k] ?? null;
  const c = await consolidateCoordinates(to.id, observation, {
    q, provenance: (field) => ({ ...(((from.fieldProvenance ?? {}) as Record<string, Record<string, unknown>>)[field] ?? {}), mergedFromSupplierId: from.id, at: now.toISOString() }),
  });
  const conflictsOpened = await openContactConflicts(q, { accountId: p.accountId, supplierId: to.id, documentId: null, observationId: null, conflicts: c.conflicts });
  const reprises = c.outcomes.filter((o) => o.decision === 'FILLED').map((o) => o.field);
  const decFrom = (from.userFieldDecisions ?? {}) as UserFieldDecisions;
  const decTo = { ...((to.userFieldDecisions ?? {}) as UserFieldDecisions) };
  for (const f of reprises) if (decFrom[f] && !decTo[f]) decTo[f] = decFrom[f];
  await tx.update(suppliers).set({
    userFieldDecisions: decTo,
    ...(from.scope === 'duo' && to.scope !== 'duo' ? { scope: 'duo' } : {}),
    updatedAt: now,
  }).where(and(eq(suppliers.id, to.id), eq(suppliers.accountId, p.accountId)));

  // 2. Relations. Documents du compte seulement ; fiabilité de chaque lien conservée (la plus forte des deux).
  const docs = await rows<{ document_id: number }>(tx, sql`
    SELECT ds.document_id FROM document_suppliers ds JOIN asset_files f ON f.id = ds.document_id AND f.account_id = ${p.accountId}
     WHERE ds.supplier_id = ${from.id}`);
  const documentIds = docs.map((d) => n(d.document_id));
  if (documentIds.length) {
    await tx.execute(sql`
      INSERT INTO document_suppliers (document_id, supplier_id, role, confidence_score, is_confirmed, match_basis)
      SELECT ds.document_id, ${to.id}, ds.role, ds.confidence_score, ds.is_confirmed, 'MERGED'
        FROM document_suppliers ds JOIN asset_files f ON f.id = ds.document_id AND f.account_id = ${p.accountId}
       WHERE ds.supplier_id = ${from.id}
      ON CONFLICT (document_id, supplier_id) DO UPDATE SET
        is_confirmed = document_suppliers.is_confirmed OR EXCLUDED.is_confirmed,
        confidence_score = GREATEST(document_suppliers.confidence_score, EXCLUDED.confidence_score),
        role = COALESCE(document_suppliers.role, EXCLUDED.role)`);
    await tx.execute(sql`DELETE FROM document_suppliers WHERE supplier_id = ${from.id} AND document_id = ANY(${`{${documentIds.join(',')}}`}::int[])`);
  }
  await tx.execute(sql`
    INSERT INTO asset_suppliers (asset_id, supplier_id, source_type)
    SELECT x.asset_id, ${to.id}, x.source_type FROM asset_suppliers x JOIN assets a ON a.id = x.asset_id AND a.account_id = ${p.accountId}
     WHERE x.supplier_id = ${from.id}
    ON CONFLICT DO NOTHING`);
  await tx.execute(sql`DELETE FROM asset_suppliers x USING assets a WHERE a.id = x.asset_id AND a.account_id = ${p.accountId} AND x.supplier_id = ${from.id}`);
  await tx.execute(sql`
    INSERT INTO equipment_suppliers (equipment_id, supplier_id, relationship_type, source_document_id, source_type, is_primary)
    SELECT x.equipment_id, ${to.id}, x.relationship_type, x.source_document_id, x.source_type, x.is_primary
      FROM equipment_suppliers x JOIN equipments e ON e.id = x.equipment_id JOIN assets a ON a.id = e.asset_id AND a.account_id = ${p.accountId}
     WHERE x.supplier_id = ${from.id}
    ON CONFLICT (equipment_id, supplier_id) DO UPDATE SET is_primary = equipment_suppliers.is_primary OR EXCLUDED.is_primary`);
  await tx.execute(sql`
    DELETE FROM equipment_suppliers x USING equipments e, assets a
     WHERE e.id = x.equipment_id AND a.id = e.asset_id AND a.account_id = ${p.accountId} AND x.supplier_id = ${from.id}`);
  await tx.execute(sql`UPDATE supplier_contact_observations SET supplier_id = ${to.id} WHERE supplier_id = ${from.id}`);

  const { mergeAgendaSupplierLinksInTx } = await import('@/services/agenda/agenda-suppliers');
  await mergeAgendaSupplierLinksInTx(tx, { accountId: p.accountId, fromSupplierId: from.id, toSupplierId: to.id, actorUserId: p.actorUserId });
  // Report des liens Opération ↔ fournisseur : écriture Opération ouverte par le module relations (INV-FINAL-009).
  const { mergeOperationSupplierRecordsInTx } = await import('@/services/relations/operation-suppliers');
  const { events: operationEvents } = await mergeOperationSupplierRecordsInTx(tx, {
    accountId: p.accountId, fromSupplierId: from.id, toSupplierId: to.id, actorUserId: p.actorUserId,
  });

  // 3. Revues.
  // Conflits de coordonnées de la fiche fusionnée : reportés sur la fiche conservée, valeur actuelle relue ;
  // ceux que la fiche conservée porte déjà (même valeur) sont clos.
  const [apres] = await tx.select().from(suppliers).where(eq(suppliers.id, to.id)).limit(1);
  const conflits = await tx.select().from(supplierReviewItems).where(and(
    eq(supplierReviewItems.accountId, p.accountId), eq(supplierReviewItems.supplierId, from.id),
    eq(supplierReviewItems.itemType, 'contact_conflict'), eq(supplierReviewItems.status, 'open')));
  for (const r of conflits) {
    const actuelle = r.conflictingField ? ((apres as unknown as Record<string, unknown>)[r.conflictingField] as string | null) ?? null : null;
    const memeValeur = !!actuelle && !!r.detectedValue && actuelle.trim().toLowerCase() === r.detectedValue.trim().toLowerCase();
    await tx.update(supplierReviewItems).set(memeValeur
      ? { supplierId: to.id, status: 'resolved', resolution: 'merged', resolvedAt: now, resolvedByUserId: p.actorUserId, updatedAt: now }
      : { supplierId: to.id, currentValue: r.conflictingField === 'iban' ? r.currentValue : actuelle, updatedAt: now })
      .where(eq(supplierReviewItems.id, r.id));
  }
  // Revues de doublon : la paire tranchée disparaît ; les autres candidats restent proposés, paire par paire.
  const doublons = await tx.select().from(supplierReviewItems).where(and(
    eq(supplierReviewItems.accountId, p.accountId), eq(supplierReviewItems.itemType, 'deduplication'), eq(supplierReviewItems.status, 'open'),
    sql`(${supplierReviewItems.supplierId} IN (${from.id}, ${to.id}) OR ${supplierReviewItems.candidateSupplierIds} @> ${JSON.stringify([from.id])}::jsonb)`));
  for (const r of doublons) {
    const sujet = r.supplierId === from.id ? to.id : r.supplierId;
    const restants = reviewCandidateIds(r.candidateSupplierIds).map((x) => (x === from.id ? to.id : x)).filter((x, i, l) => x !== sujet && l.indexOf(x) === i);
    if (sujet == null || !restants.length) {
      await tx.update(supplierReviewItems).set({ status: 'resolved', resolution: 'merged', resolvedAt: now, resolvedByUserId: p.actorUserId, updatedAt: now })
        .where(eq(supplierReviewItems.id, r.id));
    } else {
      await tx.update(supplierReviewItems).set({ supplierId: sujet, candidateSupplierIds: restants, updatedAt: now }).where(eq(supplierReviewItems.id, r.id));
    }
  }

  // 4. Décisions de paire : fusion mémorisée ; « distinctes » de la fiche fusionnée reportées sur la conservée.
  const decisions = await loadPairDecisions(q, p.accountId, [from.id]);
  for (const [cle, d] of decisions) {
    if (d.decision !== 'DISTINCT') continue;
    const autre = d.low === from.id ? d.high : d.low;
    if (autre === to.id) continue;
    const { low, high } = pairKey(to.id, autre);
    if ((await loadPairDecisions(q, p.accountId, [to.id])).has(`${low}:${high}`)) continue;
    await tx.execute(sql`
      INSERT INTO supplier_identity_decisions (account_id, supplier_low_id, supplier_high_id, decision, basis, evidence_fingerprint, evidence, decided_by_user_id, decided_at)
      SELECT account_id, ${low}, ${high}, 'DISTINCT', basis, NULL, evidence || jsonb_build_object('inheritedFromPair', ${cle}::text), decided_by_user_id, decided_at
        FROM supplier_identity_decisions WHERE account_id = ${p.accountId} AND supplier_low_id = ${d.low} AND supplier_high_id = ${d.high}
      ON CONFLICT DO NOTHING`);
  }
  await recordPairDecision(q, { accountId: p.accountId, a: from, b: to, decision: 'SAME', reviewId: p.reviewId ?? null, userId: p.actorUserId,
    evidence: { keptSupplierId: to.id, mergedSupplierId: from.id, documents: documentIds.length } });

  await tx.update(suppliers).set({ status: 'archived', mergedIntoSupplierId: to.id, updatedAt: now })
    .where(and(eq(suppliers.id, from.id), eq(suppliers.accountId, p.accountId)));

  // 5. Cartes d'identité devenues sans objet (fiche fusionnée en cible ou en « déjà connu »).
  const obsoletes = await tx.update(toProcessActions)
    .set({ resolvedAt: now, resolutionReason: 'OBSOLETE', updatedAt: now })
    .where(and(
      eq(toProcessActions.accountId, p.accountId), eq(toProcessActions.ruleCode, 'SUPPLIER-IDENTITY'), isNull(toProcessActions.resolvedAt),
      sql`(${toProcessActions.targetId} = ${from.id} OR ${toProcessActions.triggerContext}->>'knownSupplierId' = ${String(from.id)}
           OR ${toProcessActions.triggerContext}->>'detectedSupplierId' = ${String(from.id)})`,
      p.actionId ? sql`${toProcessActions.id} <> ${p.actionId}` : sql`true`,
    ))
    .returning({ id: toProcessActions.id, targetId: toProcessActions.targetId });
  if (obsoletes.length) {
    await tx.insert(toProcessActionEvents).values(obsoletes.map((a) => ({
      actionId: a.id, accountId: p.accountId, event: 'OBSOLETE', actorUserId: p.actorUserId, targetType: 'SUPPLIER', targetId: a.targetId,
      fieldKey: 'identity', details: { ruleCode: 'SUPPLIER-IDENTITY', reason: 'SUPPLIER_MERGED', mergedSupplierId: from.id, keptSupplierId: to.id }, createdAt: now,
    })));
  }

  return { keptId: to.id, mergedId: from.id, documentIds, conflictsOpened, operationEvents };
}

/** Effets HORS transaction, une fois la fusion validée : événements Opération, réévaluation T3, assistant. */
export async function afterSupplierMerge(accountId: number, r: SupplierMergeResult): Promise<void> {
  try {
    const { publishBusinessOperationEvents } = await import('@/services/business-operations/events');
    await publishBusinessOperationEvents(r.operationEvents as never);
  } catch (e) { console.error('[fournisseurs] événements Opération après fusion non publiés :', (e as Error).message); }
  try {
    const { requestOperationSupplierResync } = await import('@/services/relations/operation-suppliers');
    await requestOperationSupplierResync(accountId, r.documentIds);
  } catch (e) { console.error('[fournisseurs] réévaluation T3 après fusion non demandée :', (e as Error).message); }
  try {
    const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
    await emitBusinessEvent({ type: 'SUPPLIER_CHANGED', accountId, entityId: r.keptId });
  } catch { /* non bloquant */ }
}
