/**
 * Régularisation CONTRÔLÉE des coûts IA non chiffrés — lot 109L (ticket P1
 * « Tarifs Gemini non reconnus », point D ; migration 1150).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DRY-RUN → EXPORT AVANT / APRÈS → APPLICATION UNIQUE → RETOUR ARRIÈRE
 *
 *   1. `dryRunRegularization` : classe chaque appel concerné de la période
 *      (`cost-diagnostic.ts`) et décide, SANS RIEN MODIFIER :
 *        regularize     tarif DOCUMENTÉ à la date de l'appel (ligne valide
 *                       à cette date, ou retrait à tort prouvé par une
 *                       republication à l'identique, ou saisie manuelle
 *                       vérifiée à validité rétroactive sourcée) — mode payant,
 *                       palier Standard, modalité texte/image (règles de
 *                       l'adaptateur) ; palier d'invite et montants datés
 *                       appliqués à la date de l'appel ;
 *        keep_unpriced  non reconstituable : reste non chiffré, AVEC RAISON ;
 *        no_action      coût connu (nul/arrondi) ou déjà régularisé.
 *      Les agrégats journaliers d'appels supprimés sont traités À PART (une
 *      correction par agrégat, entièrement non tarifé seulement) ; les
 *      sauvegardes S3 ne sont jamais touchées. Plan enregistré, empreinte.
 *   2. `regularizationExport` : CSV avant / après de chaque ligne.
 *   3. `applyRegularization(dryRunId)` : refuse si le plan a changé
 *      (empreinte recalculée) ou s'il a déjà été appliqué ; écrit les
 *      corrections par lots, chacune UNIQUE par cible (index partiel) —
 *      reprise après interruption et double exécution sans effet ;
 *   4. `revertRegularization(applyRunId)` : désactive les corrections (jamais
 *      supprimées) ; les coûts initiaux réapparaissent.
 *
 * JAMAIS : modifier `cost_micros` ou `metadata.pricing` d'une trace, appeler un
 * modèle, créer un appel, réinjecter un tarif courant dans le passé.
 * Coût effectif (rapports, budgets, plafonds) = correction active sinon coût
 * initial : aucun double comptage.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import {
  COST_METHOD_VERSION, forEachDiagnosedCall, reconstitutedCost, rollupCandidates,
  type DiagnosedCall, type Query, type RollupCandidate,
} from './cost-diagnostic';

export type RegularizationDecision = 'regularize' | 'keep_unpriced' | 'no_action';

export interface PlanItem {
  targetKind: 'event' | 'rollup';
  targetId: number;
  callAt: string;
  provider: string | null;
  model: string | null;
  useCaseCode: string | null;
  accountId: number | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number | null;
  initialCostMicros: number | null;
  initialStatus: string;
  cause: string;
  decision: RegularizationDecision;
  decisionReason: string;
  priceRowId: number | null;
  priceSource: string | null;
  priceRef: Record<string, unknown> | null;
  correctedCostMicros: number | null;
  correctedExactMicros: number | null;
}

/** Décision pour un appel classé (pur, testé). */
export function decideEvent(c: DiagnosedCall): PlanItem {
  const base: PlanItem = {
    targetKind: 'event', targetId: c.id, callAt: c.at, provider: c.provider, model: c.model, useCaseCode: c.useCaseCode,
    accountId: c.accountId, calls: 1, inputTokens: c.inputTokens, outputTokens: c.outputTokens, thoughtsTokens: c.thoughtsTokens,
    initialCostMicros: c.costMicros, initialStatus: c.pricingStatus, cause: c.cause,
    decision: 'keep_unpriced', decisionReason: c.notReconstitutable ?? 'non reconstituable',
    priceRowId: null, priceSource: null, priceRef: null, correctedCostMicros: null, correctedExactMicros: null,
  };
  if (c.corrected) return { ...base, decision: 'no_action', decisionReason: 'déjà régularisé (correction active)' };
  if (c.cause === 'ZERO_OR_ROUNDED') return { ...base, decision: 'no_action', decisionReason: 'coût connu (nul ou arrondi) : statut reclassé, aucun montant à corriger' };
  if (!c.price || !c.priceMethod) return base;
  const r = reconstitutedCost(c, c.price);
  return {
    ...base, decision: 'regularize',
    decisionReason: c.priceMethod === 'continuity' ? 'tarif retiré à tort puis republié à l’identique : montant prouvé avant et après'
      : c.priceMethod === 'documented_backdated' ? 'saisie manuelle vérifiée, validité rétroactive sourcée' : 'tarif documenté valide à la date de l’appel',
    priceRowId: c.price.id, priceSource: c.price.source,
    priceRef: {
      id: c.price.id, source: c.price.source, verified: c.price.verified, inputMicros: c.price.inputMicros, outputMicros: c.price.outputMicros,
      tiers: c.price.tiers, effectiveFrom: c.price.effectiveFrom, method: c.priceMethod, thoughtsIncluded: (c.thoughtsTokens ?? 0) > 0,
    },
    correctedCostMicros: r.costMicros, correctedExactMicros: r.exactMicros,
  };
}

