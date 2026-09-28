/**
 * Plafond budgétaire mensuel par compte et alertes de coût — CDC §6.6, §31.3.
 *
 * « Plafond budgétaire configurable par compte et par mois » (§6.6) ;
 * « déclencher une alerte si le coût mensuel d'un compte dépasse le plafond
 * configuré » et « moyenne > 0,005 USD par réponse » (§31.3).
 *
 * Le coût vient de `verebona_ai_runs.estimated_cost_micros`, alimentée par
 * la passerelle à chaque tentative (voir `usage-tracking.service.ts`).
 *
 * Plafond atteint : l'IA est coupée pour le compte jusqu'au mois suivant —
 * les réponses déterministes, la recherche et l'aide continuent (§6.6
 * « limitation temporaire avec message non culpabilisant »). Base
 * injoignable : on n'empêche pas l'usage (échec ouvert, journalisé).
 *
 * Les alertes de plafond sont écrites dans `ai_alerts` (alertes du BO IA,
 * type `budget`), dédupliquées par compte, niveau et mois : elles n'étaient
 * que des `console.warn`, invisibles du tableau de bord. Les alertes de coût
 * moyen (par réponse sur 24 h, par utilisateur actif) sont évaluées toutes
 * les heures par `observability/assistant-alerts.ts` — la moyenne
 * journalière remplace l'ancienne alerte portée sur chaque réponse (§31.3).
 */
import { pgClient } from '@/db';
import { getAssistantConfig } from '../config/assistant-config';
import type { AlertInput } from '@/services/ai/alerts/alerts.repository';

export interface MonthlyBudgetStatus {
  allowed: boolean;
  usedMicros: number;
  limitMicros: number;
  /** true quand la part d'alerte (80 % par défaut) est franchie. */
  alert: boolean;
}

/** Message affiché quand l'IA est suspendue pour le mois — jamais culpabilisant. */
export const MONTHLY_BUDGET_NOTICE =
  'Les réponses rédigées sont momentanément limitées pour votre compte ce mois-ci. '
  + 'La recherche, vos données et le Centre d’aide restent disponibles.';

export function evaluateBudget(usedMicros: number, limitMicros: number, alertRatio: number): MonthlyBudgetStatus {
  if (!limitMicros || limitMicros <= 0) return { allowed: true, usedMicros, limitMicros: 0, alert: false };
  return {
    allowed: usedMicros < limitMicros,
    usedMicros,
    limitMicros,
    alert: usedMicros >= limitMicros * alertRatio,
  };
}

export async function monthlyCostMicros(accountId: number, now = new Date()): Promise<number> {
  const debut = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const rows = (await pgClient.unsafe(
    `SELECT COALESCE(SUM(estimated_cost_micros), 0)::bigint AS total
       FROM verebona_ai_runs WHERE account_id = $1 AND created_at >= $2`,
    [accountId, debut] as never[],
  )) as unknown as Array<{ total: string | number }>;
  return Number(rows[0]?.total ?? 0);
}

export async function checkMonthlyBudget(accountId: number): Promise<MonthlyBudgetStatus> {
  const cfg = getAssistantConfig();
  if (!cfg.monthlyBudgetMicros) return { allowed: true, usedMicros: 0, limitMicros: 0, alert: false };
  let used = 0;
  try {
    used = await monthlyCostMicros(accountId);
  } catch (e) {
    console.warn('[verebona] plafond mensuel non vérifiable — échec ouvert :', (e as Error).message);
    return { allowed: true, usedMicros: 0, limitMicros: cfg.monthlyBudgetMicros, alert: false };
  }
  const status = evaluateBudget(used, cfg.monthlyBudgetMicros, cfg.budgetAlertRatio);
  if (status.alert) await raiseBudgetAlert(accountId, status, cfg.budgetAlertRatio);
  return status;
}

// ── Alertes de plafond (ai_alerts) ─────────────────────────────────────────

type RaiseAlert = (a: AlertInput) => Promise<boolean>;
let raiseAlertImpl: RaiseAlert = async (a) => (await import('@/services/ai/alerts/alerts.repository')).raiseAlert(a);

/** Réservé aux tests : remplace l'écriture dans `ai_alerts` (`null` : la vraie). */
export function setBudgetAlertWriterForTests(fn: RaiseAlert | null): void {
  raiseAlertImpl = fn ?? (async (a) => (await import('@/services/ai/alerts/alerts.repository')).raiseAlert(a));
  dejaSignalees.clear();
}

/** Alertes déjà écrites par ce processus (clé de déduplication) : une écriture par mois, pas par demande. */
const dejaSignalees = new Set<string>();

/**
 * Écrit l'alerte de plafond du compte dans `ai_alerts` : « part d'alerte
 * franchie » (warning) ou « plafond atteint, IA suspendue » (critique).
 * Dédupliquée par compte, niveau et mois. Ne lève jamais : un échec
 * d'écriture est journalisé, sans bloquer la demande.
 */
export async function raiseBudgetAlert(
  accountId: number,
  status: MonthlyBudgetStatus,
  alertRatio: number,
  now = new Date(),
): Promise<boolean> {
  const atteint = !status.allowed;
  const mois = now.toISOString().slice(0, 7);
  const dedupeKey = `assistant:monthly_budget:${atteint ? 'reached' : 'threshold'}:${accountId}:${mois}`;
  if (dejaSignalees.has(dedupeKey)) return false;
  const partUtilisee = status.limitMicros > 0 ? status.usedMicros / status.limitMicros : 0;
  try {
    const nouvelle = await raiseAlertImpl({
      kind: 'budget',
      code: atteint ? 'assistant_monthly_budget_reached' : 'assistant_monthly_budget_threshold',
      treatment: 'T2',
      accountId,
      severity: atteint ? 'critical' : 'warning',
      message: atteint
        ? `Assistant : plafond mensuel du compte ${accountId} atteint (${status.usedMicros} / ${status.limitMicros} micro-unités) — réponses rédigées suspendues jusqu'au mois suivant (§6.6).`
        : `Assistant : ${Math.round(partUtilisee * 100)} % du plafond mensuel du compte ${accountId} consommé (seuil ${Math.round(alertRatio * 100)} %, §31.3).`,
      // Seuils appliqués, tracés avec l'alerte (§31.3).
      details: { usedMicros: status.usedMicros, limitMicros: status.limitMicros, alertRatio, month: mois },
      drilldownHref: `/admin/ai-executions?treatment=T2&accountId=${accountId}`,
      dedupeKey,
    });
    dejaSignalees.add(dedupeKey);
    return nouvelle;
  } catch (e) {
    console.warn(`[verebona][alerte-coût] compte ${accountId} : alerte de plafond non enregistrée (${(e as Error).message}).`);
    return false;
  }
}
