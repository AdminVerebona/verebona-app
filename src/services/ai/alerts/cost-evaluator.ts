/**
 * Budgets et anomalies de coût — CDC BO IA COST-010 à COST-014, CST-UI-08,
 * CST-UI-09, WF-22, WF-44.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RIEN ICI N'ARRÊTE UN TRAITEMENT (COST-013)
 *
 * Budgets et anomalies produisent des ALERTES (Dashboard + Coûts), avec un
 * lien vers les exécutions responsables. Aucune suspension, aucun
 * ralentissement : c'est la règle la plus répétée du SCR-09.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BUDGETS (COST-010)
 *
 * Global et par traitement, MENSUELS (mois calendaire, UTC) : c'est la
 * période de facturation du fournisseur, donc celle où un dépassement a un
 * sens. Paramètre local à l'environnement, non versionné (`ai_cost_settings`).
 * Pas de budget par compte en V1. Seules les dépenses MÉTIER (is_billable)
 * sont comptées : sondes et tests sont techniques (COST-006).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ANOMALIES (COST-011, COST-012, COST-014, WF-44)
 *
 * Évaluées une fois par jour, sur la DERNIÈRE JOURNÉE COMPLÈTE, contre une
 * ligne de base des 28 jours précédents. Signaux : coût total, coût moyen par
 * appel, volume d'appels, taux de fallback, et coût par compte (un compte
 * coûteux est identifié sans budget dédié, COST-014).
 *
 * L'algorithme est fixé dans le code, sans réglage (COST-012 : « activer/
 * désactiver, pas de tuning statistique ») :
 *   · baseline insuffisante (moins de 14 jours observés) → AUCUNE anomalie
 *     (WF-44 : « ne pas produire de fausse anomalie ») ;
 *   · anomalie si la valeur dépasse moyenne + 3 écarts-types ET 1,5 × la
 *     moyenne ET un plancher absolu (un passage de 2 à 5 centimes n'est pas
 *     un incident).
 */
import { TREATMENTS, TREATMENT_DEFINITIONS, type Treatment } from '../config/treatments';

export const MIN_BASELINE_DAYS = 14;
export const BASELINE_DAYS = 28;
const SIGMAS = 3;
const MIN_RATIO = 1.5;

export interface AnomalyVerdict {
  anomalous: boolean;
  /** `false` : baseline trop courte pour conclure. */
  enoughBaseline: boolean;
  mean: number;
  std: number;
  value: number;
}

/** Détection pure (testée sans base). `floor` : valeur absolue minimale. */
export function detectAnomaly(history: number[], value: number, floor = 0): AnomalyVerdict {
  const n = history.length;
  const mean = n > 0 ? history.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? history.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(variance);
  const enoughBaseline = n >= MIN_BASELINE_DAYS;
  const anomalous = enoughBaseline
    && value >= floor
    && value > mean + SIGMAS * std
    && value >= MIN_RATIO * mean
    && value > 0;
  return { anomalous, enoughBaseline, mean, std, value };
}

export interface BudgetVerdict {
  scope: string;
  budgetMicros: number;
  spentMicros: number;
  exceeded: boolean;
}

/** Budgets dépassés (pur). Un budget `null` n'est pas surveillé. */
export function evaluateBudgets(
  budgets: Array<{ scope: string; monthlyBudgetMicros: number | null }>,
  spentByScope: Record<string, number>,
): BudgetVerdict[] {
  return budgets
    .filter((b): b is { scope: string; monthlyBudgetMicros: number } => b.monthlyBudgetMicros != null)
    .map((b) => {
      const spent = spentByScope[b.scope] ?? 0;
      return { scope: b.scope, budgetMicros: b.monthlyBudgetMicros, spentMicros: spent, exceeded: spent > b.monthlyBudgetMicros };
    });
}

/** Expression SQL : traitement d'une ligne `ai_usage_event` (e.use_case_code). */
export function treatmentCaseSql(alias = 'e'): string {
  const whens = TREATMENTS.map((t) => `WHEN '${TREATMENT_DEFINITIONS[t].useCaseCode}' THEN '${t}'`).join(' ');
  return `CASE ${alias}.use_case_code ${whens} ELSE NULL END`;
}

/**
 * Montant lisible. Les coûts sont stockés dans la devise de la grille
 * tarifaire (USD, cf. écran Coûts) : le budget est saisi dans la même unité,
 * pour être comparable sans conversion.
 */
const euros = (micros: number) => `${(micros / 1_000_000).toFixed(2)} $`;

// ── Base ────────────────────────────────────────────────────────────────────

type Raise = typeof import('./alerts.repository').raiseAlert;

async function raiseDefault(...args: Parameters<Raise>): ReturnType<Raise> {
  return (await import('./alerts.repository')).raiseAlert(...args);
}

export interface CostSettings {
  budgets: Array<{ scope: string; monthlyBudgetMicros: number | null }>;
  anomaliesEnabled: boolean;
}

