/**
 * Saisie Sinistre → Opération CLAIM — écriture déterministe dans la session
 * d'écriture Opération (lot 44, O5 ; CDC Opérations V1 ch. 15, B14, C2, C5,
 * C6.1, C8.1, C12, C13.1, C14, C14.1, C14.2, C19, C24 ; décisions PO Q2, Q3,
 * Q4, Q11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA SAISIE EST UNE SOURCE CLAIM_FORM PRIORITAIRE (C19, 15.2)
 *
 *   · une source CLAIM_FORM (autorité USER, certaine) par bien concerné
 *     (`source_entity_key` = bien, convention C20) : un sinistre multi-biens
 *     survit à la suppression ou au départ de l'un de ses biens (F-187) ;
 *   · statut de l'Opération REALIZED (le sinistre est arrivé, F-148 à
 *     F-150), clôture `closed_at` seulement pour un dossier « Clos » (C14.1) ;
 *   · indemnité → composante INDEMNITY (Q4) — globale pour un sinistre
 *     multi-biens (F-160), attribuée au bien d'un sinistre mono-bien (F-159) ;
 *     le coût brut (REALIZED_COST) n'est jamais diminué ;
 *   · police : lien vers le Contrat d'assurance quand il est CERTAIN (une
 *     seule Opération CONTRACT porte cette police, ou le contrat de la fiche
 *     du bien si la police n'est pas précisée — C13.1, F-155), sinon le texte
 *     seul (F-156) ;
 *   · action avec facture : rapprochement de l'INTERVENTION enfant prouvée
 *     par ce document (C14.2, F-152), jamais de nouvelle intervention créée
 *     ici (anti-fragmentation : T3 la créera depuis le document) ; une action
 *     sans facture reste une action (F-151) ;
 *   · référence de dossier (CLAIM, M1) : un sinistre établi par les SEULS
 *     documents qui porte la même référence est la même réalité — fusion V1
 *     (B8) dans le sinistre saisi, sans doublon ; deux sinistres saisis ne
 *     sont jamais fusionnés ;
 *   · reconsolidation T3 du sinistre dans la même transaction (sources
 *     documentaires : constat, déclaration, courriers) ; la saisie prime pour
 *     ce qu'elle porte (`consolidator.ts`, lot 44).
 *
 * Événement d'agenda (claimEventKey) : `agenda_items.business_operation_id`
 * — LIEN, jamais un élément d'agenda créé (pas de doublon, F-147) ;
 * événement de l'historique : `claim_details.history_event_id`.
 *
 * Miroir de compatibilité (Q11) : `syncClaimMirror` recopie le sinistre le
 * plus récent de chaque bien touché dans `asset_additional_infos.claim_json`
 * (forme du lot 43) et l'empreinte de son repère de migration, dans la MÊME
 * transaction — retour arrière possible vers le lot 43 pendant la fenêtre de
 * compatibilité (docs/exploitation/sinistres-compatibilite.md).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  applyPatch, emptyAdditionalInfos, sanitizeSection,
  type AdditionalInfoSectionData, type NormalizedPatch,
} from '@/lib/assets/additional-infos';
import type { DbTx } from '../lock';
import { normalizeBusinessReference } from '../model';
import type { BusinessOperationRepository, ClaimListsInput } from '../repository';
import type { WriteSession } from '../write';
import {
  CLAIM_FORM_INDEMNITY_FINGERPRINT, CLAIM_MIGRATION_VERSION, claimClosedFor, claimLabel, claimToSection, pickMirrorClaim,
  sectionToClaimWrite, type ClaimRecord,
} from '../claims/model';
import { loadClaimRecords } from '../claims/read';
import { emptyCardNeeds, type OperationCardNeeds } from './card-needs';
import { Changes, reconsolidateOperation } from './consolidator';

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];
const intArray = (v: readonly number[]): string => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Erreur métier de la saisie Sinistre (route : 404 / 409 / 422). */
export class ClaimFormError extends Error {
  constructor(
    readonly code: 'CLAIM_NOT_FOUND' | 'CONFLICT' | 'INVALID_ASSETS' | 'EVENT_ALREADY_LINKED' | 'EVENT_NOT_FOUND',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ClaimFormError';
  }
}

