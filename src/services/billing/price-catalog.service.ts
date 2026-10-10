/**
 * Catalogue commercial COURANT : résolution, validation et publication des
 * projections — CDC lookup_key V4 §6, §8, §9, LK-08 à LK-16, LK-22 à LK-28,
 * LK-94, EX-004, EX-010, EX-011.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS NIVEAUX, UNE SEULE SOURCE DE VENTE
 *
 *   Stripe            source du montant, de la devise et de la cadence ; les
 *                     six Price courants sont retrouvés par leur clé stable
 *                     (`prices.list({ lookup_keys })`, une requête) ;
 *   état partagé      `stripe_catalog_state.active_snapshot` : la RÉVISION
 *                     ACTIVE, persistée et commune à toutes les instances,
 *                     à la vitrine et à Checkout (EX-004) ;
 *   mémoire           cache d'instance ≤ 30 s, pour l'affichage seulement.
 *
 * Avant toute opération qui ENGAGE un prix (Checkout, montée en gamme,
 * programmation, changement admin), le prix de la révision active est RELU
 * chez Stripe par son identifiant et revalidé (LK-23) : une photographie,
 * même récente, n'autorise jamais un paiement.
 *
 * Pendant une publication (transferts de clés), la vente continue sur les
 * identifiants de la révision active enregistrée — jamais sur une clé en
 * cours de transfert (EX-010, EX-011). Seule la courte fenêtre d'activation
 * (bascule de la révision en base + portail) renvoie 503
 * BILLING_CATALOG_UPDATING.
 *
 * En cas d'absence ou d'incohérence : erreur typée 503, anomalie — JAMAIS un
 * ancien prix, une autre offre, un montant local ou un `price_data` (§6.3).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { pgClient } from '@/db';
import { envNumber } from '@/lib/env-number';
import { getStripeServer, getStripeCatalogContext, type StripeCatalogContext } from '@/lib/stripe-client';
import {
  ALL_LOOKUP_KEYS,
  CATALOG_COUPLES,
  coupleKey,
  planFromMetadataValue,
  type BillingPeriod,
  type CatalogCouple,
  type PlanCode,
} from '@/lib/billing/plan-catalog';
import {
  BillingCatalogError,
  catalogVersionOf,
  groupByLookupKey,
  productIdOf,
  toPublicOffer,
  validateSalePrice,
  type CatalogSnapshot,
  type CoupleKey,
  type PublicOffer,
  type ResolvedPrice,
} from './catalog-types';
import { pgCatalogStore, type CatalogStateRow, type CatalogStore, type PriceVersionRow } from './catalog-store';
import { legacyPriceRefs, legacyV2PriceFor } from './legacy-price-env';
import { versionRowFrom, isStripeTransient } from './price-history.service';

// ─── Dépendances (injectables pour les tests) ────────────────────────────────

export interface AnomalyPort {
  report(input: { fingerprint: string; title: string; detail?: Record<string, unknown> }): Promise<unknown>;
  resolve(fingerprint: string): Promise<unknown>;
}

export interface CatalogDeps {
  store: CatalogStore;
  stripe: () => Stripe;
  context: () => StripeCatalogContext;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  anomalies: AnomalyPort;
  lock: <T>(name: string, ttlMs: number, work: () => Promise<T>) => Promise<T | null>;
}

const realAnomalies: AnomalyPort = {
  async report(input) {
    const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
    void buildFingerprint;
    return reportAnomaly({ domain: 'stripe', fingerprint: input.fingerprint, title: input.title, detail: input.detail ?? null });
  },
  async resolve(fingerprint) {
    const { autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
    return autoResolveAnomaly(fingerprint, { origin: 'stripe_catalog_check' });
  },
};

const realLock: CatalogDeps['lock'] = async (name, ttl, work) => {
  const { withJobLock } = await import('@/lib/job-lock');
  return withJobLock(name, ttl, work);
};

let override: Partial<CatalogDeps> | null = null;

/** Tests : remplace tout ou partie des dépendances (et vide le cache mémoire). */
export function __setCatalogDepsForTests(d: Partial<CatalogDeps> | null): void {
  override = d;
  memo.clear();
  bootstrapInFlight = null;
  lastBootstrapAttempt = 0;
}

