/**
 * Surveillance de la complétude T1 (lot 34F, ticket T1 « Monitoring ») :
 *
 *   · journal T1 structuré, une ligne par document analysé :
 *     `[t1-completeness] {"documentId":…,"sourceUnitsCount":…,"factsCount":…,
 *     "coverageRatio":…,"unresolvedCount":…,"uncertainCount":…,
 *     "failedCount":…,"repairPassCount":…,"factsDroppedCount":…,
 *     "truncatedCount":…,"qualityState":…,"anomalies":[…]}` (aucune valeur
 *     métier) ;
 *   · anomalies FONCTIONNELLES (FACTS_TRUNCATED, PARTIAL_EXTRACTION,
 *     FACT_INVALID_DROPPED, SOURCE_UNIT_FAILED, COVERAGE_INCOMPLETE) :
 *     visibles dans BO › Exécutions IA (panneau « Complétude T1 »), et, pour
 *     un échec DÉFINITIF (INCOMPLETE_FINAL), dans BO › Supervision (domaine
 *     IA, une anomalie par document, résolue automatiquement à la prochaine
 *     analyse complète).
 */
import type { T1CompletenessReport, T1QualityState } from './types';

export const completenessFingerprint = (fileId: number) => `ai:t1-completeness:${fileId}`;

/** Ligne de journal (exportée pour les tests) — compteurs seulement. */
export function completenessLogLine(fileId: number, r: T1CompletenessReport): string {
  return `[t1-completeness] ${JSON.stringify({
    documentId: fileId,
    sourceUnitsCount: r.totalSourceUnits,
    factsCount: r.factsCount,
    coverageRatio: r.coverageRatio,
    unresolvedCount: r.unresolvedUnits,
    uncertainCount: r.uncertainUnits,
    failedCount: r.failedUnits,
    repairPassCount: r.repairPassCount,
    factsDroppedCount: r.droppedFactsCount,
    truncatedCount: r.truncatedSectionsCount,
    chunkCount: r.chunkCount,
    qualityState: r.qualityState,
    anomalies: r.anomalies,
  })}`;
}

export async function recordT1Completeness(p: {
  accountId: number; fileId: number; report: T1CompletenessReport; persisted: boolean;
}): Promise<void> {
  const r = p.report;
  const line = completenessLogLine(p.fileId, r);
  if (r.anomalies.length > 0) console.warn(line); else console.info(line);
  const { autoResolveAnomaly, reportAnomaly } = await import('@/services/admin/anomaly.service');
  if (r.qualityState === 'INCOMPLETE_FINAL') {
    await reportAnomaly({
      domain: 'ai',
      fingerprint: completenessFingerprint(p.fileId),
      title: `Analyse T1 incomplète (document ${p.fileId}) : ${r.anomalies.join(', ') || 'couverture incomplète'}`,
      accountId: p.accountId,
      detail: {
        fileId: p.fileId, qualityState: r.qualityState, anomalies: r.anomalies, coverageRatio: r.coverageRatio,
        failedUnits: r.failedUnits, truncatedSections: r.truncatedSectionsCount, droppedFacts: r.droppedFactsCount,
        persisted: p.persisted,
      },
    });
  } else if (r.qualityState === 'COMPLETE' || r.qualityState === 'COMPLETE_WITH_UNRESOLVED') {
    await autoResolveAnomaly(completenessFingerprint(p.fileId), { origin: 't1_completeness', cause: `analyse ${r.qualityState}` });
  }
}

// ── Lecture BO (Exécutions IA) ─────────────────────────────────────────────

export interface CompletenessDocumentRow {
  fileId: number;
  accountId: number;
  title: string | null;
  qualityState: T1QualityState;
  anomalies: string[];
  coverageRatio: number;
  totalUnits: number;
  unresolvedUnits: number;
  uncertainUnits: number;
  failedUnits: number;
  factsCount: number;
  droppedFactsCount: number;
  truncatedSectionsCount: number;
  repairPassCount: number;
  chunkCount: number;
  retryAttempts: number;
  origin: string;
  updatedAt: string;
}