/** Origine de la saisie : formulaire (CLAIM_FORM) ou ancien formulaire migré (MIGRATION, C14.3). */
export type ClaimWriteOrigin =
  | { kind: 'FORM' }
  | { kind: 'MIGRATION'; assetId: number; migrationSourceId: number };

const CLAIM_FORM_LOCATOR = { form: 'claim' } as const;

// ── Biens concernés (Q2, 15.5) ─────────────────────────────────────────────

/** Biens vivants du compte parmi ceux demandés (ordre conservé, sans doublon). */
export async function liveAccountAssets(tx: DbTx, accountId: number, assetIds: readonly number[]): Promise<number[]> {
  const uniques = [...new Set(assetIds.filter((a) => Number.isSafeInteger(a) && a > 0))];
  if (!uniques.length) return [];
  const r = await rows<{ id: number }>(tx, sql`
    SELECT id FROM assets WHERE account_id = ${accountId} AND deleted_at IS NULL AND id = ANY(${intArray(uniques)}::int[])`);
  const ok = new Set(r.map((x) => Number(x.id)));
  return uniques.filter((a) => ok.has(a));
}

/**
 * Pose les biens concernés : une source CLAIM_FORM et un lien (autorité USER)
 * par bien ; un bien retiré perd sa source et son lien (historisés). Rend la
 * source CLAIM_FORM du bien principal.
 */
async function setClaimAssets(repo: BusinessOperationRepository, tx: DbTx, claimId: number, assetIds: readonly number[], primaryAssetId: number): Promise<number> {
  const voulus = new Set(assetIds);
  const actuels = await rows<{ asset_id: number }>(tx, sql`
    SELECT asset_id FROM business_operation_asset_links WHERE operation_id = ${claimId} AND active`);
  for (const l of actuels) {
    const a = Number(l.asset_id);
    if (voulus.has(a)) continue;
    const src = await rows<{ id: string }>(tx, sql`
      SELECT id FROM business_operation_sources WHERE operation_id = ${claimId} AND active AND source_kind = 'CLAIM_FORM' AND source_entity_key = ${String(a)}`);
    for (const s of src) await repo.deactivateSource(Number(s.id), 'CLAIM_FORM_ASSET_REMOVED');
    await repo.unlinkAsset(claimId, a, 'CLAIM_FORM_ASSET_REMOVED');
  }
  let primarySource = 0;
  for (const a of [primaryAssetId, ...assetIds.filter((x) => x !== primaryAssetId)]) {
    const sourceId = await repo.addSource(claimId, {
      kind: 'CLAIM_FORM', entityKey: a, locator: { ...CLAIM_FORM_LOCATOR }, authority: 'USER', confidence: 'certain', matchReason: 'USER_CLAIM_FORM',
    }, 'CLAIM_FORM_SOURCE');
    if (a === primaryAssetId) primarySource = sourceId;
    await repo.linkAsset(claimId, { assetId: a, role: a === primaryAssetId ? 'PRIMARY' : 'CONCERNED', authority: 'USER', sourceId }, 'CLAIM_FORM_ASSET_LINKED');
  }
  return primarySource;
}

// ── Police → Contrat d'assurance (C13.1, F-155, F-156) ─────────────────────

/**
 * Contrat d'assurance CERTAIN du sinistre, sinon null (texte conservé seul) :
 *   · police saisie : exactement UNE Opération CONTRACT active du compte porte
 *     cette référence (POLICY / CONTRACT, valeur normalisée) ;
 *   · police non précisée (« seulement s'il diffère du contrat de la fiche ») :
 *     exactement UN contrat établi par la fiche du bien principal (source
 *     ASSET_DATA « CONTRACT », lot 43, Q6).
 */
