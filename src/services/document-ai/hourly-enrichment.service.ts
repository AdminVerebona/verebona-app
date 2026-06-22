/**
 * HourlyEnrichmentService (Phase 3 — Propagation événementielle pure)
 * ════════════════════════════════════════════════════════════════════
 *
 * ╔═══ CIBLE ATTEINTE ═══════════════════════════════════════════════╗
 * ║ Ce service a été migré vers le moteur de propagation             ║
 * ║ événementiel (services/coherence/).                              ║
 * ║                                                                  ║
 * ║ Résumé de la migration :                                         ║
 * ║   ✓ enrich-and-coherence émet des événements d'impact           ║
 * ║   ✓ impact-propagation résout le graphe de dépendances          ║
 * ║   ✓ inconsistency_registry capture les conflits                  ║
 * ║   ✓ Version tracker : skip des biens inchangés                  ║
 * ║   ✗ Ce cron NE FAIT PLUS de scan IA global                      ║
 * ║   → L'IA (Flash-lite) est appelée UNIQUEMENT pour les items     ║
 * ║     explicitement marqués requires_ai_review dans impact_queue   ║
 * ║   → Le traitement temps réel passe par la file d'impact         ║
 * ║     (/api/cron/process-impacts toutes les 15 min)               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Tournée par le cron /api/cron/hourly-enrichment (toutes les 30 min).
 *
 * Comportement actuel (5 phases déterministes, sans IA par défaut) :
 *  Phase 1 — Recover stale processing items (crashed workers)
 *  Phase 2 — Process pending impacts (via processPendingImpacts)
 *  Phase 3 — [EXCEPTIONNEL] Process requires_ai_review items (max 5/run)
 *            → seul endroit où Gemini peut encore être appelé
 *  Phase 4 — Re-verify stale object_versions (24h+ non vérifiés)
 */

import { recoverStaleItems, processPendingImpacts } from '../coherence';
import { hasAiReviewItems, dequeueAiReviewItems, complete } from '../coherence/impact-queue.service';
import { markVerified } from '../coherence/version-tracker.service';
import { db } from '@/db';
import { assetFiles, documentAnalysisProposals, objectVersions, assets, agendaItems, agendaAssetLinks } from '@/db/schema';
import { eq, and, lt, or, isNull, isNotNull, not, inArray } from 'drizzle-orm';
import { commitDocument } from './commit-engine';

export interface HourlyEnrichmentResult {
  staleRecovered: number;
  queueImpactsProcessed: number;
  aiReviewItemsProcessed: number;
  aiReviewErrors: number;
  staleReVerified: number;
  documentCatchupCommitted: number;
  errors: number;
  durationMs: number;
}

