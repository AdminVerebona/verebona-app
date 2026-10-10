/**
 * Types et gardes des offres souscriptibles (réexports) — CDC lookup_key V4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PLUS AUCUNE RÉSOLUTION PAR VARIABLE D'ENVIRONNEMENT
 *
 * `resolvePriceId`, `resolvePlanFromPriceId`, `expectedAmountCents` et
 * `PRICE_CATALOG` lisaient six variables `STRIPE_PRICE_*` et des montants
 * codés en dur (EC-01, EC-02, EC-05, EC-12). Ils sont retirés :
 *   - prix de VENTE : `resolveCurrentPrice` (services/billing/price-catalog.service.ts),
 *     révision active résolue par `lookup_key` et relue chez Stripe avant
 *     tout paiement ;
 *   - reconnaissance d'un prix HISTORIQUE : `resolveHistoricalPrice`
 *     (services/billing/price-history.service.ts), registre durable ;
 *   - montants : manifeste unique `services/billing/pricing-manifest.ts`.
 * Les variables historiques ne sont plus lues que par la double lecture de
 * transition (`services/billing/legacy-price-env.ts`), à retirer en D10.
 * ══════════════════════════════════════════════════════════════════════════
 */
export {
  type PlanCode,
  type BillingPeriod,
  PLAN_RANK,
  isPlanCode,
  isBillingPeriod,
  isUpgrade,
} from '@/lib/billing/plan-catalog';