export async function resolveInsuranceContract(tx: DbTx, accountId: number, policyText: string | null, primaryAssetId: number | null): Promise<number | null> {
  if (policyText) {
    const norm = normalizeBusinessReference(policyText);
    if (!norm) return null;
    const r = await rows<{ id: string }>(tx, sql`
      SELECT DISTINCT o.id FROM business_operations o
        JOIN business_operation_references r ON r.operation_id = o.id AND r.active AND r.reference_kind IN ('POLICY', 'CONTRACT')
       WHERE o.account_id = ${accountId} AND o.type_code = 'CONTRACT' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         AND r.normalized_value = ${norm}
       LIMIT 2`);
    return r.length === 1 ? Number(r[0].id) : null;
  }
  if (primaryAssetId === null) return null;
  const r = await rows<{ id: string }>(tx, sql`
    SELECT DISTINCT o.id FROM business_operations o
      JOIN business_operation_sources s ON s.operation_id = o.id AND s.active AND s.source_kind = 'ASSET_DATA'
       AND s.source_entity_key = ${String(primaryAssetId)} AND s.locator->>'nature' = 'CONTRACT'
     WHERE o.account_id = ${accountId} AND o.type_code = 'CONTRACT' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
     LIMIT 2`);
  return r.length === 1 ? Number(r[0].id) : null;
}

// ── Événement d'agenda / d'historique (C14, F-147) ─────────────────────────

/**
 * Lie l'événement choisi au sinistre, sans jamais créer d'élément d'agenda.
 * Agenda : `agenda_items.business_operation_id` (un élément déjà rattaché à
 * un AUTRE sinistre actif est refusé) ; les liens posés par l'utilisateur vers
 * un autre élément sont retirés (les projections T4 ne sont pas touchées).
 * Historique : rend l'identifiant à écrire dans `history_event_id`.
 */
export async function linkClaimEvent(tx: DbTx, accountId: number, claimId: number, key: string | null, assetIds: readonly number[]): Promise<{ historyEventId: number | null }> {
  const m = key ? /^(agenda|event):([1-9]\d{0,9})$/.exec(key) : null;
  const agendaId = m?.[1] === 'agenda' ? Number(m[2]) : null;
  const eventId = m?.[1] === 'event' ? Number(m[2]) : null;
  if (agendaId !== null) {
    const [a] = await rows<{ id: number; op: string | null; op_active: boolean | null }>(tx, sql`
      SELECT ai.id, ai.business_operation_id AS op,
             (SELECT o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL FROM business_operations o WHERE o.id = ai.business_operation_id) AS op_active
        FROM agenda_items ai
       WHERE ai.id = ${agendaId} AND ai.account_id = ${accountId}
         AND EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = ai.id AND l.asset_id = ANY(${intArray(assetIds)}::int[]))
       FOR UPDATE OF ai`);
    if (!a) throw new ClaimFormError('EVENT_NOT_FOUND', 'Événement introuvable pour ce bien.', { path: 'claim.claimEventKey' });
    if (a.op !== null && Number(a.op) !== claimId && a.op_active) {
      throw new ClaimFormError('EVENT_ALREADY_LINKED', 'Cet événement est déjà rattaché à un autre sinistre.', { path: 'claim.claimEventKey' });
    }
    if (a.op === null || Number(a.op) !== claimId) {
      await tx.execute(sql`UPDATE agenda_items SET business_operation_id = ${claimId}, updated_at = now() WHERE id = ${agendaId}`);
    }
  }
  if (eventId !== null) {
    const [e] = await rows(tx, sql`
      SELECT 1 FROM events WHERE id = ${eventId} AND account_id = ${accountId}
         AND (asset_id = ANY(${intArray(assetIds)}::int[]) OR linked_asset_id = ANY(${intArray(assetIds)}::int[]))`);
    if (!e) throw new ClaimFormError('EVENT_NOT_FOUND', 'Événement introuvable pour ce bien.', { path: 'claim.claimEventKey' });
  }
  // Liens utilisateur vers un autre élément d'agenda : retirés (une seule ancre).
  await tx.execute(sql`
    UPDATE agenda_items SET business_operation_id = NULL, updated_at = now()
     WHERE business_operation_id = ${claimId} AND account_id = ${accountId} AND projection_origin IS NULL
       AND (${agendaId}::int IS NULL OR id <> ${agendaId}::int)`);
  return { historyEventId: eventId };
}

