/**
 * Lot 105B — SURVEILLANCE POST-ACTIVATION par SIGNAUX MÉTIER VÉRIFIABLES
 * (ticket P1 « IA auto-amélioration », §5 ; recette R8). Préproduction.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Après une activation automatique (candidate de modèle 86A ou révision de
 * prompt 99B), la surveillance INVALID_OUTPUT existante est COMPLÉTÉE par :
 *   · contrôles serveur existants : taux de sorties refusées (schéma, contrat
 *     d'exécution) — attribution EXACTE par `ai_usage_event.config_version_id`
 *     (appels servis SOUS la candidate, comparés à ceux servis sous la
 *     configuration précédente ; appels de qualification exclus) ;
 *   · disponibilité : taux d'erreurs fournisseur / modèle (même attribution) ;
 *   · latence P95 et coût par résultat valide : ALERTE seulement (jamais un
 *     retour arrière à eux seuls) ;
 *   · CAS CERTIFIÉS REJOUÉS (campagne POST_CHECK) : ancienne configuration ↔
 *     candidate, MÊMES cas, même campagne — une « régression certifiée » est un
 *     cas obligatoire RÉUSSI par l'ancienne version et en ÉCHEC avec la
 *     candidate : l'imputation à la candidate est alors démontrée (un défaut
 *     commun aux deux versions n'est jamais imputé).
 * Décision (pure, `assessPostActivation`) : retour arrière seulement si une
 * dégradation IMPUTABLE est démontrée ; données insuffisantes, anomalie non
 * imputable ou candidate déjà remplacée par un humain → jamais de retour
 * arrière abusif. Fenêtre, volumes et seuils : `promotion-params.ts`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Treatment } from '../config/treatments';
import type { NonRegressionAssessment } from './non-regression';
import { promotionParams, type PromotionParams } from './promotion-params';

type Row = Record<string, unknown>;
type Query = (text: string, params: unknown[]) => Promise<Row[]>;

export interface UsageWindow {
  calls: number;
  success: number;
  /** Sorties refusées par les contrôles serveur (schéma, contrat d'exécution). */
  invalid: number;
  /** Erreurs fournisseur / modèle (indisponibilité), hors refus de contrôle et blocages volontaires. */
  providerErrors: number;
  p95Ms: number | null;
  costPerValid: number | null;
}

export const EMPTY_USAGE: UsageWindow = Object.freeze({ calls: 0, success: 0, invalid: 0, providerErrors: 0, p95Ms: null, costPerValid: null }) as UsageWindow;

const CONTROL_CODES = ['INVALID_OUTPUT', 'RUNTIME_CONTRACT_MISMATCH'];

/** Signaux d'usage attribués EXACTEMENT à une version de configuration, sur une période (lecture seule). */
export async function usageSignals(p: { operations: readonly string[]; versionId: number | null; from: Date; to: Date; query?: Query }): Promise<UsageWindow> {
  if (!p.versionId || !p.operations.length || p.to <= p.from) return { ...EMPTY_USAGE };
  const query: Query = p.query ?? (async (t, params) => {
    const { pgClient } = await import('@/db');
    return (await pgClient.unsafe(t, params as never[])) as unknown as Row[];
  });
  try {
    const [r] = await query(
      `SELECT count(*)::int AS calls,
              count(*) FILTER (WHERE status = 'success')::int AS success,
              count(*) FILTER (WHERE status <> 'success' AND error_code = ANY($5::text[]))::int AS invalid,
              count(*) FILTER (WHERE status = 'error' AND COALESCE(error_code, '') <> ALL($5::text[]))::int AS provider_errors,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status = 'success' AND duration_ms IS NOT NULL) AS p95,
              sum(cost_micros) FILTER (WHERE cost_micros IS NOT NULL)::bigint AS cost,
              count(*) FILTER (WHERE cost_micros IS NULL)::int AS unknown_cost
         FROM ai_usage_event
        WHERE operation_code = ANY($1::text[]) AND config_version_id = $2 AND created_at >= $3::timestamptz AND created_at < $4::timestamptz
          AND COALESCE(metadata->>'trigger', '') <> 'qualification'`,
      [[...p.operations], p.versionId, p.from.toISOString(), p.to.toISOString(), CONTROL_CODES],
    );
    const success = Number(r?.success ?? 0);
    return {
      calls: Number(r?.calls ?? 0), success, invalid: Number(r?.invalid ?? 0), providerErrors: Number(r?.provider_errors ?? 0),
      p95Ms: r?.p95 == null ? null : Number(r.p95),
      costPerValid: success && Number(r?.unknown_cost ?? 0) === 0 && r?.cost != null ? Number(r.cost) / success : null,
    };
  } catch {
    return { ...EMPTY_USAGE };
  }
}

