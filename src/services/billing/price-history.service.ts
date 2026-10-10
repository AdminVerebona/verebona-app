/**
 * Reconnaissance des prix courants ET historiques — CDC lookup_key V4 §7.4,
 * LK-17, LK-21, LK-65 à LK-67, TC-15 à TC-20.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN ANCIEN PRIX N'EST JAMAIS « INCONNU » PARCE QU'IL N'EST PLUS VENDU
 *
 * La clé stable peut avoir été transférée, retirée, ou n'avoir jamais existé
 * sur un ancien Price : cela ne rend pas le contrat inconnu. L'ordre :
 *   1. registre `stripe_price_versions` (correspondance déjà validée) ;
 *   2. Price exact relu chez Stripe, MÊME INACTIF : contexte (mode),
 *      périodicité, et produit APPROUVÉ pour une offre ;
 *   3. double lecture de transition : identifiant encore présent dans une
 *      variable STRIPE_PRICE_* (preuve configurée par l'exploitant).
 * L'égalité de montant, le nom commercial, des métadonnées seules ou le
 * préfixe `price_` ne suffisent JAMAIS (§7.4). Un prix reconnu est inscrit au
 * registre ; les anciens montants (19/59/79, 29/59/89) ne l'invalident pas.
 *
 * Le résultat est une UNION EXPLICITE : reconnu, inconnu, incohérent,
 * indisponibilité technique. Pas de `null` ambigu (§5.3) : un appelant ne
 * peut pas marquer un paiement « synchronisé » sur un prix non rapproché.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { getStripeServer, getStripeCatalogContext, getStripeKeyMode } from '@/lib/stripe-client';
import {
  lookupKeyFor,
  periodOfInterval,
  planFromMetadataValue,
  type BillingPeriod,
  type PlanCode,
} from '@/lib/billing/plan-catalog';
import { priceRevisionOf, productIdOf, type TaxBehavior } from './catalog-types';
import { pgCatalogStore, type CatalogStore, type PriceVersionRow } from './catalog-store';
import { findLegacyPriceRef } from './legacy-price-env';

export type HistoricalPriceResult =
  | {
      status: 'recognized';
      priceId: string;
      planCode: PlanCode;
      billingPeriod: BillingPeriod;
      /** `null` seulement en double lecture de transition sans accès Stripe. */
      unitAmountCents: number | null;
      currency: string | null;
      productId: string | null;
      source: 'registry' | 'stripe' | 'legacy-env';
    }
  | { status: 'unknown'; priceId: string | null; reason: string }
  | { status: 'inconsistent'; priceId: string; reason: string }
  | { status: 'unavailable'; priceId: string; reason: string };

export interface HistoryDeps {
  store: CatalogStore;
  stripe: () => Pick<Stripe, 'prices'>;
  context: () => { catalogContext: string; mode: 'test' | 'live' | null };
  env: NodeJS.ProcessEnv;
}

const defaultDeps = (): HistoryDeps => ({
  store: pgCatalogStore,
  stripe: getStripeServer,
  context: () => getStripeCatalogContext(),
  env: process.env,
});

/** Erreur réseau / indisponibilité Stripe, à distinguer d'un objet absent. */
export function isStripeTransient(error: unknown): boolean {
  const e = error as { type?: string; code?: string; statusCode?: number; name?: string };
  if (e?.name === 'StripeConfigError') return true;
  if (e?.type === 'StripeConnectionError' || e?.type === 'StripeAPIError' || e?.type === 'StripeRateLimitError') return true;
  return typeof e?.statusCode === 'number' && (e.statusCode >= 500 || e.statusCode === 429);
}

export function isStripeMissing(error: unknown): boolean {
  const e = error as { code?: string; statusCode?: number };
  return e?.code === 'resource_missing' || e?.statusCode === 404;
}

