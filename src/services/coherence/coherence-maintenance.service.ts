/**
 * Maintenance DÉTERMINISTE de la file de cohérence (impact_queue) —
 * reprise, au lot 16b-3, des phases sans IA de l'ancien
 * `document-ai/hourly-enrichment.service` (supprimé avec la route
 * `/api/cron/hourly-enrichment`, décision PO D-H1).
 *
 *   1. reprise des éléments bloqués en traitement (worker interrompu) ;
 *   2. traitement des impacts en attente (`processPendingImpacts`, budget
 *      de 4 min) ;
 *   3. biens non revérifiés depuis 24 h marqués vérifiés ;
 *   4. cohérence globale par règles SQL (documents rattachés à un bien
 *      supprimé, éléments d'agenda orphelins, comptages journalisés).
 *
 * RETIRÉ : la revue IA (`requires_ai_review`, `enrich-and-coherence`,
 * relais `legacy_enrich_coherence`) et le rattrapage des documents en
 * VALIDATION_REQUIRED par le moteur de commit historique (propositions
 * `matchedAssetId` que le master T1 n'écrit pas).
 *
 * Exécutée par la planification interne (`daily-maintenance-scheduler`,
 * tâche `coherence-maintenance`, environ toutes les heures) : plus aucune
 * ligne de cron externe à poser. Ne lève jamais (chaque phase est isolée).
 */
import { recoverStaleItems, processPendingImpacts } from './index';
import { markVerified } from './version-tracker.service';
import { db } from '@/db';
import { assetFiles, objectVersions, assets, agendaItems, agendaAssetLinks } from '@/db/schema';
import { eq, and, lt, or, isNull, isNotNull, not, inArray } from 'drizzle-orm';

export interface CoherenceMaintenanceResult {
  staleRecovered: number;
  queueImpactsProcessed: number;
  staleReVerified: number;
  coherenceIssues: number;
  errors: number;
  durationMs: number;
}

export async function runCoherenceMaintenance(): Promise<CoherenceMaintenanceResult> {
  const startAt = Date.now();
  const result: CoherenceMaintenanceResult = {
    staleRecovered: 0, queueImpactsProcessed: 0, staleReVerified: 0, coherenceIssues: 0, errors: 0, durationMs: 0,
  };

  // ── 1. Éléments bloqués en traitement ─────────────────────────────────────
  try {
    result.staleRecovered = await recoverStaleItems();
  } catch (err) {
    result.errors++;
    console.error('[coherence-maintenance] reprise des éléments bloqués :', err);
  }

  // ── 2. Impacts en attente ─────────────────────────────────────────────────
  try {
    const MAX_BATCH_TIME_MS = 4 * 60 * 1000;
    while (Date.now() - startAt < MAX_BATCH_TIME_MS) {
      const batch = await processPendingImpacts(25);
      result.queueImpactsProcessed += batch.impactsResolved;
      if (batch.impactsResolved === 0 && batch.errors === 0) break;
    }
  } catch (err) {
    result.errors++;
    console.error('[coherence-maintenance] impacts en attente :', err);
  }

  // ── 3. Biens non revérifiés depuis 24 h ───────────────────────────────────
  try {
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const staleAssets = await db
      .select({ id: objectVersions.id })
      .from(objectVersions)
      .where(and(
        eq(objectVersions.objectType, 'asset'),
        or(isNull(objectVersions.lastVerifiedAt), lt(objectVersions.lastVerifiedAt, staleThreshold)),
      ))
      .limit(50);
    if (staleAssets.length > 0) {
      // Marqués vérifiés : ils seront remis en file à leur prochaine modification.
      await markVerified('asset', 0, staleThreshold);
      result.staleReVerified = staleAssets.length;
    }
  } catch (err) {
    result.errors++;
    console.error('[coherence-maintenance] revérification des biens :', err);
  }

  // ── 4. Cohérence globale (règles SQL) ─────────────────────────────────────
  try {
    result.coherenceIssues = await verifyGlobalCoherence();
  } catch (err) {
    result.errors++;
    console.error('[coherence-maintenance] cohérence globale :', err);
  }

  result.durationMs = Date.now() - startAt;
  return result;
}