export function catalogDeps(): CatalogDeps {
  return {
    store: pgCatalogStore,
    stripe: getStripeServer,
    context: () => getStripeCatalogContext(),
    now: () => new Date(),
    env: process.env,
    anomalies: realAnomalies,
    lock: realLock,
    ...(override ?? {}),
  };
}

/** Empreinte d'anomalie du catalogue (consolidée, jamais multipliée, LK-92). */
export function catalogFingerprint(context: string, ...parts: string[]): string {
  return ['stripe', 'catalog', context, ...parts].join(':');
}

// ─── Cache mémoire d'instance (LK-22) ────────────────────────────────────────

/** Borne du cache mémoire local : 30 s maximum (critère de recette). */
export function memoryTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(30_000, envNumber('BILLING_CATALOG_MEMORY_TTL_MS', 30_000, { min: 0 }, env));
}
/** Fraîcheur de présentation (HTTP, vitrine) : 5 minutes maximum. */
export function presentationTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(300, envNumber('BILLING_CATALOG_PRESENTATION_TTL_S', 60, { min: 0 }, env));
}
/** Au-delà, une photographie non reconfirmée est « périmée » (LK-28). */
export const STALE_AFTER_MS = 15 * 60_000;

const memo = new Map<string, { at: number; state: CatalogStateRow | null }>();

async function readState(d: CatalogDeps, fresh: boolean): Promise<CatalogStateRow | null> {
  const ctx = d.context().catalogContext;
  const hit = memo.get(ctx);
  const now = d.now().getTime();
  if (!fresh && hit && now - hit.at < memoryTtlMs(d.env)) return hit.state;
  const state = await d.store.getState(ctx);
  memo.set(ctx, { at: now, state });
  return state;
}

/** Oublie la photographie mémoire de cette instance (les autres : ≤ 30 s, génération en base). */
export function forgetCatalogMemory(): void {
  memo.clear();
}

// ─── Révision active ─────────────────────────────────────────────────────────

let bootstrapInFlight: Promise<unknown> | null = null;
let lastBootstrapAttempt = 0;

/**
 * Révision active persistée. Au tout premier démarrage (aucune révision),
 * une synchronisation est tentée une fois (mutualisée, au plus toutes les
 * 30 s) : elle amorce la révision depuis les clés stables — ou, en double
 * lecture de transition, depuis les prix V2 configurés.
 */
async function activeState(d: CatalogDeps, fresh: boolean): Promise<CatalogStateRow | null> {
  let state = await readState(d, fresh);
  if (state?.activeSnapshot) return state;
  const now = d.now().getTime();
  if (!bootstrapInFlight && now - lastBootstrapAttempt > 30_000) {
    lastBootstrapAttempt = now;
    bootstrapInFlight = refreshCatalog({ source: 'bootstrap' }, d).catch(() => undefined).finally(() => { bootstrapInFlight = null; });
  }
  if (bootstrapInFlight) await bootstrapInFlight;
  state = await readState(d, true);
  return state;
}

function isActivating(state: CatalogStateRow | null, now: Date): boolean {
  return Boolean(state?.activatingUntil && state.activatingUntil.getTime() > now.getTime());
}

export interface ResolveOptions {
  /** Opération engageant un prix : relecture et validation chez Stripe (LK-23). */
  forPayment?: boolean;
}

/**
 * Prix courant d'un couple (contrat §5.3). Lève `BillingCatalogError`.
 */
