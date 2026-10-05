/**
 * Alimentation du référentiel fournisseurs depuis la projection T1 (lot 22,
 * chantier B — CDC Fournisseurs V1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 *
 * Le lot 16b-3 a supprimé `processSupplierFromExtraction` (appelé par
 * l'ancien moteur) : depuis, aucun document n'alimentait plus le référentiel
 * — ni fournisseur créé, ni lien document → fournisseur, ni revue de doublon.
 *
 * Le master T1 (`t1_master_v1`, branche ANALYZE_DOCUMENT) fournit
 * `document.supplier` = NOM et SIRET (14 chiffres) avec confiance et extrait ;
 * il ne fournit PAS de coordonnées (adresse, téléphone, e-mail, IBAN).
 * La projection (`toSourceAnalysisResult`) le porte dans
 * `result.document.supplier`. On s'abonne à l'analyse (`onSourceAnalyzed`,
 * comme T3 et T4) et on rebranche la chaîne historique sur ces données :
 *
 *   1. document absent, supprimé, fournisseur édité par l'utilisateur sur le
 *      document (`user_edited_fields.supplier` — posé aussi quand il RETIRE
 *      le lien, `DELETE /api/documents/[id]/supplier`) ou DÉJÀ lié à un
 *      fournisseur (lien posé par l'utilisateur ou par une analyse
 *      précédente) : RIEN — idempotent, une réanalyse ne crée ni doublon, ni
 *      second lien, ni ne recrée un lien retiré. Tous les fichiers du groupe
 *      T1 sont traités (le principal d'abord). Limite : l'enregistrement du
 *      tiroir remplace `user_edited_fields` en entier (route PATCH du
 *      document) ; si le client renvoie l'objet sans `supplier`, la trace
 *      d'un retrait est perdue ;
 *   2. rapprochement (`findCandidates` : SIRET / SIREN, puis nom normalisé)
 *      et décision (`assessMatch`) :
 *        · certain   → lien au fournisseur existant ;
 *        · incertain → nouveau fournisseur + revue de doublon (carte
 *                      « À traiter » SUPPLIER-IDENTITY), comme avant ;
 *        · nouveau   → fournisseur créé (`source = document_extraction`) ;
 *   3. fiche existante : un champ renseigné n'est JAMAIS remplacé (SIRET
 *      différent → revue `contact_conflict`) ; un champ vide n'est complété
 *      que sur une fiche créée par l'analyse — jamais sur une fiche saisie
 *      par l'utilisateur (`source <> 'document_extraction'`) ;
 *   4. observation (`supplier_contact_observations`), portée Duo, liens
 *      équipement : comme la chaîne historique.
 *
 * Concurrence : une transaction par document, verrou consultatif par compte
 * (`pg_advisory_xact_lock`) — deux documents du même fournisseur analysés en
 * même temps (deux instances) ne créent pas deux fiches. Toutes les requêtes
 * passent par la transaction (pool à une connexion sous `next start`).
 * Jamais bloquant pour l'analyse (`emitSourceAnalyzed` absorbe l'erreur).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, eq, and } from 'drizzle-orm';
import { db } from '@/db';
import {
  assetFiles, documentSuppliers, suppliers, supplierContactObservations, supplierReviewItems,
} from '@/db/schema';
import {
  assessMatch, classifySirenSiret, consolidateCoordinates, findCandidates, normalizeName,
  propagateScopeIfNeeded, recalculateEquipmentSuppliers, type SupplierQueryRunner,
} from './supplier-service';

/** Fournisseur lu par T1 (projection `result.document.supplier`). */
export interface AnalyzedSupplier {
  name: string;
  siret?: string | null;
  /** Confiance T1 : `certain` | `probable` | `conflictual`. */
  confidence?: string | null;
}

