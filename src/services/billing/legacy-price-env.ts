/**
 * DOUBLE LECTURE DE TRANSITION — variables de prix historiques (CDC lookup_key
 * V4, LK-82, LK-89, D10).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * À QUOI CELA SERT, ET JUSQU'À QUAND
 *
 * Avant ce lot, les six prix V2 étaient désignés par `STRIPE_PRICE_*_MONTHLY
 * / _YEARLY`, et les trois prix annuels historiques par `STRIPE_PRICE_STANDARD
 * / _PREMIUM / _PREMIUM_DUO`. Ces neuf variables ne sont PLUS une dépendance
 * de fonctionnement :
 *   - elles servent de PREUVE lors de la reprise historique automatique
 *     (identifiants configurés par l'exploitant → produits approuvés,
 *     versions inscrites au registre, clé stable initialisée si absente) ;
 *   - tant que la reprise n'a pas tourné (premier démarrage), elles évitent
 *     qu'un abonnement existant soit « inconnu ».
 * Une fois la reprise faite (BO › Exploitation › Catalogue Stripe : « Reprise
 * historique : terminée »), elles peuvent être SUPPRIMÉES de l'environnement
 * (D10) : un démarrage sans elles fonctionne (TC-73), les anciens identifiants
 * restent dans le registre `stripe_price_versions`.
 *
 * Aucun montant n'est déduit de ces variables : la reconnaissance vérifie
 * toujours l'objet Stripe ou le registre.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { BillingPeriod, PlanCode } from '@/lib/billing/plan-catalog';

export interface LegacyPriceVar {
  name: string;
  planCode: PlanCode;
  /** `null` : prix annuel du modèle à périodicité unique (avant V2). */
  billingPeriod: BillingPeriod | null;
  generation: 'v2' | 'legacy';
}

export const LEGACY_PRICE_VARS: readonly LegacyPriceVar[] = [
  { name: 'STRIPE_PRICE_STANDARD_MONTHLY', planCode: 'standard', billingPeriod: 'monthly', generation: 'v2' },
  { name: 'STRIPE_PRICE_STANDARD_YEARLY', planCode: 'standard', billingPeriod: 'yearly', generation: 'v2' },
  { name: 'STRIPE_PRICE_PREMIUM_MONTHLY', planCode: 'premium', billingPeriod: 'monthly', generation: 'v2' },
  { name: 'STRIPE_PRICE_PREMIUM_YEARLY', planCode: 'premium', billingPeriod: 'yearly', generation: 'v2' },
  { name: 'STRIPE_PRICE_PREMIUM_DUO_MONTHLY', planCode: 'premium_duo', billingPeriod: 'monthly', generation: 'v2' },
  { name: 'STRIPE_PRICE_PREMIUM_DUO_YEARLY', planCode: 'premium_duo', billingPeriod: 'yearly', generation: 'v2' },
  { name: 'STRIPE_PRICE_STANDARD', planCode: 'standard', billingPeriod: null, generation: 'legacy' },
  { name: 'STRIPE_PRICE_PREMIUM', planCode: 'premium', billingPeriod: null, generation: 'legacy' },
  { name: 'STRIPE_PRICE_PREMIUM_DUO', planCode: 'premium_duo', billingPeriod: null, generation: 'legacy' },
];

export interface LegacyPriceRef extends LegacyPriceVar { priceId: string }

/** Identifiants encore présents dans l'environnement (lecture seule). */
export function legacyPriceRefs(env: NodeJS.ProcessEnv = process.env): LegacyPriceRef[] {
  return LEGACY_PRICE_VARS.flatMap((v) => {
    const priceId = env[v.name]?.trim();
    return priceId ? [{ ...v, priceId }] : [];
  });
}

/** Référence de transition d'un identifiant, ou `null`. */
export function findLegacyPriceRef(priceId: string, env: NodeJS.ProcessEnv = process.env): LegacyPriceRef | null {
  return legacyPriceRefs(env).find((r) => r.priceId === priceId) ?? null;
}

/** Prix V2 configuré pour un couple (amorçage de la révision active seulement). */
export function legacyV2PriceFor(plan: PlanCode, period: BillingPeriod, env: NodeJS.ProcessEnv = process.env): string | null {
  return legacyPriceRefs(env).find((r) => r.generation === 'v2' && r.planCode === plan && r.billingPeriod === period)?.priceId ?? null;
}
