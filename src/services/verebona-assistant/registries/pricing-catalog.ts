/**
 * Catalogue de prix des modèles — CDC §15.9.
 *
 * Les prix sont des DONNÉES D'EXPLOITATION, pas des règles fonctionnelles : ils ne
 * sont jamais codés dans les services métier. Ce catalogue est versionné et sert à
 * estimer le coût, comparer, mettre à jour et détecter une dérive.
 *
 * ⚠️ Les tarifs Gemini doivent être revérifiés avant CHAQUE mise en production
 *    (cf. « Références techniques » du CDC — https://ai.google.dev/gemini-api/docs/pricing).
 */

export const PRICING_CATALOG_VERSION = 'pricing-catalog-v1.0' as const;

export interface ModelPrice {
  modelId: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  effectiveFrom: string; // ISO
}

export const PRICING: Record<string, ModelPrice> = {
  'gemini-2.5-flash-lite': {
    modelId: 'gemini-2.5-flash-lite',
    inputPerMTokUsd: 0.10,
    outputPerMTokUsd: 0.40,
    effectiveFrom: '2026-07-16',
  },
  'gemini-3.1-flash-lite': {
    modelId: 'gemini-3.1-flash-lite',
    inputPerMTokUsd: 0.10,   // TODO(§15.9) : revérifier au catalogue Gemini avant prod
    outputPerMTokUsd: 0.40,
    effectiveFrom: '2026-07-16',
  },
};

/** Coût estimé en micro-USD (entier) pour un appel. */
export function estimateCostMicros(modelId: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[modelId];
  if (!p) return 0;
  const usd =
    (inputTokens / 1_000_000) * p.inputPerMTokUsd +
    (outputTokens / 1_000_000) * p.outputPerMTokUsd;
  return Math.round(usd * 1_000_000);
}
