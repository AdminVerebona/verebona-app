/**
 * Lot 113AN (Trello #741) — réconciliation de la couverture d'un document
 * DÉJÀ analysé, depuis ses données PERSISTÉES (aucun appel IA, aucune
 * lecture du fichier) : faits actifs, décisions de valeur actives et
 * VALIDES, métadonnées de l'extraction, lignes de tableau de la couche A.
 *
 * Utilisée par :
 *   · la reprise ciblée (`t1-completeness-retry`, réparation demandée par le
 *     contrôle de cohérence) AVANT de choisir les unités à réparer — seules
 *     les vraies lacunes sont envoyées au modèle — et APRÈS l'ajout des faits ;
 *   · le réexamen des décisions de valeur (`value-decisions/review.ts`) : une
 *     décision arrivée APRÈS l'analyse (contrôle de cohérence) met enfin à
 *     jour la couverture (elle restait `not_extracted`) ;
 *   · BO › Exécutions IA › Complétude T1 › « Réconcilier (sans IA) » :
 *     simulation (rien n'est écrit) ou application (journalisée).
 *
 * Idempotente : une seconde application ne change rien (même provenance,
 * même état). Ne crée ni fait, ni décision, ni lien : seuls l'état de
 * couverture, sa provenance et la politique des unités restantes changent.
 */
import { candidateReconciliationValue, reconcileCoverage, reconciliationSummary, residualCounts, withResidualPolicies, type ReconciliationInput } from './coverage-reconciliation';
import { buildCompletenessReport } from './coverage';
import {
  loadDocumentCoverage, loadDocumentSourceUnits, loadUnresolvedDocumentFacts, maxCompletenessRetries, writeSourceLayer,
} from './repository';
import { SOURCE_LAYER_VERSION, type CoveredSourceUnit, type T1CoverageDiagnostics, type UnresolvedFactRecord } from './types';

type Row = Record<string, unknown>;
type Sql = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/** Données persistées d'un document vues par la réconciliation (sans l'étape). */
export async function loadStoredReconciliationInput(sql: Sql, accountId: number, fileId: number): Promise<Omit<ReconciliationInput, 'stage'>> {
  const faits = (await sql.unsafe(
    `SELECT f.id::float8 AS id, f.excerpt, f.location, f.value_text, f.normalized_value, to_jsonb(f)->>'raw_value' AS raw_value,
            f.value_number::float8 AS value_number, f.label, f.attribute, f.fact_key, f.canonical_key, to_jsonb(f)->>'raw_key' AS raw_key,
            to_jsonb(f)->'source_unit_ids' AS source_unit_ids
       FROM document_facts f WHERE f.account_id = $1 AND f.file_id = $2 AND f.status = 'active' ORDER BY f.id`,
    [accountId, fileId] as never[],
  )) as Row[];
  const [ext] = (await sql.unsafe(
    `SELECT amount_cents::float8 AS amount_cents, to_char(document_date, 'YYYY-MM-DD') AS document_date, supplier_siret
       FROM document_extractions WHERE account_id = $1 AND file_id = $2`,
    [accountId, fileId] as never[],
  )) as Row[];
  // Lot 114G (#760, P2-05) : candidats Opération ACTIFS du document — l'analyse les exploitait, le chargement
  // historique les omettait. Table absente (schéma ancien) : aucun candidat, jamais une erreur.
  const candidats = (await sql.unsafe(
    `SELECT candidate_key, payload FROM document_operation_candidates
      WHERE account_id = $1 AND file_id = $2 AND status = 'ACTIVE' ORDER BY id`,
    [accountId, fileId] as never[],
  ).catch(() => [])) as Row[];
  const { loadActiveValueDecisions } = await import('../value-decisions/store');
  const decisions = (await loadActiveValueDecisions(sql as never, accountId, [fileId]).catch(() => []))
    .filter((d) => d.validity === 'VALID' && d.sourceUnitId);
  const page = (loc: unknown) => {
    const l = (typeof loc === 'string' ? JSON.parse(loc) : loc) as { page?: unknown } | null;
    return typeof l?.page === 'number' ? l.page : null;
  };
  return {
    facts: faits.map((f) => ({
      ref: `db:${Number(f.id)}`,
      unitIds: Array.isArray(f.source_unit_ids) ? (f.source_unit_ids as unknown[]).map(String) : [],
      values: [f.value_text, f.normalized_value, f.raw_value, f.value_number == null ? null : Number(f.value_number)],
      labels: [f.label as string | null, f.attribute as string | null, f.fact_key as string | null, f.canonical_key as string | null, f.raw_key as string | null],
      excerpt: (f.excerpt as string | null) ?? null,
      page: page(f.location),
    })),
    values: [
      ...(ext?.amount_cents != null ? [{ ref: 'amount', source: 'METADATA' as const, values: [Number(ext.amount_cents) / 100], page: null }] : []),
      ...(ext?.document_date ? [{ ref: 'documentDate', source: 'METADATA' as const, values: [String(ext.document_date)], page: null }] : []),
      ...(ext?.supplier_siret ? [{ ref: 'supplier', source: 'METADATA' as const, values: [String(ext.supplier_siret)], page: null }] : []),
      ...candidats.map((c) => candidateReconciliationValue(String(c.candidate_key), typeof c.payload === 'string' ? JSON.parse(c.payload) : c.payload))
        .filter((v) => v.values.length > 0),
    ],
    decisions: decisions.map((d) => ({
      ref: `db:${d.id}`, sourceUnitId: d.sourceUnitId!, kind: d.kind, normalizedValue: d.normalizedValue, decision: d.decision,
    })),
  };
}

