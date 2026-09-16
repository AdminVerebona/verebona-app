import Stripe from 'stripe';
import { resolvePlanFromPriceId } from '@/lib/stripe-prices';

// ══════════════════════════════════════════════════════════════════════════
// MODE STRIPE (TEST / LIVE) — GARDE-FOU
//
// La preprod a tourné avec une clé `sk_live_` alors que ses Price IDs et ses
// clients étaient en mode test, puis l'inverse. Stripe cloisonne strictement
// les deux modes : un objet créé dans l'un est introuvable depuis l'autre
// (« a similar object exists in test mode, but a live mode key was used »).
//
// Le client refuse désormais de s'initialiser si le mode de la clé ne
// correspond pas à l'environnement. Mieux vaut un paiement indisponible et
// un log explicite qu'un client live créé depuis la preprod.
//
// Mode attendu, par ordre de priorité :
//   1. STRIPE_EXPECTED_MODE=test|live      (forçage explicite)
//   2. NEXT_PUBLIC_APP_ENV = production / prod / live  → live
//      NEXT_PUBLIC_APP_ENV = toute autre valeur         → test
//   3. NEXT_PUBLIC_APP_ENV absente → aucun contrôle (avertissement seul)
// ══════════════════════════════════════════════════════════════════════════

export type StripeMode = 'test' | 'live';

const PRODUCTION_ENV_VALUES = ['production', 'prod', 'live'];

export class StripeConfigError extends Error {
  constructor(public code: 'STRIPE_KEY_MISSING' | 'STRIPE_KEY_INVALID' | 'STRIPE_MODE_MISMATCH', message: string) {
    super(message);
    this.name = 'StripeConfigError';
  }
}

/** Mode d'une clé Stripe d'après son préfixe (`sk_`, `rk_`, `pk_`). */
export function getStripeKeyMode(key: string | undefined | null): StripeMode | null {
  if (!key) return null;
  if (/^(sk|rk|pk)_test_/.test(key)) return 'test';
  if (/^(sk|rk|pk)_live_/.test(key)) return 'live';
  return null;
}

/** Mode attendu pour l'environnement courant, ou `null` si indéterminable. */
export function getExpectedStripeMode(env: NodeJS.ProcessEnv = process.env): StripeMode | null {
  const forced = env.STRIPE_EXPECTED_MODE?.trim().toLowerCase();
  if (forced === 'test' || forced === 'live') return forced;

  const appEnv = env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
  if (!appEnv) return null;
  return PRODUCTION_ENV_VALUES.includes(appEnv) ? 'live' : 'test';
}

/**
 * Vérifie la cohérence de la configuration Stripe. Lève `StripeConfigError`
 * si la clé est absente, illisible ou d'un mode différent de celui attendu.
 * Retourne le mode de la clé.
 */
export function assertStripeConfig(env: NodeJS.ProcessEnv = process.env): StripeMode {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new StripeConfigError('STRIPE_KEY_MISSING', 'STRIPE_SECRET_KEY is not defined');
  }

  const keyMode = getStripeKeyMode(secretKey);
  if (!keyMode) {
    throw new StripeConfigError('STRIPE_KEY_INVALID', 'STRIPE_SECRET_KEY has an unknown prefix (expected sk_test_/sk_live_/rk_test_/rk_live_)');
  }

  const expected = getExpectedStripeMode(env);
  if (!expected) {
    console.warn(`[stripe] NEXT_PUBLIC_APP_ENV absente : mode de clé "${keyMode}" non contrôlé.`);
    return keyMode;
  }

  if (keyMode !== expected) {
    throw new StripeConfigError(
      'STRIPE_MODE_MISMATCH',
      `STRIPE_SECRET_KEY est en mode "${keyMode}" alors que l'environnement ` +
      `"${env.NEXT_PUBLIC_APP_ENV ?? '?'}" attend le mode "${expected}".`,
    );
  }

  return keyMode;
}

let stripeClient: Stripe | null = null;
let stripeClientKey: string | null = null;

export const getStripeServer = (): Stripe => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  // Recréer le client si la clé a changé à chaud (rechargement d'env en dev).
  if (!stripeClient || stripeClientKey !== secretKey) {
    assertStripeConfig();
    stripeClient = new Stripe(secretKey!, { apiVersion: '2025-08-27.basil', typescript: true });
    stripeClientKey = secretKey!;
  }
  return stripeClient;
};

/**
 * Produits Stripe — modèle LEGACY à périodicité unique (annuel).
 *
 * ⚠️ Les Price IDs de ce tableau lisent STRIPE_PRICE_STANDARD / _PREMIUM /
 * _PREMIUM_DUO, qui ne sont plus renseignées depuis la tarification V2
 * (6 prix, cf. `@/lib/stripe-prices`). Ne plus comparer un Price ID à
 * `STRIPE_PRODUCTS.X.priceId` : utiliser `getTierFromPriceId`, qui connaît
 * les deux catalogues.
 *
 * Webhook Stripe à configurer sur : POST /api/billing/stripe-webhook
 * Événements requis :
 *   checkout.session.completed
 *   customer.subscription.created
 *   customer.subscription.updated
 *   customer.subscription.deleted
 *   invoice.payment_succeeded
 *   invoice.payment_failed
 */
export const STRIPE_PRODUCTS = {
  STANDARD: {
    priceId: process.env.STRIPE_PRICE_STANDARD || '',
    name: 'Verebona Standard',
    amount: 1900, // 19 € TTC
    currency: 'eur',
    interval: 'year' as const,
    tier: 'standard' as const,
  },
  PREMIUM: {
    priceId: process.env.STRIPE_PRICE_PREMIUM || '',
    name: 'Verebona Premium',
    amount: 5900, // 59 € TTC
    currency: 'eur',
    interval: 'year' as const,
    tier: 'premium' as const,
  },
  PREMIUM_DUO: {
    priceId: process.env.STRIPE_PRICE_PREMIUM_DUO || '',
    name: 'Verebona Premium Duo',
    amount: 7900, // 79 € TTC
    currency: 'eur',
    interval: 'year' as const,
    tier: 'premium_duo' as const,
  },
} as const;

export type PlanTier = 'standard' | 'premium' | 'premium_duo';

/**
 * Offre correspondant à un Price ID : catalogue V2 (6 prix) d'abord,
 * puis anciens prix annuels pour les abonnements souscrits avant la V2.
 */
export function getTierFromPriceId(priceId: string | null | undefined): PlanTier | null {
  if (!priceId) return null;
  const v2 = resolvePlanFromPriceId(priceId);
  if (v2) return v2.planCode;
  for (const product of Object.values(STRIPE_PRODUCTS)) {
    if (product.priceId && product.priceId === priceId) return product.tier;
  }
  return null;
}

export function isValidPriceId(priceId: string): boolean {
  return getTierFromPriceId(priceId) !== null;
}