// ── Actions avec facture → INTERVENTION enfant (C14.2) ─────────────────────

/**
 * INTERVENTION prouvée par la facture d'une action : active, du compte, dont
 * une source DOCUMENT active est ce fichier. Préférence : déjà enfant de ce
 * sinistre, sinon sans parent. Une intervention enfant d'un AUTRE sinistre
 * n'est jamais « volée » ; aucune n'est créée ici.
 */
async function interventionForInvoice(tx: DbTx, accountId: number, claimId: number, fileId: number): Promise<{ id: number; parent: number | null } | null> {
  const r = await rows<{ id: string; parent: string | null }>(tx, sql`
    SELECT o.id, o.parent_operation_id AS parent FROM business_operations o
     WHERE o.account_id = ${accountId} AND o.type_code = 'INTERVENTION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       AND (o.parent_operation_id IS NULL OR o.parent_operation_id = ${claimId})
       AND EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT'
                      AND s.source_entity_key = ${String(fileId)})
     ORDER BY (o.parent_operation_id = ${claimId}) DESC NULLS LAST, o.id`);
  if (!r.length) return null;
  const enfant = r.find((x) => x.parent !== null);
  if (enfant) return { id: Number(enfant.id), parent: claimId };
  return r.length === 1 ? { id: Number(r[0].id), parent: null } : null;
}

async function linkActionInterventions(repo: BusinessOperationRepository, tx: DbTx, accountId: number, claimId: number, lists: ClaimListsInput, changes: Changes): Promise<ClaimListsInput> {
  const actions = [];
  for (const a of lists.actions) {
    if (a.invoiceFileId === null) { actions.push({ ...a, childOperationId: null }); continue; }
    const child = await interventionForInvoice(tx, accountId, claimId, a.invoiceFileId);
    if (child && child.parent === null) changes.track(await repo.setParent(child.id, claimId, 'CLAIM_ACTION_INVOICE'));
    actions.push({ ...a, childOperationId: child?.id ?? null });
  }
  return { ...lists, actions };
}

// ── Indemnité (Q4, F-159, F-160) ───────────────────────────────────────────

async function syncIndemnity(repo: BusinessOperationRepository, tx: DbTx, claimId: number, cents: number | null, sourceId: number, assetIds: readonly number[], changes: Changes): Promise<void> {
  const [cur] = await rows<{ id: string }>(tx, sql`
    SELECT id FROM business_operation_financial_components
     WHERE operation_id = ${claimId} AND active AND fingerprint = ${CLAIM_FORM_INDEMNITY_FINGERPRINT}`);
  if (cents === null) {
    if (cur) changes.track(await repo.supersedeFinancialComponent(Number(cur.id), 'CLAIM_FORM_INDEMNITY_REMOVED'));
    return;
  }
  const before = cur ? Number(cur.id) : null;
  const id = await repo.addFinancialComponent(claimId, {
    kind: 'INDEMNITY', amountMinor: cents, currency: 'EUR', amountEurCents: null,
    // Mono-bien : l'indemnité concerne ce bien (F-159) ; multi-biens : globale, jamais ventilée (F-160).
    targetAssetId: assetIds.length === 1 ? assetIds[0] : null,
    label: 'Indemnité reçue', fingerprint: CLAIM_FORM_INDEMNITY_FINGERPRINT,
    sources: [{ sourceId, isPrimary: true }],
  }, 'CLAIM_FORM_INDEMNITY');
  changes.track(id !== before);
}

// ── Référence de dossier (M1) et fusion des sinistres documentaires ────────