export async function getCostSettings(): Promise<CostSettings> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT scope, monthly_budget_micros FROM ai_cost_settings`, [] as never[],
  )) as unknown as Array<{ scope: string; monthly_budget_micros: string | number | null }>;
  const [a] = (await pgClient.unsafe(
    `SELECT enabled FROM ai_cost_anomaly_settings WHERE id = TRUE`, [] as never[],
  )) as unknown as Array<{ enabled: boolean }>;
  const byScope = new Map(rows.map((r) => [r.scope, r.monthly_budget_micros == null ? null : Number(r.monthly_budget_micros)]));
  return {
    budgets: ['global', ...TREATMENTS].map((scope) => ({ scope, monthlyBudgetMicros: byScope.get(scope) ?? null })),
    anomaliesEnabled: a ? Boolean(a.enabled) : true,
  };
}

export async function saveCostSettings(
  input: { budgets?: Array<{ scope: string; monthlyBudgetMicros: number | null }>; anomaliesEnabled?: boolean },
  userId: number,
): Promise<void> {
  const { pgClient } = await import('@/db');
  const scopes = new Set(['global', ...TREATMENTS]);
  for (const b of input.budgets ?? []) {
    if (!scopes.has(b.scope)) throw new Error(`Périmètre de budget inconnu : ${b.scope}`);
    if (b.monthlyBudgetMicros != null && (!Number.isFinite(b.monthlyBudgetMicros) || b.monthlyBudgetMicros < 0)) {
      throw new Error(`Budget invalide pour ${b.scope}.`);
    }
    await pgClient.unsafe(
      `INSERT INTO ai_cost_settings (scope, monthly_budget_micros, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (scope) DO UPDATE SET monthly_budget_micros = EXCLUDED.monthly_budget_micros,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [b.scope, b.monthlyBudgetMicros == null ? null : Math.round(b.monthlyBudgetMicros), userId] as never[],
    );
  }
  if (typeof input.anomaliesEnabled === 'boolean') {
    await pgClient.unsafe(
      `INSERT INTO ai_cost_anomaly_settings (id, enabled, updated_by, updated_at) VALUES (TRUE, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [input.anomaliesEnabled, userId] as never[],
    );
  }
}

/** Budgets : dépense métier du mois calendaire en cours, par périmètre. */
export async function evaluateBudgetAlerts(now: Date = new Date(), raise: Raise = raiseDefault): Promise<BudgetVerdict[]> {
  const { pgClient } = await import('@/db');
  const settings = await getCostSettings();
  if (!settings.budgets.some((b) => b.monthlyBudgetMicros != null)) return [];
  const rows = (await pgClient.unsafe(
    `SELECT ${treatmentCaseSql('e')} AS t, COALESCE(SUM(e.cost_micros), 0)::bigint AS spent
       FROM ai_usage_event e
      WHERE e.is_billable AND e.created_at >= date_trunc('month', NOW())
      GROUP BY 1`,
    [] as never[],
  )) as unknown as Array<{ t: string | null; spent: string | number }>;
  const spent: Record<string, number> = { global: 0 };
  for (const r of rows) {
    spent.global += Number(r.spent);
    if (r.t) spent[r.t] = (spent[r.t] ?? 0) + Number(r.spent);
  }
  const month = now.toISOString().slice(0, 7);
  const verdicts = evaluateBudgets(settings.budgets, spent);
  for (const v of verdicts.filter((x) => x.exceeded)) {
    await raise({
      kind: 'budget',
      code: 'budget_exceeded',
      treatment: v.scope === 'global' ? null : v.scope,
      severity: 'warning',
      message: `Budget ${v.scope === 'global' ? 'global' : v.scope} dépassé pour ${month} : `
        + `${euros(v.spentMicros)} dépensés pour ${euros(v.budgetMicros)} prévus. Aucun traitement n'est interrompu.`,
      details: { month, ...v },
      drilldownHref: v.scope === 'global' ? '/admin/ai-costs?period=month' : `/admin/ai-costs?period=month&treatment=${v.scope}`,
      dedupeKey: `budget:${v.scope}:${month}`,
    });
  }
  return verdicts;
}

interface DayRow { day: string; cost: number; calls: number; ok: number; fallbacks: number }

