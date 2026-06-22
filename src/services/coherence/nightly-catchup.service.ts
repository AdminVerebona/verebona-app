/**
 * NightlyCatchupService
 * ──────────────────────
 * Lightweight nightly catch-up mechanism that replaces the heavy AI batch.
 *
 * This service:
 *   1. Processes all pending and failed impact queue items (retry mechanism)
 *   2. Recover stale "processing" items that may have crashed
 *   3. Verifies technical inconsistencies via SQL/backend rules (no AI calls)
 *   4. Re-checks only objects marked as modified or not recently verified
 *   5. Never launches full AI analysis on the entire account
 *
 * Runs via the existing /api/cron/hourly-enrichment endpoint (renamed to
 * /api/cron/nightly-catchup) or a new dedicated cron endpoint.
 */

import { db } from '@/db';
import { assets, assetFiles, objectVersions } from '@/db/schema';
import { eq, and, isNull, not, lt, sql, or } from 'drizzle-orm';
import { processPendingImpacts } from './impact-propagation.service';
import { recoverStaleItems, dequeue, enqueue } from './impact-queue.service';
import { markVerified } from './version-tracker.service';
import type { PropagationResult } from './impact-propagation.service';

export interface NightlyCatchupResult {
  impactsProcessed: number;
  staleRecovered: number;
  technicalInconsistencies: TechnicalInconsistency[];
  inconsistenciesFixed: number;
  reVerifiedAssets: number;
  errors: number;
  durationMs: number;
  propagationResult: PropagationResult | null;
}

interface TechnicalInconsistency {
  assetId: number;
  accountId: number;
  field: string;
  issue: string;
  severity: 'warning' | 'error';
}

// ─── Technical rules (pure SQL / backend - no AI calls) ─────────────────────

const TECHNICAL_RULES: Array<{
  name: string;
  check: () => Promise<TechnicalInconsistency[]>;
}> = [
  {
    name: 'missing_category',
    check: async () => {
      const rows = await db
        .select({ id: assets.id, accountId: assets.accountId })
        .from(assets)
        .where(
          and(
            isNull(assets.deletedAt),
            or(isNull(assets.category), eq(assets.category, '')),
          ),
        )
        .limit(100);

      return rows
        .filter((r): r is typeof r & { accountId: number } => r.accountId !== null)
        .map(r => ({
        assetId: r.id,
        accountId: r.accountId,
        field: 'category',
        issue: 'Catégorie manquante',
        severity: 'warning' as const,
      }));
    },
  },
  {
    name: 'orphan_documents',
    check: async () => {
      const rows = await db
        .select({
          id: assetFiles.id,
          accountId: assetFiles.accountId,
          assetId: assetFiles.assetId,
        })
        .from(assetFiles)
        .where(
          and(
            isNull(assetFiles.assetId),
            isNull(assetFiles.deletedAt),
            not(isNull(assetFiles.analysisState)),
          ),
        )
        .limit(100);

      return rows
        .filter((r): r is typeof r & { accountId: number } => r.accountId !== null)
        .map(r => ({
        assetId: r.assetId ?? 0,
        accountId: r.accountId,
        field: 'asset_id',
        issue: 'Document analysé sans rattachement à un bien',
        severity: 'warning' as const,
      }));
    },
  },
  {
    name: 'estimated_value_without_date',
    check: async () => {
      const rows = await db
        .select({ id: assets.id, accountId: assets.accountId })
        .from(assets)
        .where(
          and(
            isNull(assets.deletedAt),
            not(isNull(assets.estimatedValueCents)),
            isNull(assets.updatedAt), // no updatedAt → no valuationDate in kc
          ),
        )
        .limit(100);

      return rows
        .filter((r): r is typeof r & { accountId: number } => r.accountId !== null)
        .map(r => ({
        assetId: r.id,
        accountId: r.accountId,
        field: 'estimatedValueDate',
        issue: 'Estimation sans date de valorisation',
        severity: 'warning' as const,
      }));
    },
  },
  {
    name: 'missing_dpe_immobilier',
    check: async () => {
      // Assets of category IMMOBILIER without DPE class
      // This is a lightweight check - doesn't need AI
      const rows = await db
        .select({ id: assets.id, accountId: assets.accountId })
        .from(assets)
        .where(
          and(
            eq(assets.category, 'IMMOBILIER'),
            isNull(assets.deletedAt),
          ),
        )
        .limit(100);

      const withDpe: TechnicalInconsistency[] = [];
      for (const asset of rows.filter((a): a is typeof a & { accountId: number } => a.accountId !== null)) {
        const [assetRow] = await db
          .select({ kc: assets.keyCharacteristics })
          .from(assets)
          .where(eq(assets.id, asset.id))
          .limit(1);

        if (!assetRow?.kc) continue;
        try {
          const kc = JSON.parse(assetRow.kc);
          if (!kc.dpeClass || kc.dpeClass === '') {
            withDpe.push({
              assetId: asset.id,
              accountId: asset.accountId,
              field: 'dpeClass',
              issue: 'DPE non renseigné pour un bien immobilier',
              severity: 'warning',
            });
          }
        } catch {}
      }

      return withDpe;
    },
  },
  {
    name: 'inconsistency_empty_resolved',
    check: async () => {
      // Auto-resolve inconsistencies where the current value is now empty
      // and the resolution was accepted
      // This is handled by the inconsistency service directly
      return [];
    },
  },
];