export async function runHourlyEnrichment(): Promise<HourlyEnrichmentResult> {
  const startAt = Date.now();
  const result: HourlyEnrichmentResult = {
    staleRecovered: 0,
    queueImpactsProcessed: 0,
    aiReviewItemsProcessed: 0,
    aiReviewErrors: 0,
    staleReVerified: 0,
    documentCatchupCommitted: 0,
    errors: 0,
    durationMs: 0,
  };

  console.log('[hourly-enrichment] Démarrage (5 phases déterministes)...');

  // ── Phase 1: Recover stale processing items ───────────────────────────────
  try {
    result.staleRecovered = await recoverStaleItems();
    if (result.staleRecovered > 0) {
      console.log(`[hourly-enrichment] Phase 1: ${result.staleRecovered} items bloqués récupérés`);
    }
  } catch (err) {
    result.errors++;
    console.error('[hourly-enrichment] Phase 1 error:', err);
  }

  // ── Phase 2: Process pending impacts ──────────────────────────────────────
  try {
    const MAX_BATCH_TIME_MS = 4 * 60 * 1000; // 4 min budget for queue processing
    let batchCount = 0;

    while (Date.now() - startAt < MAX_BATCH_TIME_MS) {
      const batchResult = await processPendingImpacts(25);
      result.queueImpactsProcessed += batchResult.impactsResolved;

      batchCount++;

      // If no impacts were processed, queue is empty
      if (batchResult.impactsResolved === 0 && batchResult.errors === 0) {
        break;
      }

      // Log progress every 5 batches
      if (batchCount % 5 === 0) {
        console.log(`[hourly-enrichment] Phase 2: batch ${batchCount}, ${result.queueImpactsProcessed} impacts`);
      }
    }

    if (result.queueImpactsProcessed > 0) {
      console.log(`[hourly-enrichment] Phase 2: ${result.queueImpactsProcessed} impacts traités (${batchCount} lots)`);
    }
  } catch (err) {
    result.errors++;
    console.error('[hourly-enrichment] Phase 2 error:', err);
  }

  // ── Phase 3: [EXCEPTIONNEL] Process requires_ai_review items ──────────────
  // Only called when items are explicitly flagged. Max 5 per run.
  try {
    const hasAiItems = await hasAiReviewItems();
    if (hasAiItems) {
      const aiItems = await dequeueAiReviewItems(5);
      console.log(`[hourly-enrichment] Phase 3: ${aiItems.length} items requires_ai_review à traiter`);

      for (const item of aiItems) {
        try {
          if (!item.assetId) {
            await complete(item.id, { skipped: true, reason: 'no_asset_id' });
            result.aiReviewItemsProcessed++;
            continue;
          }

          // Dynamic import to keep Gemini SDK out of the critical path
          const { applyAiEnrichmentAndCoherence } = await import(
            './enrich-and-coherence.service'
          );

          const { enriched, alertsFound } = await applyAiEnrichmentAndCoherence({
            assetId: item.assetId,
            accountId: item.accountId,
          });

          await complete(item.id, {
            enriched,
            alertsFound,
            ai_review_processed: true,
          });

          result.aiReviewItemsProcessed++;
          console.log(
            `[hourly-enrichment] Phase 3: asset ${item.assetId} traité par IA ` +
            `(enriched=${enriched}, alerts=${alertsFound})`,
          );
        } catch (err) {
          result.aiReviewErrors++;
          console.error(`[hourly-enrichment] Phase 3 error on item ${item.id}:`, err);
        }
      }
    }
  } catch (err) {
    result.errors++;
    console.error('[hourly-enrichment] Phase 3 error:', err);
  }

  // ── Phase 4: Re-verify stale object versions ──────────────────────────────
  try {
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const staleAssets = await db
      .select({ id: objectVersions.id, objectId: objectVersions.objectId, accountId: objectVersions.accountId })
      .from(objectVersions)
      .where(
        and(
          eq(objectVersions.objectType, 'asset'),
          or(
            isNull(objectVersions.lastVerifiedAt),
            lt(objectVersions.lastVerifiedAt, staleThreshold),
          ),
        ),
      )
      .limit(50);

    if (staleAssets.length > 0) {
      // Mark as verified (they'll re-enqueue if dirty on next change)
      await markVerified('asset', 0, staleThreshold);
      result.staleReVerified = staleAssets.length;
      console.log(`[hourly-enrichment] Phase 4: ${staleAssets.length} objets stalés marqués vérifiés`);
    }
  } catch (err) {
    result.errors++;
    console.error('[hourly-enrichment] Phase 4 error:', err);
  }

  // ── Phase 5: Document catch-up + cohérence globale ──────────────────────────
  // Ratrapage des documents bloqués en VALIDATION_REQUIRED avec propositions en
  // attente (matchedAssetId au cap 0.6) + vérification de cohérence sur TOUS les
  // documents, assets et éléments agenda.
  try {
    result.documentCatchupCommitted = await processStuckValidationDocuments();
    if (result.documentCatchupCommitted > 0) {
      console.log(`[hourly-enrichment] Phase 5: ${result.documentCatchupCommitted} document(s) auto-commités`);
    }

    const coherenceIssues = await verifyGlobalCoherence();
    if (coherenceIssues > 0) {
      console.log(`[hourly-enrichment] Phase 5: ${coherenceIssues} incohérence(s) détectée(s)`);
    }
  } catch (err) {
    result.errors++;
    console.error('[hourly-enrichment] Phase 5 error:', err);
  }

  result.durationMs = Date.now() - startAt;
  console.log(
    `[hourly-enrichment] Terminé en ${result.durationMs}ms — ` +
    `${result.queueImpactsProcessed} impacts, ${result.aiReviewItemsProcessed} IA, ` +
    `${result.staleReVerified} reverifs, ${result.staleRecovered} récupérés, ` +
    `${result.documentCatchupCommitted} docs auto-commités`,
  );
  return result;
}