export type SupplierFeedResult =
  | { status: 'skipped'; reason: 'NO_SUPPLIER' | 'LOW_CONFIDENCE' | 'DOCUMENT_NOT_FOUND' | 'USER_EDITED_DOCUMENT' | 'ALREADY_LINKED' }
  | { status: 'linked' | 'created' | 'created_uncertain'; supplierId: number; conflicts: number };

/** Espace du verrou consultatif (deux entiers : espace, compte). */
const VERROU_FOURNISSEURS = 22410;

/** Confiance T1 retenue pour alimenter le référentiel (un fournisseur contradictoire est ignoré). */
const confianceRetenue = (c: string | null | undefined) => !c || c === 'certain' || c === 'probable';

/**
 * Alimente le référentiel pour UN document analysé. Voir l'en-tête.
 * `userId` : créateur des fiches nouvelles (déposant / analyse).
 */
export async function feedSupplierFromAnalysis(p: {
  accountId: number;
  userId: number;
  documentId: number;
  supplier: AnalyzedSupplier | null | undefined;
}): Promise<SupplierFeedResult> {
  const nom = p.supplier?.name?.trim() ?? '';
  if (!nom) return { status: 'skipped', reason: 'NO_SUPPLIER' };
  if (!confianceRetenue(p.supplier?.confidence)) return { status: 'skipped', reason: 'LOW_CONFIDENCE' };

  const normalizedName = normalizeName(nom);
  const { siren, siret } = classifySirenSiret(p.supplier?.siret ?? null);
  const observation = { name: nom, siren, siret };

  let out: SupplierFeedResult = { status: 'skipped', reason: 'DOCUMENT_NOT_FOUND' };
  let scope: string | null = null;

  await db.transaction(async (tx) => {
    const q = tx as unknown as SupplierQueryRunner;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${VERROU_FOURNISSEURS}, ${p.accountId})`);

    const [doc] = await q
      .select({ id: assetFiles.id, scope: assetFiles.scope, userEditedFields: assetFiles.userEditedFields, deletedAt: assetFiles.deletedAt })
      .from(assetFiles)
      .where(and(eq(assetFiles.id, p.documentId), eq(assetFiles.accountId, p.accountId)))
      .limit(1);
    if (!doc || doc.deletedAt) { out = { status: 'skipped', reason: 'DOCUMENT_NOT_FOUND' }; return; }
    if ((doc.userEditedFields as Record<string, unknown> | null)?.supplier === true) {
      out = { status: 'skipped', reason: 'USER_EDITED_DOCUMENT' };
      return;
    }
    const [lien] = await q
      .select({ supplierId: documentSuppliers.supplierId })
      .from(documentSuppliers)
      .where(eq(documentSuppliers.documentId, p.documentId))
      .limit(1);
    if (lien) { out = { status: 'skipped', reason: 'ALREADY_LINKED' }; return; }
    scope = doc.scope ?? null;

    const candidates = await findCandidates(p.accountId, normalizedName, siren, siret, null, q);
    const decision = assessMatch(candidates, observation);

    let supplierId: number;
    let conflicts: Array<{ field: string; currentValue: string | null; detectedValue: string | null }> = [];
    if (decision === 'certain') {
      supplierId = candidates[0].id;
      const [fiche] = await q.select({ source: suppliers.source }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
      // Fiche saisie par l'utilisateur : jamais complétée, seulement comparée.
      const r = await consolidateCoordinates(supplierId, observation, { q, fill: fiche?.source === 'document_extraction' });
      conflicts = r.conflicts;
    } else {
      const [cree] = await q.insert(suppliers).values({
        accountId: p.accountId,
        createdByUserId: p.userId,
        name: nom,
        normalizedName,
        siren,
        siret,
        source: 'document_extraction',
        contactStatus: 'unverified',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning({ id: suppliers.id });
      supplierId = cree.id;
      if (decision === 'uncertain') {
        await q.insert(supplierReviewItems).values({
          accountId: p.accountId,
          itemType: 'deduplication',
          status: 'open',
          supplierId,
          documentId: p.documentId,
          detectedName: nom,
          candidateSupplierIds: candidates.slice(0, 3).map((c) => c.id),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    await q.insert(documentSuppliers).values({
      documentId: p.documentId,
      supplierId,
      isConfirmed: decision === 'certain',
      confidenceScore: p.supplier?.confidence === 'certain' ? '1' : p.supplier?.confidence === 'probable' ? '0.7' : null,
    }).onConflictDoNothing();

    const [obs] = await q.insert(supplierContactObservations).values({
      supplierId,
      documentId: p.documentId,
      observedName: nom,
      observedSiren: siren,
      observedSiret: siret,
      createdAt: new Date(),
    }).returning({ id: supplierContactObservations.id });

    // Conflits : une revue ouverte par (fournisseur, champ, valeur relevée).
    for (const c of conflicts) {
      const [deja] = await q
        .select({ id: supplierReviewItems.id })
        .from(supplierReviewItems)
        .where(and(
          eq(supplierReviewItems.supplierId, supplierId),
          eq(supplierReviewItems.itemType, 'contact_conflict'),
          eq(supplierReviewItems.status, 'open'),
          eq(supplierReviewItems.conflictingField, c.field),
          eq(supplierReviewItems.detectedValue, c.detectedValue ?? ''),
        ))
        .limit(1);
      if (deja) continue;
      await q.insert(supplierReviewItems).values({
        accountId: p.accountId,
        itemType: 'contact_conflict',
        status: 'open',
        supplierId,
        documentId: p.documentId,
        observationId: obs.id,
        conflictingField: c.field,
        currentValue: c.currentValue,
        detectedValue: c.detectedValue,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    out = {
      status: decision === 'certain' ? 'linked' : decision === 'uncertain' ? 'created_uncertain' : 'created',
      supplierId,
      conflicts: conflicts.length,
    };
  });

  const res = out as SupplierFeedResult;
  if (res.status !== 'skipped') {
    // Hors transaction (exécutant global) : portée Duo, liens équipement, caches.
    if (scope) await propagateScopeIfNeeded(res.supplierId, scope);
    await recalculateEquipmentSuppliers(p.documentId);
    try {
      const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
      await emitBusinessEvent({ type: 'SUPPLIER_CHANGED', accountId: p.accountId, entityId: res.supplierId });
    } catch { /* non bloquant */ }
  }
  return res;
}

let enregistre = false;

/**
 * Abonnement à l'analyse T1 (étape 13, comme T3 et T4). À appeler une fois au
 * démarrage (`instrumentation-node.ts`). Idempotent.
 */
export async function registerSupplierReferentialHandler(): Promise<void> {
  if (enregistre) return;
  enregistre = true;
  const { onSourceAnalyzed } = await import('@/services/ai/source-analysis/events');
  onSourceAnalyzed('référentiel fournisseurs', async (e) => {
    const s = e.result.document.supplier;
    if (!s?.value?.name) return;
    // Groupe T1 (plusieurs fichiers analysés ensemble, ex. pages d'une même
    // facture) : chaque fichier est relié, le principal d'abord — les suivants
    // retrouvent la fiche qu'il a créée (rapprochement certain) ; mêmes règles
    // par fichier (fournisseur modifié ou lien retiré à la main : ignoré).
    const fichiers = [e.leadSourceId, ...(e.result.sourceGroup?.sourceIds ?? []).filter((id) => id !== e.leadSourceId)];
    for (const documentId of [...new Set(fichiers)]) {
      const r = await feedSupplierFromAnalysis({
        accountId: e.accountId,
        userId: e.userId,
        documentId,
        supplier: { name: s.value.name, siret: s.value.siret ?? null, confidence: s.confidence },
      });
      if (r.status !== 'skipped') {
        console.info(`[fournisseurs] document ${documentId} : ${r.status} (fournisseur ${r.supplierId}).`);
      }
    }
  });
}

/** Réservé aux tests. */
export function __resetSupplierHandlerForTests(): void {
  enregistre = false;
}
