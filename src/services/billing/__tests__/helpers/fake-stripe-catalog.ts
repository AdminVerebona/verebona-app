/**
 * Doublures de test du catalogue Stripe (lot 35C) : magasin partagé en
 * mémoire (`CatalogStore`) et Stripe simulé (prix, clés stables avec
 * transfert atomique, produits, portail). Aucune base, aucun réseau.
 */
import type Stripe from 'stripe';
import type {
  ApprovedProduct, CatalogRunRow, CatalogStateRow, CatalogStore, PriceVersionRow,
} from '../../catalog-store';
import type { CatalogDeps } from '../../price-catalog.service';

export function memoryStore(): CatalogStore & { states: Map<string, CatalogStateRow>; products: Map<string, ApprovedProduct[]>; versions: Map<string, PriceVersionRow>; runs: CatalogRunRow[] } {
  const states = new Map<string, CatalogStateRow>();
  const products = new Map<string, ApprovedProduct[]>();
  const versions = new Map<string, PriceVersionRow>();
  const runs: CatalogRunRow[] = [];
  const blank = (ctx: string): CatalogStateRow => ({
    catalogContext: ctx, stripeAccountId: null, livemode: null, activeRevision: null, activeSnapshot: null, previousRevision: null,
    previousSnapshot: null, verifiedAt: null, generation: 0, invalidatedAt: null, publicationState: 'ACTIVE', publicationRunId: null,
    publicationError: null, activatingUntil: null, publishedManifestRevision: null, candidateManifestRevision: null, candidateFirstSeenAt: null,
    portalConfigurationId: null, portalFingerprint: null, portalVerifiedAt: null, backfillCompletedAt: null, lastSyncError: null, updatedAt: null,
  });
  const ensure = (ctx: string) => { if (!states.has(ctx)) states.set(ctx, blank(ctx)); return states.get(ctx)!; };
  return {
    states, products, versions, runs,
    async getState(ctx) { return states.get(ctx) ? { ...states.get(ctx)! } : null; },
    async ensureState(ctx) { return { ...ensure(ctx) }; },
    async activateSnapshot(i) {
      const s = ensure(i.context);
      for (const v of i.versions) await this.upsertPriceVersion(v);
      const changed = s.activeRevision !== i.snapshot.version;
      if (i.keepPrevious && changed && s.activeRevision) { s.previousRevision = s.activeRevision; s.previousSnapshot = s.activeSnapshot; }
      s.activeRevision = i.snapshot.version;
      s.activeSnapshot = JSON.parse(JSON.stringify(i.snapshot));
      s.verifiedAt = new Date(i.snapshot.verifiedAt);
      if (changed) s.generation++;
      s.stripeAccountId = i.stripeAccountId ?? s.stripeAccountId;
      s.livemode = i.livemode ?? s.livemode;
      if (i.publishedManifestRevision) s.publishedManifestRevision = i.publishedManifestRevision;
      if (i.publicationState) { s.publicationState = i.publicationState; if (i.publicationState === 'ACTIVE') s.publicationError = null; }
      s.activatingUntil = null;
      s.lastSyncError = null;
      return { ...s };
    },
    async touchVerified(ctx, at, acct, live) { const s = ensure(ctx); s.verifiedAt = at; s.stripeAccountId = acct ?? s.stripeAccountId; s.livemode = live ?? s.livemode; s.lastSyncError = null; },
    async invalidate(ctx) { const s = ensure(ctx); s.invalidatedAt = new Date(); s.generation++; },
    async setPublication(ctx, p) { const s = ensure(ctx); s.publicationState = p.state; s.publicationRunId = p.runId ?? s.publicationRunId; s.publicationError = p.error ?? null; s.activatingUntil = p.activatingUntil ?? null; s.generation++; },
    async setCandidate(ctx, rev, now) { const s = ensure(ctx); if (s.candidateManifestRevision !== rev) s.candidateFirstSeenAt = now; s.candidateManifestRevision = rev; },
    async setPortal(ctx, id, fp, at) { const s = ensure(ctx); s.portalConfigurationId = id; s.portalFingerprint = fp; s.portalVerifiedAt = at; },
    async setBackfillCompleted(ctx, at) { ensure(ctx).backfillCompletedAt = at; },
    async setSyncError(ctx, e) { ensure(ctx).lastSyncError = e; },
    async listApprovedProducts(ctx) { return [...(products.get(ctx) ?? [])]; },
    async approveProduct(ctx, p) {
      const list = products.get(ctx) ?? [];
      const existing = list.find((x) => x.stripeProductId === p.stripeProductId);
      if (existing) {
        if (existing.planCode !== p.planCode) return 'conflict';
        if (p.role === 'sale' && existing.role !== 'sale') {
          if (list.some((x) => x.planCode === p.planCode && x.role === 'sale')) return 'conflict';
          existing.role = 'sale';
        }
        return 'exists';
      }
      if (p.role === 'sale' && list.some((x) => x.planCode === p.planCode && x.role === 'sale')) return 'conflict';
      list.push({ planCode: p.planCode, stripeProductId: p.stripeProductId, role: p.role, source: p.source });
      products.set(ctx, list);
      return 'inserted';
    },
    async findPriceVersion(ctx, id) { return versions.get(`${ctx}|${id}`) ?? null; },
    async upsertPriceVersion(v) {
      const k = `${v.catalogContext}|${v.stripePriceId}`;
      const cur = versions.get(k);
      versions.set(k, cur ? { ...cur, observedLookupKey: v.observedLookupKey, stripeActive: v.stripeActive } : { ...v });
    },
    async listPriceVersions(ctx) { return [...versions.values()].filter((v) => v.catalogContext === ctx); },
    async createRun(r) {
      const id = runs.length + 1;
      runs.push({ id, catalogContext: r.context, kind: r.kind, state: r.state, trigger: r.trigger, actor: r.actor ?? null, codeVersion: 'test', manifestRevision: r.manifestRevision ?? null, fromRevision: r.fromRevision ?? null, toRevision: null, dryRun: Boolean(r.dryRun), steps: [], createdPrices: {}, transfers: [], report: null, error: null, startedAt: new Date(), finishedAt: null });
      return id;
    },
    async updateRun(id, p) {
      const r = runs[id - 1];
      if (!r) return;
      if (p.state) r.state = p.state;
      if (p.toRevision) r.toRevision = p.toRevision;
      if (p.createdPrices) r.createdPrices = p.createdPrices;
      if (p.transfers) r.transfers = p.transfers;
      if (p.report) r.report = p.report;
      if (p.error) r.error = p.error;
      if (p.step) r.steps.push(p.step);
      if (p.finished) r.finishedAt = new Date();
    },
    async getRun(id) { return runs[id - 1] ?? null; },
    async listRuns(ctx, limit) { return runs.filter((r) => r.catalogContext === ctx).slice(-limit).reverse(); },
  };
}