/** Réconciliation EN MÉMOIRE d'unités persistées (reprise ciblée) ; politiques posées. */
export async function reconcileStoredUnits<U extends CoveredSourceUnit>(sql: Sql, p: { accountId: number; fileId: number; units: readonly U[] }): Promise<U[]> {
  const input = await loadStoredReconciliationInput(sql, p.accountId, p.fileId);
  return withResidualPolicies(reconcileCoverage(p.units, { ...input, stage: 'STORED' }));
}

/** Requalification d'une unité (simulation ou application) — identifiants et codes seulement. */
export interface StoredRequalification {
  unitId: string; kind: string; page: number | null;
  from: { status: string; reason: string | null }; to: { status: string; reason: string | null };
  rule: string | null; refs: string[];
}

export interface StoredReconciliationResult {
  outcome: 'APPLIED' | 'SIMULATED' | 'UNCHANGED' | 'NO_LAYER';
  requalified: StoredRequalification[];
  before: { covered: number; unresolved: number; uncertain: number; qualityState: string | null };
  after: { covered: number; unresolved: number; uncertain: number; qualityState: string | null };
}

const compte = (units: readonly CoveredSourceUnit[], s: string) => units.filter((u) => u.status === s).length;

/**
 * Réconcilie la couche A persistée d'un document. `apply` : écrit les unités
 * requalifiées (provenance, politique) et recalcule le rapport de complétude
 * avec les MÊMES règles que l'analyse ; sinon simulation (rien n'est écrit).
 */