/** Décision pour un agrégat journalier (pur). */
export function decideRollup(r: RollupCandidate): PlanItem {
  const base: PlanItem = {
    targetKind: 'rollup', targetId: r.id, callAt: `${r.day}T00:00:00.000Z`, provider: r.provider, model: r.model, useCaseCode: r.useCaseCode,
    accountId: r.accountId, calls: r.unpricedCalls, inputTokens: r.inputTokens, outputTokens: r.outputTokens, thoughtsTokens: null,
    initialCostMicros: r.costMicros, initialStatus: 'legacy_undetermined', cause: 'LEGACY_NO_PROOF',
    decision: 'keep_unpriced', decisionReason: r.reason, priceRowId: null, priceSource: null, priceRef: null, correctedCostMicros: null, correctedExactMicros: null,
  };
  if (r.corrected) return { ...base, decision: 'no_action', decisionReason: 'déjà régularisé (correction active)' };
  if (!r.regularizable || !r.price) return base;
  const exact = r.inputTokens * r.price.inputMicros + r.outputTokens * r.price.outputMicros;
  return {
    ...base, decision: 'regularize', decisionReason: r.reason,
    priceRowId: r.price.id, priceSource: r.price.source,
    priceRef: { id: r.price.id, source: r.price.source, verified: r.price.verified, inputMicros: r.price.inputMicros, outputMicros: r.price.outputMicros, effectiveFrom: r.price.effectiveFrom, method: 'rollup_valid_all_day' },
    // Agrégat entièrement non tarifé : le coût corrigé remplace un coût initial nul.
    correctedCostMicros: Math.round(exact) + Math.max(0, r.costMicros), correctedExactMicros: exact + Math.max(0, r.costMicros),
  };
}

/** Empreinte du plan (cibles régularisées, montants, tarifs) — pure. */
export function planFingerprint(items: readonly PlanItem[]): string {
  const h = createHash('sha256');
  for (const i of items.filter((x) => x.decision === 'regularize').sort((a, b) => a.targetKind.localeCompare(b.targetKind) || a.targetId - b.targetId)) {
    h.update(`${i.targetKind}:${i.targetId}:${i.correctedCostMicros}:${i.priceRowId}\n`);
  }
  return h.digest('hex');
}

export interface PlanSummary {
  candidates: number;
  regularize: { calls: number; rows: number; micros: number };
  keepUnpriced: { calls: number; rows: number; byReason: Record<string, number> };
  noAction: { calls: number; rows: number };
  byCause: Record<string, { calls: number; regularize: number; keepUnpriced: number; noAction: number; micros: number }>;
  byModel: Record<string, { calls: number; regularize: number; micros: number }>;
  /** Supplément par compte et par mois (plafonds compte : effet visible avant application). */
  byAccountMonth: Array<{ accountId: number | null; month: string; micros: number }>;
  rollups: { rows: number; regularize: number; micros: number };
}

