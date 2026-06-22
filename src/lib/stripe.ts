import Stripe from 'stripe';

let stripeClient: Stripe | null = null;

export const getStripeServer = (): Stripe => {
  if (!stripeClient) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not defined');
    stripeClient = new Stripe(secretKey, { apiVersion: '2025-08-27.basil', typescript: true });
  }
  return stripeClient;
};

/**
 * Produits Stripe — 2 produits actifs :
 *
 *   STANDARD : 19 €/an — 2 biens actifs
 *              Price ID : STRIPE_PRICE_STANDARD (price_1TbfzZL7bbQ8HKBXzD1AdNLB)
 *
 *   PREMIUM  : 59 €/an — 1 utilisateur, accès toutes les fonctionnalités
 *              Price ID : STRIPE_PRICE_PREMIUM (price_1Sfp5wL7bbQ8HKBXUop7t7cy)
 *
 *   PREMIUM_DUO : 79 €/an — 2 utilisateurs sur le même compte
 *              Price ID : STRIPE_PRICE_PREMIUM_DUO (price_1TI9U7L7bbQ8HKBX8yBIqnfa)
 *              Abonnement séparé de Premium (sub Stripe indépendant sur duo_accounts)
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

export function isValidPriceId(priceId: string): boolean {
  return Object.values(STRIPE_PRODUCTS).some(p => p.priceId === priceId);
}

export function getTierFromPriceId(priceId: string): 'standard' | 'premium' | 'premium_duo' | null {
  for (const product of Object.values(STRIPE_PRODUCTS)) {
    if (product.priceId === priceId) return product.tier as 'standard' | 'premium' | 'premium_duo';
  }
  return null;
}