type P = Partial<Stripe.Price> & { id: string };

export function price(p: P & { amount?: number; interval?: 'month' | 'year'; product?: string; key?: string | null }): Stripe.Price {
  return {
    id: p.id,
    object: 'price',
    active: p.active ?? true,
    livemode: p.livemode ?? false,
    currency: p.currency ?? 'eur',
    type: p.type ?? 'recurring',
    unit_amount: p.amount ?? p.unit_amount ?? 390,
    recurring: p.recurring ?? { interval: p.interval ?? 'month', interval_count: 1, usage_type: 'licensed' } as Stripe.Price.Recurring,
    billing_scheme: p.billing_scheme ?? 'per_unit',
    custom_unit_amount: p.custom_unit_amount ?? null,
    transform_quantity: p.transform_quantity ?? null,
    tax_behavior: p.tax_behavior ?? 'inclusive',
    lookup_key: p.key === undefined ? null : p.key,
    metadata: p.metadata ?? {},
    product: p.product ?? 'prod_standard',
  } as unknown as Stripe.Price;
}

export interface FakeStripe {
  prices: Map<string, Stripe.Price>;
  products: Map<string, Stripe.Product>;
  portal: Map<string, Stripe.BillingPortal.Configuration>;
  calls: string[];
  failOn: { update?: (id: string, n: number) => boolean; list?: boolean; retrieve?: boolean };
  client: Stripe;
}

