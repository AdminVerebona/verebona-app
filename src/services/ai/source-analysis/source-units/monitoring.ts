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
import { COVERAGE_ISSUES, coverageIssueOf, splitHistoricalAndCurrent, type AnalysisReportRef, type CoverageCurrentFace, type CoverageHistoricalFace, type CoverageIssue, type CoverageIssueInput, type CoverageIssueView } from './coverage-issue';

/** Empreinte de l'anomalie de Supervision « analyse T1 incomplète » d'un document. */
export const completenessFingerprint = (fileId: number) => `ai:t1-completeness:${fileId}`;
/** Préfixes des alertes de Supervision T1 de couverture (réévaluation du stock, lot 114H). */
export const T1_COVERAGE_ALERT_PREFIXES = ['ai:t1-completeness:', 'ai:t1-normalisation-loss:'] as const;

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
    // Lot 49B : couverture réelle, réparations, pertes de normalisation (compteurs seulement).
    ...(r.diagnostics ? {
      sourceVerification: r.diagnostics.sourceVerification,
      pagesExpected: r.diagnostics.pagesExpected,
      pagesVerified: r.diagnostics.pagesVerified,
      pagesMissing: r.diagnostics.pagesMissing.length,
      pagesUnverified: r.diagnostics.pagesUnverified.length,
      pendingRepairs: r.diagnostics.pendingRepairUnits,
      exhaustedRepairs: r.diagnostics.exhaustedRepairUnits,
      truncations: r.diagnostics.truncations,
      originalsPreserved: r.diagnostics.originalsPreserved,
      normalisationLosses: r.diagnostics.normalisationLosses,
      // Lot 54G : pages citées non vérifiées, relectures du fichier, champs retirés, tableaux.
      pagesCitedUnverified: r.diagnostics.pagesCitedUnverified?.length ?? 0,
      needsSourceUnits: r.diagnostics.needsSourceUnits,
      sourceRereads: r.diagnostics.sourceRereads ?? 0,
      sourceRereadsFailed: r.diagnostics.sourceRereadsFailed ?? 0,
      prunedFields: r.diagnostics.prunedFields ?? 0,
      prunedOriginalsPreserved: r.diagnostics.prunedOriginalsPreserved ?? 0,
      tablesUncertain: r.diagnostics.tablesUncertain ?? 0,
      tablesResolved: r.diagnostics.tablesResolved ?? 0,
    } : {}),
  })}`;
}

/** Empreinte de l'anomalie de Supervision « perte de normalisation non compensée » d'un document. */
export const normalisationLossFingerprint = (fileId: number) => `ai:t1-normalisation-loss:${fileId}`;

/**
 * Signale en Supervision une analyse T1 DÉFINITIVEMENT incomplète (lacune réelle sans reprise admissible).
 * Façade partagée (lot 114H, #775) : écriture d'une analyse ou d'une reprise, et réévaluation du stock.
 */
export async function reportT1IncompleteFinal(p: {
  accountId: number; fileId: number; persisted: boolean;
  report: Pick<T1CompletenessReport, 'qualityState' | 'anomalies' | 'coverageRatio' | 'failedUnits' | 'truncatedSectionsCount' | 'droppedFactsCount'>;
}): Promise<number | null> {
  const { reportAnomaly } = await import('@/services/admin/anomaly.service');
  const r = p.report;
  return reportAnomaly({
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
}

export async function recordT1Completeness(p: {
  accountId: number; fileId: number; report: T1CompletenessReport; persisted: boolean;
}): Promise<void> {
  const r = p.report;
  const line = completenessLogLine(p.fileId, r);
  if (r.anomalies.length > 0) console.warn(line); else console.info(line);
  const { autoResolveAnomaly, reportAnomaly } = await import('@/services/admin/anomaly.service');
  if (r.qualityState === 'INCOMPLETE_FINAL') {
    await reportT1IncompleteFinal({ accountId: p.accountId, fileId: p.fileId, report: r, persisted: p.persisted });
  } else if (r.qualityState === 'COMPLETE' || r.qualityState === 'COMPLETE_WITH_UNRESOLVED' || r.qualityState === 'VERIFICATION_INCOMPLETE') {
    // D19 : une vérification incomplète n'est pas un échec définitif (pas de
    // Supervision) — elle reste visible dans BO › Complétude T1 avec sa reprise.
    await autoResolveAnomaly(completenessFingerprint(p.fileId), { origin: 't1_completeness', cause: `analyse ${r.qualityState}` });
  }
  // Lot 49B (DEV-03) : perte de normalisation NON compensée (valeur non conservée) — Supervision.
  const pertes = r.diagnostics?.normalisationLosses ?? 0;
  if (pertes > 0) {
    await reportAnomaly({
      domain: 'ai',
      fingerprint: normalisationLossFingerprint(p.fileId),
      title: `Analyse T1 : ${pertes} valeur(s) réduite(s) ou retirée(s) sans original conservé (document ${p.fileId})`,
      accountId: p.accountId,
      detail: { fileId: p.fileId, losses: pertes, truncations: r.diagnostics?.truncations ?? 0, originalsPreserved: r.diagnostics?.originalsPreserved ?? 0 },
    });
  } else if (r.diagnostics) {
    await autoResolveAnomaly(normalisationLossFingerprint(p.fileId), { origin: 't1_completeness', cause: 'aucune perte de normalisation' });
  }
}

// ── Lecture BO (Exécutions IA) ─────────────────────────────────────────────

interface CompletenessDocumentRow {
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
  /** Lot 49B : vérification de la source, diagnostics (compteurs, numéros de page), dernière reprise. */
  sourceVerification: string | null;
  verification: Record<string, unknown> | null;
  lastRetryAt: string | null;
  lastRetryResult: string | null;
  /** Lot 53 (D19) : reprise automatique programmée (null : aucune). */
  nextRetryAt?: string | null;
  /** Lot 114H (#775, § 6) : issue ACTUELLE (recalculée à la lecture), motif vérifiable et prochaine action réelle. */
  issue?: CoverageIssueView;
  /** Carte #837 (D4) : état consigné par le rapport d'exécution d'origine (immuable), distinct de l'état actuel. */
  historical?: CoverageHistoricalFace;
  current?: CoverageCurrentFace;
}

interface CompletenessOverview {
  days: number;
  /** Documents analysés sur la période, par état de qualité. */
  byQuality: Record<T1QualityState, number>;
  /** Documents par anomalie fonctionnelle. */
  byAnomaly: Record<string, number>;
  /** Moyennes de la période (null sans document). */
  averageCoverage: number | null;
  repairPasses: number;
  /** Lot 49B : documents par vérification de la source (null : antérieurs au lot 49B). */
  bySourceVerification: Record<string, number>;
  rows: CompletenessDocumentRow[];
  /** Lot 53 (D19) : reprises automatiques au plus par document (suivi d'une vérification incomplète). */
  maxRetries?: number;
  /** Lot 54G (§6) : diagnostics T1 agrégés sur la période (compteurs, jamais de contenu). */
  totals?: T1DiagnosticsTotals;
  /** Couche A absente (migrations 0295-0297 non appliquées). */
  unavailable?: boolean;
  /**
   * Lot 114H (#775, § 6) : documents de la période par issue ACTUELLE (`coverage-issue.ts`) — résolue, réparation
   * programmée, anomalie technique, plafond atteint, limite de vérification (sans action), non résolue actionnable.
   *
   * ══════════════════════════════════════════════════════════════════════
   * LOT 115H (Trello #785, § 6) — PLUS DE PLAFOND DE 5 000 SUR LES TOTAUX
   *
   * Règle remplacée : les compteurs par issue portaient sur les 5 000
   * documents les plus RÉCENTS de la période, et une troncature était
   * signalée. Au-delà, les totaux du BO étaient faux : un administrateur
   * lisait « 12 anomalies techniques » sur un stock qui en comptait
   * davantage, sans moyen de connaître le vrai nombre.
   *
   * Le balayage est maintenant EXHAUSTIF sur la période : il est paginé par
   * clé (`updated_at`, `file_id`) et lit toute la période, par pages de
   * `ISSUE_SCAN_PAGE`. `byIssueScanned` dit combien de documents ont été
   * classés — et `byIssueTruncated` reste faux.
   * ══════════════════════════════════════════════════════════════════════
   */
  byIssue?: Record<CoverageIssue, number>;
  /** Documents réellement classés par issue. */
  byIssueScanned?: number;
  /**
   * Carte #837 (D3) : `true` dès que le classement n'est PAS exhaustif (échéance,
   * erreur SQL, écart avec le total de la période). Jamais `false` après une
   * lecture tronquée.
   */
  byIssueTruncated?: boolean;
  /** Carte #837 (D3) : statut du classement — `INCOMPLETE` porte sa cause et sa progression. */
  byIssueStatus?: 'COMPLETE' | 'INCOMPLETE';
  byIssueIncomplete?: IssueScanIncomplete | null;
  /** Documents de la période (agrégat SQL, même instantané que le classement). */
  byIssueExpected?: number | null;
}

/** Carte #837 (D3) : pourquoi et où le classement s'est arrêté (reprise possible au curseur). */
export interface IssueScanIncomplete {
  cause: 'TIME_BUDGET' | 'SQL_ERROR' | 'COUNT_MISMATCH';
  scanned: number;
  expected: number | null;
  /** Curseur de reprise (`updatedAt`, `fileId`) du dernier document classé. */
  cursor: { updatedAt: string; fileId: number } | null;
  error?: string;
}

/**
 * Taille d'une PAGE de lecture des issues (technique, pas une borne de total) :
 * la période est parcourue en entier, page par page.
 */
const ISSUE_SCAN_PAGE = 2_000;
/**
 * Carte #837 (D3) : budget de TEMPS du classement (pas un plafond de documents).
 * Dépassé : le rapport est déclaré INCOMPLETE avec sa progression — jamais un
 * total présenté comme exhaustif.
 */
const ISSUE_SCAN_BUDGET_MS = 25_000;

/** Lot 54G (§6) — totaux des diagnostics de couverture réelle sur la période. */
interface T1DiagnosticsTotals {
  documents: number;
  pagesExpected: number; pagesVerified: number; pagesMissing: number; pagesUnverified: number; pagesReread: number;
  pagesCitedUnverified: number;
  needsSourceUnits: number; sourceRereads: number; sourceRereadsFailed: number; sourceRereadResolved: number; needsSourceExhausted: number;
  pendingRepairUnits: number; exhaustedRepairUnits: number;
  prunedFields: number; prunedOriginalsPreserved: number; normalisationLosses: number;
  tablesUncertain: number; tablesResolved: number;
}

/** Clés numériques (compteurs) et listes (pages) du JSONB `verification` agrégées (lot 54G). */
const TOTAL_COUNTERS: ReadonlyArray<keyof T1DiagnosticsTotals> = [
  'pagesExpected', 'pagesVerified', 'needsSourceUnits', 'sourceRereads', 'sourceRereadsFailed', 'sourceRereadResolved', 'needsSourceExhausted',
  'pendingRepairUnits', 'exhaustedRepairUnits', 'prunedFields', 'prunedOriginalsPreserved', 'normalisationLosses', 'tablesUncertain', 'tablesResolved',
];
const TOTAL_LISTS: ReadonlyArray<[keyof T1DiagnosticsTotals, string]> = [
  ['pagesMissing', 'pagesMissing'], ['pagesUnverified', 'pagesUnverified'], ['pagesReread', 'pagesReread'], ['pagesCitedUnverified', 'pagesCitedUnverified'],
];

/** Requête des totaux (exportée pour les tests) : clés fixes, aucune donnée utilisateur interpolée. */
function diagnosticsTotalsSql(): string {
  const n = (k: string) => `coalesce(SUM(CASE WHEN jsonb_typeof(verification -> '${k}') = 'number' THEN (verification ->> '${k}')::float8 END), 0)::float8 AS "${k}"`;
  const l = (k: string, col: string) => `coalesce(SUM(CASE WHEN jsonb_typeof(verification -> '${col}') = 'array' THEN jsonb_array_length(verification -> '${col}') END), 0)::float8 AS "${k}"`;
  // `to_jsonb(c)` : colonne 0329 lue sans erreur si absente (même tolérance que les lignes).
  return `SELECT COUNT(*)::float8 AS documents, ${[...TOTAL_COUNTERS.map(n), ...TOTAL_LISTS.map(([k, c]) => l(k, c))].join(', ')}
            FROM (SELECT to_jsonb(c) -> 'verification' AS verification FROM document_extraction_coverage c WHERE c.updated_at >= $1) x
           WHERE jsonb_typeof(verification) = 'object'`;
}

/**
 * Lot 115H (#785, § 6), complété par la carte #837 (D3) — CLASSEMENT PAR ISSUE
 * de TOUS les documents de la période.
 *
 * Règle remplacée : les lignes étaient toutes MATÉRIALISÉES en mémoire, la
 * boucle s'arrêtait en silence à 5 000 pages, et une erreur SQL rendait une
 * liste PARTIELLE tandis que le rapport annonçait `byIssueTruncated = false`.
 *
 * Désormais :
 *   · une seule transaction en lecture seule, isolation REPEATABLE READ : le
 *     total (agrégat SQL) et les pages sont lus sur le MÊME instantané — ni
 *     document sauté ni compté deux fois même si la couverture change pendant
 *     la lecture ;
 *   · pagination par CLÉ (`updated_at`, `file_id`), agrégation page par page
 *     (aucune liste en mémoire), aucun plafond de pages ;
 *   · échéance de temps, erreur SQL au milieu, ou nombre classé ≠ total :
 *     `INCOMPLETE` avec la cause, la progression et le curseur de reprise.
 * Ne lève jamais.
 */
async function lireRapportsOrigine(docs: ReadonlyArray<{ fileId: number; accountId: number }>): Promise<Map<number, AnalysisReportRef>> {
  const out = new Map<number, AnalysisReportRef>();
  if (docs.length === 0) return out;
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT DISTINCT ON (r.file_id) r.file_id, r.id, r.created_at, cov.value AS cov_value, cov.links AS cov_links
         FROM ai_execution_reports r
         JOIN jsonb_to_recordset($1::jsonb) AS d(file_id int, account_id int) ON d.file_id = r.file_id AND d.account_id = r.account_id
         LEFT JOIN LATERAL (
           SELECT e.value, e.links FROM ai_execution_report_entries e
            WHERE e.report_id = COALESCE(r.entries_report_id, r.id) AND e.section = 'COVERAGE' LIMIT 1
         ) cov ON TRUE
        WHERE r.treatment = 'T1'
        ORDER BY r.file_id, r.created_at DESC, r.id DESC`,
      [JSON.stringify(docs.map((d) => ({ file_id: d.fileId, account_id: d.accountId })))] as never[],
    )) as unknown as Array<Record<string, unknown>>;
    for (const r of rows) {
      const brut = r.cov_value;
      const valeur = typeof brut === 'string' && brut.startsWith('"') ? JSON.parse(brut) as unknown : brut;
      const liens = (typeof r.cov_links === 'string' ? JSON.parse(r.cov_links) : r.cov_links) as { anomalies?: unknown[] } | null;
      out.set(Number(r.file_id), {
        reportId: Number(r.id), createdAt: r.created_at as string | Date | null,
        qualityState: typeof valeur === 'string' ? valeur : null,
        anomalies: Array.isArray(liens?.anomalies) ? liens!.anomalies.map(String) : null,
      });
    }
  } catch (e) {
    console.warn('[t1-completeness] rapports d’exécution d’origine illisibles (face historique indisponible) :', (e as Error).message);
  }
  return out;
}