/** Résumé du plan (pur). */
export function summarize(items: readonly PlanItem[]): PlanSummary {
  const s: PlanSummary = {
    candidates: 0, regularize: { calls: 0, rows: 0, micros: 0 }, keepUnpriced: { calls: 0, rows: 0, byReason: {} }, noAction: { calls: 0, rows: 0 },
    byCause: {}, byModel: {}, byAccountMonth: [], rollups: { rows: 0, regularize: 0, micros: 0 },
  };
  const am = new Map<string, { accountId: number | null; month: string; micros: number }>();
  for (const i of items) {
    s.candidates += i.calls;
    const c = (s.byCause[i.cause] ??= { calls: 0, regularize: 0, keepUnpriced: 0, noAction: 0, micros: 0 });
    c.calls += i.calls;
    const m = (s.byModel[i.model ?? '—'] ??= { calls: 0, regularize: 0, micros: 0 });
    m.calls += i.calls;
    if (i.targetKind === 'rollup') s.rollups.rows++;
    if (i.decision === 'regularize') {
      const delta = (i.correctedCostMicros ?? 0) - Math.max(0, i.initialCostMicros ?? 0);
      s.regularize.calls += i.calls; s.regularize.rows++; s.regularize.micros += delta;
      c.regularize += i.calls; c.micros += delta; m.regularize += i.calls; m.micros += delta;
      if (i.targetKind === 'rollup') { s.rollups.regularize++; s.rollups.micros += delta; }
      const k = `${i.accountId ?? '—'}|${i.callAt.slice(0, 7)}`;
      const x = am.get(k) ?? { accountId: i.accountId, month: i.callAt.slice(0, 7), micros: 0 };
      x.micros += delta; am.set(k, x);
    } else if (i.decision === 'keep_unpriced') {
      s.keepUnpriced.calls += i.calls; s.keepUnpriced.rows++; c.keepUnpriced += i.calls;
      s.keepUnpriced.byReason[i.decisionReason] = (s.keepUnpriced.byReason[i.decisionReason] ?? 0) + i.calls;
    } else {
      s.noAction.calls += i.calls; s.noAction.rows++; c.noAction += i.calls;
    }
  }
  s.byAccountMonth = [...am.values()].sort((a, b) => b.micros - a.micros).slice(0, 100);
  return s;
}

/** Plan complet de la période (lecture seule). */
export async function buildPlan(q: Query, f: { since: Date; until: Date; accounts: number[] | null }): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  await forEachDiagnosedCall(q, f, (c) => { items.push(decideEvent(c)); });
  for (const r of await rollupCandidates(q, f)) items.push(decideRollup(r));
  return items;
}

// ── Exécutions (base) ──────────────────────────────────────────────────────

type Sql = { unsafe: (t: string, p?: never[]) => Promise<unknown> };
type Rows = Array<Record<string, unknown>>;
const rowsOf = async (s: Sql, t: string, p: unknown[] = []) => ((await s.unsafe(t, p as never[])) as Rows) ?? [];

async function defaultSql(): Promise<Sql> {
  const { pgClient } = await import('@/db');
  return pgClient as unknown as Sql;
}

const queryOf = (s: Sql): Query => (t, p) => rowsOf(s, t, p);
/** `pgClient.unsafe()` ne sérialise pas les `Date` : toujours une chaîne ISO. */
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export interface RunResult { runId: number; status: string; summary: PlanSummary | Record<string, unknown>; fingerprint?: string | null; refused?: string }

/** Simulation : plan enregistré (lignes + résumé + empreinte). Aucune correction écrite. */
export async function dryRunRegularization(f: { since: Date; until: Date }, operatorUserId: number | null, sql?: Sql): Promise<RunResult> {
  const s = sql ?? await defaultSql();
  const [run] = await rowsOf(s, `INSERT INTO ai_cost_regularization_runs (mode, since, until, method_version, operator_user_id)
                                 VALUES ('dry_run', $1, $2, $3, $4) RETURNING id`, [f.since.toISOString(), f.until.toISOString(), COST_METHOD_VERSION, operatorUserId]);
  const runId = Number(run.id);
  try {
    const items = await buildPlan(queryOf(s), { ...f, accounts: null });
    for (let k = 0; k < items.length; k += 500) await insertItems(s, runId, items.slice(k, k + 500));
    const summary = summarize(items);
    const fp = planFingerprint(items);
    await s.unsafe(`UPDATE ai_cost_regularization_runs SET status = 'completed', finished_at = NOW(), summary = $2::jsonb, plan_fingerprint = $3 WHERE id = $1`,
      [runId, JSON.stringify(summary), fp] as never[]);
    return { runId, status: 'completed', summary, fingerprint: fp };
  } catch (e) {
    await s.unsafe(`UPDATE ai_cost_regularization_runs SET status = 'failed', finished_at = NOW(), error_message = $2 WHERE id = $1`,
      [runId, String((e as Error).message).slice(0, 500)] as never[]).catch(() => undefined);
    throw e;
  }
}