/** Régressions CERTIFIÉES d'un rejeu : cas obligatoire réussi par l'ancienne version, en échec avec la candidate. */
export function certifiedRegressions(a: NonRegressionAssessment | null): Array<{ operationCode: string; caseId: string; defects: string[] }> {
  if (!a) return [];
  return a.operations.flatMap((o) => o.regressions.filter((x) => x.mandatory && x.reference === 'PASSED' && x.candidate === 'FAILED')
    .map((x) => ({ operationCode: o.operationCode, caseId: x.caseId, defects: x.defects })));
}

export type SignalOutcome = 'DEGRADED' | 'ALERT' | 'OK' | 'INSUFFICIENT';
export interface Signal { code: string; label: string; outcome: SignalOutcome; imputable: boolean; detail: string }
export type PostVerdict = 'DEGRADED_IMPUTABLE' | 'ALERT' | 'OK' | 'INSUFFICIENT_DATA' | 'NOT_IMPUTABLE';

export interface ReplayResult {
  campaignId: number | null;
  status: string;
  /** null : rejeu non concluant (campagne refusée, prérequis…) — jamais une conclusion. */
  regressions: Array<{ operationCode: string; caseId: string; defects: string[] }> | null;
  reason: string | null;
}

/**
 * Décision post-activation (pure). `candidateActive` : la candidate est toujours la configuration servie (sinon un
 * humain a choisi autre chose : rien n'est imputé, aucun retour arrière).
 */
export function assessPostActivation(p: {
  before: UsageWindow; after: UsageWindow; replay: ReplayResult | null; candidateActive: boolean; params?: PromotionParams['watch'];
}): { verdict: PostVerdict; rollback: boolean; signals: Signal[]; reasons: string[] } {
  const w = p.params ?? promotionParams().watch;
  if (!p.candidateActive) {
    return { verdict: 'NOT_IMPUTABLE', rollback: false, signals: [], reasons: ['candidate remplacée (choix humain ou autre activation) : aucune dégradation ne lui est imputée, aucun retour arrière'] };
  }
  const signals: Signal[] = [];
  const assez = p.after.calls >= w.minCalls && p.before.calls >= w.minCalls;
  const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
  const taux = (n: number, d: number) => (d ? n / d : 0);
  if (!assez) {
    signals.push({ code: 'USAGE', label: 'signaux d’usage', outcome: 'INSUFFICIENT', imputable: false, detail: `${p.after.calls} appel(s) sous la candidate, ${p.before.calls} sous la version précédente (minimum ${w.minCalls} de chaque côté)` });
  } else {
    const iA = taux(p.after.invalid, p.after.calls);
    const iB = taux(p.before.invalid, p.before.calls);
    signals.push({
      code: 'SERVER_CONTROLS', label: 'sorties refusées par les contrôles serveur', imputable: true,
      outcome: p.after.invalid >= 2 && iA - iB >= w.invalidRateIncrease ? 'DEGRADED' : 'OK',
      detail: `${pct(iA)} sous la candidate (${p.after.invalid}/${p.after.calls}) contre ${pct(iB)} avant (${p.before.invalid}/${p.before.calls}) ; seuil +${pct(w.invalidRateIncrease)}`,
    });
    const eA = taux(p.after.providerErrors, p.after.calls);
    const eB = taux(p.before.providerErrors, p.before.calls);
    signals.push({
      code: 'AVAILABILITY', label: 'disponibilité (erreurs fournisseur / modèle)', imputable: true,
      outcome: p.after.providerErrors >= 2 && eA - eB >= w.errorRateIncrease ? 'DEGRADED' : 'OK',
      detail: `${pct(eA)} d’erreurs sous la candidate contre ${pct(eB)} avant ; seuil +${pct(w.errorRateIncrease)}`,
    });
    if (p.after.p95Ms != null && p.before.p95Ms) {
      const r = p.after.p95Ms / p.before.p95Ms;
      signals.push({ code: 'LATENCY', label: 'latence P95', imputable: true, outcome: r > 1 + w.latencyAlertRatio ? 'ALERT' : 'OK', detail: `P95 ${Math.round(p.after.p95Ms)} ms contre ${Math.round(p.before.p95Ms)} ms (alerte au-delà de +${pct(w.latencyAlertRatio)})` });
    }
    if (p.after.costPerValid != null && p.before.costPerValid) {
      const r = p.after.costPerValid / p.before.costPerValid;
      signals.push({ code: 'COST', label: 'coût par résultat valide', imputable: true, outcome: r > 1 + w.costAlertRatio ? 'ALERT' : 'OK', detail: `rapport ${r.toFixed(2)} (alerte au-delà de +${pct(w.costAlertRatio)})` });
    }
  }
  if (p.replay) {
    if (p.replay.regressions == null) {
      signals.push({ code: 'CERTIFIED_REPLAY', label: 'cas certifiés rejoués', outcome: 'INSUFFICIENT', imputable: false, detail: `rejeu non concluant (${p.replay.reason ?? p.replay.status}) : aucune conclusion` });
    } else {
      const n = p.replay.regressions.length;
      signals.push({
        code: 'CERTIFIED_REPLAY', label: 'cas certifiés rejoués', imputable: true, outcome: n >= w.minCertifiedRegressions ? 'DEGRADED' : 'OK',
        detail: n ? `${n} régression(s) certifiée(s) — réussi(s) par l’ancienne version, en échec avec la candidate : ${p.replay.regressions.slice(0, 5).map((x) => `${x.operationCode}/${x.caseId}`).join(', ')}` : 'aucune régression certifiée sur les mêmes cas',
      });
    }
  }
  const degrades = signals.filter((s) => s.outcome === 'DEGRADED' && s.imputable);
  const alertes = signals.filter((s) => s.outcome === 'ALERT');
  const concluants = signals.filter((s) => s.outcome !== 'INSUFFICIENT');
  const verdict: PostVerdict = degrades.length ? 'DEGRADED_IMPUTABLE' : alertes.length ? 'ALERT' : concluants.length ? 'OK' : 'INSUFFICIENT_DATA';
  return {
    verdict, rollback: verdict === 'DEGRADED_IMPUTABLE', signals,
    reasons: degrades.length ? degrades.map((s) => `${s.label} : ${s.detail}`) : alertes.map((s) => `${s.label} : ${s.detail}`),
  };
}

