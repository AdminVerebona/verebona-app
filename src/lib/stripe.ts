/**
 * Point d'entrée historique du client Stripe : réexporte `@/lib/stripe-client`
 * (LK-07). Le catalogue LEGACY à périodicité unique (`STRIPE_PRODUCTS`) et les
 * résolveurs inverses fondés sur les variables d'environnement
 * (`getTierFromPriceId`, `isValidPriceId`) ont été RETIRÉS (CDC lookup_key V4,
 * EC-02, LK-65, LK-89) : la reconnaissance d'un prix passe par le registre
 * historique (`services/billing/price-history.service.ts`).
 *
 * Webhook Stripe à configurer sur : POST /api/billing/stripe-webhook
 * Événements requis : voir `docs/exploitation/stripe-catalogue-lookup-key.md`.
 */
export * from '@/lib/stripe-client';

export type PlanTier = 'standard' | 'premium' | 'premium_duo';