async function insertItems(s: Sql, runId: number, items: readonly PlanItem[]): Promise<void> {
  if (items.length === 0) return;
  const cols = 22;
  const values: unknown[] = [];
  const tuples = items.map((i, k) => {
    values.push(runId, i.targetKind, i.targetId, i.callAt, i.provider, i.model, i.useCaseCode, i.accountId, i.calls, i.inputTokens, i.outputTokens,
      i.thoughtsTokens, i.initialCostMicros, i.initialStatus, i.cause, i.decision, i.decisionReason.slice(0, 300), i.priceRowId, i.priceSource,
      i.priceRef ? JSON.stringify(i.priceRef) : null, i.correctedCostMicros, i.correctedExactMicros);
    const b = k * cols;
    return `(${Array.from({ length: cols }, (_, j) => `$${b + j + 1}${j === 19 ? '::jsonb' : ''}`).join(',')})`;
  });
  await s.unsafe(
    `INSERT INTO ai_cost_regularization_items (run_id, target_kind, target_id, call_at, provider, model, use_case_code, account_id, calls,
       input_tokens, output_tokens, thoughts_tokens, initial_cost_micros, initial_status, cause, decision, decision_reason, price_row_id,
       price_source, price_ref, corrected_cost_micros, corrected_exact_micros) VALUES ${tuples.join(',')}`,
    values as never[],
  );
}

/**
 * Application UNIQUE d'une simulation. Refusée si : simulation introuvable ou
 * non terminée ; déjà appliquée ; plan modifié depuis (empreinte recalculée).
 * Reprise : une application interrompue est reprise par un nouvel appel (les
 * corrections déjà écrites sont ignorées, index unique).
 */
export async function applyRegularization(dryRunId: number, operatorUserId: number | null, sql?: Sql): Promise<RunResult> {
  const s = sql ?? await defaultSql();
  const [dr] = await rowsOf(s, `SELECT * FROM ai_cost_regularization_runs WHERE id = $1 AND mode = 'dry_run'`, [dryRunId]);
  const refuse = async (code: string, message: string): Promise<RunResult> => {
    const [r] = await rowsOf(s, `INSERT INTO ai_cost_regularization_runs (mode, status, since, until, method_version, dry_run_id, operator_user_id, finished_at, error_message)
                                 VALUES ('apply', 'refused', $1, $2, $3, $4, $5, NOW(), $6) RETURNING id`,
      [dr ? iso(dr.since) : new Date().toISOString(), dr ? iso(dr.until) : new Date().toISOString(), COST_METHOD_VERSION, dr ? dryRunId : null, operatorUserId, `${code} : ${message}`]);
    return { runId: Number(r.id), status: 'refused', summary: {}, refused: code };
  };
  if (!dr) return refuse('NOT_FOUND', 'simulation introuvable');
  if (dr.status !== 'completed') return refuse('DRY_RUN_NOT_COMPLETED', 'simulation non terminée');
  const [done] = await rowsOf(s, `SELECT id FROM ai_cost_regularization_runs WHERE mode = 'apply' AND dry_run_id = $1 AND status = 'completed' LIMIT 1`, [dryRunId]);
  if (done) return refuse('ALREADY_APPLIED', `simulation déjà appliquée (exécution ${String(done.id)})`);
  const plan = await buildPlan(queryOf(s), { since: new Date(String(dr.since)), until: new Date(String(dr.until)), accounts: null });
  // Les cibles déjà corrigées par une application INTERROMPUE de cette même simulation restent dans le plan d'origine.
  const resumed = await rowsOf(s, `SELECT target_kind, target_id FROM ai_cost_corrections WHERE dry_run_id = $1 AND reverted_at IS NULL`, [dryRunId]);
  const dejaFaits = new Set(resumed.map((r) => `${String(r.target_kind)}:${String(r.target_id)}`));
  const planItems: PlanItem[] = await rowsOf(s, `SELECT * FROM ai_cost_regularization_items WHERE run_id = $1 AND decision = 'regularize' ORDER BY id`, [dryRunId])
    .then((rows) => rows.map(itemOfRow));
  const recalcule = [...plan.filter((i) => i.decision === 'regularize'), ...planItems.filter((i) => dejaFaits.has(`${i.targetKind}:${i.targetId}`))];
  const uniq = new Map(recalcule.map((i) => [`${i.targetKind}:${i.targetId}`, i]));
  if (planFingerprint([...uniq.values()]) !== String(dr.plan_fingerprint)) {
    return refuse('PLAN_CHANGED', 'le plan a changé depuis la simulation (nouvelles traces, tarifs ou corrections) : relancez une simulation');
  }
  const [run] = await rowsOf(s, `INSERT INTO ai_cost_regularization_runs (mode, since, until, method_version, plan_fingerprint, dry_run_id, operator_user_id)
                                 VALUES ('apply', $1, $2, $3, $4, $5, $6) RETURNING id`,
    [iso(dr.since), iso(dr.until), COST_METHOD_VERSION, dr.plan_fingerprint, dryRunId, operatorUserId]);
  const runId = Number(run.id);
  let written = 0; let skipped = 0;
  try {
    for (let k = 0; k < planItems.length; k += 500) {
      const lot = planItems.slice(k, k + 500);
      const r = await writeCorrections(s, runId, dryRunId, lot, operatorUserId);
      written += r; skipped += lot.length - r;
    }
    const summary = { written, skipped, items: planItems.length, micros: planItems.reduce((a, i) => a + ((i.correctedCostMicros ?? 0) - Math.max(0, i.initialCostMicros ?? 0)), 0) };
    await s.unsafe(`UPDATE ai_cost_regularization_runs SET status = 'completed', finished_at = NOW(), summary = $2::jsonb WHERE id = $1`, [runId, JSON.stringify(summary)] as never[]);
    return { runId, status: 'completed', summary };
  } catch (e) {
    await s.unsafe(`UPDATE ai_cost_regularization_runs SET status = 'interrupted', finished_at = NOW(), error_message = $2, summary = $3::jsonb WHERE id = $1`,
      [runId, String((e as Error).message).slice(0, 500), JSON.stringify({ written, skipped })] as never[]).catch(() => undefined);
    throw e;
  }
}