export async function resolveCurrentPrice(
  plan: PlanCode,
  period: BillingPeriod,
  options: ResolveOptions = {},
  d: CatalogDeps = catalogDeps(),
): Promise<ResolvedPrice> {
  const couple = CATALOG_COUPLES.find((c) => c.planCode === plan && c.billingPeriod === period);
  if (!couple) throw new BillingCatalogError(plan ? 'INVALID_BILLING_PERIOD' : 'INVALID_PLAN');

  const state = await activeState(d, Boolean(options.forPayment));
  if (options.forPayment && isActivating(state, d.now())) throw new BillingCatalogError('BILLING_CATALOG_UPDATING');
  const entry = state?.activeSnapshot?.entries?.[coupleKey(plan, period)];
  if (!entry) {
    const reason = state?.activeSnapshot?.unavailable?.[coupleKey(plan, period)] ?? 'NO_ACTIVE_REVISION';
    throw new BillingCatalogError('PRICE_UNAVAILABLE', `${couple.lookupKey} : ${reason}`);
  }
  if (!options.forPayment) return entry;

  // ── Relecture chez Stripe avant d'engager un prix (LK-23) ──
  let price: Stripe.Price;
  try {
    price = await d.stripe().prices.retrieve(entry.priceId, { expand: ['product'] });
  } catch (error) {
    if (isStripeTransient(error)) throw new BillingCatalogError('STRIPE_UNAVAILABLE', (error as Error).message);
    await reportPriceIssue(d, couple, 'PRICE_NOT_FOUND', `${entry.priceId} introuvable`);
    throw new BillingCatalogError('PRICE_UNAVAILABLE', `${entry.priceId} introuvable`);
  }
  const check = validateSalePrice(price, couple, {
    livemode: d.context().mode ? d.context().mode === 'live' : null,
    saleProductId: entry.productId,
    // Pendant une publication, la clé peut déjà être sur le candidat : la
    // révision active reste vendable par son identifiant (EX-011).
    checkLookupKey: false,
    verifiedAt: d.now().toISOString(),
  });
  if (!check.ok || check.resolved.priceRevision !== entry.priceRevision) {
    const code = check.ok ? 'REVISION_MISMATCH' : check.code;
    await reportPriceIssue(d, couple, code, check.ok ? `${entry.priceId} a changé chez Stripe` : check.detail);
    await d.store.invalidate(d.context().catalogContext).catch(() => undefined);
    forgetCatalogMemory();
    throw new BillingCatalogError('PRICE_UNAVAILABLE', `${couple.lookupKey} : ${code}`);
  }
  return entry;
}

async function reportPriceIssue(d: CatalogDeps, couple: CatalogCouple, code: string, detail: string): Promise<void> {
  const ctx = d.context().catalogContext;
  console.error(JSON.stringify({ evt: 'billing.catalog.price_unavailable', context: ctx, lookupKey: couple.lookupKey, plan: couple.planCode, period: couple.billingPeriod, code, detail }));
  await d.anomalies.report({
    fingerprint: catalogFingerprint(ctx, 'couple', couple.lookupKey),
    title: `Catalogue Stripe : ${couple.lookupKey} indisponible (${code})`,
    detail: { context: ctx, lookupKey: couple.lookupKey, code, detail },
  }).catch(() => undefined);
}

/**
 * Contrôle « affichage ↔ clic » (LK-34, LK-35) : la révision affichée doit
 * être celle du prix CHOISI (pas la version globale). Lève 409.
 */
export function assertDisplayedRevision(resolved: ResolvedPrice, displayed: string | null | undefined): void {
  if (!displayed) throw new BillingCatalogError('PRICE_CONFIRMATION_REQUIRED', undefined, toPublicOffer(resolved));
  if (displayed !== resolved.priceRevision) throw new BillingCatalogError('PRICE_CHANGED', undefined, toPublicOffer(resolved));
}

// ─── Catalogue public (LK-29, LK-30, LK-33) ─────────────────────────────────

export interface PlanQuota { plan_code: PlanCode; max_assets: number | null; max_documents: number | null; max_users: number | null }

export interface PublicBillingCatalog {
  catalog_version: string | null;
  verified_at: string | null;
  /** `ok` | `stale` (photographie non reconfirmée) | `unavailable` | `updating`. */
  status: 'ok' | 'stale' | 'unavailable' | 'updating';
  /** Actions tarifaires possibles (faux si Stripe ne répond plus, LK-28). */
  purchasable: boolean;
  offers: PublicOffer[];
  plans: PlanQuota[];
}

