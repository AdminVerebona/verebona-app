/**
 * Lot 100B — LIMITES TECHNIQUES des campagnes de qualification, réglables
 * sans changer le code (ticket #601 ; arbitrage A4 : AUCUN plafond financier
 * mensuel, traçage complet des coûts — `certification/repository.costRows`).
 *
 * Variables Scalingo (préproduction), bornées ; absentes ou invalides : valeur
 * du code (`thresholds.ts`) :
 *   AI_QUALIF_MAX_RETRIES       nouveaux essais après une erreur fournisseur transitoire (0 à 3 ; code : 1)
 *   AI_QUALIF_CONCURRENCY       appels simultanés par traitement (1 à 3 ; code : 2 en file, 3 pour T2 / T6)
 *   AI_QUALIF_MAX_COUPLES       couples au plus par campagne automatique (1 à 100 ; code : 24)
 *   AI_QUALIF_OBSERVATIONS      observations par cas en campagne automatique (2 à 5 ; code : 2 — une mesure isolée ne prouve jamais un gain)
 *
 * Ce sont des limites d'EXÉCUTION : elles ne changent pas la version des
 * seuils (aucune preuve n'est rendue obsolète) ; elles ne peuvent jamais
 * abaisser une exigence de qualité. Une concurrence réduite abaisse d'autant
 * la simultanéité visée par l'essai de concurrence (même borne des deux côtés).
 */
import type { QualificationThresholds } from './thresholds';

const borne = (name: string, min: number, max: number): number | null => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export interface RuntimeLimits { maxRetries: number; concurrency: number | null; maxCouples: number; observationsAuto: number; source: Record<string, 'code' | 'env'> }

export function runtimeLimits(th: QualificationThresholds): RuntimeLimits {
  const r = borne('AI_QUALIF_MAX_RETRIES', 0, 3);
  const c = borne('AI_QUALIF_CONCURRENCY', 1, 3);
  const m = borne('AI_QUALIF_MAX_COUPLES', 1, 100);
  const o = borne('AI_QUALIF_OBSERVATIONS', 2, 5);
  return {
    maxRetries: r ?? th.transientRetries, concurrency: c, maxCouples: m ?? th.campaign.maxCouplesPerCampaign, observationsAuto: o ?? th.campaign.observationsAuto,
    source: { maxRetries: r == null ? 'code' : 'env', concurrency: c == null ? 'code' : 'env', maxCouples: m == null ? 'code' : 'env', observationsAuto: o == null ? 'code' : 'env' },
  };
}

/** Seuils effectifs d'exécution (même version : limites techniques seulement). */
export function withRuntimeLimits(th: QualificationThresholds): QualificationThresholds {
  const l = runtimeLimits(th);
  const cap = (n: number) => (l.concurrency == null ? n : Math.min(n, l.concurrency));
  return {
    ...th,
    transientRetries: l.maxRetries,
    concurrency: { ...th.concurrency, queuedPerTreatment: cap(th.concurrency.queuedPerTreatment), synchronousSimultaneous: cap(th.concurrency.synchronousSimultaneous), queuedPerWorker: Math.max(cap(th.concurrency.queuedPerTreatment), cap(th.concurrency.queuedPerWorker)) },
    campaign: { ...th.campaign, maxCouplesPerCampaign: l.maxCouples, observationsAuto: l.observationsAuto },
  };
}