function itemOfRow(r: Record<string, unknown>): PlanItem {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    targetKind: r.target_kind as 'event' | 'rollup', targetId: Number(r.target_id), callAt: new Date(String(r.call_at)).toISOString(),
    provider: r.provider == null ? null : String(r.provider), model: r.model == null ? null : String(r.model),
    useCaseCode: r.use_case_code == null ? null : String(r.use_case_code), accountId: num(r.account_id), calls: Number(r.calls),
    inputTokens: Number(r.input_tokens ?? 0), outputTokens: Number(r.output_tokens ?? 0), thoughtsTokens: num(r.thoughts_tokens),
    initialCostMicros: num(r.initial_cost_micros), initialStatus: String(r.initial_status ?? ''), cause: String(r.cause),
    decision: r.decision as RegularizationDecision, decisionReason: String(r.decision_reason ?? ''), priceRowId: num(r.price_row_id),
    priceSource: r.price_source == null ? null : String(r.price_source), priceRef: (r.price_ref as Record<string, unknown>) ?? null,
    correctedCostMicros: num(r.corrected_cost_micros), correctedExactMicros: num(r.corrected_exact_micros),
  };
}

/** Écrit un lot de corrections ; une cible déjà corrigée est ignorée (idempotent). Rend le nombre écrit. */
async function writeCorrections(s: Sql, runId: number, dryRunId: number, items: readonly PlanItem[], operator: number | null): Promise<number> {
  if (items.length === 0) return 0;
  const cols = 15;
  const values: unknown[] = [];
  const tuples = items.map((i, k) => {
    values.push(i.targetKind, i.targetId, runId, dryRunId, i.callAt, i.initialCostMicros,
      JSON.stringify({ status: i.initialStatus, costMicros: i.initialCostMicros }), i.correctedCostMicros, i.correctedExactMicros, i.cause,
      String(i.priceRef?.method ?? 'valid_at_call'), COST_METHOD_VERSION, i.priceRowId, i.priceSource, JSON.stringify(i.priceRef ?? {}));
    const b = k * cols;
    return `(${Array.from({ length: cols }, (_, j) => `$${b + j + 1}${j === 6 || j === 14 ? '::jsonb' : ''}`).join(',')}, ${operator === null ? 'NULL' : Number(operator)})`;
  });
  const rows = await rowsOf(s,
    `INSERT INTO ai_cost_corrections (target_kind, target_id, run_id, dry_run_id, call_at, initial_cost_micros, initial_pricing,
       corrected_cost_micros, corrected_exact_micros, cause, method, method_version, price_row_id, price_source, price_ref, applied_by)
     VALUES ${tuples.join(',')}
     ON CONFLICT (target_kind, target_id) WHERE reverted_at IS NULL DO NOTHING
     RETURNING id`, values);
  return rows.length;
}