export function fakeStripe(initial: Stripe.Price[], products: Array<{ id: string; plan: string; active?: boolean }> = []): FakeStripe {
  const prices = new Map(initial.map((p) => [p.id, p]));
  const prods = new Map<string, Stripe.Product>(products.map((p) => [p.id, { id: p.id, object: 'product', active: p.active ?? true, metadata: { verebona_plan: `verebona_${p.plan}` } } as unknown as Stripe.Product]));
  const portal = new Map<string, Stripe.BillingPortal.Configuration>();
  const calls: string[] = [];
  const failOn: FakeStripe['failOn'] = {};
  let created = 0;
  let updates = 0;
  const idem = new Map<string, Stripe.Price>();
  const withProduct = (p: Stripe.Price) => ({ ...p, product: prods.get(p.product as string) ?? p.product }) as Stripe.Price;
  const client = {
    accounts: { retrieve: async () => ({ id: 'acct_test' }) },
    prices: {
      // Comme le SDK : une promesse ET un itérable asynchrone (auto-pagination).
      list: (params: Stripe.PriceListParams) => {
        calls.push('prices.list');
        const compute = () => {
          if (failOn.list) throw Object.assign(new Error('Stripe down'), { type: 'StripeConnectionError' });
          let data = [...prices.values()];
          if (params.lookup_keys) data = data.filter((p) => p.lookup_key && params.lookup_keys!.includes(p.lookup_key));
          if (params.active !== undefined) data = data.filter((p) => p.active === params.active);
          if (params.product) data = data.filter((p) => p.product === params.product);
          // Ordre volontairement inversé (TC-02).
          return data.reverse().map(withProduct);
        };
        const promise = Promise.resolve().then(() => ({ object: 'list', data: compute(), has_more: false }) as unknown as Stripe.ApiList<Stripe.Price>);
        return Object.assign(promise, { [Symbol.asyncIterator]: async function* () { for (const d of compute()) yield d; } });
      },
      retrieve: async (id: string) => {
        calls.push(`prices.retrieve:${id}`);
        if (failOn.retrieve) throw Object.assign(new Error('Stripe down'), { type: 'StripeConnectionError' });
        const p = prices.get(id);
        if (!p) throw Object.assign(new Error('No such price'), { code: 'resource_missing', statusCode: 404 });
        return withProduct(p);
      },
      create: async (params: Stripe.PriceCreateParams, opts?: { idempotencyKey?: string }) => {
        if (opts?.idempotencyKey && idem.has(opts.idempotencyKey)) return withProduct(idem.get(opts.idempotencyKey)!);
        created++;
        calls.push('prices.create');
        const p = price({
          id: `price_new_${created}`, amount: params.unit_amount ?? 0, interval: params.recurring!.interval as 'month' | 'year',
          product: params.product as string, tax_behavior: params.tax_behavior ?? 'unspecified', metadata: params.metadata as Record<string, string>,
        });
        prices.set(p.id, p);
        if (opts?.idempotencyKey) idem.set(opts.idempotencyKey, p);
        return withProduct(p);
      },
      update: async (id: string, params: Stripe.PriceUpdateParams) => {
        updates++;
        calls.push(`prices.update:${id}`);
        if (failOn.update?.(id, updates)) throw Object.assign(new Error('Stripe down'), { type: 'StripeConnectionError' });
        const p = prices.get(id)!;
        if (params.lookup_key !== undefined) {
          const holder = [...prices.values()].find((x) => x.lookup_key === params.lookup_key && x.id !== id);
          if (holder) {
            if (!params.transfer_lookup_key) throw new Error('lookup_key already used');
            prices.set(holder.id, { ...holder, lookup_key: null });
          }
          prices.set(id, { ...prices.get(id)!, lookup_key: params.lookup_key as string });
        }
        if (params.active !== undefined) prices.set(id, { ...prices.get(id)!, active: params.active });
        return withProduct(prices.get(id) ?? p);
      },
    },
    products: {
      search: async () => ({ data: [...prods.values()] }),
      create: async () => { throw new Error('ne doit pas créer de produit'); },
    },
    billingPortal: {
      configurations: {
        list: () => ({ [Symbol.asyncIterator]: async function* () { for (const c of portal.values()) yield c; } }),
        retrieve: async (id: string) => portal.get(id) ?? Promise.reject(new Error('missing')),
        create: async (params: Stripe.BillingPortal.ConfigurationCreateParams) => {
          const c = { id: `bpc_${portal.size + 1}`, active: true, metadata: params.metadata, features: params.features } as unknown as Stripe.BillingPortal.Configuration;
          portal.set(c.id, c);
          calls.push('portal.create');
          return c;
        },
        update: async (id: string, params: Stripe.BillingPortal.ConfigurationUpdateParams) => {
          const c = portal.get(id)!;
          const next = { ...c, features: { ...c.features, ...params.features } } as unknown as Stripe.BillingPortal.Configuration;
          portal.set(id, next);
          calls.push('portal.update');
          return next;
        },
      },
    },
  } as unknown as Stripe;
  return { prices, products: prods, portal, calls, failOn, client };
}