async function planQuotas(): Promise<PlanQuota[]> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT plan_code, max_assets, max_documents, max_users FROM plan_limits WHERE plan_code IN ('standard','premium','premium_duo') ORDER BY plan_code`,
    );
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      plan_code: r.plan_code as PlanCode,
      max_assets: r.max_assets == null ? null : Number(r.max_assets),
      max_documents: r.max_documents == null ? null : Number(r.max_documents),
      max_users: r.max_users == null ? null : Number(r.max_users),
    }));
  } catch {
    return [];
  }
}

/** Construction pure de la réponse publique (aucun identifiant de compte, aucun secret). */
export function buildPublicCatalog(state: CatalogStateRow | null, now: Date, plans: PlanQuota[] = []): PublicBillingCatalog {
  const snap = state?.activeSnapshot ?? null;
  if (!snap) return { catalog_version: null, verified_at: null, status: 'unavailable', purchasable: false, offers: [], plans };
  const offers: PublicOffer[] = CATALOG_COUPLES.flatMap((c) => {
    const e = snap.entries[coupleKey(c.planCode, c.billingPeriod)];
    return e ? [toPublicOffer(e, true)] : [];
  });
  const verifiedAt = state?.verifiedAt ?? new Date(snap.verifiedAt);
  const stale = now.getTime() - verifiedAt.getTime() > STALE_AFTER_MS;
  const updating = isActivating(state, now);
  return {
    catalog_version: snap.version,
    verified_at: verifiedAt.toISOString(),
    status: updating ? 'updating' : stale ? 'stale' : offers.length ? 'ok' : 'unavailable',
    purchasable: !updating && !(stale && state?.lastSyncError) && offers.length > 0,
    offers,
    plans,
  };
}

/** Catalogue public, mutualisé (lecture d'état partagé ; aucun appel Stripe par visiteur). */
export async function getPublicCatalog(d: CatalogDeps = catalogDeps()): Promise<PublicBillingCatalog> {
  const state = await activeState(d, false);
  return buildPublicCatalog(state, d.now(), await planQuotas());
}

// ─── Synchronisation (refreshCatalog) ────────────────────────────────────────

export interface CatalogRefreshResult {
  status: 'unchanged' | 'adopted' | 'skipped' | 'failed';
  reason?: string;
  version?: string | null;
  unavailable?: Partial<Record<CoupleKey, string>>;
}

/** Les six prix porteurs des clés stables (une requête, pagination défensive, LK-09). */
export async function listKeyedPrices(stripe: Pick<Stripe, 'prices'>, keys: readonly string[] = ALL_LOOKUP_KEYS): Promise<Stripe.Price[]> {
  const out: Stripe.Price[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await stripe.prices.list({
      lookup_keys: [...keys],
      active: true,
      type: 'recurring',
      currency: 'eur',
      limit: 100,
      expand: ['data.product'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    out.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return out;
}

/** États pendant lesquels la synchronisation n'adopte JAMAIS l'état des clés Stripe. */
const NO_ADOPTION_STATES = new Set(['PREPARED', 'VALIDATING', 'PUBLISHING', 'READY', 'RECOVERING', 'FAILED']);

async function stripeAccountId(stripe: Stripe): Promise<string | null> {
  try {
    const acct = await (stripe.accounts as unknown as { retrieve: () => Promise<{ id: string }> }).retrieve();
    return acct?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Produit de VENTE approuvé pour une offre ; à défaut, amorçage vérifié
 * (LK-03) : produit du prix porteur de la clé, SI sa métadonnée produit
 * désigne l'offre (convention du seed `verebona_<offre>`) ou si un identifiant
 * de prix configuré par l'exploitant (STRIPE_PRICE_*) appartient à ce produit.
 * Jamais une recherche par nom.
 */
async function saleProductFor(
  d: CatalogDeps,
  ctx: string,
  plan: PlanCode,
  keyed: Stripe.Price | undefined,
  approved: Array<{ planCode: PlanCode; stripeProductId: string; role: string }>,
  legacyProducts: Map<string, PlanCode>,
  accountId: string | null,
): Promise<string | null> {
  const sale = approved.find((a) => a.planCode === plan && a.role === 'sale');
  if (sale) return sale.stripeProductId;
  if (!keyed) return null;
  const productId = productIdOf(keyed);
  if (!productId) return null;
  const product = typeof keyed.product === 'object' ? (keyed.product as Stripe.Product) : null;
  const metaPlan = planFromMetadataValue(product?.metadata?.verebona_plan);
  const proof = metaPlan === plan ? 'bootstrap:product-metadata' : legacyProducts.get(productId) === plan ? 'bootstrap:legacy-env' : null;
  if (!proof) return null;
  const r = await d.store.approveProduct(ctx, { planCode: plan, stripeProductId: productId, role: 'sale', source: proof, stripeAccountId: accountId, livemode: keyed.livemode });
  return r === 'conflict' ? null : productId;
}

/**
 * Relit Stripe et publie les projections validées (« sync ») : ne crée ni
 * prix ni abonnement. Lit Stripe AU MOMENT du traitement, jamais le contenu
 * d'un événement (LK-25). Verrou partagé (LK-27).
 */
export async function refreshCatalog(
  opts: { source: string },
  d: CatalogDeps = catalogDeps(),
): Promise<CatalogRefreshResult> {
  const ctx = d.context();
  if (!ctx.mode) return { status: 'skipped', reason: 'NO_STRIPE_KEY' };
  const result = await d.lock(`stripe-catalog-sync:${ctx.catalogContext}`, 120_000, () => doRefresh(opts, d, ctx));
  return result ?? { status: 'skipped', reason: 'LOCKED' };
}

async function doRefresh(opts: { source: string }, d: CatalogDeps, ctx: StripeCatalogContext): Promise<CatalogRefreshResult> {
  const now = d.now();
  const nowIso = now.toISOString();
  const state = await d.store.ensureState(ctx.catalogContext);
  const stripe = d.stripe();
  try {
    const accountId = await stripeAccountId(stripe);
    const accountChanged = Boolean(state.stripeAccountId && accountId && state.stripeAccountId !== accountId);
    if (accountChanged) {
      await d.anomalies.report({
        fingerprint: catalogFingerprint(ctx.catalogContext, 'account-changed'),
        title: 'Catalogue Stripe : le compte Stripe du contexte a changé (base restaurée ou clé d’un autre compte)',
        detail: { context: ctx.catalogContext, previous: state.stripeAccountId, current: accountId },
      });
    }

    // Publication en cours ou en échec : on ne touche pas à la révision
    // active (ancienne grille vendue, EX-010, TC-84) — vérification seule.
    if (NO_ADOPTION_STATES.has(state.publicationState) && !accountChanged) {
      await d.store.touchVerified(ctx.catalogContext, now, accountId, ctx.mode === 'live');
      forgetCatalogMemory();
      return { status: 'skipped', reason: `PUBLICATION_${state.publicationState}`, version: state.activeRevision };
    }

    const keyedPrices = await listKeyedPrices(stripe);
    const groups = groupByLookupKey(keyedPrices);
    const approved = await d.store.listApprovedProducts(ctx.catalogContext);
    const legacyProducts = new Map<string, PlanCode>();
    const livemode = ctx.mode === 'live';
    // Amorçage des produits de vente : les identifiants configurés par
    // l'exploitant désignent des produits Verebona (preuve, LK-03, LK-82).
    if (CATALOG_COUPLES.some((c) => !approved.some((a) => a.planCode === c.planCode && a.role === 'sale'))) {
      for (const ref of legacyPriceRefs(d.env)) {
        try {
          const p = await stripe.prices.retrieve(ref.priceId);
          const productId = productIdOf(p);
          if (productId && p.livemode === livemode) legacyProducts.set(productId, ref.planCode);
        } catch { /* identifiant obsolète : sans effet */ }
      }
    }

    const entries: CatalogSnapshot['entries'] = {};
    const unavailable: CatalogSnapshot['unavailable'] = {};
    const versions: PriceVersionRow[] = [];

    for (const couple of CATALOG_COUPLES) {
      const key = coupleKey(couple.planCode, couple.billingPeriod);
      let candidates = groups.get(couple.lookupKey) ?? [];

      // Amorçage (LK-83) : clé absente → initialisée sur le prix V2 configuré,
      // après vérification. Ne vole jamais une clé portée par un autre prix.
      if (candidates.length === 0) {
        const initialized = await initializeKeyFromLegacy(d, stripe, couple, legacyProducts);
        if (initialized) candidates = [initialized];
      }
      if (candidates.length === 0) { unavailable[key] = 'KEY_MISSING'; continue; }
      if (candidates.length > 1) { unavailable[key] = 'KEY_CONFLICT'; continue; }
      const price = candidates[0];
      const saleProduct = await saleProductFor(d, ctx.catalogContext, couple.planCode, price, approved, legacyProducts, accountId);
      const check = validateSalePrice(price, couple, { livemode, saleProductId: saleProduct, verifiedAt: nowIso });
      if (!check.ok) {
        unavailable[key] = check.code;
        await reportPriceIssue(d, couple, check.code, check.detail);
        continue;
      }
      entries[key] = check.resolved;
      versions.push(versionRowFrom(price, couple.planCode, couple.billingPeriod, ctx, 'catalog', accountId));
      await d.anomalies.resolve(catalogFingerprint(ctx.catalogContext, 'couple', couple.lookupKey)).catch(() => undefined);
    }

    const version = catalogVersionOf(entries);
    const sameAsActive = state.activeRevision === version && !accountChanged
      && JSON.stringify(state.activeSnapshot?.unavailable ?? {}) === JSON.stringify(unavailable);
    if (sameAsActive) {
      for (const v of versions) await d.store.upsertPriceVersion(v);
      await d.store.touchVerified(ctx.catalogContext, now, accountId, livemode);
      forgetCatalogMemory();
      await d.anomalies.resolve(catalogFingerprint(ctx.catalogContext, 'sync-failed')).catch(() => undefined);
      return { status: 'unchanged', version, unavailable };
    }

    // Une photographie entièrement vide ne remplace jamais une révision
    // vendable (incident de configuration, pas une publication).
    if (Object.keys(entries).length === 0 && state.activeSnapshot && Object.keys(state.activeSnapshot.entries).length > 0) {
      await d.store.setSyncError(ctx.catalogContext, 'Aucune clé stable valide chez Stripe : révision active conservée');
      return { status: 'failed', reason: 'EMPTY_CATALOG', version: state.activeRevision, unavailable };
    }

    const snapshot: CatalogSnapshot = { version, verifiedAt: nowIso, entries, unavailable, source: opts.source === 'bootstrap' ? 'bootstrap' : 'sync' };
    await d.store.activateSnapshot({
      context: ctx.catalogContext, stripeAccountId: accountId, livemode, snapshot,
      keepPrevious: !accountChanged, versions,
    });
    forgetCatalogMemory();
    await detectDrift(d, ctx.catalogContext, entries, state.publishedManifestRevision);
    console.info(JSON.stringify({ evt: 'billing.catalog.adopted', context: ctx.catalogContext, source: opts.source, from: state.activeRevision, to: version, unavailable }));
    // Portail aligné sur la nouvelle révision (LK-48) — best effort, contrôlé au clic.
    try {
      const { syncUpgradePortal } = await import('./portal-configuration.service');
      await syncUpgradePortal({ reason: `sync:${opts.source}` }, d);
    } catch (e) {
      console.error('[price-catalog] portail non synchronisé :', (e as Error).message);
    }
    return { status: 'adopted', version, unavailable };
  } catch (error) {
    const message = (error as Error)?.message?.slice(0, 300) ?? String(error);
    await d.store.setSyncError(ctx.catalogContext, message).catch(() => undefined);
    console.error(JSON.stringify({ evt: 'billing.catalog.sync_failed', context: ctx.catalogContext, source: opts.source, error: message }));
    // Anomalie consolidée seulement si la photographie devient périmée.
    const verified = state.verifiedAt?.getTime() ?? 0;
    if (now.getTime() - verified > STALE_AFTER_MS) {
      await d.anomalies.report({
        fingerprint: catalogFingerprint(ctx.catalogContext, 'sync-failed'),
        title: 'Catalogue Stripe : synchronisation impossible (photographie périmée)',
        detail: { context: ctx.catalogContext, error: message },
      }).catch(() => undefined);
    }
    return { status: 'failed', reason: message };
  }
}

/**
 * Clé stable absente : l'initialiser sur le prix V2 configuré par
 * l'exploitant (STRIPE_PRICE_<OFFRE>_<PÉRIODE>) — double lecture de
 * transition, avant suppression des variables. Vérifie le prix (actif,
 * cadence, devise) ; refuse si le prix porte déjà une autre clé.
 */
async function initializeKeyFromLegacy(
  d: CatalogDeps,
  stripe: Stripe,
  couple: CatalogCouple,
  legacyProducts: Map<string, PlanCode>,
): Promise<Stripe.Price | null> {
  const priceId = legacyV2PriceFor(couple.planCode, couple.billingPeriod, d.env);
  if (!priceId) return null;
  try {
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    if (!price.active || price.recurring?.interval !== couple.interval || (price.currency ?? '').toLowerCase() !== 'eur') return null;
    if (price.lookup_key && price.lookup_key !== couple.lookupKey) {
      await d.anomalies.report({
        fingerprint: catalogFingerprint(d.context().catalogContext, 'key-init', couple.lookupKey),
        title: `Catalogue Stripe : ${priceId} porte déjà la clé ${price.lookup_key}`,
        detail: { lookupKey: couple.lookupKey, priceId, existing: price.lookup_key },
      });
      return null;
    }
    legacyProducts.set(productIdOf(price) ?? '', couple.planCode);
    if (price.lookup_key === couple.lookupKey) return price;
    const updated = await stripe.prices.update(priceId, { lookup_key: couple.lookupKey, expand: ['product'] });
    console.info(JSON.stringify({ evt: 'billing.catalog.key_initialized', lookupKey: couple.lookupKey, priceId }));
    return updated;
  } catch (e) {
    console.error(`[price-catalog] initialisation de ${couple.lookupKey} impossible :`, (e as Error).message);
    return null;
  }
}

/**
 * Dérive (§16.4) : la grille réellement vendue diffère du manifeste DÉJÀ
 * publié — modification manuelle dans Stripe. Signalée, jamais écrasée
 * silencieusement.
 */
async function detectDrift(d: CatalogDeps, ctx: string, entries: CatalogSnapshot['entries'], published: string | null): Promise<void> {
  const { PRICING_MANIFEST, manifestRevision } = await import('./pricing-manifest');
  if (!published || published !== manifestRevision()) return;
  const drift = CATALOG_COUPLES.filter((c) => {
    const e = entries[coupleKey(c.planCode, c.billingPeriod)];
    return e && e.unitAmountCents !== PRICING_MANIFEST[c.planCode][c.billingPeriod].unitAmountCents;
  }).map((c) => c.lookupKey);
  const fp = catalogFingerprint(ctx, 'drift');
  if (drift.length) {
    await d.anomalies.report({ fingerprint: fp, title: `Catalogue Stripe : dérive par rapport au référentiel du code (${drift.join(', ')})`, detail: { lookupKeys: drift } });
  } else {
    await d.anomalies.resolve(fp).catch(() => undefined);
  }
}

/** Invalidation partagée (événement Price/Product, LK-24, LK-25) : génération +1 en base. */
export async function invalidateCatalog(reason: string, d: CatalogDeps = catalogDeps()): Promise<void> {
  await d.store.invalidate(d.context().catalogContext);
  forgetCatalogMemory();
  console.info(JSON.stringify({ evt: 'billing.catalog.invalidated', context: d.context().catalogContext, reason }));
}