export function versionRowFrom(
  price: Stripe.Price,
  planCode: PlanCode,
  billingPeriod: BillingPeriod,
  ctx: { catalogContext: string },
  source: string,
  stripeAccountId: string | null = null,
): PriceVersionRow {
  const taxBehavior = (price.tax_behavior ?? 'unspecified') as TaxBehavior;
  const interval = billingPeriod === 'monthly' ? 'month' : 'year';
  return {
    catalogContext: ctx.catalogContext,
    stripeAccountId,
    livemode: price.livemode,
    stripePriceId: price.id,
    stripeProductId: productIdOf(price) ?? 'unknown',
    planCode,
    billingPeriod,
    logicalLookupKey: lookupKeyFor(planCode, billingPeriod),
    observedLookupKey: price.lookup_key ?? null,
    unitAmountCents: price.unit_amount ?? 0,
    currency: (price.currency ?? 'eur').toLowerCase(),
    interval,
    intervalCount: price.recurring?.interval_count ?? 1,
    taxBehavior,
    priceRevision: priceRevisionOf({ priceId: price.id, unitAmountCents: price.unit_amount ?? 0, currency: 'eur', interval, intervalCount: 1, taxBehavior }),
    stripeActive: price.active,
    source,
  };
}

/**
 * Classe un Price Stripe déjà relu (pur, hors inscription). `approved` :
 * produits approuvés du contexte. `legacyPlan` : preuve de transition.
 */
export function classifyFetchedPrice(
  price: Stripe.Price,
  approved: Array<{ planCode: PlanCode; stripeProductId: string }>,
  opts: { mode: 'test' | 'live' | null; legacyPlan?: PlanCode | null },
): { ok: true; planCode: PlanCode; billingPeriod: BillingPeriod; viaLegacy: boolean } | { ok: false; status: 'unknown' | 'inconsistent'; reason: string } {
  if (opts.mode && price.livemode !== (opts.mode === 'live')) {
    return { ok: false, status: 'inconsistent', reason: 'WRONG_MODE' };
  }
  const period = periodOfInterval(price.recurring?.interval, price.recurring?.interval_count);
  if (!price.recurring || !period) return { ok: false, status: 'inconsistent', reason: 'UNSUPPORTED_INTERVAL' };
  const productId = productIdOf(price);
  const match = approved.find((a) => a.stripeProductId === productId);
  const planCode = match?.planCode ?? opts.legacyPlan ?? null;
  if (!planCode) return { ok: false, status: 'unknown', reason: 'PRODUCT_NOT_APPROVED' };
  if (match && opts.legacyPlan && opts.legacyPlan !== match.planCode) {
    return { ok: false, status: 'inconsistent', reason: 'LEGACY_PLAN_CONFLICT' };
  }
  const metaPlan = planFromMetadataValue(price.metadata?.verebona_plan);
  if (price.metadata?.verebona_plan && metaPlan !== planCode) return { ok: false, status: 'inconsistent', reason: 'METADATA_CONFLICT' };
  if (price.metadata?.verebona_period && price.metadata.verebona_period !== period) {
    return { ok: false, status: 'inconsistent', reason: 'METADATA_CONFLICT' };
  }
  return { ok: true, planCode, billingPeriod: period, viaLegacy: !match };
}

/**
 * Reconnaît un prix par son identifiant (union explicite, voir l'en-tête).
 * `source` : origine de l'inscription au registre (webhook, reprise…).
 */
