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
 *   - pannes ponctuelles injectables ;
 *   - lot 49A : PORTAIL réaliste — Stripe refuse deux prix de même
 *     périodicité sous un même produit (« For each product, its price must
 *     have unique billing intervals. », erreur réelle de la préprod), ainsi
 *     qu'un prix inconnu ou d'un autre produit ; chaque écriture est
 *     journalisée (`portalWrites`) ; pannes injectables (`portalFail`).
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
  /**
   * Lot 49A : panne des écritures de portail (n = numéro d'écriture, 1-based).
   * `transient` : StripeConnectionError ; sinon StripeInvalidRequestError.
   */
  portalFail?: (n: number, products: Array<{ product: string; prices: string[] }>) => 'transient' | 'invalid' | 'intervals' | null;
  /** Identifiant du compte renvoyé par `accounts.retrieve` (défaut `acct_preprod_test`). */
  accountId?: string;
  /**
   * Lot 53I — `features.subscription_update.products` est un champ
   * INCLUDABLE de l'API (SDK 18.5.0 : `products?:`, absent de l'exemple
   * d'objet de la documentation) : il n'est renvoyé que s'il est demandé par
   * `expand` (`features.subscription_update.products`, ou
   * `data.features.subscription_update.products` sur une liste). Les
   * réponses de retrieve / create / update / list l'OMETTENT sinon — c'est
   * le comportement qui a produit « prix acceptés ∅ » en préprod.
   *   - `legacyAlwaysIncludeProducts` : ancien comportement de la doublure
   *     (toujours renvoyé) — jamais utilisé par les tests du lot 53 ;
   *   - `rejectProductsExpand` : Stripe refuse l'expansion (« This property
   *     cannot be expanded ») — repli sans expansion, état indéterminé ;
   *   - `omitProductsEvenExpanded` : propriété absente même demandée.
   */
  legacyAlwaysIncludeProducts?: boolean;
  rejectProductsExpand?: boolean;
  omitProductsEvenExpanded?: boolean;
}

/** Chemin d'expansion du champ includable (lot 53I). */
export const PRODUCTS_EXPAND_PATH = 'features.subscription_update.products';

/** Message EXACT renvoyé par Stripe lors de l'incident préprod (lot 49A). */
export const STRIPE_UNIQUE_INTERVALS_ERROR = 'For each product, its price must have unique billing intervals.';

export interface RealisticStripe {
  prices: Map<string, Stripe.Price>;
  products: Map<string, Stripe.Product>;
  calls: string[];
  opts: RealisticOptions;
  client: Stripe;
  portal: Map<string, Stripe.BillingPortal.Configuration>;
  /** Écritures de portail demandées (acceptées ou refusées). */
  portalWrites: Array<{ op: 'create' | 'update'; id: string | null; products: Array<{ product: string; prices: string[] }>; accepted: boolean; error?: string; productsSent: boolean }>;
  /** Lectures de portail (op, expansion demandée, `products` présent dans la réponse). */
  portalReads: Array<{ op: 'retrieve' | 'create' | 'update' | 'list'; id: string | null; expand: string[]; productsReturned: boolean }>;
  /** Sessions de portail créées (flux de confirmation de montée en gamme). */
  portalSessions: Array<{ id: string; configuration: string; subscription: string; item: string; price: string }>;
  /** Abonnements simulés (montée en gamme, lot 53I). */
  subscriptions: Map<string, SimSubscription>;
  /** Factures simulées (prorata). */
  invoices: Array<{ subscription: string; amount: number; lines: Array<{ description: string; amount: number }>; at: number }>;
  /**
   * Confirmation d'une session de portail par le client (ce que fait la
   * page Stripe) : règles du portail appliquées — prix autorisé par la
   * configuration, `proration_behavior` de la configuration, échéance
   * conservée (pas de changement d'ancre de facturation).
   */
  confirmPortalSession: (sessionId: string, nowSec: number) => SimSubscription;
}