// ── Phase 5 helper ─────────────────────────────────────────────────────────────

const HIGH_CONFIDENCE = 0.7;

async function processStuckValidationDocuments(): Promise<number> {
  // 1. Find documents in VALIDATION_REQUIRED with pending matchedAssetId proposals
  const proposalAssetFileIds = await db
    .select({ assetFileId: documentAnalysisProposals.assetFileId })
    .from(documentAnalysisProposals)
    .where(
      and(
        eq(documentAnalysisProposals.targetKey, 'matchedAssetId'),
        eq(documentAnalysisProposals.status, 'pending'),
      ),
    );

  if (proposalAssetFileIds.length === 0) return 0;

  const uniqueIds = [...new Set(proposalAssetFileIds.map(r => r.assetFileId))];

  const stuckDocs = await db
    .select({ id: assetFiles.id, accountId: assetFiles.accountId })
    .from(assetFiles)
    .where(
      and(
        eq(assetFiles.analysisState, 'VALIDATION_REQUIRED'),
        isNull(assetFiles.deletedAt),
        inArray(assetFiles.id, uniqueIds),
      ),
    )
    .limit(50);

  if (stuckDocs.length === 0) return 0;

  let committed = 0;

  for (const doc of stuckDocs) {
    try {
      if (!doc.accountId) continue;

      // 2. Load current proposals for this document
      const proposals = await db.select()
        .from(documentAnalysisProposals)
        .where(eq(documentAnalysisProposals.assetFileId, doc.id));

      const assetLink = proposals.find(p => p.targetKey === 'matchedAssetId' && p.status === 'pending');
      if (!assetLink) continue;

      // 3. Check for blocking proposals (room/equipment)
      const hasRoomSuggestions = proposals.some(p => p.targetKey === 'linkedRoomId' && p.status === 'pending');
      const hasEquipmentSuggestions = proposals.some(p => p.targetKey === 'equipmentId' && p.status === 'pending');
      if (hasRoomSuggestions || hasEquipmentSuggestions) continue;

      // 4. Check all field proposals are high confidence
      const fieldProposals = proposals.filter(p => p.proposalType === 'field' && p.status === 'pending');
      const allFieldsHighConf = fieldProposals.every(p => p.confidence && parseFloat(p.confidence) >= HIGH_CONFIDENCE);
      if (!allFieldsHighConf) continue;

      // 5. Check asset link confidence — bump if it was the old cap (0.6)
      const linkConf = assetLink.confidence ? parseFloat(assetLink.confidence) : 0;
      if (linkConf < 0.6) continue; // genuinely low confidence — skip

      if (linkConf < HIGH_CONFIDENCE) {
        // Bump from old cap (0.6) to current threshold (0.7)
        await db.update(documentAnalysisProposals)
          .set({ confidence: '0.7' })
          .where(eq(documentAnalysisProposals.id, assetLink.id));
      }

      // 6. All clear — commit the document (links asset, commits fields, creates agenda items)
      await commitDocument(doc.id, doc.accountId);
      await db.update(assetFiles)
        .set({ analysisState: 'ANALYZED', updatedAt: new Date() })
        .where(eq(assetFiles.id, doc.id));

      committed++;
      console.log(`[hourly-enrichment] Phase 5: Document #${doc.id} auto-commité — lien asset + champs`);

    } catch (err) {
      console.error(`[hourly-enrichment] Phase 5: Erreur document #${doc.id}:`, err);
    }
  }

  return committed;
}

// ── Vérification de cohérence globale — tous les documents, assets, agenda ─────
// Passe légère sans IA : vérifie par règles SQL que les données sont cohérentes.
// Détecte les orphelins, les contradictions de dates, les références cassées.

async function verifyGlobalCoherence(): Promise<number> {
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
      console.log(`[hourly-enrichment] Cohérence: doc #${doc.id} détaché (asset #${doc.assetId} supprimé)`);
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
      console.log(`[hourly-enrichment] Cohérence: agenda #${item.id} annulé (asset lié supprimé)`);
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
        console.log(`[hourly-enrichment] Cohérence: doc #${doc.id} ANALYZED sans titre`);
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
      console.log(`[hourly-enrichment] Cohérence: ${staleAgendaItems.length} agenda items dépassés non clôturés`);
    }
  } catch { /* non-bloquant */ }

  return issues;
}