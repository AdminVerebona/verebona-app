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
 * Les alertes sont des journaux `[verebona][alerte-coût]` destinés à la
 * supervision (un cron d'alerting global relève d'un autre lot).
 */
import { pgClient } from '@/db';
import { getAssistantConfig } from '../config/assistant-config';

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
  if (!status.allowed) {
    console.warn(`[verebona][alerte-coût] compte ${accountId} : plafond mensuel atteint (${used} / ${status.limitMicros} micro-unités) — IA suspendue jusqu'au mois suivant (§6.6).`);
  } else if (status.alert) {
    console.warn(`[verebona][alerte-coût] compte ${accountId} : ${Math.round((used / status.limitMicros) * 100)} % du plafond mensuel consommé (§31.3).`);
  }
  return status;
}

/** Alerte « coût par réponse » (§31.3 : > 0,005 USD par défaut). */
export function alertIfCostlyResponse(accountId: number, requestId: string, costMicros: number | null): boolean {
  if (costMicros == null) return false;
  const seuil = getAssistantConfig().costAlertPerResponseUsd * 1_000_000;
  if (seuil > 0 && costMicros > seuil) {
    console.warn(`[verebona][alerte-coût] demande ${requestId} (compte ${accountId}) : ${costMicros} micro-unités > seuil ${seuil} (§31.3).`);
    return true;
  }
  return false;
}