/**
 * Évaluation complète d'une candidate activée (signaux d'usage attribués + rejeu des cas certifiés si dû).
 * Le rejeu est au plus `maxReplays` fois par activation, après `replayAfterMs` (0 : désactivé).
 */
export async function evaluatePostActivation(p: {
  treatment: Treatment; operations: readonly string[]; candidateVersionId: number; previousVersionId: number | null;
  activatedAt: Date; now: Date; replaysDone: number; candidateActive: boolean;
  replay?: (x: { treatment: Treatment; candidateVersionId: number; referenceVersionId: number; reason: string }) => Promise<{ campaignId: number | null; status: string; refusal: string | null; assessment: NonRegressionAssessment | null }>;
  query?: Query; params?: PromotionParams['watch'];
}): Promise<{ assessment: ReturnType<typeof assessPostActivation>; before: UsageWindow; after: UsageWindow; replay: ReplayResult | null }> {
  const w = p.params ?? promotionParams().watch;
  const ecoule = Math.max(60_000, p.now.getTime() - p.activatedAt.getTime());
  const after = await usageSignals({ operations: p.operations, versionId: p.candidateVersionId, from: p.activatedAt, to: new Date(p.now.getTime() + 1000), query: p.query });
  const before = await usageSignals({ operations: p.operations, versionId: p.previousVersionId, from: new Date(p.activatedAt.getTime() - Math.max(ecoule, 7 * 86_400_000)), to: p.activatedAt, query: p.query });
  let replay: ReplayResult | null = null;
  const du = w.replayAfterMs > 0 && p.replaysDone < w.maxReplays && p.previousVersionId != null && p.candidateActive && p.now.getTime() - p.activatedAt.getTime() >= w.replayAfterMs;
  if (du) {
    const run = p.replay ?? (async (x) => (await import('./campaign')).requestPostActivationReplay(x));
    try {
      const r = await run({ treatment: p.treatment, candidateVersionId: p.candidateVersionId, referenceVersionId: p.previousVersionId!, reason: `Contrôle post-activation de la candidate ${p.candidateVersionId} : rejeu des cas certifiés (ancienne configuration ${p.previousVersionId} ↔ candidate).` });
      const concluant = r.status === 'COMPLETED' && r.assessment != null;
      replay = { campaignId: r.campaignId, status: r.status, regressions: concluant ? certifiedRegressions(r.assessment) : null, reason: concluant ? null : r.refusal ?? r.status };
    } catch (e) {
      replay = { campaignId: null, status: 'FAILED', regressions: null, reason: (e as Error).message.slice(0, 300) };
    }
  }
  return { assessment: assessPostActivation({ before, after, replay, candidateActive: p.candidateActive, params: w }), before, after, replay };
}