/** Retour arrière d'une application : corrections désactivées (conservées), coûts initiaux rétablis. */
export async function revertRegularization(applyRunId: number, operatorUserId: number | null, sql?: Sql): Promise<RunResult> {
  const s = sql ?? await defaultSql();
  const [ap] = await rowsOf(s, `SELECT * FROM ai_cost_regularization_runs WHERE id = $1 AND mode = 'apply' AND status IN ('completed', 'interrupted')`, [applyRunId]);
  if (!ap) {
    const [r] = await rowsOf(s, `INSERT INTO ai_cost_regularization_runs (mode, status, since, until, method_version, operator_user_id, finished_at, error_message)
                                 VALUES ('revert', 'refused', NOW(), NOW(), $1, $2, NOW(), 'NOT_FOUND : application introuvable') RETURNING id`, [COST_METHOD_VERSION, operatorUserId]);
    return { runId: Number(r.id), status: 'refused', summary: {}, refused: 'NOT_FOUND' };
  }
  const [run] = await rowsOf(s, `INSERT INTO ai_cost_regularization_runs (mode, since, until, method_version, dry_run_id, operator_user_id)
                                 VALUES ('revert', $1, $2, $3, $4, $5) RETURNING id`, [iso(ap.since), iso(ap.until), COST_METHOD_VERSION, ap.dry_run_id, operatorUserId]);
  const runId = Number(run.id);
  const rows = await rowsOf(s, `UPDATE ai_cost_corrections SET reverted_at = NOW(), reverted_by = $2, revert_run_id = $3
                                 WHERE run_id = $1 AND reverted_at IS NULL RETURNING id`, [applyRunId, operatorUserId, runId]);
  const summary = { reverted: rows.length, applyRunId };
  await s.unsafe(`UPDATE ai_cost_regularization_runs SET status = 'completed', finished_at = NOW(), summary = $2::jsonb WHERE id = $1`, [runId, JSON.stringify(summary)] as never[]);
  return { runId, status: 'completed', summary };
}

/** Exécutions récentes (BO). */
export async function listRegularizationRuns(limit = 20, sql?: Sql): Promise<Rows> {
  const s = sql ?? await defaultSql();
  return rowsOf(s, `SELECT id, mode, status, since, until, method_version, plan_fingerprint, dry_run_id, operator_user_id, started_at, finished_at, summary, error_message
                      FROM ai_cost_regularization_runs ORDER BY id DESC LIMIT $1`, [Math.min(100, Math.max(1, limit))]).catch(() => []);
}

const csvCell = (v: unknown) => {
  if (v == null) return '';
  const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",;\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** Export CSV AVANT / APRÈS d'une simulation (ou de l'application qui en découle). */
export async function regularizationExport(runId: number, sql?: Sql): Promise<string | null> {
  const s = sql ?? await defaultSql();
  const [run] = await rowsOf(s, `SELECT id, mode, dry_run_id FROM ai_cost_regularization_runs WHERE id = $1`, [runId]);
  if (!run) return null;
  const planId = run.mode === 'dry_run' ? Number(run.id) : Number(run.dry_run_id);
  const items = await rowsOf(s,
    `SELECT i.*, c.id AS correction_id, c.applied_at, c.reverted_at
       FROM ai_cost_regularization_items i
       LEFT JOIN ai_cost_corrections c ON c.target_kind = i.target_kind AND c.target_id = i.target_id AND c.dry_run_id = i.run_id
      WHERE i.run_id = $1 ORDER BY i.target_kind, i.target_id`, [planId]);
  const head = ['cible', 'identifiant', 'date_appel', 'fournisseur', 'modele', 'traitement', 'compte', 'appels', 'jetons_entree', 'jetons_sortie', 'jetons_raisonnement',
    'avant_cout_micro_usd', 'avant_statut', 'cause', 'decision', 'raison', 'tarif_ligne', 'tarif_source', 'tarif_reference', 'apres_cout_micro_usd', 'apres_cout_exact',
    'correction', 'appliquee_le', 'annulee_le'];
  const lines = [head.join(';')];
  for (const i of items) {
    lines.push([i.target_kind, i.target_id, i.call_at instanceof Date ? i.call_at.toISOString() : i.call_at, i.provider, i.model, i.use_case_code, i.account_id, i.calls,
      i.input_tokens, i.output_tokens, i.thoughts_tokens, i.initial_cost_micros, i.initial_status, i.cause, i.decision, i.decision_reason, i.price_row_id, i.price_source,
      i.price_ref, i.decision === 'regularize' ? i.corrected_cost_micros : i.initial_cost_micros, i.corrected_exact_micros, i.correction_id,
      i.applied_at instanceof Date ? i.applied_at.toISOString() : i.applied_at, i.reverted_at instanceof Date ? i.reverted_at.toISOString() : i.reverted_at].map(csvCell).join(';'));
  }
  return `${lines.join('\n')}\n`;
}
