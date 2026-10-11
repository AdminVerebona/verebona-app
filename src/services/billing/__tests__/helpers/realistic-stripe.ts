/**
 * Compte Stripe SIMULÉ « réaliste » (lot 36B) — reproduit les règles Stripe
 * qui comptent pour l'amorçage du catalogue, absentes de la doublure du lot
 * 35C :
 *   - une `lookup_key` est UNIQUE dans le compte, même portée par un prix
 *     ARCHIVÉ ; la poser sans `transfer_lookup_key` sur un autre prix échoue ;
 *   - `prices.list` filtre réellement `lookup_keys`, `active`, `type`,
 *     `currency`, `product` ; sans `active`, renvoie aussi les archivés ;
 *   - produits avec ou sans métadonnées, recherche par métadonnée
 *     (`metadata['verebona_plan']:'…' AND active:'true'`), création permise ;
 *   - clé RESTREINTE simulée (écriture refusée : StripePermissionError 403) ;
 *   - pannes ponctuelles injectables.
 *
 * Comptes types : `seedAccount` (ancien seed : clés `verebona_<offre>_<période>`,
 * métadonnée produit `verebona_<offre>`, prix `<offre>`, taxes `unspecified`),
 * `manualAccount` (prix créés à la main dans le dashboard : ni clé ni
 * métadonnée), variables V1 / V2 correspondantes.
 */
import type Stripe from 'stripe';
import type { BillingPeriod, PlanCode } from '@/lib/billing/plan-catalog';

const PLANS: PlanCode[] = ['standard', 'premium', 'premium_duo'];
const PERIODS: BillingPeriod[] = ['monthly', 'yearly'];

export interface RealisticOptions {
  /** Clé restreinte : écritures refusées. */
  denyWrites?: { prices?: boolean; products?: boolean };
  /** Pannes ponctuelles (renvoyer vrai pour échouer). */
  failOnce?: { productsCreate?: boolean; portal?: boolean };
}

export interface RealisticStripe {
  prices: Map<string, Stripe.Price>;
  products: Map<string, Stripe.Product>;
  calls: string[];
  opts: RealisticOptions;
  client: Stripe;
}

