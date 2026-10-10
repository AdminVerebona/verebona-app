/**
 * Client Stripe serveur, garde-fous de mode et version d'API — CDC lookup_key
 * V4 §5.2, LK-07 (module indépendant : aucun import du catalogue de prix, ce
 * qui évite le lien circulaire `stripe.ts` ↔ `stripe-prices.ts`).
 *
 * `@/lib/stripe` réexporte ce module pour les appelants existants.
 * Module SERVEUR uniquement.
 */
import Stripe from 'stripe';

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


/** Version d'API figée (LK-72) : toute montée de version est un chantier distinct. */
export const STRIPE_API_VERSION = '2025-08-27.basil' as const;

/**
 * Contexte de catalogue (LK-02, TC-80) : mode de la clé + environnement
 * applicatif. Les mêmes noms de clés stables existent en test et en live ;
 * objets, caches, registres et journaux ne sont JAMAIS mélangés entre deux
 * contextes. L'identifiant du compte Stripe est vérifié et mémorisé par la
 * synchronisation (`stripe_catalog_state.stripe_account_id`) : un compte
 * différent pour un même contexte (base restaurée, clé d'un autre compte)
 * invalide la photographie au lieu de la réutiliser.
 */
export interface StripeCatalogContext {
  mode: StripeMode | null;
  appEnv: string;
  catalogContext: string;
}

export function getStripeCatalogContext(env: NodeJS.ProcessEnv = process.env): StripeCatalogContext {
  const mode = getStripeKeyMode(env.STRIPE_SECRET_KEY);
  const appEnv = (env.NEXT_PUBLIC_APP_ENV || 'unknown').trim().toLowerCase() || 'unknown';
  return { mode, appEnv, catalogContext: `${mode ?? 'nokey'}:${appEnv}` };
}
