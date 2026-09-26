/**
 * Évaluateur des garde-fous — CDC BO IA T1-UI-09, T3-UI-06, T4-UI-05, SCR-02
 * (« catalogue prédéfini, seuil, réaction alerte/suspension »), MOD-011.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI MANQUAIT
 *
 * Les garde-fous étaient choisis, seuillés, versionnés — et aucun code ne les
 * lisait. Cet évaluateur tourne périodiquement (boucleur, toutes les cinq
 * minutes, une seule instance) : pour chaque traitement, il lit les
 * garde-fous de la version EFFECTIVE, mesure la grandeur correspondante dans
 * la télémétrie, et applique la réaction configurée.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MESURES — chacune sur une grandeur DÉJÀ tracée (règle du catalogue)
 *
 *   consecutive_failures : appels en échec consécutifs les plus récents
 *                          (`ai_usage_event`, statut) ;
 *   invalid_output_rate  : % d'appels rejetés par le schéma (`INVALID_OUTPUT`)
 *                          sur la dernière heure ;
 *   fallback_rate        : % d'appels réussis servis par un fallback sur la
 *                          dernière heure ;
 *   daily_cost           : coût cumulé du jour, en euros ;
 *   execution_duration   : durée maximale (s) d'une exécution de file close
 *                          dans la dernière heure (T1, T3, T4).
 * Les taux exigent un échantillon minimal : deux échecs sur trois appels ne
 * sont pas « 66 % de sorties invalides », c'est du bruit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÉACTIONS
 *
 * « alerte » : une alerte (dédupliquée par fenêtre) — rien n'est interrompu.
 * « suspension » : le traitement passe SUSPENDED (motif « garde-fou … ») SANS
 * interrompre les exécutions en cours (MOD-011) et SANS sonde automatique :
 * c'est une décision de configuration, la levée est manuelle (bouton
 * « Réactiver ») — contrairement au disjoncteur, qui se réarme seul.
 */
import type { Treatment } from '../config/treatments';
import { TREATMENTS, TREATMENT_DEFINITIONS } from '../config/treatments';
import type { GuardrailSetting } from '../config/config-types';

export interface GuardrailMetrics {
  consecutiveFailures: number;
  /** Appels de la dernière heure (dénominateur des taux). */
  callsLastHour: number;
  invalidOutputsLastHour: number;
  /** Appels RÉUSSIS de la dernière heure, et ceux servis par un fallback. */
  successesLastHour: number;
  fallbacksLastHour: number;
  dailyCostMicros: number;
  /** `null` : traitement hors file, ou aucune exécution close sur la fenêtre. */
  maxExecutionSeconds: number | null;
}

/** Échantillon minimal pour qu'un taux soit interprétable. */
export const MIN_RATE_SAMPLE = 20;

export interface GuardrailVerdict {
  code: string;
  value: number | null;
  threshold: number;
  breached: boolean;
}

/** Évaluation pure d'un garde-fou (testée sans base). */
export function evaluateGuardrail(g: GuardrailSetting, m: GuardrailMetrics): GuardrailVerdict {
  const verdict = (value: number | null): GuardrailVerdict => ({
    code: g.code, value, threshold: g.threshold, breached: value !== null && value >= g.threshold,
  });
  switch (g.code) {
    case 'consecutive_failures':
      return verdict(m.consecutiveFailures);
    case 'invalid_output_rate':
      return verdict(m.callsLastHour >= MIN_RATE_SAMPLE
        ? Math.round((m.invalidOutputsLastHour / m.callsLastHour) * 1000) / 10 : null);
    case 'fallback_rate':
      return verdict(m.successesLastHour >= MIN_RATE_SAMPLE
        ? Math.round((m.fallbacksLastHour / m.successesLastHour) * 1000) / 10 : null);
    case 'daily_cost':
      return verdict(m.dailyCostMicros / 1_000_000);
    case 'execution_duration':
      return verdict(m.maxExecutionSeconds);
    default:
      // Code hors catalogue : la validation l'aurait refusé ; rien à affirmer.
      return verdict(null);
  }
}

/** Fenêtre de déduplication d'une alerte : le jour pour le coût, l'heure sinon. */
export function alertWindow(code: string, now: Date = new Date()): string {
  const iso = now.toISOString();
  return code === 'daily_cost' ? iso.slice(0, 10) : iso.slice(0, 13);
}

/** Lien préfiltré vers les exécutions responsables. */
export function guardrailDrilldown(treatment: Treatment, code: string): string {
  const q = new URLSearchParams({ treatment });
  if (code === 'consecutive_failures' || code === 'invalid_output_rate') q.set('errorsOnly', '1');
  if (code === 'fallback_rate') q.set('rank', 'fallback');
  return code === 'execution_duration' ? `/admin/ai-queue?treatment=${treatment}` : `/admin/ai-executions?${q}`;
}

// ── Branchement base ────────────────────────────────────────────────────────

export interface GuardrailDeps {
  loadGuardrails(t: Treatment): Promise<GuardrailSetting[]>;
  measure(t: Treatment): Promise<GuardrailMetrics>;
  raiseAlert: typeof import('./alerts.repository').raiseAlert;
  suspend(t: Treatment, reason: string): Promise<boolean>;
}