const permission = () => Object.assign(new Error('The provided key does not have the required permissions'), { type: 'StripePermissionError', statusCode: 403, rawType: 'permission_error' });
const invalid = (m: string) => Object.assign(new Error(m), { type: 'StripeInvalidRequestError', statusCode: 400 });
const missing = (id: string) => Object.assign(new Error(`No such price: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });

export function mkProduct(id: string, metadata: Record<string, string> = {}, active = true): Stripe.Product {
  return { id, object: 'product', active, name: id, metadata } as unknown as Stripe.Product;
}

export function mkPrice(p: {
  id: string; product: string; amount: number; interval: 'month' | 'year'; key?: string | null; active?: boolean;
  metadata?: Record<string, string>; tax?: 'inclusive' | 'exclusive' | 'unspecified'; currency?: string; type?: 'recurring' | 'one_time'; livemode?: boolean;
}): Stripe.Price {
  const type = p.type ?? 'recurring';
  return {
    id: p.id, object: 'price', active: p.active ?? true, livemode: p.livemode ?? false, currency: p.currency ?? 'eur', type,
    unit_amount: p.amount, recurring: type === 'recurring' ? { interval: p.interval, interval_count: 1, usage_type: 'licensed' } : null,
    billing_scheme: 'per_unit', custom_unit_amount: null, transform_quantity: null, tax_behavior: p.tax ?? 'unspecified',
    lookup_key: p.key ?? null, metadata: p.metadata ?? {}, product: p.product, nickname: null,
  } as unknown as Stripe.Price;
}

export function realisticStripe(initialPrices: Stripe.Price[], initialProducts: Stripe.Product[], opts: RealisticOptions = {}): RealisticStripe {
  const prices = new Map(initialPrices.map((p) => [p.id, { ...p }]));
  const products = new Map(initialProducts.map((p) => [p.id, { ...p }]));
  const calls: string[] = [];
  const idem = new Map<string, unknown>();
  const portal = new Map<string, Stripe.BillingPortal.Configuration>();
  let n = 0;
  const expand = (p: Stripe.Price, on: boolean) => (on ? ({ ...p, product: products.get(p.product as string) ?? p.product }) as Stripe.Price : { ...p });
  const holderOf = (key: string, except?: string) => [...prices.values()].find((x) => x.lookup_key === key && x.id !== except);

  const client = {
    accounts: { retrieve: async () => ({ id: 'acct_preprod_test' }) },
    prices: {
      list: (params: Stripe.PriceListParams & { expand?: string[] }) => {
        calls.push('prices.list');
        const compute = () => {
          let data = [...prices.values()];
          if (params.lookup_keys) data = data.filter((p) => p.lookup_key && params.lookup_keys!.includes(p.lookup_key));
          if (params.active !== undefined) data = data.filter((p) => p.active === params.active);
          if (params.type) data = data.filter((p) => p.type === params.type);
          if (params.currency) data = data.filter((p) => p.currency === params.currency);
          if (params.product) data = data.filter((p) => p.product === params.product);
          return data.map((p) => expand(p, Boolean(params.expand?.includes('data.product'))));
        };
        const promise = Promise.resolve().then(() => ({ object: 'list', data: compute(), has_more: false }) as unknown as Stripe.ApiList<Stripe.Price>);
        return Object.assign(promise, { [Symbol.asyncIterator]: async function* () { for (const d of compute()) yield d; } });
      },
      retrieve: async (id: string, params?: { expand?: string[] }) => {
        calls.push(`prices.retrieve:${id}`);
        const p = prices.get(id);
        if (!p) throw missing(id);
        return expand(p, Boolean(params?.expand?.includes('product')));
      },
      create: async (params: Stripe.PriceCreateParams & { expand?: string[] }, o?: { idempotencyKey?: string }) => {
        if (opts.denyWrites?.prices) throw permission();
        if (o?.idempotencyKey && idem.has(o.idempotencyKey)) return expand(idem.get(o.idempotencyKey) as Stripe.Price, true);
        if (!products.has(params.product as string)) throw invalid(`No such product: '${params.product}'`);
        calls.push('prices.create');
        const p = mkPrice({
          id: `price_new_${++n}`, product: params.product as string, amount: params.unit_amount ?? 0,
          interval: params.recurring!.interval as 'month' | 'year', tax: (params.tax_behavior ?? 'unspecified') as 'inclusive',
          metadata: (params.metadata ?? {}) as Record<string, string>, key: params.lookup_key ?? null,
        });
        if (p.lookup_key && holderOf(p.lookup_key)) throw invalid('lookup_key already in use');
        prices.set(p.id, p);
        if (o?.idempotencyKey) idem.set(o.idempotencyKey, p);
        return expand(p, true);
      },
      update: async (id: string, params: Stripe.PriceUpdateParams & { expand?: string[] }) => {
        calls.push(`prices.update:${id}`);
        if (opts.denyWrites?.prices) throw permission();
        const p = prices.get(id);
        if (!p) throw missing(id);
        if (params.lookup_key !== undefined && params.lookup_key !== null) {
          const holder = holderOf(params.lookup_key as string, id);
          if (holder) {
            if (!params.transfer_lookup_key) throw invalid(`A price (${holder.id}) already uses that lookup key.`);
            prices.set(holder.id, { ...holder, lookup_key: null });
          }
          prices.set(id, { ...prices.get(id)!, lookup_key: params.lookup_key as string });
        }
        if (params.active !== undefined) prices.set(id, { ...prices.get(id)!, active: params.active });
        return expand(prices.get(id)!, Boolean(params.expand?.includes('product')));
      },
    },
    products: {
      search: async (params: { query: string }) => {
        calls.push('products.search');
        const meta = /metadata\['verebona_plan'\]:'([^']+)'/.exec(params.query)?.[1];
        const activeOnly = /active:'true'/.test(params.query);
        const data = [...products.values()].filter((p) => (!meta || p.metadata?.verebona_plan === meta) && (!activeOnly || p.active));
        return { object: 'search_result', data, has_more: false };
      },
      create: async (params: Stripe.ProductCreateParams, o?: { idempotencyKey?: string }) => {
        if (opts.denyWrites?.products) throw permission();
        if (opts.failOnce?.productsCreate) { opts.failOnce.productsCreate = false; throw Object.assign(new Error('Stripe down'), { type: 'StripeConnectionError' }); }
        if (o?.idempotencyKey && idem.has(o.idempotencyKey)) return idem.get(o.idempotencyKey);
        calls.push('products.create');
        const p = mkProduct(`prod_new_${++n}`, (params.metadata ?? {}) as Record<string, string>);
        products.set(p.id, p);
        if (o?.idempotencyKey) idem.set(o.idempotencyKey, p);
        return p;
      },
    },
    subscriptions: { list: () => ({ [Symbol.asyncIterator]: async function* () { /* aucun */ } }) },
    billingPortal: {
      configurations: {
        list: () => ({ [Symbol.asyncIterator]: async function* () { for (const c of portal.values()) yield c; } }),
        retrieve: async (id: string) => portal.get(id) ?? Promise.reject(new Error('missing')),
        create: async (params: Stripe.BillingPortal.ConfigurationCreateParams) => {
          if (opts.failOnce?.portal) { opts.failOnce.portal = false; throw invalid('business_profile requis'); }
          const c = { id: `bpc_${portal.size + 1}`, active: true, metadata: params.metadata, features: params.features } as unknown as Stripe.BillingPortal.Configuration;
          portal.set(c.id, c);
          return c;
        },
        update: async (id: string, params: Stripe.BillingPortal.ConfigurationUpdateParams) => {
          const c = portal.get(id)!;
          const next = { ...c, features: { ...c.features, ...params.features } } as unknown as Stripe.BillingPortal.Configuration;
          portal.set(id, next);
          return next;
        },
      },
    },
  } as unknown as Stripe;
  return { prices, products, calls, opts, client };
}

// ─── Comptes types ───────────────────────────────────────────────────────────

/** Grille V2 du code avant le lot 35 (`lib/stripe-prices` à base1010). */
export const V2_GRID: Record<PlanCode, Record<BillingPeriod, number>> = {
  standard: { monthly: 290, yearly: 2900 },
  premium: { monthly: 590, yearly: 5900 },
  premium_duo: { monthly: 890, yearly: 8900 },
};

const short = (p: PlanCode) => (p === 'premium_duo' ? 'duo' : p === 'premium' ? 'pre' : 'std');

/**
 * (a) Compte amorcé par l'ancien seed `seed-stripe-prices.ts` : produits
 * `verebona_<offre>` (métadonnée produit), prix à clé
 * `verebona_<offre>_<période>`, métadonnées prix `<offre>` / `<période>`,
 * `tax_behavior` non précisé.
 */
export function seedAccount(o: { archived?: boolean; only?: PlanCode[] } = {}): { prices: Stripe.Price[]; products: Stripe.Product[] } {
  const plans = o.only ?? PLANS;
  return {
    products: plans.map((p) => mkProduct(`prod_seed_${short(p)}`, { verebona_plan: `verebona_${p}` })),
    prices: plans.flatMap((p) => PERIODS.map((per) => mkPrice({
      id: `price_seed_${short(p)}_${per[0]}`, product: `prod_seed_${short(p)}`, amount: V2_GRID[p][per], interval: per === 'monthly' ? 'month' : 'year',
      key: `verebona_${p}_${per}`, metadata: { verebona_plan: p, verebona_period: per }, active: !o.archived,
    }))),
  };
}

/**
 * (b) Prix créés À LA MAIN dans le dashboard : ni lookup_key ni métadonnée,
 * un produit par offre (nom seul). `legacyAnnual` : anciens prix annuels du
 * modèle à périodicité unique (19 / 59 / 79 €) sous les mêmes produits.
 */
export function manualAccount(o: { legacyAnnual?: boolean; keys?: boolean } = {}): { prices: Stripe.Price[]; products: Stripe.Product[] } {
  const legacy: Record<PlanCode, number> = { standard: 1900, premium: 5900, premium_duo: 7900 };
  return {
    products: PLANS.map((p) => mkProduct(`prod_man_${short(p)}`)),
    prices: [
      ...PLANS.flatMap((p) => PERIODS.map((per) => mkPrice({
        id: `price_man_${short(p)}_${per[0]}`, product: `prod_man_${short(p)}`, amount: V2_GRID[p][per], interval: per === 'monthly' ? 'month' : 'year',
        key: o.keys ? `verebona_${p}_${per}` : null,
      }))),
      ...(o.legacyAnnual ? PLANS.map((p) => mkPrice({ id: `price_v1_${short(p)}`, product: `prod_man_${short(p)}`, amount: legacy[p], interval: 'year' })) : []),
    ],
  };
}

/** Variables V2 (`STRIPE_PRICE_<OFFRE>_<PÉRIODE>`) vers les prix d'un compte type. */
export function v2Env(prefix: 'seed' | 'man'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PLANS) for (const per of PERIODS) out[`STRIPE_PRICE_${p.toUpperCase()}_${per.toUpperCase()}`] = `price_${prefix}_${short(p)}_${per[0]}`;
  return out;
}

/** Variables V1 (`STRIPE_PRICE_STANDARD|PREMIUM|PREMIUM_DUO`) vers les anciens annuels. */
export function v1Env(): Record<string, string> {
  return { STRIPE_PRICE_STANDARD: 'price_v1_std', STRIPE_PRICE_PREMIUM: 'price_v1_pre', STRIPE_PRICE_PREMIUM_DUO: 'price_v1_duo' };
}