export async function resolveHistoricalPrice(
  priceId: string | null | undefined,
  options: { source?: string; price?: Stripe.Price | null } = {},
  deps: HistoryDeps = defaultDeps(),
): Promise<HistoricalPriceResult> {
  if (!priceId) return { status: 'unknown', priceId: null, reason: 'NO_PRICE' };
  const ctx = deps.context();

  const known = await deps.store.findPriceVersion(ctx.catalogContext, priceId);
  if (known) {
    return {
      status: 'recognized', priceId, planCode: known.planCode, billingPeriod: known.billingPeriod,
      unitAmountCents: known.unitAmountCents, currency: known.currency, productId: known.stripeProductId, source: 'registry',
    };
  }

  const legacy = findLegacyPriceRef(priceId, deps.env);
  let price: Stripe.Price | null = options.price && typeof options.price.product !== 'undefined' ? options.price : null;
  if (!price) {
    try {
      price = await deps.stripe().prices.retrieve(priceId, { expand: ['product'] });
    } catch (error) {
      if (legacy) return legacyRecognized(priceId, legacy.planCode, legacy.billingPeriod);
      if (isStripeMissing(error)) return { status: 'unknown', priceId, reason: 'PRICE_NOT_FOUND' };
      return { status: 'unavailable', priceId, reason: (error as Error)?.message?.slice(0, 200) ?? 'STRIPE_UNAVAILABLE' };
    }
  }

  const approved = await deps.store.listApprovedProducts(ctx.catalogContext);
  const verdict = classifyFetchedPrice(price, approved, { mode: ctx.mode, legacyPlan: legacy?.planCode ?? null });
  if (!verdict.ok) return { status: verdict.status, priceId, reason: verdict.reason } as HistoricalPriceResult;

  if (verdict.viaLegacy) {
    // Preuve de transition : le produit de ce prix devient reconnu pour
    // l'historique (jamais éligible à la vente par ce seul fait, LK-03).
    const productId = productIdOf(price);
    if (productId) {
      await deps.store.approveProduct(ctx.catalogContext, {
        planCode: verdict.planCode, stripeProductId: productId, role: 'historical', source: 'legacy-env', livemode: price.livemode,
      });
    }
  }
  await deps.store.upsertPriceVersion(versionRowFrom(price, verdict.planCode, verdict.billingPeriod, ctx, options.source ?? 'reconciliation'));
  return {
    status: 'recognized', priceId, planCode: verdict.planCode, billingPeriod: verdict.billingPeriod,
    unitAmountCents: price.unit_amount ?? null, currency: price.currency ?? null, productId: productIdOf(price),
    source: verdict.viaLegacy ? 'legacy-env' : 'stripe',
  };
}

function legacyRecognized(priceId: string, planCode: PlanCode, billingPeriod: BillingPeriod | null): HistoricalPriceResult {
  return {
    status: 'recognized', priceId, planCode,
    // Ancien modèle à périodicité unique : annuel.
    billingPeriod: billingPeriod ?? 'yearly',
    unitAmountCents: null, currency: null, productId: null, source: 'legacy-env',
  };
}

/** Prérésolution groupée (registre des factures, reprise) : une entrée par identifiant. */
export async function resolveHistoricalPrices(
  priceIds: Array<string | null | undefined>,
  options: { source?: string } = {},
  deps?: HistoryDeps,
): Promise<Map<string, HistoricalPriceResult>> {
  const out = new Map<string, HistoricalPriceResult>();
  for (const id of new Set(priceIds.filter((v): v is string => Boolean(v)))) {
    out.set(id, await resolveHistoricalPrice(id, options, deps));
  }
  return out;
}

/** Item principal Verebona d'un abonnement (LK-73) : exactement un item reconnu. */
export async function primaryItem(sub: Stripe.Subscription, source: string): Promise<{ item: Stripe.SubscriptionItem; result: Extract<HistoricalPriceResult, { status: 'recognized' }> } | { error: 'NONE' | 'MULTIPLE' | 'UNAVAILABLE' }> {
  const recognized: Array<{ item: Stripe.SubscriptionItem; result: Extract<HistoricalPriceResult, { status: 'recognized' }> }> = [];
  let unavailable = false;
  for (const item of sub.items.data) {
    const r = await resolveHistoricalPrice(item.price?.id, { source, price: item.price });
    if (r.status === 'recognized') recognized.push({ item, result: r });
    if (r.status === 'unavailable') unavailable = true;
  }
  if (recognized.length === 1) return recognized[0];
  if (recognized.length > 1) return { error: 'MULTIPLE' };
  return { error: unavailable ? 'UNAVAILABLE' : 'NONE' };
}

/**
 * Prix non rapprochable lors d'une synchronisation (LK-66) : l'erreur est
 * LEVÉE (webhook en échec → Stripe relivre ; anomalie conservée), jamais un
 * `null` qui laisserait l'événement marqué traité.
 */
export class PriceRecognitionError extends Error {
  constructor(public readonly code: 'UNKNOWN_HISTORICAL_PRICE' | 'STRIPE_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'PriceRecognitionError';
  }
}

/** Mode du contexte courant (utilitaire de diagnostic). */
export function currentMode(): 'test' | 'live' | null {
  return getStripeKeyMode(process.env.STRIPE_SECRET_KEY);
}