export function testDeps(store: CatalogStore, stripe: Stripe, over: Partial<CatalogDeps> = {}) {
  const anomalies: Array<{ fingerprint: string; title: string }> = [];
  const resolved: string[] = [];
  const held = new Set<string>();
  let now = new Date('2026-10-10T10:00:00Z');
  const deps: CatalogDeps = {
    store,
    stripe: () => stripe,
    context: () => ({ mode: 'test', appEnv: 'preprod', catalogContext: 'test:preprod' }),
    now: () => now,
    env: { STRIPE_EXPECTED_MODE: 'test' } as unknown as NodeJS.ProcessEnv,
    anomalies: { report: async (a) => { anomalies.push(a); }, resolve: async (f) => { resolved.push(f); } },
    lock: async (name, _ttl, work) => {
      if (held.has(name)) return null;
      held.add(name);
      try { return await work(); } finally { held.delete(name); }
    },
    ...over,
  };
  return { deps, anomalies, resolved, held, setNow: (d: Date) => { now = d; } };
}

/** Grille « ancienne » (avant bascule) : 2,90/29, 5,90/59, 8,90/89 sous trois produits. */
export function oldGrid(): Stripe.Price[] {
  return [
    price({ id: 'p_std_m', amount: 290, interval: 'month', product: 'prod_standard', key: 'verebona_standard_monthly', tax_behavior: 'unspecified' }),
    price({ id: 'p_std_y', amount: 2900, interval: 'year', product: 'prod_standard', key: 'verebona_standard_yearly', tax_behavior: 'unspecified' }),
    price({ id: 'p_pre_m', amount: 590, interval: 'month', product: 'prod_premium', key: 'verebona_premium_monthly', tax_behavior: 'unspecified' }),
    price({ id: 'p_pre_y', amount: 5900, interval: 'year', product: 'prod_premium', key: 'verebona_premium_yearly', tax_behavior: 'unspecified' }),
    price({ id: 'p_duo_m', amount: 890, interval: 'month', product: 'prod_duo', key: 'verebona_premium_duo_monthly', tax_behavior: 'unspecified' }),
    price({ id: 'p_duo_y', amount: 8900, interval: 'year', product: 'prod_duo', key: 'verebona_premium_duo_yearly', tax_behavior: 'unspecified' }),
  ];
}

export const PRODUCTS = [
  { id: 'prod_standard', plan: 'standard' },
  { id: 'prod_premium', plan: 'premium' },
  { id: 'prod_duo', plan: 'premium_duo' },
];