async function classerIssuesDeLaPeriode(since: string, maxRetries: number, opts: {
  budgetMs?: number; pageSize?: number; cursor?: { updatedAt: string; fileId: number } | null;
} = {}): Promise<{ byIssue: Record<CoverageIssue, number>; scanned: number; expected: number | null; incomplete: IssueScanIncomplete | null }> {
  const { pgClient } = await import('@/db');
  const byIssue = Object.fromEntries(COVERAGE_ISSUES.map((i) => [i, 0])) as Record<CoverageIssue, number>;
  const fin = Date.now() + Math.max(1, opts.budgetMs ?? ISSUE_SCAN_BUDGET_MS);
  const taille = Math.max(1, Math.trunc(opts.pageSize ?? ISSUE_SCAN_PAGE));
  let scanned = 0;
  let expected: number | null = null;
  let curseur: { updatedAt: string; fileId: number } | null = opts.cursor ?? null;
  let incomplete: IssueScanIncomplete | null = null;
  const objet = (v: unknown): Record<string, unknown> | null => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;
  try {
    await pgClient.begin('isolation level repeatable read read only', async (tx) => {
      const t = tx as unknown as { unsafe: (q: string, p?: never[]) => Promise<unknown> };
      const [n] = (await t.unsafe(
        `SELECT COUNT(*)::int AS n FROM document_extraction_coverage c
          WHERE c.updated_at >= $1 AND ($2::timestamptz IS NULL OR (c.updated_at, c.file_id) < ($2::timestamptz, $3::int))`,
        [since, curseur?.updatedAt ?? null, curseur?.fileId ?? 0] as never[],
      )) as Array<{ n: number }>;
      expected = Number(n?.n ?? 0);
      for (;;) {
        if (Date.now() > fin) {
          incomplete = { cause: 'TIME_BUDGET', scanned, expected, cursor: curseur };
          return;
        }
        let rows: Array<CoverageIssueInput & { updatedAt: string; fileId: number }>;
        try {
          rows = (await t.unsafe(
            // Curseur EXACT (texte, microsecondes) : un passage par `Date` tronquait à la milliseconde et faisait
            // sauter tous les documents écrits dans la même milliseconde (lecture arrêtée en silence — carte #837, D3).
            `SELECT c.file_id AS "fileId", c.updated_at::text AS "updatedAt",
                    c.quality_state AS "qualityState", c.anomalies, c.next_retry_at AS "nextRetryAt", c.retry_attempts AS "retryAttempts",
                    to_jsonb(c) ->> 'source_verification' AS "sourceVerification", to_jsonb(c) -> 'verification' AS verification,
                    to_jsonb(c) ->> 'last_retry_result' AS "lastRetryResult"
               FROM document_extraction_coverage c
              WHERE c.updated_at >= $1
                AND ($2::timestamptz IS NULL OR (c.updated_at, c.file_id) < ($2::timestamptz, $3::int))
              ORDER BY c.updated_at DESC, c.file_id DESC
              LIMIT $4`,
            [since, curseur?.updatedAt ?? null, curseur?.fileId ?? 0, taille] as never[],
          )) as Array<CoverageIssueInput & { updatedAt: string; fileId: number }>;
        } catch (e) {
          incomplete = { cause: 'SQL_ERROR', scanned, expected, cursor: curseur, error: String((e as Error).message ?? e).slice(0, 200) };
          return;
        }
        for (const r of rows) byIssue[coverageIssueOf({ ...r, verification: objet(r.verification), maxRetries }).issue]++;
        scanned += rows.length;
        if (rows.length > 0) {
          const dernier = rows[rows.length - 1];
          curseur = { updatedAt: String(dernier.updatedAt), fileId: Number(dernier.fileId) };
        }
        if (rows.length < taille) return;
      }
    });
  } catch (e) {
    incomplete ??= { cause: 'SQL_ERROR', scanned, expected, cursor: curseur, error: String((e as Error).message ?? e).slice(0, 200) };
  }
  if (!incomplete && expected !== null && scanned !== expected) incomplete = { cause: 'COUNT_MISMATCH', scanned, expected, cursor: curseur };
  if (incomplete) {
    console.warn(`[t1-completeness] classement par issue INCOMPLET (${incomplete.cause}) : ${scanned}/${expected ?? '?'} document(s).`);
  }
  return { byIssue, scanned, expected, incomplete };
}