/** Abonnement simulé : un item, période courante, ancre de facturation. */
export interface SimSubscription {
  id: string;
  customer: string;
  status: 'active' | 'past_due' | 'canceled';
  itemId: string;
  priceId: string;
  current_period_start: number;
  current_period_end: number;
  billing_cycle_anchor: number;
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
  const portalWrites: RealisticStripe['portalWrites'] = [];
  const portalReads: RealisticStripe['portalReads'] = [];
  const portalSessions: RealisticStripe['portalSessions'] = [];
  const subscriptions = new Map<string, SimSubscription>();
  const invoices: RealisticStripe['invoices'] = [];
  /**
   * Réponse API d'une configuration : `products` (includable) n'est renvoyé
   * que sur demande explicite. L'objet stocké (`portal`) reste complet : il
   * représente l'état RÉEL chez Stripe, que les tests consultent directement.
   */
  const respond = (op: RealisticStripe['portalReads'][number]['op'], c: Stripe.BillingPortal.Configuration, expandList: string[] | undefined, path = PRODUCTS_EXPAND_PATH) => {
    const expandAsked = (expandList ?? []).includes(path);
    if (expandAsked && opts.rejectProductsExpand) {
      throw invalid(`This property cannot be expanded (${path}).`);
    }
    const include = opts.legacyAlwaysIncludeProducts || (expandAsked && !opts.omitProductsEvenExpanded);
    const out = JSON.parse(JSON.stringify(c)) as Stripe.BillingPortal.Configuration;
    if (!include && out.features?.subscription_update) delete (out.features.subscription_update as { products?: unknown }).products;
    portalReads.push({ op, id: c.id ?? null, expand: [...(expandList ?? [])], productsReturned: Boolean(out.features?.subscription_update && 'products' in out.features.subscription_update) });
    return out;
  };
  /** Forme stockée par Stripe : `adjustable_quantity` par défaut sur chaque produit. */
  const stored = (features: unknown) => {
    const f = JSON.parse(JSON.stringify(features ?? {})) as { subscription_update?: { products?: Array<Record<string, unknown>> } };
    for (const p of f.subscription_update?.products ?? []) p.adjustable_quantity ??= { enabled: false, maximum: null, minimum: 1 };
    return f;
  };
  let n = 0;
  /** Règles Stripe du portail : prix existants, du bon produit, une périodicité par produit. */
  const checkPortal = (op: 'create' | 'update', id: string | null, features: Stripe.BillingPortal.ConfigurationCreateParams.Features | undefined) => {
    const products = ((features?.subscription_update as { products?: Array<{ product: string; prices: string[] }> } | undefined)?.products ?? [])
      .map((p) => ({ product: p.product, prices: [...p.prices] }));
    const injected = opts.portalFail?.(portalWrites.length + 1, products) ?? null;
    let error: Error | null = null;
    if (injected === 'transient') error = Object.assign(new Error('Stripe down'), { type: 'StripeConnectionError' });
    else if (injected === 'invalid') error = invalid('Invalid portal configuration');
    else if (injected === 'intervals') error = invalid(STRIPE_UNIQUE_INTERVALS_ERROR);
    for (const p of error ? [] : products) {
      const intervals = new Set<string>();
      for (const priceId of p.prices) {
        const pr = prices.get(priceId);
        if (!pr) { error = invalid(`No such price: '${priceId}'`); break; }
        if (pr.product !== p.product) { error = invalid(`The price ${priceId} does not belong to product ${p.product}.`); break; }
        const iv = `${pr.recurring?.interval}:${pr.recurring?.interval_count ?? 1}`;
        if (intervals.has(iv)) { error = invalid(STRIPE_UNIQUE_INTERVALS_ERROR); break; }
        intervals.add(iv);
      }
      if (error) break;
    }
    const productsSent = Boolean(features?.subscription_update && 'products' in (features.subscription_update as object));
    // Liste explicitement VIDE avec mise à jour activée : refus Stripe (aucun produit autorisé).
    if (!error && productsSent && products.length === 0 && (features?.subscription_update as { enabled?: boolean })?.enabled) {
      error = invalid('features[subscription_update][products]: you must specify at least one product when subscription updates are enabled.');
    }
    portalWrites.push({ op, id, products, accepted: !error, productsSent, ...(error ? { error: error.message } : {}) });
    calls.push(`portal.${op}`);
    if (error) throw error;
  };
  const expand = (p: Stripe.Price, on: boolean) => (on ? ({ ...p, product: products.get(p.product as string) ?? p.product }) as Stripe.Price : { ...p });
  const holderOf = (key: string, except?: string) => [...prices.values()].find((x) => x.lookup_key === key && x.id !== except);

