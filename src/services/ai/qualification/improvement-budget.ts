/**
 * Lot 113I — REGISTRE D'ENGAGEMENTS DU BUDGET D'AMÉLIORATION (CDC V2 §13, §31 :
 * BUD-01..08, FIN-001..009, INV-06, C-007).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 100 € / mois (UTC) pour TOUTE l'amélioration automatique de préproduction,
 * dont 80 € d'EXPÉRIMENTATIONS (génération, exploration, qualification,
 * juges) et 20 € de SURVEILLANCE (contrôles actifs justifiés). DISTINCT du
 * budget IA métier : la passerelle, les budgets d'alerte métier
 * (`ai_cost_settings`, informatifs) et le plafond par compte ne sont pas
 * touchés ; un budget d'amélioration épuisé n'interrompt JAMAIS le service
 * utilisateur (REC-034).
 *
 * Protocole par ESSAI d'appel fournisseur (FIN-003, FIN-004) :
 *   1. borne supérieure du coût (tarif de la grille, jetons d'entrée majorés,
 *      sortie maximale, marge de sécurité administrée, conversion FX prudente
 *      administrée) — non calculable → aucun appel (COST_UNKNOWN /
 *      FX_UNAVAILABLE) ;
 *   2. RÉSERVATION atomique sous verrou consultatif PostgreSQL (mois +
 *      environnement, valable entre instances Scalingo) : consommé + réservé +
 *      non rapproché ≤ enveloppe DE LA PHASE (la surveillance ne finance jamais
 *      l'exploration, REC-033) ; clé d'essai unique (une réservation par essai,
 *      jamais deux appels pour la même clé) ;
 *   3. appel par la passerelle EXISTANTE ;
 *   4. RÈGLEMENT : coût réel de la trace converti ; coût inconnu → UNRECONCILED
 *      (le montant réservé reste engagé et BLOQUE les nouveaux appels jusqu'au
 *      rapprochement, jamais converti en zéro) ; coût > réserve → anomalie de
 *      sous-estimation (blocage + alerte, FIN-006) ; appel jamais envoyé →
 *      RELEASED.
 * Processus arrêté entre réservation et règlement : la réservation reste
 * RESERVED puis passe UNRECONCILED au balayage (FIN-005) — jamais libérée sur
 * simple délai, jamais rejouée.
 * Alertes administrateur 50 € (information) et 75 € (vigilance), refus pour
 * budget (suspension des expérimentations seulement) : `ai_alerts` existant,
 * dédupliquées par mois (BUD-02, FIN-008, OPS-04).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getAiEnvironment } from '../config/environment';
import type { Treatment } from '../config/treatments';
import { loadPolicy, type ImprovementPolicy } from './improvement-policy';

export type BudgetPhase = 'EXPERIMENT' | 'MONITOR';
export type BudgetPurpose = 'GENERATION' | 'EXPLORATION' | 'VALIDATION' | 'JUDGE' | 'MONITOR_CHECK';
export type ReservationState = 'RESERVED' | 'SETTLED' | 'RELEASED' | 'UNRECONCILED';
export type BudgetRefusalCode = 'BUDGET_UNAVAILABLE' | 'COST_UNKNOWN' | 'FX_UNAVAILABLE' | 'COST_UNRECONCILED' | 'PREPROD_ONLY';

const MICRO = 1_000_000;

/** Mois de référence UTC (cohérent avec la comptabilité de coûts existante, BUD-07). */
export function budgetMonth(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export interface PriceInput { inputMicrosPerToken: number; outputMicrosPerToken: number; currency: string }

export interface CostBound {
  ok: true;
  /** Montant réservé, micro-EUR (arrondi supérieur). */
  maxEurMicros: number;
  quotedCurrency: string;
  /** Borne dans la devise de la grille (micro-unités). */
  quotedMicros: number;
  fx: { rate: number; marginRatio: number; source: string | null; date: string | null } | null;
  detail: { inputTokens: number; outputTokens: number; attempts: number; safetyMultiplier: number };
}

/** Conversion PRUDENTE devise de la grille → micro-EUR (centralisée, BUD-06). `null` : conversion sûre impossible. */
export function toEurMicros(micros: number, currency: string, policy: ImprovementPolicy): { eurMicros: number; fx: CostBound['fx'] } | null {
  const cur = currency.toUpperCase();
  if (cur === 'EUR') return { eurMicros: Math.ceil(micros), fx: null };
  if (cur !== 'USD') return null;
  const { usdToEur, marginRatio, source, date } = policy.fx;
  if (usdToEur == null || marginRatio == null || !source || !date) return null;
  // Arrondi supérieur après neutralisation du bruit flottant (déterministe, toujours prudent).
  return { eurMicros: Math.ceil(Number((micros * usdToEur * (1 + marginRatio)).toFixed(6))), fx: { rate: usdToEur, marginRatio, source, date } };
}

/** Borne supérieure (pure, FIN-003). Jamais une estimation optimiste : tout inconnu refuse. */
export function upperBound(p: {
  price: PriceInput | null; inputTokens: number | null; maxOutputTokens: number | null; attempts: number; policy: ImprovementPolicy;
}): CostBound | { ok: false; code: 'COST_UNKNOWN' | 'FX_UNAVAILABLE'; reason: string } {
  if (!p.price || !Number.isFinite(p.price.inputMicrosPerToken) || !Number.isFinite(p.price.outputMicrosPerToken)) {
    return { ok: false, code: 'COST_UNKNOWN', reason: 'tarif du modèle inconnu : coût maximum non estimable, appel différé' };
  }
  if (p.inputTokens == null || !(p.inputTokens >= 0)) return { ok: false, code: 'COST_UNKNOWN', reason: 'volume d’entrée non estimable (aucun historique, pièce jointe sans borne administrée)' };
  if (p.maxOutputTokens == null || !(p.maxOutputTokens > 0)) return { ok: false, code: 'COST_UNKNOWN', reason: 'limite de sortie inconnue : coût maximum non estimable' };
  const m = p.policy.costBound.safetyMultiplier;
  if (m == null) return { ok: false, code: 'COST_UNKNOWN', reason: 'marge de sécurité de la borne de coût À DÉFINIR PAR ADMINISTRATEUR (BO › Promotion automatique)' };
  const attempts = Math.max(1, Math.trunc(p.attempts));
  const quoted = Math.ceil((p.inputTokens * p.price.inputMicrosPerToken + p.maxOutputTokens * p.price.outputMicrosPerToken) * attempts * m);
  const eur = toEurMicros(quoted, p.price.currency, p.policy);
  if (!eur) return { ok: false, code: 'FX_UNAVAILABLE', reason: `conversion ${p.price.currency} → EUR non administrée (taux, source, date, marge À DÉFINIR) : aucune comparaison directe, appel différé` };
  return { ok: true, maxEurMicros: Math.max(1, eur.eurMicros), quotedCurrency: p.price.currency.toUpperCase(), quotedMicros: quoted, fx: eur.fx, detail: { inputTokens: p.inputTokens, outputTokens: p.maxOutputTokens, attempts, safetyMultiplier: m } };
}

type Row = Record<string, unknown>;
type Tx = { unsafe: (t: string, p?: never[]) => Promise<unknown> };
const rows = async (sql: Tx, t: string, p: unknown[] = []): Promise<Row[]> => (await sql.unsafe(t, p as never[])) as unknown as Row[];

export interface ReserveInput {
  attemptKey: string;
  phase: BudgetPhase;
  purpose: BudgetPurpose;
  bound: CostBound;
  environment?: string;
  objectiveId?: number | null;
  campaignId?: number | null;
  candidateVersionId?: number | null;
  treatment?: Treatment | null;
  operationCode?: string | null;
  now?: Date;
}

export type ReserveResult =
  | { ok: true; reservationId: number; reused: boolean; state: ReservationState }
  | { ok: false; code: BudgetRefusalCode; message: string; remainingEurMicros: number | null };

/** Enveloppe de la phase (micro-EUR). */
export function envelopeOf(policy: ImprovementPolicy, phase: BudgetPhase): number {
  return Math.round((phase === 'EXPERIMENT' ? policy.budget.experimentEur : policy.budget.monitorEur) * MICRO);
}

/** Engagé d'une phase : réglé + réservé + non rapproché (ce dernier compté à sa borne, FIN-005). */
const COMMITTED_SQL = `SELECT COALESCE(sum(CASE WHEN state = 'SETTLED' THEN settled_eur_micros WHEN state IN ('RESERVED', 'UNRECONCILED') THEN GREATEST(max_eur_micros, COALESCE(settled_eur_micros, 0)) ELSE 0 END), 0)::bigint AS n
                         FROM ai_improvement_budget_reservations WHERE environment = $1 AND budget_month = $2 AND phase = $3`;

/** Réservation atomique avant appel (BUD-03/04). Ne lève pas pour un refus : rend un code stable. */
export async function reserve(p: ReserveInput, deps: { policy?: ImprovementPolicy } = {}): Promise<ReserveResult> {
  const environment = p.environment ?? getAiEnvironment();
  if (environment === 'production') return { ok: false, code: 'PREPROD_ONLY', message: 'Aucun appel d’amélioration en production (PRD-01).', remainingEurMicros: null };
  const policy = deps.policy ?? await loadPolicy(environment);
  const month = budgetMonth(p.now);
  const envelope = envelopeOf(policy, p.phase);
  const { pgClient } = await import('@/db');
  const out = await pgClient.begin(async (tx) => {
    const sql = tx as unknown as Tx;
    await rows(sql, `SELECT pg_advisory_xact_lock(hashtext('ai_improvement_budget:' || $1 || ':' || $2))`, [environment, month]);
    const [deja] = await rows(sql, `SELECT id, state FROM ai_improvement_budget_reservations WHERE attempt_key = $1`, [p.attemptKey]);
    if (deja) return { ok: true as const, reservationId: Number(deja.id), reused: true, state: String(deja.state) as ReservationState };
    // Coût inconnu / sous-estimation non résolus (tous mois confondus) : blocage des NOUVEAUX appels (BUD-05, FIN-006, FIN-007).
    const [blq] = await rows(sql,
      `SELECT count(*) FILTER (WHERE state = 'UNRECONCILED')::int AS unrec, count(*) FILTER (WHERE underestimated AND anomaly_resolved_at IS NULL)::int AS under
         FROM ai_improvement_budget_reservations WHERE environment = $1`, [environment]);
    if (Number(blq?.unrec ?? 0) > 0 || Number(blq?.under ?? 0) > 0) {
      return { ok: false as const, code: 'COST_UNRECONCILED' as const, message: `${Number(blq?.unrec ?? 0)} engagement(s) au coût inconnu et ${Number(blq?.under ?? 0)} sous-estimation(s) non résolue(s) : nouveaux appels d’amélioration bloqués jusqu’au rapprochement (le service métier n’est pas concerné).`, remainingEurMicros: null };
    }
    const [c] = await rows(sql, COMMITTED_SQL, [environment, month, p.phase]);
    const engage = Number(c?.n ?? 0);
    const reste = envelope - engage;
    if (p.bound.maxEurMicros > reste) {
      return { ok: false as const, code: 'BUDGET_UNAVAILABLE' as const, message: `Budget ${p.phase === 'EXPERIMENT' ? 'd’expérimentation' : 'de surveillance'} insuffisant pour ${month} : ${(p.bound.maxEurMicros / MICRO).toFixed(4)} € requis, ${(Math.max(0, reste) / MICRO).toFixed(4)} € disponibles — objectif en attente du budget (aucun appel).`, remainingEurMicros: Math.max(0, reste) };
    }
    const [ins] = await rows(sql,
      `INSERT INTO ai_improvement_budget_reservations
         (environment, budget_month, phase, purpose, attempt_key, objective_id, campaign_id, candidate_version_id, treatment, operation_code,
          quoted_currency, quoted_max_micros, fx_reference, max_eur_micros, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, 'RESERVED') RETURNING id`,
      [environment, month, p.phase, p.purpose, p.attemptKey, p.objectiveId ?? null, p.campaignId ?? null, p.candidateVersionId ?? null, p.treatment ?? null, p.operationCode ?? null,
        p.bound.quotedCurrency, p.bound.quotedMicros, JSON.stringify({ ...(p.bound.fx ?? {}), detail: p.bound.detail, policyVersion: policy.version }), p.bound.maxEurMicros]);
    return { ok: true as const, reservationId: Number(ins.id), reused: false, state: 'RESERVED' as ReservationState };
  }) as ReserveResult;
  if (out.ok && !out.reused) await evaluateBudgetAlerts(environment, month, policy).catch(() => undefined);
  if (!out.ok && out.code === 'BUDGET_UNAVAILABLE') {
    await raiseBudgetAlert(environment, `improvement-budget:${environment}:${month}:${p.phase}:refused`, 'warning', 'IMPROVEMENT_BUDGET_EXHAUSTED',
      `Budget d’amélioration IA (${p.phase === 'EXPERIMENT' ? 'expérimentations' : 'surveillance'}) insuffisant pour ${month} : expérimentations suspendues, service métier NON concerné.`, { month, phase: p.phase }).catch(() => undefined);
  }
  return out;
}

/**
 * Règlement d'une réservation après l'appel (BUD-05). `sent: false` : l'appel n'est jamais parti (RELEASED).
 * Coût inconnu : UNRECONCILED. Coût > réserve : SETTLED + anomalie de sous-estimation (blocage, alerte).
 */
export async function settle(reservationId: number, r: { sent: boolean; costMicros: number | null; currency?: string; providerTraceId?: string | null }, deps: { policy?: ImprovementPolicy } = {}): Promise<ReservationState> {
  const { pgClient } = await import('@/db');
  return pgClient.begin(async (tx) => {
    const sql = tx as unknown as Tx;
    const [res] = await rows(sql, `SELECT id, environment, state, max_eur_micros, quoted_currency FROM ai_improvement_budget_reservations WHERE id = $1 FOR UPDATE`, [reservationId]);
    if (!res) return 'RELEASED';
    if (['SETTLED', 'RELEASED'].includes(String(res.state))) return String(res.state) as ReservationState; // idempotent
    if (!r.sent) {
      await rows(sql, `UPDATE ai_improvement_budget_reservations SET state = 'RELEASED', settled_eur_micros = 0, settled_at = now(), updated_at = now() WHERE id = $1`, [reservationId]);
      return 'RELEASED';
    }
    const policy = deps.policy ?? await loadPolicy(String(res.environment));
    const eur = r.costMicros != null && Number.isFinite(r.costMicros) ? toEurMicros(r.costMicros, r.currency ?? String(res.quoted_currency), policy) : null;
    if (!eur) {
      await rows(sql, `UPDATE ai_improvement_budget_reservations SET state = 'UNRECONCILED', provider_trace_id = COALESCE($2, provider_trace_id), cost_status = 'UNKNOWN', updated_at = now() WHERE id = $1`,
        [reservationId, r.providerTraceId ?? null]);
      return 'UNRECONCILED';
    }
    const under = eur.eurMicros > Number(res.max_eur_micros);
    await rows(sql,
      `UPDATE ai_improvement_budget_reservations SET state = 'SETTLED', settled_eur_micros = $2, settled_quoted_micros = $3, provider_trace_id = COALESCE($4, provider_trace_id),
              cost_status = 'KNOWN', underestimated = $5, settled_at = now(), updated_at = now() WHERE id = $1`,
      [reservationId, eur.eurMicros, Math.round(r.costMicros!), r.providerTraceId ?? null, under]);
    if (under) {
      await raiseBudgetAlert(String(res.environment), `improvement-budget:underestimated:${reservationId}`, 'critical', 'IMPROVEMENT_COST_UNDERESTIMATED',
        `Coût réel d’un appel d’amélioration supérieur à sa réservation (${(eur.eurMicros / MICRO).toFixed(4)} € > ${(Number(res.max_eur_micros) / MICRO).toFixed(4)} €) : nouvelles expérimentations bloquées, revue de la borne requise.`,
        { reservationId }).catch(() => undefined);
    }
    return 'SETTLED';
  }) as Promise<ReservationState>;
}

/**
 * Balayage (FIN-005, OPS-07) : réservations RESERVED plus anciennes que `staleMs` (processus arrêté, appel peut-être
 * facturé) → UNRECONCILED ; UNRECONCILED avec trace dont le coût est désormais connu dans `ai_usage_event` → réglées.
 */
export async function sweepReservations(p: { environment?: string; staleMs?: number; now?: Date } = {}): Promise<{ markedUnreconciled: number; reconciled: number }> {
  const environment = p.environment ?? getAiEnvironment();
  const { pgClient } = await import('@/db');
  const sql = pgClient as unknown as Tx;
  const avant = new Date((p.now ?? new Date()).getTime() - (p.staleMs ?? 2 * 3_600_000)).toISOString();
  let marked = 0;
  let reconciled = 0;
  try {
    marked = (await rows(sql, `UPDATE ai_improvement_budget_reservations SET state = 'UNRECONCILED', cost_status = 'UNKNOWN', updated_at = now()
                                 WHERE environment = $1 AND state = 'RESERVED' AND created_at < $2::timestamptz RETURNING id`, [environment, avant])).length;
    // Rapprochement par la clé d'essai tracée avec l'appel (`metadata.improvementAttemptKey`, lot 113I) ou par la trace :
    // réglé seulement si TOUTES les lignes d'usage de l'essai ont un coût connu (un coût inconnu ne vaut jamais zéro).
    const attente = await rows(sql, `SELECT r.id, e.cost, e.trace FROM ai_improvement_budget_reservations r
                                       JOIN LATERAL (SELECT count(*)::int AS n, count(*) FILTER (WHERE cost_micros IS NULL)::int AS unknown,
                                                            sum(cost_micros)::bigint AS cost, max(metadata->>'traceId') AS trace
                                                       FROM ai_usage_event
                                                      WHERE created_at >= r.created_at - interval '5 minutes'
                                                        AND (metadata->>'improvementAttemptKey' = r.attempt_key OR (r.provider_trace_id IS NOT NULL AND metadata->>'traceId' = r.provider_trace_id))) e
                                         ON e.n > 0 AND e.unknown = 0
                                      WHERE r.environment = $1 AND r.state = 'UNRECONCILED' LIMIT 200`, [environment]);
    for (const a of attente) {
      if ((await settle(Number(a.id), { sent: true, costMicros: Number(a.cost), providerTraceId: a.trace == null ? null : String(a.trace) })) === 'SETTLED') reconciled += 1;
    }
  } catch (e) {
    if (String((e as { code?: string })?.code) !== '42P01') throw e;
  }
  return { markedUnreconciled: marked, reconciled };
}

/**
 * Rapprochement ADMINISTRATIF d'un engagement inconnu (facture fournisseur) ou levée d'une anomalie de sous-estimation
 * après revue (historisé : aucun coût n'est effacé, DATA-06).
 */
export async function adminReconcile(p: { reservationId: number; costMicros?: number | null; currency?: string; resolveUnderestimation?: boolean; userId: number; note: string }): Promise<void> {
  if (!Number.isInteger(p.userId) || p.userId <= 0) throw new Error('administrateur requis');
  const { pgClient } = await import('@/db');
  if (p.costMicros != null) await settle(p.reservationId, { sent: true, costMicros: p.costMicros, currency: p.currency });
  if (p.resolveUnderestimation) {
    await pgClient.unsafe(`UPDATE ai_improvement_budget_reservations SET anomaly_resolved_at = now(), anomaly_resolved_by = $2, anomaly_note = $3, updated_at = now() WHERE id = $1 AND underestimated`,
      [p.reservationId, p.userId, p.note.slice(0, 500)] as never[]);
  }
}

export interface BudgetSummary {
  month: string;
  currency: 'EUR';
  policyVersion: number;
  envelope: { totalEur: number; experimentEur: number; monitorEur: number };
  alerts: { infoEur: number; vigilanceEur: number };
  phases: Record<BudgetPhase, { settledEur: number; reservedEur: number; unreconciledEur: number; remainingEur: number }>;
  totalCommittedEur: number;
  unreconciled: number;
  underestimated: number;
  fx: ImprovementPolicy['fx'];
  blocked: string | null;
  available: boolean;
}

/** Tableau de budget (BO-04, FIN-008). Table absente : budget non initialisé (aucune dépense possible). */
export async function budgetSummary(p: { environment?: string; now?: Date } = {}): Promise<BudgetSummary> {
  const environment = p.environment ?? getAiEnvironment();
  const policy = await loadPolicy(environment);
  const month = budgetMonth(p.now);
  const phases = { EXPERIMENT: { settledEur: 0, reservedEur: 0, unreconciledEur: 0, remainingEur: policy.budget.experimentEur }, MONITOR: { settledEur: 0, reservedEur: 0, unreconciledEur: 0, remainingEur: policy.budget.monitorEur } };
  let unreconciled = 0;
  let underestimated = 0;
  let available = true;
  try {
    const { pgClient } = await import('@/db');
    const r = await rows(pgClient as unknown as Tx,
      `SELECT phase, sum(settled_eur_micros) FILTER (WHERE state = 'SETTLED')::bigint AS settled, sum(max_eur_micros) FILTER (WHERE state = 'RESERVED')::bigint AS reserved,
              sum(max_eur_micros) FILTER (WHERE state = 'UNRECONCILED')::bigint AS unrec
         FROM ai_improvement_budget_reservations WHERE environment = $1 AND budget_month = $2 GROUP BY phase`, [environment, month]);
    for (const x of r) {
      const ph = String(x.phase) as BudgetPhase;
      if (!phases[ph]) continue;
      phases[ph].settledEur = Number(x.settled ?? 0) / MICRO;
      phases[ph].reservedEur = Number(x.reserved ?? 0) / MICRO;
      phases[ph].unreconciledEur = Number(x.unrec ?? 0) / MICRO;
      phases[ph].remainingEur = Math.max(0, (envelopeOf(policy, ph) - Number(x.settled ?? 0) - Number(x.reserved ?? 0) - Number(x.unrec ?? 0)) / MICRO);
    }
    const [b] = await rows(pgClient as unknown as Tx, `SELECT count(*) FILTER (WHERE state = 'UNRECONCILED')::int AS u, count(*) FILTER (WHERE underestimated AND anomaly_resolved_at IS NULL)::int AS s FROM ai_improvement_budget_reservations WHERE environment = $1`, [environment]);
    unreconciled = Number(b?.u ?? 0);
    underestimated = Number(b?.s ?? 0);
  } catch {
    available = false;
  }
  const total = Object.values(phases).reduce((n, x) => n + x.settledEur + x.reservedEur + x.unreconciledEur, 0);
  const blocked = !available ? 'registre budgétaire illisible : aucun appel d’amélioration (fail-closed)'
    : unreconciled || underestimated ? `${unreconciled} coût(s) inconnu(s), ${underestimated} sous-estimation(s) : nouveaux appels bloqués jusqu’au rapprochement`
      : policy.fx.usdToEur == null ? 'taux de conversion USD → EUR À DÉFINIR : aucun appel payant (coût maximum non comparable à l’enveloppe en euros)'
        : policy.costBound.safetyMultiplier == null ? 'marge de sécurité de la borne de coût À DÉFINIR : aucun appel payant' : null;
  return {
    month, currency: 'EUR', policyVersion: policy.version,
    envelope: { totalEur: policy.budget.monthlyEur, experimentEur: policy.budget.experimentEur, monitorEur: policy.budget.monitorEur },
    alerts: { infoEur: policy.budget.infoAlertEur, vigilanceEur: policy.budget.vigilanceAlertEur },
    phases, totalCommittedEur: Math.round(total * 10_000) / 10_000, unreconciled, underestimated, fx: policy.fx, blocked, available,
  };
}

async function raiseBudgetAlert(environment: string, dedupeKey: string, severity: 'info' | 'warning' | 'critical', code: string, message: string, details: Record<string, unknown>): Promise<void> {
  const { raiseAlert } = await import('../alerts/alerts.repository');
  await raiseAlert({ kind: 'budget', code, severity, message, details: { ...details, environment, scope: 'improvement' }, dedupeKey, drilldownHref: '/admin/ai-config#auto-promotion' });
}

/** Alertes 50 € / 75 € (information / vigilance), une fois par mois et par seuil (BUD-02, REC-031). */
export async function evaluateBudgetAlerts(environment: string, month: string, policy: ImprovementPolicy): Promise<string[]> {
  const { pgClient } = await import('@/db');
  const [t] = await rows(pgClient as unknown as Tx,
    `SELECT COALESCE(sum(CASE WHEN state = 'SETTLED' THEN settled_eur_micros WHEN state IN ('RESERVED', 'UNRECONCILED') THEN max_eur_micros ELSE 0 END), 0)::bigint AS n
       FROM ai_improvement_budget_reservations WHERE environment = $1 AND budget_month = $2`, [environment, month]);
  const total = Number(t?.n ?? 0) / MICRO;
  const levees: string[] = [];
  for (const [seuil, sev, code] of [[policy.budget.infoAlertEur, 'info', 'IMPROVEMENT_BUDGET_INFO'], [policy.budget.vigilanceAlertEur, 'warning', 'IMPROVEMENT_BUDGET_VIGILANCE']] as const) {
    if (total >= seuil) {
      await raiseBudgetAlert(environment, `improvement-budget:${environment}:${month}:${seuil}`, sev, code,
        `Budget d’amélioration IA : ${total.toFixed(2)} € engagés en ${month} (seuil ${seuil} €). Information pour l’administrateur — aucun traitement métier n’est suspendu.`, { month, totalEur: total, thresholdEur: seuil });
      levees.push(code);
    }
  }
  return levees;
}

// ══════════════════════════════════════════════════════════════════════════
// Port d'ESSAI pour le moteur de qualification (runner) — réservation avant
// chaque essai d'appel, règlement après (FIN-004).
// ══════════════════════════════════════════════════════════════════════════

export type AttemptReservation =
  | { ok: true; reservationId: number; reused: boolean; state: ReservationState }
  | { ok: false; code: BudgetRefusalCode; message: string };

export interface AttemptBudget {
  reserve(p: {
    attemptKey: string; treatment: Treatment; operationCode: string; model: string; provider?: string;
    variables: unknown; attachments: number; maxOutputTokens: number | null; candidateVersionId: number | null;
  }): Promise<AttemptReservation>;
  settle(reservationId: number, r: { sent: boolean; costMicros: number | null; traceId?: string | null }): Promise<void>;
}

/** Volume d'entrée de référence d'une opération : maximum observé sur 30 jours (appels réussis), null si aucun. */
async function observedMaxInputTokens(operationCode: string): Promise<number | null> {
  try {
    const { pgClient } = await import('@/db');
    const [r] = await rows(pgClient as unknown as Tx,
      `SELECT max(input_tokens)::int AS m FROM ai_usage_event WHERE COALESCE(operation_code, operation_type) = $1 AND status = 'success' AND input_tokens IS NOT NULL AND created_at > now() - interval '30 days'`, [operationCode]);
    return r?.m == null ? null : Number(r.m);
  } catch { return null; }
}

/** Estimation PRUDENTE des jetons d'entrée (pure) : max(historique, variables / 2) + pièces jointes bornées. */
export function estimateInputTokens(p: { observedMax: number | null; variables: unknown; attachments: number; attachmentMaxTokens: number | null }): { tokens: number | null; reason: string | null } {
  if (p.observedMax == null) return { tokens: null, reason: 'aucun historique d’entrée pour cette opération (30 jours) : volume d’entrée non estimable sans risque de sous-estimation' };
  if (p.attachments > 0 && p.attachmentMaxTokens == null) return { tokens: null, reason: 'pièce(s) jointe(s) : jetons maximum par pièce À DÉFINIR PAR ADMINISTRATEUR' };
  let chars = 0;
  try { chars = JSON.stringify(p.variables ?? {}).length; } catch { chars = 0; }
  return { tokens: Math.max(p.observedMax, Math.ceil(chars / 2)) + p.attachments * (p.attachmentMaxTokens ?? 0), reason: null };
}

/** Port réel (base, grille tarifaire, politique administrée). */
export function improvementAttemptBudget(ctx: {
  phase: BudgetPhase; purpose: BudgetPurpose; campaignId: number | null; environment?: string; attemptsPerReservation?: number;
  objectiveOf?: (candidateVersionId: number | null) => number | null; now?: () => Date;
}): AttemptBudget {
  let policyP: Promise<ImprovementPolicy> | null = null;
  const policy = () => (policyP ??= loadPolicy(ctx.environment ?? getAiEnvironment()));
  const hist = new Map<string, Promise<number | null>>();
  return {
    async reserve(p) {
      const pol = await policy();
      const pricing = await import('../gateway/pricing/pricing.repository');
      await pricing.refreshPricingCacheIfStale().catch(() => false);
      const prix = pricing.getCachedPrice(p.provider ?? 'gemini', p.model);
      if (!hist.has(p.operationCode)) hist.set(p.operationCode, observedMaxInputTokens(p.operationCode));
      const entree = estimateInputTokens({ observedMax: await hist.get(p.operationCode)!, variables: p.variables, attachments: p.attachments, attachmentMaxTokens: pol.costBound.attachmentMaxTokens });
      let sortie = p.maxOutputTokens;
      if (sortie == null) {
        const { capabilitiesOf } = await import('../provider/model-capabilities');
        const lim = capabilitiesOf(p.model).outputTokenLimit;
        sortie = typeof lim === 'number' ? lim : null;
      }
      const bound = upperBound({
        price: prix ? { inputMicrosPerToken: Number(prix.inputMicros), outputMicrosPerToken: Number(prix.outputMicros), currency: String(prix.currency ?? 'USD') } : null,
        inputTokens: entree.tokens, maxOutputTokens: sortie, attempts: ctx.attemptsPerReservation ?? 1, policy: pol,
      });
      if (!bound.ok) return { ok: false, code: bound.code, message: entree.reason && bound.code === 'COST_UNKNOWN' && entree.tokens == null ? entree.reason : bound.reason };
      const r = await reserve({
        attemptKey: p.attemptKey, phase: ctx.phase, purpose: ctx.purpose, bound, environment: ctx.environment,
        campaignId: ctx.campaignId, candidateVersionId: p.candidateVersionId, objectiveId: ctx.objectiveOf?.(p.candidateVersionId) ?? null,
        treatment: p.treatment, operationCode: p.operationCode, now: ctx.now?.(),
      }, { policy: pol });
      return r.ok ? r : { ok: false, code: r.code, message: r.message };
    },
    async settle(reservationId, r) {
      await settle(reservationId, { sent: r.sent, costMicros: r.costMicros, providerTraceId: r.traceId ?? null }, { policy: await policy() });
    },
  };
}