export async function reconcileStoredDocumentCoverage(p: {
  accountId: number; fileId: number; apply: boolean; origin: string;
}): Promise<StoredReconciliationResult> {
  const { pgClient } = await import('@/db');
  const sql = pgClient as unknown as Sql;
  const stored = await loadDocumentSourceUnits(p.fileId, { accountId: p.accountId, limit: 50_000 });
  const cov = await loadDocumentCoverage(p.fileId, p.accountId);
  if (stored.length === 0 || !cov) {
    const vide = { covered: 0, unresolved: 0, uncertain: 0, qualityState: cov?.qualityState ?? null };
    return { outcome: 'NO_LAYER', requalified: [], before: vide, after: vide };
  }
  const { toCovered, storedDiagnostics } = await import('./jobs');
  const units = stored.map(toCovered);
  const majs = await reconcileStoredUnits(sql, { accountId: p.accountId, fileId: p.fileId, units });
  const requalified: StoredRequalification[] = [];
  majs.forEach((u, i) => {
    const a = units[i];
    if (a.status === u.status && a.reason === u.reason) return;
    requalified.push({
      unitId: u.sourceUnitId, kind: u.kind, page: u.page, from: { status: a.status, reason: a.reason }, to: { status: u.status, reason: u.reason },
      rule: u.coverageProvenance?.rule ?? null, refs: u.coverageProvenance?.refs ?? [],
    });
  });
  const politiquesChangees = majs.some((u, i) => (u.residualPolicy ?? null) !== (units[i].residualPolicy ?? null));
  const before = { covered: compte(units, 'COVERED'), unresolved: compte(units, 'UNRESOLVED'), uncertain: compte(units, 'UNCERTAIN'), qualityState: cov.qualityState };

  // Rapport recalculé avec les règles de l'analyse (données conservées de la ligne de couverture).
  const diag = storedDiagnostics(cov.verification ?? null);
  const unresolved: UnresolvedFactRecord[] = (await loadUnresolvedDocumentFacts(p.fileId, { accountId: p.accountId }))
    .map(({ id: _i, fileId: _f, createdAt: _c, ...x }) => { void _i; void _f; void _c; return x; });
  const report = buildCompletenessReport(majs, {
    factsCount: cov.factsCount, unresolvedFacts: unresolved, truncatedSectionsCount: cov.truncatedSectionsCount,
    batchedSectionsCount: cov.batchedSectionsCount, repairPassCount: cov.repairPassCount, chunkCount: cov.chunkCount,
    warningCodes: (cov.anomalies ?? []).includes('PARTIAL_EXTRACTION') ? ['PARTIAL_EXTRACTION'] : [],
    retryAllowed: cov.retryAttempts < maxCompletenessRetries(),
    verification: diag.verification ? { ...diag.verification, verified: Array.from({ length: diag.pagesVerified }, (_, i) => i + 1) } : null,
    normalisation: diag.normalisation, sourceReread: diag.sourceReread,
  });
  if (report.diagnostics) {
    const d = report.diagnostics as T1CoverageDiagnostics & { continuationRuns?: number };
    if (diag.repairPropagation) d.repairPropagation = diag.repairPropagation;
    if (diag.coverageRepair) d.coverageRepair = diag.coverageRepair;
    if (diag.continuationRuns) d.continuationRuns = diag.continuationRuns;
    d.reconciliation = reconciliationSummary(majs, 'STORED');
    d.residualPolicies = residualCounts(majs);
  }
  const after = { covered: report.coveredUnits, unresolved: report.unresolvedUnits, uncertain: report.uncertainUnits, qualityState: report.qualityState };
  if (requalified.length === 0 && !politiquesChangees) return { outcome: 'UNCHANGED', requalified, before, after: before };
  if (!p.apply) return { outcome: 'SIMULATED', requalified, before, after };

  await pgClient.begin(async (tx) => {
    await writeSourceLayer(tx as never, {
      accountId: p.accountId, fileId: p.fileId, extractionId: cov.extractionId ?? null, origin: 'RETRY',
      layer: { layerVersion: SOURCE_LAYER_VERSION, units: majs, unresolvedFacts: unresolved, report, retryable: report.qualityState === 'INCOMPLETE_RETRYABLE' },
      retryAttempts: cov.retryAttempts,
      nextRetryAt: cov.nextRetryAt ? new Date(cov.nextRetryAt) : null,
      retryResult: requalified.length > 0 ? `RECONCILED_${requalified.length}` : 'RECONCILED_POLICIES',
    });
  });
  console.info(`[t1-reconciliation] fichier ${p.fileId} (${p.origin}) : ${requalified.length} unité(s) requalifiée(s), `
    + `${before.qualityState} → ${after.qualityState}`);
  return { outcome: 'APPLIED', requalified, before, after };
}