  const client = {
    accounts: { retrieve: async () => ({ id: opts.accountId ?? 'acct_preprod_test' }) },
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
    subscriptions: {
      list: () => ({ [Symbol.asyncIterator]: async function* () { /* aucun */ } }),
      retrieve: async (id: string) => {
        const sub = subscriptions.get(id);
        if (!sub) throw invalid(`No such subscription: '${id}'`);
        return { ...sub };
      },
      update: async (id: string) => { calls.push(`subscriptions.update:${id}`); return { ...subscriptions.get(id) }; },
    },
    billingPortal: {
      configurations: {
        list: (params?: { expand?: string[] }) => {
          const all = [...portal.values()];
          return { [Symbol.asyncIterator]: async function* () { for (const c of all) yield respond('list', c, params?.expand, `data.${PRODUCTS_EXPAND_PATH}`); } };
        },
        retrieve: async (id: string, params?: { expand?: string[] }) => {
          const c = portal.get(id);
          if (!c) throw Object.assign(new Error(`No such configuration: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
          return respond('retrieve', c, params?.expand);
        },
        create: async (params: Stripe.BillingPortal.ConfigurationCreateParams & { expand?: string[] }) => {
          if (opts.failOnce?.portal) { opts.failOnce.portal = false; throw invalid('business_profile requis'); }
          if (opts.rejectProductsExpand && (params.expand ?? []).includes(PRODUCTS_EXPAND_PATH)) throw invalid(`This property cannot be expanded (${PRODUCTS_EXPAND_PATH}).`);
          checkPortal('create', null, params.features);
          const c = {
            id: `bpc_${portal.size + 1}`, object: 'billing_portal.configuration', active: true, livemode: false, is_default: false,
            metadata: params.metadata ?? {}, name: params.name ?? null, features: stored(params.features),
          } as unknown as Stripe.BillingPortal.Configuration;
          portal.set(c.id, c);
          return respond('create', c, params.expand);
        },
        update: async (id: string, params: Stripe.BillingPortal.ConfigurationUpdateParams & { expand?: string[] }) => {
          const c = portal.get(id);
          if (!c) throw invalid(`No such configuration: '${id}'`);
          if (opts.rejectProductsExpand && (params.expand ?? []).includes(PRODUCTS_EXPAND_PATH)) throw invalid(`This property cannot be expanded (${PRODUCTS_EXPAND_PATH}).`);
          checkPortal('update', id, params.features as Stripe.BillingPortal.ConfigurationCreateParams.Features);
          // Fusion par sous-objet (comportement Stripe : un champ non envoyé est conservé).
          const sent = stored(params.features) as Record<string, Record<string, unknown>>;
          const features = JSON.parse(JSON.stringify(c.features)) as Record<string, Record<string, unknown>>;
          for (const [k, v] of Object.entries(sent)) features[k] = { ...(features[k] ?? {}), ...v };
          const next = { ...c, features } as unknown as Stripe.BillingPortal.Configuration;
          portal.set(id, next);
          return respond('update', next, params.expand);
        },
      },
      sessions: {
        /**
         * Flux `subscription_update_confirm` : Stripe refuse un prix cible non
         * autorisé par la configuration (produit + prix) ou une configuration
         * dont la mise à jour est désactivée.
         */
        create: async (params: Stripe.BillingPortal.SessionCreateParams) => {
          const conf = portal.get(params.configuration ?? '');
          if (!conf) throw invalid(`No such configuration: '${params.configuration}'`);
          const flow = params.flow_data?.subscription_update_confirm;
          if (flow) {
            const su = conf.features.subscription_update;
            const item = flow.items[0];
            const target = prices.get(item.price ?? '');
            const allowed = su.enabled && (su.products ?? []).some((p) => p.product === target?.product && p.prices.includes(item.price ?? ''));
            if (!target || !allowed) throw invalid(`The price ${item.price} is not allowed by the portal configuration ${conf.id}.`);
            if (!subscriptions.has(flow.subscription)) throw invalid(`No such subscription: '${flow.subscription}'`);
            const id = `bps_${portalSessions.length + 1}`;
            portalSessions.push({ id, configuration: conf.id, subscription: flow.subscription, item: item.id, price: item.price! });
            calls.push('portal.session');
            return { id, url: `https://billing.stripe.test/p/session/${id}` };
          }
          return { id: `bps_${portalSessions.length + 1}`, url: 'https://billing.stripe.test/p/session/x' };
        },
      },
    },
  } as unknown as Stripe;

  const confirmPortalSession = (sessionId: string, nowSec: number): SimSubscription => {
    const session = portalSessions.find((x) => x.id === sessionId);
    if (!session) throw invalid(`No such session: '${sessionId}'`);
    const conf = portal.get(session.configuration)!;
    const sub = subscriptions.get(session.subscription)!;
    const from = prices.get(sub.priceId)!;
    const to = prices.get(session.price)!;
    // Prorata au temps restant de la période EN COURS, ancre inchangée.
    const total = sub.current_period_end - sub.current_period_start;
    const remaining = Math.max(0, sub.current_period_end - nowSec);
    const credit = -Math.round(((from.unit_amount ?? 0) * remaining) / total);
    const debit = Math.round(((to.unit_amount ?? 0) * remaining) / total);
    const behavior = conf.features.subscription_update.proration_behavior;
    if (behavior !== 'none') {
      const lines = [
        { description: `Temps inutilisé sur ${from.id}`, amount: credit },
        { description: `Temps restant sur ${to.id}`, amount: debit },
      ];
      // `always_invoice` : facture immédiate ; `create_prorations` : lignes en attente (prochaine facture).
      if (behavior === 'always_invoice') invoices.push({ subscription: sub.id, amount: credit + debit, lines, at: nowSec });
    }
    const next = { ...sub, priceId: to.id };
    subscriptions.set(sub.id, next);
    calls.push(`portal.confirm:${sessionId}`);
    return { ...next };
  };

  return { prices, products, calls, opts, client, portal, portalWrites, portalReads, portalSessions, subscriptions, invoices, confirmPortalSession };
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