export interface CompletenessOverview {
  days: number;
  /** Documents analysés sur la période, par état de qualité. */
  byQuality: Record<T1QualityState, number>;
  /** Documents par anomalie fonctionnelle. */
  byAnomaly: Record<string, number>;
  /** Moyennes de la période (null sans document). */
  averageCoverage: number | null;
  repairPasses: number;
  rows: CompletenessDocumentRow[];
  /** Couche A absente (migrations 0295-0297 non appliquées). */
  unavailable?: boolean;
}

export async function getT1CompletenessOverview(opts: { days?: number; limit?: number; anomaly?: string | null } = {}): Promise<CompletenessOverview> {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
  const empty: CompletenessOverview = {
    days, byQuality: { COMPLETE: 0, COMPLETE_WITH_UNRESOLVED: 0, INCOMPLETE_RETRYABLE: 0, INCOMPLETE_FINAL: 0 },
    byAnomaly: {}, averageCoverage: null, repairPasses: 0, rows: [],
  };
  const { sourceLayerReady } = await import('./repository');
  if (!(await sourceLayerReady())) return { ...empty, unavailable: true };
  const { pgClient } = await import('@/db');
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [agg, anomalies, rows] = await Promise.all([
    pgClient.unsafe(
      `SELECT quality_state AS q, COUNT(*)::int AS n, AVG(coverage_ratio)::float8 AS avg, SUM(repair_pass_count)::int AS repairs
         FROM document_extraction_coverage WHERE updated_at >= $1 GROUP BY quality_state`,
      [since] as never[],
    ) as unknown as Promise<Array<{ q: T1QualityState; n: number; avg: number; repairs: number }>>,
    pgClient.unsafe(
      `SELECT a AS code, COUNT(*)::int AS n FROM document_extraction_coverage, unnest(anomalies) a
        WHERE updated_at >= $1 GROUP BY a`,
      [since] as never[],
    ) as unknown as Promise<Array<{ code: string; n: number }>>,
    pgClient.unsafe(
      `SELECT c.file_id AS "fileId", c.account_id AS "accountId", coalesce(af.retained_title, af.original_filename) AS title,
              c.quality_state AS "qualityState", c.anomalies, c.coverage_ratio::float8 AS "coverageRatio",
              c.total_units AS "totalUnits", c.unresolved_units AS "unresolvedUnits", c.uncertain_units AS "uncertainUnits",
              c.failed_units AS "failedUnits", c.facts_count AS "factsCount", c.dropped_facts_count AS "droppedFactsCount",
              c.truncated_sections_count AS "truncatedSectionsCount", c.repair_pass_count AS "repairPassCount",
              c.chunk_count AS "chunkCount", c.retry_attempts AS "retryAttempts", c.origin, c.updated_at AS "updatedAt"
         FROM document_extraction_coverage c
         LEFT JOIN asset_files af ON af.id = c.file_id
        WHERE c.updated_at >= $1 AND cardinality(c.anomalies) > 0
          AND ($2::text IS NULL OR $2 = ANY(c.anomalies))
        ORDER BY (c.quality_state = 'INCOMPLETE_FINAL') DESC, (c.quality_state = 'INCOMPLETE_RETRYABLE') DESC, c.updated_at DESC
        LIMIT $3`,
      [since, opts.anomaly ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 200)] as never[],
    ) as unknown as Promise<CompletenessDocumentRow[]>,
  ]);
  const out = { ...empty, byQuality: { ...empty.byQuality } };
  let total = 0;
  let somme = 0;
  for (const r of agg) {
    out.byQuality[r.q] = Number(r.n);
    total += Number(r.n);
    somme += Number(r.avg ?? 0) * Number(r.n);
    out.repairPasses += Number(r.repairs ?? 0);
  }
  out.averageCoverage = total > 0 ? Math.round((somme / total) * 10_000) / 10_000 : null;
  for (const a of anomalies) out.byAnomaly[a.code] = Number(a.n);
  out.rows = rows.map((r) => ({ ...r, coverageRatio: Number(r.coverageRatio) }));
  return out;
}