async function syncClaimReference(repo: BusinessOperationRepository, tx: DbTx, accountId: number, claimId: number, ref: string | null, sourceId: number, changes: Changes, cards: OperationCardNeeds): Promise<void> {
  const norm = ref ? normalizeBusinessReference(ref) : '';
  // Références CLAIM posées par la saisie (sources utilisateur) devenues fausses : retirées.
  const posees = await rows<{ id: string; normalized_value: string }>(tx, sql`
    SELECT r.id, r.normalized_value FROM business_operation_references r
      JOIN business_operation_sources s ON s.id = r.source_id AND s.source_kind IN ('CLAIM_FORM', 'MIGRATION')
     WHERE r.operation_id = ${claimId} AND r.active AND r.reference_kind = 'CLAIM'`);
  for (const p of posees) if (p.normalized_value !== norm) changes.track(await repo.deactivateReference(Number(p.id), 'CLAIM_FORM_REFERENCE_CHANGED'));
  if (!norm) return;
  changes.track(await repo.addReference(claimId, { kind: 'CLAIM', value: ref!, sourceId }, 'CLAIM_FORM_REFERENCE'));
  // Sinistres établis par les SEULS documents portant la même référence : même réalité (M1, B8).
  const memes = await rows<{ id: string }>(tx, sql`
    SELECT DISTINCT o.id FROM business_operations o
      JOIN business_operation_references r ON r.operation_id = o.id AND r.active AND r.reference_kind = 'CLAIM' AND r.normalized_value = ${norm}
     WHERE o.account_id = ${accountId} AND o.type_code = 'CLAIM' AND o.id <> ${claimId}
       AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active AND s.source_kind IN ('CLAIM_FORM', 'MIGRATION'))
     ORDER BY o.id`);
  for (const m of memes) {
    if (await repo.mergeOperations(Number(m.id), claimId, 'CLAIM_FORM_MERGE_REFERENCE')) {
      changes.track(true);
      cards.reviewedOperations.push(Number(m.id));
    }
  }
}

// ── Écriture complète d'une sous-rubrique sur le sinistre ──────────────────

export interface ApplyClaimOptions {
  sourceId: number;
  assetIds: readonly number[];
  primaryAssetId: number;
  today?: string;
  changes?: Changes;
  cards?: OperationCardNeeds;
}

/**
 * Écrit l'état COMPLET de la sous-rubrique (déjà validée et relue) sur le
 * sinistre : détails, date de survenue, statut et clôture, indemnité,
 * listes, événement lié, police, référence ; puis reconsolidation T3.
 * Chaque écriture du dépôt compare avant d'écrire (aucun historique sans
 * changement).
 */
export async function applyClaimSection(session: WriteSession, accountId: number, claimId: number, section: AdditionalInfoSectionData, o: ApplyClaimOptions): Promise<void> {
  const repo = session.repository(accountId);
  const tx = session.tx;
  const changes = o.changes ?? new Changes();
  const cards = o.cards ?? emptyCardNeeds();
  const w = sectionToClaimWrite(section);

  const contractId = await resolveInsuranceContract(tx, accountId, w.details.policyReferenceText ?? null, o.primaryAssetId);
  const { historyEventId } = await linkClaimEvent(tx, accountId, claimId, w.claimEventKey, o.assetIds);
  changes.track(await repo.upsertClaimDetails(claimId, { ...w.details, insuranceContractOperationId: contractId, historyEventId }, 'CLAIM_FORM_DETAILS'));

  const op = await repo.load(claimId);
  // Le sinistre est arrivé : REALIZED, quel que soit l'avancement du dossier (C14.1, INV-FINAL-022).
  if (op.status !== 'REALIZED') changes.track(await repo.setStatus(claimId, 'REALIZED', { reasonCode: 'CLAIM_FORM_REALIZED', sourceId: o.sourceId }));
  changes.track(await repo.updateAttributes(claimId, { realizedDate: w.occurredOn, technicalLabel: claimLabel(section) }, 'CLAIM_FORM_ATTRIBUTES'));
  if (claimClosedFor(w.details.status ?? null)) changes.track(await repo.close(claimId, 'CLAIM_FILE_CLOSED'));
  else changes.track(await repo.reopen(claimId, 'CLAIM_FILE_REOPENED'));

  await syncIndemnity(repo, tx, claimId, w.compensationCents, o.sourceId, o.assetIds, changes);
  const lists = await linkActionInterventions(repo, tx, accountId, claimId, w.lists, changes);
  changes.track(await repo.replaceClaimLists(claimId, lists, 'CLAIM_FORM_LISTS'));
  await syncClaimReference(repo, tx, accountId, claimId, w.details.insurerClaimRef ?? null, o.sourceId, changes, cards);

  // T3 : les preuves documentaires du sinistre sont reconsolidées avec la saisie.
  await reconsolidateOperation(repo, tx, claimId, o.today ?? todayUtc(), changes, cards);
}