async function measureFromDb(t: Treatment): Promise<GuardrailMetrics> {
  const { pgClient } = await import('@/db');
  const useCase = TREATMENT_DEFINITIONS[t].useCaseCode;
  const [agg] = (await pgClient.unsafe(
    `SELECT
       COUNT(*) FILTER (WHERE created_at > NOW() - interval '1 hour')::int AS calls,
       COUNT(*) FILTER (WHERE created_at > NOW() - interval '1 hour' AND error_code = 'INVALID_OUTPUT')::int AS invalid,
       COUNT(*) FILTER (WHERE created_at > NOW() - interval '1 hour' AND status = 'success')::int AS ok,
       COUNT(*) FILTER (WHERE created_at > NOW() - interval '1 hour' AND status = 'success'
                          AND (model_rank IN ('fallback_1', 'fallback_2') OR is_fallback))::int AS fallbacks,
       COALESCE(SUM(cost_micros) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)::bigint AS cost
     FROM ai_usage_event
    WHERE use_case_code = $1 AND created_at > LEAST(NOW() - interval '1 hour', date_trunc('day', NOW()))`,
    [useCase] as never[],
  )) as unknown as Array<Record<string, unknown>>;

  // Échecs consécutifs : série d'erreurs en tête des 200 derniers appels.
  const [consec] = (await pgClient.unsafe(
    `WITH derniers AS (
       SELECT status, ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS rn
         FROM ai_usage_event WHERE use_case_code = $1
        ORDER BY created_at DESC, id DESC LIMIT 200)
     SELECT COALESCE(MIN(rn) FILTER (WHERE status = 'success') - 1,
                     (SELECT COUNT(*) FROM derniers))::int AS n
       FROM derniers`,
    [useCase] as never[],
  )) as unknown as Array<{ n: number }>;

  let maxExecutionSeconds: number | null = null;
  if (TREATMENT_DEFINITIONS[t].batch) {
    const [d] = (await pgClient.unsafe(
      `SELECT MAX(EXTRACT(EPOCH FROM (finished_at - started_at)))::float AS s
         FROM ai_job_queue
        WHERE treatment = $1 AND status IN ('DONE', 'FAILED')
          AND started_at IS NOT NULL AND finished_at > NOW() - interval '1 hour'`,
      [t] as never[],
    )) as unknown as Array<{ s: number | null }>;
    maxExecutionSeconds = d?.s == null ? null : Math.round(Number(d.s));
  }

  return {
    consecutiveFailures: Number(consec?.n ?? 0),
    callsLastHour: Number(agg?.calls ?? 0),
    invalidOutputsLastHour: Number(agg?.invalid ?? 0),
    successesLastHour: Number(agg?.ok ?? 0),
    fallbacksLastHour: Number(agg?.fallbacks ?? 0),
    dailyCostMicros: Number(agg?.cost ?? 0),
    maxExecutionSeconds,
  };
}

/**
 * Suspension par garde-fou : SANS requeue des exécutions en cours (MOD-011),
 * SANS sonde (`suspended_by_breaker = FALSE`). N'écrase pas un état déjà
 * posé (désactivé à la main, ou déjà suspendu).
 */
async function suspendFromDb(t: Treatment, reason: string): Promise<boolean> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `INSERT INTO ai_treatment_state (treatment, state, suspended_reason, suspended_at, updated_at)
     VALUES ($1, 'SUSPENDED', $2, NOW(), NOW())
     ON CONFLICT (treatment) DO UPDATE SET
       state = 'SUSPENDED', suspended_reason = EXCLUDED.suspended_reason,
       suspended_at = NOW(), updated_by = NULL, updated_at = NOW()
     WHERE ai_treatment_state.state = 'ENABLED'
     RETURNING treatment`,
    [t, reason] as never[],
  )) as unknown as unknown[];
  if (rows.length > 0) {
    const { invalidateRuntimeGuardCache } = await import('../queue/runnable-guard');
    invalidateRuntimeGuardCache();
    return true;
  }
  return false;
}

const defaultDeps: GuardrailDeps = {
  async loadGuardrails(t) {
    const { resolveTreatmentConfig } = await import('../config/config-resolver');
    return (await resolveTreatmentConfig(t))?.guardrails ?? [];
  },
  measure: measureFromDb,
  raiseAlert: async (a) => (await import('./alerts.repository')).raiseAlert(a),
  suspend: suspendFromDb,
};

export interface GuardrailReport {
  treatment: Treatment;
  verdict: GuardrailVerdict;
  reaction: GuardrailSetting['reaction'];
  suspended: boolean;
}

/** Un passage d'évaluation sur tous les traitements. Ne lève jamais. */
export async function evaluateGuardrails(
  deps: GuardrailDeps = defaultDeps,
  now: Date = new Date(),
): Promise<GuardrailReport[]> {
  const out: GuardrailReport[] = [];
  for (const t of TREATMENTS) {
    try {
      const guardrails = await deps.loadGuardrails(t);
      if (guardrails.length === 0) continue;
      const metrics = await deps.measure(t);
      for (const g of guardrails) {
        const verdict = evaluateGuardrail(g, metrics);
        if (!verdict.breached) continue;
        let suspended = false;
        if (g.reaction === 'suspension') {
          suspended = await deps.suspend(t, `garde-fou « ${g.code} » franchi (${verdict.value} ≥ ${g.threshold})`);
        }
        await deps.raiseAlert({
          kind: 'guardrail',
          code: g.code,
          treatment: t,
          severity: g.reaction === 'suspension' ? 'critical' : 'warning',
          message: `${t} — garde-fou « ${g.code} » franchi : ${verdict.value} ≥ ${g.threshold}`
            + (suspended ? ' — traitement suspendu.' : '.'),
          details: { value: verdict.value, threshold: g.threshold, reaction: g.reaction, suspended },
          drilldownHref: guardrailDrilldown(t, g.code),
          dedupeKey: `guardrail:${t}:${g.code}:${alertWindow(g.code, now)}`,
        });
        out.push({ treatment: t, verdict, reaction: g.reaction, suspended });
      }
    } catch (e) {
      console.error(`[guardrails] évaluation ${t} impossible (non bloquant) :`, (e as Error).message);
    }
  }
  return out;
}