// ─── Main catchup function ──────────────────────────────────────────────────

export async function runNightlyCatchup(): Promise<NightlyCatchupResult> {
  const startAt = Date.now();
  const result: NightlyCatchupResult = {
    impactsProcessed: 0,
    staleRecovered: 0,
    technicalInconsistencies: [],
    inconsistenciesFixed: 0,
    reVerifiedAssets: 0,
    errors: 0,
    durationMs: 0,
    propagationResult: null,
  };

  console.log('[nightly-catchup] Starting nightly catch-up...');

  // ── Phase 1: Recover stale processing items ───────────────────────────────
  try {
    result.staleRecovered = await recoverStaleItems();
    if (result.staleRecovered > 0) {
      console.log(`[nightly-catchup] Recovered ${result.staleRecovered} stale items`);
    }
  } catch (err) {
    result.errors++;
    console.error('[nightly-catchup] Error recovering stale items:', err);
  }

  // ── Phase 2: Process pending impacts ──────────────────────────────────────
  // Process in batches until the queue is mostly empty, respecting time budget
  const MAX_PROCESSING_TIME_MS = 8 * 60 * 1000; // 8 minutes max (Vercel limit is 15)
  let batchCount = 0;

  while (Date.now() - startAt < MAX_PROCESSING_TIME_MS) {
    try {
      const batchResult = await processPendingImpacts(25);
      result.impactsProcessed += batchResult.impactsResolved;

      if (!result.propagationResult) {
        result.propagationResult = batchResult;
      } else {
        aggregatePropagationResults(result.propagationResult, batchResult);
      }

      batchCount++;

      // If no impacts were processed, queue is empty
      if (batchResult.impactsResolved === 0 && batchResult.errors === 0) {
        break;
      }

      // Log progress every 5 batches
      if (batchCount % 5 === 0) {
        console.log(`[nightly-catchup] Batch ${batchCount}: ${result.impactsProcessed} impacts processed`);
      }
    } catch (err) {
      result.errors++;
      console.error('[nightly-catchup] Error in batch processing:', err);
      break;
    }
  }

  console.log(`[nightly-catchup] Processed ${result.impactsProcessed} impacts in ${batchCount} batches`);

  // ── Phase 3: Verify technical inconsistencies ─────────────────────────────
  try {
    for (const rule of TECHNICAL_RULES) {
      try {
        const issues = await rule.check();
        result.technicalInconsistencies.push(...issues);

        // For now, just report — auto-fix would be added later
        if (issues.length > 0) {
          console.log(`[nightly-catchup] Rule "${rule.name}": ${issues.length} issue(s) found`);
        }
      } catch (err) {
        result.errors++;
        console.error(`[nightly-catchup] Error checking rule "${rule.name}":`, err);
      }
    }
  } catch (err) {
    result.errors++;
    console.error('[nightly-catchup] Error in technical verification:', err);
  }

  // ── Phase 4: Re-verify stale objects ──────────────────────────────────────
  // Find objects not verified in the last 24h and re-check them
  try {
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Get stale asset version entries
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
      console.log(`[nightly-catchup] Re-verifying ${staleAssets.length} stale objects`);

      for (const stale of staleAssets) {
        try {
          // Enqueue a catch-up impact for each stale asset
          await enqueueSimpleCatchup(stale.accountId, stale.objectId);
          result.reVerifiedAssets++;
        } catch (err) {
          result.errors++;
          console.error(`[nightly-catchup] Error re-verifying asset ${stale.objectId}:`, err);
        }
      }

      // Mark them as verified after enqueuing
      await markVerified('asset', 0, staleThreshold);
    }
  } catch (err) {
    result.errors++;
    console.error('[nightly-catchup] Error re-verifying stale objects:', err);
  }

  result.durationMs = Date.now() - startAt;
  console.log(`[nightly-catchup] Completed in ${result.durationMs}ms — ${result.impactsProcessed} impacts, ${result.technicalInconsistencies.length} issues, ${result.reVerifiedAssets} re-verified`);
  return result;
}

async function enqueueSimpleCatchup(accountId: number, assetId: number): Promise<void> {
  await enqueue({
    accountId,
    assetId,
    triggerType: 'batch_catchup',
    source: 'nightly_catchup',
    priority: -5, // Lowest priority — pure catch-up
    metadata: { catchupType: 'stale_object_verification' },
  });
}

function aggregatePropagationResults(target: PropagationResult, source: PropagationResult): void {
  target.impactsResolved += source.impactsResolved;
  target.fieldsApplied += source.fieldsApplied;
  target.fieldsProposed += source.fieldsProposed;
  target.fieldsConflicted += source.fieldsConflicted;
  target.agendaItemsCreated += source.agendaItemsCreated;
  target.searchUpdatesTriggered += source.searchUpdatesTriggered;
  target.errors += source.errors;
}