// ── Création, modification, suppression ────────────────────────────────────

export interface ClaimMutationResult {
  claimId: number;
  /** Biens dont le miroir `claim_json` a été recalculé. */
  assets: number[];
  changes: number;
  /** Suppression : le sinistre reste établi par des documents (F-088). */
  remains?: boolean;
}

/** Sous-rubrique actuelle d'un sinistre du compte, lue sous verrou. */
export async function currentClaimSection(tx: DbTx, accountId: number, claimId: number): Promise<{ record: ClaimRecord; section: AdditionalInfoSectionData } | null> {
  const [record] = await loadClaimRecords(tx, accountId, { ids: [claimId] });
  return record ? { record, section: claimToSection(record) } : null;
}

/** Applique un correctif VALIDÉ (forme `validateAdditionalInfosPatch`, sous-rubrique `claim`) à une sous-rubrique. */
export function patchClaimSection(current: AdditionalInfoSectionData, patch: NormalizedPatch): AdditionalInfoSectionData {
  const base = { ...emptyAdditionalInfos(), claim: current };
  return sanitizeSection('claim', applyPatch(base, { set: { claim: patch.set.claim ?? {} }, unset: { claim: patch.unset.claim ?? [] } }).claim);
}

/**
 * Nouveau sinistre saisi (F-015 : REALIZED, même sans document) sur le bien
 * `primaryAssetId`, éventuellement multi-biens (Q2). Rend son identifiant.
 */
export async function createClaimInSession(session: WriteSession, accountId: number, p: {
  primaryAssetId: number; assetIds: readonly number[]; section: AdditionalInfoSectionData; today?: string; cards?: OperationCardNeeds;
}): Promise<ClaimMutationResult> {
  const repo = session.repository(accountId);
  const tx = session.tx;
  const assetIds = await liveAccountAssets(tx, accountId, [p.primaryAssetId, ...p.assetIds]);
  if (!assetIds.includes(p.primaryAssetId)) throw new ClaimFormError('INVALID_ASSETS', 'Bien introuvable.', { path: 'assetIds' });
  const w = sectionToClaimWrite(p.section);
  const created = await repo.create({
    type: { code: 'CLAIM' }, status: 'REALIZED', realizedDate: w.occurredOn, technicalLabel: claimLabel(p.section),
    source: { kind: 'CLAIM_FORM', entityKey: p.primaryAssetId, locator: { ...CLAIM_FORM_LOCATOR }, authority: 'USER', confidence: 'certain', matchReason: 'USER_CLAIM_FORM' },
    assets: [{ assetId: p.primaryAssetId, role: 'PRIMARY', authority: 'USER' }],
    reasonCode: 'CLAIM_FORM_CREATE',
  });
  const changes = new Changes();
  changes.track(true);
  const sourceId = await setClaimAssets(repo, tx, created.id, assetIds, p.primaryAssetId);
  await applyClaimSection(session, accountId, created.id, p.section, { sourceId, assetIds, primaryAssetId: p.primaryAssetId, today: p.today, changes, cards: p.cards });
  const touched = await syncClaimMirror(tx, accountId, assetIds);
  return { claimId: created.id, assets: touched, changes: changes.n };
}

/**
 * Modification d'un sinistre du bien `assetId` : correctif fusionné champ par
 * champ, listes remplacées en bloc ; `expectedVersion` (verrou optimiste) :
 * CONFLICT si le sinistre a changé depuis la lecture du client.
 */