/** Anomalies : dernière journée complète contre les 28 jours précédents. */
export async function evaluateAnomalyAlerts(now: Date = new Date(), raise: Raise = raiseDefault): Promise<number> {
  const { pgClient } = await import('@/db');
  const settings = await getCostSettings();
  if (!settings.anomaliesEnabled) return 0;

  const series = (await pgClient.unsafe(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COALESCE(SUM(cost_micros) FILTER (WHERE is_billable), 0)::bigint AS cost,
            COUNT(*) FILTER (WHERE is_billable)::int AS calls,
            COUNT(*) FILTER (WHERE status = 'success')::int AS ok,
            COUNT(*) FILTER (WHERE status = 'success' AND (model_rank IN ('fallback_1', 'fallback_2') OR is_fallback))::int AS fallbacks
       FROM ai_usage_event
      WHERE created_at >= date_trunc('day', NOW()) - ($1 || ' days')::interval
        AND created_at < date_trunc('day', NOW())
      GROUP BY 1 ORDER BY 1`,
    [String(BASELINE_DAYS + 1)] as never[],
  )) as unknown as Array<Record<string, unknown>>;
  const days: DayRow[] = series.map((r) => ({
    day: String(r.day), cost: Number(r.cost), calls: Number(r.calls), ok: Number(r.ok), fallbacks: Number(r.fallbacks),
  }));
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const last = days.find((d) => d.day === yesterday);
  if (!last) return 0;
  const history = days.filter((d) => d.day < yesterday);

  let raised = 0;
  const check = async (code: string, label: string, hist: number[], value: number, floor: number, fmt: (n: number) => string, href: string) => {
    const v = detectAnomaly(hist, value, floor);
    if (!v.anomalous) return;
    const ok = await raise({
      kind: 'anomaly', code, severity: 'warning',
      message: `Anomalie ${label} le ${yesterday} : ${fmt(value)} contre ${fmt(v.mean)} en moyenne sur ${hist.length} jours.`,
      details: { day: yesterday, value, mean: v.mean, std: v.std, baselineDays: hist.length },
      drilldownHref: href,
      dedupeKey: `anomaly:${code}:${yesterday}`,
    });
    if (ok) raised++;
  };
  const drill = `/admin/ai-executions?from=${yesterday}&to=${yesterday}`;
  await check('total_cost', 'de coût total', history.map((d) => d.cost), last.cost, 1_000_000, euros, drill);
  await check('cost_per_call', 'de coût moyen par appel',
    history.filter((d) => d.calls > 0).map((d) => d.cost / d.calls), last.calls > 0 ? last.cost / last.calls : 0, 1_000,
    (n) => `${(n / 1_000_000).toFixed(4)} $`, drill);
  await check('volume', 'de volume d\'appels', history.map((d) => d.calls), last.calls, 50, (n) => `${Math.round(n)} appels`, drill);
  await check('fallback_rate', 'de taux de fallback',
    history.filter((d) => d.ok >= 20).map((d) => (d.fallbacks / d.ok) * 100), last.ok >= 20 ? (last.fallbacks / last.ok) * 100 : 0, 10,
    (n) => `${n.toFixed(1)} %`, `${drill}&rank=fallback`);

  // COST-014 : compte coûteux, sans budget par compte. Seuls les comptes
  // dont la dépense d'hier dépasse le plancher sont examinés.
  const accounts = (await pgClient.unsafe(
    `WITH hier AS (
       SELECT account_id, SUM(cost_micros)::bigint AS cost FROM ai_usage_event
        WHERE is_billable AND created_at >= $1::date AND created_at < $1::date + 1
        GROUP BY account_id HAVING SUM(cost_micros) >= 500000
        ORDER BY 2 DESC LIMIT 20)
     SELECT h.account_id, h.cost,
            COALESCE((SELECT array_agg(c ORDER BY d) FROM (
               SELECT date_trunc('day', created_at) AS d, SUM(cost_micros)::bigint AS c
                 FROM ai_usage_event
                WHERE is_billable AND account_id = h.account_id
                  AND created_at >= $1::date - ($2 || ' days')::interval AND created_at < $1::date
                GROUP BY 1) s), '{}') AS hist
       FROM hier h`,
    [yesterday, String(BASELINE_DAYS)] as never[],
  )) as unknown as Array<{ account_id: number; cost: string | number; hist: Array<string | number> }>;
  for (const a of accounts) {
    // Jours sans dépense comptés à zéro : un compte habituellement muet qui
    // dépense soudain est précisément ce que COST-014 veut voir.
    const observed = (a.hist ?? []).map(Number);
    const hist = [...observed, ...Array(Math.max(0, BASELINE_DAYS - observed.length)).fill(0)];
    const v = detectAnomaly(hist, Number(a.cost), 500_000);
    if (!v.anomalous) continue;
    const ok = await raise({
      kind: 'anomaly', code: 'account_cost', accountId: Number(a.account_id), severity: 'warning',
      message: `Compte ${a.account_id} : ${euros(Number(a.cost))} dépensés le ${yesterday}, contre ${euros(v.mean)} par jour en moyenne.`,
      details: { day: yesterday, value: Number(a.cost), mean: v.mean, std: v.std },
      drilldownHref: `/admin/ai-executions?accountId=${a.account_id}&from=${yesterday}&to=${yesterday}`,
      dedupeKey: `anomaly:account_cost:${a.account_id}:${yesterday}`,
    });
    if (ok) raised++;
  }
  return raised;
}

/** Traitement couvert par un budget (pour l'affichage). */
export function budgetScopes(): Array<'global' | Treatment> {
  return ['global', ...TREATMENTS];
}