// ── Vérification de cohérence globale — tous les documents, assets, agenda ─────
// Passe légère sans IA : vérifie par règles SQL que les données sont cohérentes.
// Détecte les orphelins, les contradictions de dates, les références cassées.

export async function verifyGlobalCoherence(): Promise<number> {
  const now = new Date().toISOString().slice(0, 10);
  let issues = 0;

  // 1. Documents liés à un asset supprimé
  try {
    const orphanDocs = await db
      .select({ id: assetFiles.id, assetId: assetFiles.assetId })
      .from(assetFiles)
      .where(
        and(
          isNotNull(assetFiles.assetId),
          isNull(assetFiles.deletedAt),
          not(
            inArray(assetFiles.assetId as any,
              db.select({ id: assets.id }).from(assets).where(isNull(assets.deletedAt)) as any
            )
          ),
        ),
      )
      .limit(50);

    for (const doc of orphanDocs) {
      await db.update(assetFiles)
        .set({ assetId: null, updatedAt: new Date() })
        .where(eq(assetFiles.id, doc.id));
      issues++;
      console.log(`[coherence-maintenance] Cohérence: doc #${doc.id} détaché (asset #${doc.assetId} supprimé)`);
    }
  } catch { /* non-bloquant */ }

  // 2. Agenda items orphelins (liés à un asset supprimé dans agendaAssetLinks)
  try {
    const orphanAgendaItems = await db
      .select({ id: agendaItems.id })
      .from(agendaItems)
      .where(
        and(
          eq(agendaItems.originType, 'asset_field'),
          isNull(agendaItems.manualStatus),
          not(
            inArray(agendaItems.id as any,
              db.select({ agendaItemId: agendaAssetLinks.agendaItemId })
                .from(agendaAssetLinks)
                .innerJoin(assets, eq(agendaAssetLinks.assetId, assets.id))
                .where(isNull(assets.deletedAt)) as any
            )
          ),
        ),
      )
      .limit(50);

    for (const item of orphanAgendaItems) {
      await db.update(agendaItems)
        .set({ manualStatus: 'annule', updatedAt: new Date() })
        .where(eq(agendaItems.id, item.id));
      issues++;
      console.log(`[coherence-maintenance] Cohérence: agenda #${item.id} annulé (asset lié supprimé)`);
    }
  } catch { /* non-bloquant */ }

  // 3. Documents ANALYZED sans titre retenu
  try {
    const noTitleDocs = await db
      .select({ id: assetFiles.id })
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.analysisState, 'ANALYZED'),
          isNull(assetFiles.retainedTitle),
          isNull(assetFiles.deletedAt),
        ),
      )
      .limit(50);
    issues += noTitleDocs.length;
    if (noTitleDocs.length > 0) {
      for (const doc of noTitleDocs) {
        console.log(`[coherence-maintenance] Cohérence: doc #${doc.id} ANALYZED sans titre`);
      }
    }
  } catch { /* non-bloquant */ }

  // 4. Agenda items passés (date dépassée) non marqués réalisés/annulés
  try {
    const staleAgendaItems = await db
      .select({ id: agendaItems.id })
      .from(agendaItems)
      .where(
        and(
          isNull(agendaItems.manualStatus),
          isNotNull(agendaItems.startDate),
          lt(agendaItems.startDate, now),
        ),
      )
      .limit(50);
    if (staleAgendaItems.length > 0) {
      issues += staleAgendaItems.length;
      console.log(`[coherence-maintenance] Cohérence: ${staleAgendaItems.length} agenda items dépassés non clôturés`);
    }
  } catch { /* non-bloquant */ }

  return issues;
}