export async function updateClaimInSession(session: WriteSession, accountId: number, p: {
  assetId: number; claimId: number; patch: NormalizedPatch | null; expectedVersion: number | null; assetIds?: readonly number[] | null;
  today?: string; cards?: OperationCardNeeds;
}): Promise<ClaimMutationResult> {
  const repo = session.repository(accountId);
  const tx = session.tx;
  const cur = await currentClaimSection(tx, accountId, p.claimId);
  if (!cur || !cur.record.assets.some((a) => a.assetId === p.assetId)) throw new ClaimFormError('CLAIM_NOT_FOUND', 'Sinistre introuvable.');
  await repo.load(p.claimId); // verrou de la ligne (FOR UPDATE) avant le contrôle de version
  const [v] = await rows<{ version: number }>(tx, sql`SELECT version FROM business_operations WHERE id = ${p.claimId}`);
  if (p.expectedVersion !== null && Number(v.version) !== p.expectedVersion) {
    throw new ClaimFormError('CONFLICT', 'Ce sinistre a été modifié entre-temps (autre onglet ou co-titulaire).', { expectedVersion: p.expectedVersion });
  }
  const avant = cur.record.assets.map((a) => a.assetId);
  const primary = cur.record.assets.find((a) => a.role === 'PRIMARY')?.assetId ?? p.assetId;
  let assetIds = avant;
  if (p.assetIds) {
    assetIds = await liveAccountAssets(tx, accountId, p.assetIds);
    if (!assetIds.length) throw new ClaimFormError('INVALID_ASSETS', 'Un sinistre concerne au moins un bien.', { path: 'assetIds' });
  }
  const primaryNext = assetIds.includes(primary) ? primary : assetIds.includes(p.assetId) ? p.assetId : assetIds[0];
  const changes = new Changes();
  const sourceId = await setClaimAssets(repo, tx, p.claimId, assetIds, primaryNext);
  const section = p.patch ? patchClaimSection(cur.section, p.patch) : cur.section;
  await applyClaimSection(session, accountId, p.claimId, section, { sourceId, assetIds, primaryAssetId: primaryNext, today: p.today, changes, cards: p.cards });
  const touched = await syncClaimMirror(tx, accountId, [...new Set([...avant, ...assetIds])]);
  return { claimId: p.claimId, assets: touched, changes: changes.n };
}

/**
 * Suppression demandée par l'utilisateur (« annulation » logique, jamais
 * physique, ch. 22) : la saisie (sources CLAIM_FORM et MIGRATION, indemnité
 * saisie, lien d'agenda posé par l'utilisateur) est retirée ; sans autre
 * preuve, le sinistre est invalidé (F-089) ; établi aussi par des documents,
 * il reste (F-088). Un sinistre réalisé ne devient jamais CANCELLED (B7).
 */
export async function removeClaimInSession(session: WriteSession, accountId: number, p: { assetId: number; claimId: number; cards?: OperationCardNeeds }): Promise<ClaimMutationResult> {
  const repo = session.repository(accountId);
  const tx = session.tx;
  const cur = await currentClaimSection(tx, accountId, p.claimId);
  if (!cur || !cur.record.assets.some((a) => a.assetId === p.assetId)) throw new ClaimFormError('CLAIM_NOT_FOUND', 'Sinistre introuvable.');
  const changes = new Changes();
  const comps = await rows<{ id: string }>(tx, sql`
    SELECT id FROM business_operation_financial_components
     WHERE operation_id = ${p.claimId} AND active AND fingerprint = ${CLAIM_FORM_INDEMNITY_FINGERPRINT}`);
  for (const c of comps) changes.track(await repo.supersedeFinancialComponent(Number(c.id), 'CLAIM_FORM_REMOVED'));
  const srcs = await rows<{ id: string }>(tx, sql`
    SELECT id FROM business_operation_sources WHERE operation_id = ${p.claimId} AND active AND source_kind IN ('CLAIM_FORM', 'MIGRATION')`);
  for (const s of srcs) changes.track(await repo.deactivateSource(Number(s.id), 'CLAIM_FORM_REMOVED'));
  await tx.execute(sql`
    UPDATE agenda_items SET business_operation_id = NULL, updated_at = now()
     WHERE business_operation_id = ${p.claimId} AND account_id = ${accountId} AND projection_origin IS NULL`);
  const invalidated = await repo.invalidateIfUnsupported(p.claimId, 'CLAIM_FORM_REMOVED_NO_SOURCE');
  changes.track(invalidated);
  if (!invalidated) await reconsolidateOperation(repo, tx, p.claimId, todayUtc(), changes, p.cards ?? emptyCardNeeds());
  const touched = await syncClaimMirror(tx, accountId, cur.record.assets.map((a) => a.assetId));
  return { claimId: p.claimId, assets: touched, changes: changes.n, remains: !invalidated };
}