export async function getT1CompletenessOverview(opts: {
  days?: number; limit?: number; anomaly?: string | null;
  /** Carte #837 (D3) : budget de temps du classement par issue, taille de page (recette) et curseur de reprise. */
  issueScan?: { budgetMs?: number; pageSize?: number; cursor?: { updatedAt: string; fileId: number } | null };
} = {}): Promise<CompletenessOverview> {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
  const empty: CompletenessOverview = {
    days, byQuality: { COMPLETE: 0, COMPLETE_WITH_UNRESOLVED: 0, VERIFICATION_INCOMPLETE: 0, INCOMPLETE_RETRYABLE: 0, INCOMPLETE_FINAL: 0 },
    byAnomaly: {}, averageCoverage: null, repairPasses: 0, bySourceVerification: {}, rows: [],
  };
  const { sourceLayerReady } = await import('./repository');
  if (!(await sourceLayerReady())) return { ...empty, unavailable: true };
  const { pgClient } = await import('@/db');
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { maxCompletenessRetries } = await import('./repository');
  const plafond = maxCompletenessRetries();
  const [agg, anomalies, rows, verifs, totaux, classement] = await Promise.all([
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
              c.chunk_count AS "chunkCount", c.retry_attempts AS "retryAttempts", c.origin, c.updated_at AS "updatedAt",
              to_jsonb(c) ->> 'source_verification' AS "sourceVerification", to_jsonb(c) -> 'verification' AS verification,
              to_jsonb(c) ->> 'last_retry_at' AS "lastRetryAt", to_jsonb(c) ->> 'last_retry_result' AS "lastRetryResult",
              c.next_retry_at AS "nextRetryAt"
         FROM document_extraction_coverage c
         LEFT JOIN asset_files af ON af.id = c.file_id
        WHERE c.updated_at >= $1 AND cardinality(c.anomalies) > 0
          AND ($2::text IS NULL OR $2 = ANY(c.anomalies))
        ORDER BY (c.quality_state = 'INCOMPLETE_FINAL') DESC, (c.quality_state = 'INCOMPLETE_RETRYABLE') DESC,
                 (c.quality_state = 'VERIFICATION_INCOMPLETE') DESC, c.updated_at DESC
        LIMIT $3`,
      [since, opts.anomaly ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 200)] as never[],
    ) as unknown as Promise<CompletenessDocumentRow[]>,
    pgClient.unsafe(
      `SELECT coalesce(to_jsonb(c) ->> 'source_verification', 'NOT_CHECKED') AS v, COUNT(*)::int AS n
         FROM document_extraction_coverage c WHERE c.updated_at >= $1 GROUP BY 1`,
      [since] as never[],
    ) as unknown as Promise<Array<{ v: string; n: number }>>,
    (pgClient.unsafe(diagnosticsTotalsSql(), [since] as never[]) as unknown as Promise<Array<Record<string, number>>>)
      .catch(() => [] as Array<Record<string, number>>),
    // Lot 114H (#775), lot 115H (#785, § 6) et carte #837 (D3) : état courant de CHAQUE document de la période,
    // classé page par page sur un instantané cohérent — exhaustif, ou déclaré INCOMPLETE avec sa cause.
    classerIssuesDeLaPeriode(since, plafond, opts.issueScan ?? {}),
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
  for (const v of verifs) out.bySourceVerification[v.v] = Number(v.n);
  out.maxRetries = plafond;
  const objet = (v: unknown): Record<string, unknown> | null => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;
  // Carte #837 (D4) : rapport d'exécution d'ORIGINE (immuable) de chaque document listé — la face historique est
  // LUE, jamais reconstituée depuis la couverture actuelle. Rapport ou table absents : face « indisponible ».
  const rapports = await lireRapportsOrigine(rows.map((r) => ({ fileId: Number(r.fileId), accountId: Number(r.accountId) })));
  out.rows = rows.map((r) => {
    const faces = splitHistoricalAndCurrent({
      ...r, verification: objet(r.verification), maxRetries: out.maxRetries, analysisReport: rapports.get(Number(r.fileId)) ?? null,
    });
    return {
      ...r, coverageRatio: Number(r.coverageRatio),
      issue: coverageIssueOf({ ...r, verification: objet(r.verification), maxRetries: out.maxRetries }),
      historical: faces.historical, current: faces.current,
    };
  });
  out.byIssue = classement.byIssue;
  out.byIssueScanned = classement.scanned;
  out.byIssueExpected = classement.expected;
  // Carte #837 (D3) : jamais « exhaustif » après une lecture tronquée ou en erreur.
  out.byIssueStatus = classement.incomplete ? 'INCOMPLETE' : 'COMPLETE';
  out.byIssueIncomplete = classement.incomplete;
  out.byIssueTruncated = classement.incomplete !== null;
  if (totaux[0]) {
    out.totals = Object.fromEntries(Object.entries(totaux[0]).map(([k, v]) => [k, Number(v ?? 0)])) as unknown as T1DiagnosticsTotals;
  }
  return out;
}
