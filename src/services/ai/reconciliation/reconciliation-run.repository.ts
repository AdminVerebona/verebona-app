/**
 * Journal des exécutions — CDC §6.1, entités 7 et 8.
 *
 * Chaque exécution et chaque décision sont conservées. C'est ce qui permet, au
 * lot 3, de comparer le mode observation au comportement actuel, et plus tard
 * d'expliquer à un utilisateur pourquoi une valeur a changé.
 */
import { pgClient } from '@/db';
import type { ReconciliationDecision, ReconciliationRun } from './types';

export interface OpenRunInput {
  accountId: number;
  assetId: number;
  triggeredBy: string;
  shadow: boolean;
  traceId: string;
}

export async function openRun(input: OpenRunInput): Promise<number> {
  const rows = await pgClient.unsafe(
    `INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, shadow, trace_id, status)
     VALUES ($1,$2,$3,$4,$5,'running') RETURNING id`,
    [input.accountId, input.assetId, input.triggeredBy, input.shadow, input.traceId] as never[],
  );
  return (rows as unknown as Array<{ id: number }>)[0].id;
}

export async function recordDecisions(
  runId: number,
  accountId: number,
  assetId: number,
  decisions: ReconciliationDecision[],
): Promise<void> {
  if (decisions.length === 0) return;

  const values = decisions.map((d, i) => {
    const o = i * 10;
    return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9}::jsonb,$${o + 10})`;
  }).join(',');

  const params = decisions.flatMap((d) => [
    runId, accountId, assetId, d.fieldKey, d.action, d.reasonCode,
    d.confidence, d.deterministic, JSON.stringify(d.evidenceIds), d.sourcePriority ?? null,
  ]);

  await pgClient.unsafe(
    `INSERT INTO reconciliation_decisions (
       run_id, account_id, asset_id, field_key, action, reason_code,
       confidence, deterministic, evidence_ids, source_priority
     ) VALUES ${values}`,
    params as never[],
  );
}

export async function closeRun(runId: number, summary: ReconciliationRun): Promise<void> {
  await pgClient.unsafe(
    `UPDATE reconciliation_runs
        SET status = 'completed', finished_at = NOW(),
            decisions_count = $2, applied_count = $3,
            conflict_count = $4, ai_review_count = $5
      WHERE id = $1`,
    [runId, summary.decisions.length, summary.appliedCount,
     summary.conflictCount, summary.aiReviewCount] as never[],
  );
}