// ── Miroir de compatibilité `claim_json` (Q11) ─────────────────────────────

/**
 * Recopie, pour chaque bien, le sinistre le plus récent dans `claim_json`
 * (forme du lot 43, `{}` s'il n'y en a plus) et l'empreinte du repère de
 * migration — dans la transaction de l'écriture. N'écrase JAMAIS une
 * ancienne saisie non reprise (repère absent, sous le seuil ou ambiguë) :
 * elle reste lisible jusqu'à ce que l'utilisateur la reprenne. Ne change ni
 * la version du formulaire « Préparation des dossiers » ni sa date.
 * Rend les biens dont le JSON a été recopié.
 */
export async function syncClaimMirror(tx: DbTx, accountId: number, assetIds: readonly number[]): Promise<number[]> {
  const out: number[] = [];
  for (const assetId of [...new Set(assetIds)].sort((a, b) => a - b)) {
    const [bien] = await rows<{ id: number }>(tx, sql`SELECT id FROM assets WHERE id = ${assetId} AND account_id = ${accountId} AND deleted_at IS NULL`);
    if (!bien) continue;
    const [legacy] = await rows<{ claim: Record<string, unknown> | string; mark_outcome: string | null; mark_fp: string | null; fp: string }>(tx, sql`
      SELECT ai.claim_json AS claim, m.outcome AS mark_outcome, m.data_fingerprint AS mark_fp, md5(ai.claim_json::text) AS fp
        FROM asset_additional_infos ai LEFT JOIN business_operation_claim_migration_marks m ON m.asset_id = ai.asset_id
       WHERE ai.asset_id = ${assetId}`);
    const legacyObj = legacy ? (typeof legacy.claim === 'string' ? JSON.parse(legacy.claim) as Record<string, unknown> : legacy.claim) : {};
    const nonReprise = !!legacy && Object.keys(legacyObj ?? {}).length > 0
      && (legacy.mark_outcome === null || legacy.mark_outcome === 'BELOW_THRESHOLD' || legacy.mark_outcome === 'HOLD_AMBIGUOUS'
          || legacy.mark_fp !== legacy.fp);
    if (nonReprise) continue;
    const claims = await loadClaimRecords(tx, accountId, { assetId });
    const mirror = pickMirrorClaim(claims);
    const json = mirror ? claimToSection(mirror) : {};
    if (!legacy && !mirror) continue;
    await tx.execute(sql`
      INSERT INTO asset_additional_infos (asset_id, account_id, claim_json)
      VALUES (${assetId}, ${accountId}, ${JSON.stringify(json)}::jsonb)
      ON CONFLICT (asset_id) DO UPDATE SET claim_json = EXCLUDED.claim_json
       WHERE asset_additional_infos.claim_json IS DISTINCT FROM EXCLUDED.claim_json`);
    await tx.execute(sql`
      INSERT INTO business_operation_claim_migration_marks (asset_id, account_id, migration_version, data_fingerprint, operation_id, outcome, detail, processed_at)
      SELECT ${assetId}, ${accountId}, ${CLAIM_MIGRATION_VERSION}, md5(ai.claim_json::text), ${mirror?.id ?? null}::bigint, 'MIRRORED', '{}'::jsonb, now()
        FROM asset_additional_infos ai WHERE ai.asset_id = ${assetId}
      ON CONFLICT (asset_id) DO UPDATE SET account_id = EXCLUDED.account_id, migration_version = EXCLUDED.migration_version,
        data_fingerprint = EXCLUDED.data_fingerprint, operation_id = EXCLUDED.operation_id, processed_at = EXCLUDED.processed_at`);
    out.push(assetId);
  }
  return out;
}
