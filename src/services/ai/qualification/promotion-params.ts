/**
 * Lot 105B — PARAMÈTRES de la promotion automatique IA (préproduction), en UN
 * seul endroit : revalidation d'activation, relances après blocage A1,
 * surveillance post-activation (fenêtre, seuils, attribution, rejeu des cas
 * certifiés). Aucune règle en dur ailleurs.
 *
 * Valeurs par défaut prudentes ; surcharge par variable d'hébergeur, lue et
 * BORNÉE ici (une valeur hors bornes ou illisible garde le défaut). Aucun
 * paramètre ne peut abaisser une exigence de qualité ni le verrou A1 : ils
 * règlent des délais, des volumes et des seuils de DÉTECTION de dégradation.
 */

export interface PromotionParams {
  version: string;
  gate: {
    /** Âge maximal d'une décision A1 pour servir à une activation (au-delà : réévaluation exigée). */
    maxAssessmentAgeMs: number;
  };
  relaunch: {
    /** Relances automatiques au plus par candidate bloquée A1 (au-delà : décision humaine). */
    maxPerCandidate: number;
  };
  watch: {
    /** Durée de la fenêtre de surveillance après une activation automatique. */
    windowMs: number;
    /** Appels minimum (après ET avant) pour conclure sur un signal d'usage ; en dessous : données insuffisantes. */
    minCalls: number;
    /** Hausse ABSOLUE minimale du taux de sorties refusées par les contrôles serveur (0,05 = 5 points). */
    invalidRateIncrease: number;
    /** Hausse absolue minimale du taux d'indisponibilité (erreurs fournisseur / modèle). */
    errorRateIncrease: number;
    /** Dégradation relative du P95 de latence déclenchant une ALERTE (jamais un retour arrière seul). */
    latencyAlertRatio: number;
    /** Dégradation relative du coût par résultat valide déclenchant une ALERTE. */
    costAlertRatio: number;
    /** Rejeu des cas certifiés après activation : délai depuis l'activation (0 : désactivé). */
    replayAfterMs: number;
    /** Régressions certifiées (cas réussi par l'ancienne version, en ÉCHEC avec la candidate) pour conclure. */
    minCertifiedRegressions: number;
    /** Rejeux au plus par activation. */
    maxReplays: number;
  };
}

const HOUR = 3_600_000;

export const PROMOTION_PARAMS_DEFAULTS: PromotionParams = Object.freeze({
  version: 'promotion-ia-v1',
  gate: { maxAssessmentAgeMs: 6 * HOUR },
  relaunch: { maxPerCandidate: 5 },
  watch: {
    windowMs: 72 * HOUR, minCalls: 20, invalidRateIncrease: 0.05, errorRateIncrease: 0.05,
    latencyAlertRatio: 0.3, costAlertRatio: 0.3, replayAfterMs: 12 * HOUR, minCertifiedRegressions: 1, maxReplays: 1,
  },
}) as PromotionParams;

/** Variables d'hébergeur reconnues (documentées dans docs/exploitation/promotion-automatique-ia.md). */
export const PROMOTION_ENV = {
  watchHours: 'AI_PROMOTION_WATCH_HOURS',
  minCalls: 'AI_PROMOTION_WATCH_MIN_CALLS',
  replayAfterHours: 'AI_PROMOTION_REPLAY_AFTER_HOURS',
  maxRelaunches: 'AI_PROMOTION_MAX_A1_RELAUNCHES',
} as const;

function borne(raw: string | undefined, min: number, max: number): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Paramètres effectifs (défauts + surcharges bornées). */
export function promotionParams(vars: Record<string, string | undefined> = process.env): PromotionParams {
  const d = PROMOTION_PARAMS_DEFAULTS;
  const h = borne(vars[PROMOTION_ENV.watchHours], 1, 24 * 14);
  const m = borne(vars[PROMOTION_ENV.minCalls], 5, 10_000);
  const r = borne(vars[PROMOTION_ENV.replayAfterHours], 0, 24 * 14);
  const x = borne(vars[PROMOTION_ENV.maxRelaunches], 0, 50);
  return {
    ...d,
    relaunch: { maxPerCandidate: x ?? d.relaunch.maxPerCandidate },
    watch: {
      ...d.watch,
      windowMs: h != null ? h * HOUR : d.watch.windowMs,
      minCalls: m ?? d.watch.minCalls,
      replayAfterMs: r != null ? r * HOUR : d.watch.replayAfterMs,
    },
  };
}
