/**
 * Configuration du portail Stripe dédiée à la montée en gamme immédiate —
 * CDC lookup_key V4 §11.1, LK-47 à LK-50, EC-08, TC-41.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES PRIX AUTORISÉS SUIVENT LA RÉVISION ACTIVE
 *
 * La configuration était créée UNE fois avec les six prix de l'époque, puis
 * retrouvée (variable, cache mémoire, métadonnées) sans jamais être
 * resynchronisée : après une hausse, le portail aurait continué de proposer
 * les anciens prix comme cibles — ou refusé les nouveaux.
 *
 * Désormais, la liste `subscription_update.products` est ALIGNÉE sur la
 * révision active à chaque changement de révision (publication, rollback,
 * synchronisation) et contrôlée au clic, y compris quand l'identifiant vient
 * de STRIPE_PORTAL_UPGRADE_CONFIGURATION_ID ou d'une configuration
 * `verebona_flow = immediate_upgrade_v1` existante (LK-48). Le cache est
 * identifié par contexte + configuration + empreinte des prix (LK-49) : un
 * clic ne crée jamais de configuration, et seuls les champs gérés par ce
 * parcours sont mis à jour. La publication n'est complète qu'après RELECTURE
 * des prix effectivement acceptés par le portail.
 *
 * Les anciens prix ne sont pas proposés comme cibles (LK-50) ; le prix d'un
 * abonné historique n'a pas à y figurer pour qu'il puisse monter en gamme.
 *
 * LOT 49A — incident préprod « For each product, its price must have unique
 * billing intervals. » : la publication transmettait l'UNION des prix de
 * l'ancienne et de la nouvelle révision (deux mensuels / deux annuels sous le
 * même produit), ce que Stripe refuse. Désormais :
 *   - exactement les prix d'UNE révision (six pour une grille complète) ;
 *   - contrôle d'unicité de périodicité par produit AVANT tout appel Stripe ;
 *   - relecture et égalité EXACTE (produit par produit) des prix acceptés et
 *     des paramètres de montée en gamme ;
 *   - sauvegarde de la configuration précédente et restauration vérifiée ;
 *   - pendant une transition (publication non ACTIVE), le clic « monter en
 *     gamme » n'écrit JAMAIS le portail : il ouvre le parcours seulement si
 *     le portail correspond à la révision active, sinon `PORTAL_UPDATING`
 *     (« réessayez dans quelques minutes »).
 *
 * LOT 53I — incident préprod « PORTAL_MISMATCH : prix acceptés ∅ » puis
 * « PORTAL_RESTORE_FAILED » : `features.subscription_update.products` est un
 * champ INCLUDABLE de l'API Stripe (2025-08-27.basil) — NON renvoyé par
 * retrieve / update / create / list sans
 * `expand: ['features.subscription_update.products']` (SDK 18.5.0 :
 * `products?:`, même convention que `Price.tiers` ou
 * `Checkout.Session.line_items` ; absent de l'exemple d'objet de la
 * documentation). L'ancienne relecture, sans expansion, lisait une propriété
 * ABSENTE et la prenait pour une liste vide (`?? []`) : toute vérification
 * échouait, restauration comprise, alors que Stripe avait bien enregistré les
 * prix. Désormais :
 *   - toute lecture ET toute écriture demandent l'expansion ;
 *   - « propriété absente » (même après expansion, ou expansion refusée)
 *     = état INDÉTERMINÉ → `PORTAL_UNVERIFIABLE`, jamais « vide », jamais un
 *     succès ; « liste explicitement vide » = état déterminé, comparé ;
 *   - la vérification porte TOUJOURS sur la réponse Stripe relue, jamais sur
 *     le tableau local envoyé ;
 *   - grille complète : exactement trois produits de vente APPROUVÉS, un
 *     mensuel et un annuel chacun ; aucun prix étranger ;
 *   - aucune écriture d'une liste vide (refus avant tout appel) ;
 *   - sauvegarde indéterminée → restauration sur la révision active
 *     (ancienne), relue et vérifiée ;
 *   - publication en ÉCHEC (ou état intermédiaire figé depuis plus de
 *     30 min) : blocage durable, le clic renvoie `PORTAL_BLOCKED` (message
 *     sans « réessayez dans quelques minutes »).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { CATALOG_COUPLES, coupleKey } from '@/lib/billing/plan-catalog';
import type { CatalogSnapshot } from './catalog-types';
import { catalogDeps, catalogFingerprint, type CatalogDeps } from './price-catalog.service';

export const PORTAL_CONFIG_METADATA_KEY = 'verebona_flow';
export const PORTAL_CONFIG_METADATA_VALUE = 'immediate_upgrade_v1';
/**
 * Lot 53I — champ INCLUDABLE : à demander explicitement sur chaque lecture
 * et chaque écriture (sinon la réponse ne le contient pas).
 */
export const PORTAL_PRODUCTS_EXPAND = 'features.subscription_update.products';
/** Revérification minimale d'une configuration alignée. */
const REVERIFY_AFTER_MS = 60 * 60_000;

type PortalProducts = Array<{ product: string; prices: string[] }>;

type PortalErrorCode =
  | 'PORTAL_DUPLICATE_INTERVAL'
  | 'PORTAL_INCOMPLETE'
  | 'PORTAL_MISMATCH'
  | 'PORTAL_UPDATING'
  | 'PORTAL_RESTORE_FAILED'
  /** Lot 53I : prix autorisés NON relus (propriété absente) — état indéterminé. */
  | 'PORTAL_UNVERIFIABLE'
  /** Lot 53I : produit hors des produits de vente approuvés (ou mal réparti). */
  | 'PORTAL_PRODUCT_NOT_APPROVED'
  /** Lot 53I : configuration d'un autre mode Stripe (test ↔ live). */
  | 'PORTAL_MODE_MISMATCH'
  /** Lot 53I : publication en échec durable — montée en gamme bloquée jusqu'à la reprise. */
  | 'PORTAL_BLOCKED';

/** Erreur typée du portail (fonctionnelle : jamais reprise en boucle). */
class PortalConfigError extends Error {
  constructor(public readonly code: PortalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PortalConfigError';
  }
}

interface PortalPriceRef { planCode: string; productId: string; priceId: string; interval: string }

/** Prix d'une révision avec leur offre et leur périodicité (contrôles structurels). */
export function portalPriceRefs(snapshot: CatalogSnapshot): PortalPriceRef[] {
  return CATALOG_COUPLES.flatMap((c) => {
    const e = snapshot.entries[coupleKey(c.planCode, c.billingPeriod)];
    return e ? [{ planCode: c.planCode, productId: e.productId, priceId: e.priceId, interval: e.interval }] : [];
  });
}

/**
 * Produits et prix autorisés d'UNE révision, regroupés et triés
 * (déterministe). Lot 49A : plus aucun prix « supplémentaire » (l'union
 * ancienne + nouvelle révision provoquait le refus Stripe).
 */
export function portalProductsFor(snapshot: CatalogSnapshot): PortalProducts {
  return normalizePortalProducts(portalPriceRefs(snapshot).map((r) => ({ product: r.productId, prices: [r.priceId] })));
}

/** Forme canonique (produits triés, prix uniques triés) pour comparaison exacte. */
function normalizePortalProducts(products: Array<{ product: string; prices?: string[] | null }>): PortalProducts {
  const byProduct = new Map<string, Set<string>>();
  for (const p of products) {
    const set = byProduct.get(p.product) ?? new Set<string>();
    for (const id of p.prices ?? []) set.add(id);
    byProduct.set(p.product, set);
  }
  return [...byProduct].sort(([a], [b]) => a.localeCompare(b)).map(([product, prices]) => ({ product, prices: [...prices].sort() }));
}

/**
 * Doublons de périodicité par produit (règle Stripe : « For each product, its
 * price must have unique billing intervals. »). Vide si conforme. Pure.
 */
export function duplicateIntervals(refs: Array<{ productId: string; priceId: string; interval: string }>): string[] {
  const seen = new Map<string, string[]>();
  for (const r of refs) {
    const k = `${r.productId}:${r.interval}`;
    seen.set(k, [...(seen.get(k) ?? []), r.priceId]);
  }
  return [...seen].filter(([, ids]) => new Set(ids).size > 1).map(([k, ids]) => `${k} (${[...new Set(ids)].sort().join(', ')})`);
}

/**
 * Grille COMPLÈTE attendue au portail (lot 53I) : trois produits distincts,
 * un par offre, chacun avec exactement un mensuel et un annuel ; produits
 * de vente APPROUVÉS pour leur offre. Vide si conforme. Pure.
 */
export function completeGridIssues(refs: PortalPriceRef[], approved: Array<{ planCode: string; stripeProductId: string; role: string }>): string[] {
  const issues: string[] = [];
  if (refs.length !== CATALOG_COUPLES.length) issues.push(`${refs.length} prix au lieu de ${CATALOG_COUPLES.length}`);
  const byProduct = new Map<string, PortalPriceRef[]>();
  for (const r of refs) byProduct.set(r.productId, [...(byProduct.get(r.productId) ?? []), r]);
  if (byProduct.size !== 3) issues.push(`${byProduct.size} produit(s) au lieu de 3`);
  for (const [product, list] of byProduct) {
    const intervals = list.map((r) => r.interval).sort().join('+');
    if (intervals !== 'month+year') issues.push(`${product} : périodicités ${intervals || '∅'} (attendu un mensuel et un annuel)`);
    const plans = new Set(list.map((r) => r.planCode));
    if (plans.size !== 1) issues.push(`${product} : partagé par plusieurs offres (${[...plans].join(', ')})`);
    for (const plan of plans) {
      if (!approved.some((a) => a.role === 'sale' && a.planCode === plan && a.stripeProductId === product)) {
        issues.push(`${product} : produit non approuvé pour la vente de ${plan}`);
      }
    }
  }
  return issues;
}

export function portalFingerprint(context: string, configurationId: string, products: PortalProducts): string {
  return createHash('sha256').update(JSON.stringify([context, configurationId, products])).digest('hex').slice(0, 24);
}

/**
 * Lecture des prix autorisés d'une configuration RELUE (lot 53I) :
 *   - `absent`  : la réponse ne contient pas la propriété (champ includable
 *                 non inclus) — état INDÉTERMINÉ, jamais assimilé à « vide » ;
 *   - `present` : liste renvoyée par Stripe, éventuellement vide (`[]` ou
 *                 `null` explicites) — état DÉTERMINÉ.
 */
type PortalReading = { state: 'present'; products: PortalProducts } | { state: 'absent' };

export function readPortalProducts(conf: Stripe.BillingPortal.Configuration | null | undefined): PortalReading {
  const su = conf?.features?.subscription_update as (Stripe.BillingPortal.Configuration.Features.SubscriptionUpdate | undefined);
  if (!su || !Object.prototype.hasOwnProperty.call(su, 'products') || su.products === undefined) return { state: 'absent' };
  return { state: 'present', products: normalizePortalProducts((su.products ?? []).map((p) => ({ product: p.product, prices: p.prices }))) };
}

/** Produits acceptés, forme canonique, ou `null` si INDÉTERMINÉ (propriété absente). */
export function acceptedProductsOf(conf: Stripe.BillingPortal.Configuration): PortalProducts | null {
  const r = readPortalProducts(conf);
  return r.state === 'present' ? r.products : null;
}

/** Produits et prix acceptés par une configuration relue ; lève si indéterminé. */
export function acceptedProducts(conf: Stripe.BillingPortal.Configuration): PortalProducts {
  const r = acceptedProductsOf(conf);
  if (!r) throw new PortalConfigError('PORTAL_UNVERIFIABLE', `portail ${conf.id ?? '?'} : liste des prix autorisés absente de la réponse Stripe`);
  return r;
}

/** Prix réellement acceptés par une configuration relue (vérification) ; lève si indéterminé. */
export function acceptedPrices(conf: Stripe.BillingPortal.Configuration): string[] {
  return acceptedProducts(conf).flatMap((p) => p.prices).sort();
}

/** Paramètres du parcours de montée en gamme attendus (LK-51). */
function upgradeSettingsOk(conf: Stripe.BillingPortal.Configuration): boolean {
  const su = conf.features?.subscription_update;
  return su?.enabled === true
    && su.proration_behavior === 'always_invoice'
    && (su.default_allowed_updates ?? []).includes('price');
}

interface PortalCheck {
  ok: boolean;
  /** `false` : prix autorisés non relus (propriété absente) — rien n'est prouvé. */
  determinate: boolean;
  accepted: PortalProducts | null;
  settingsOk: boolean;
  /** Prix acceptés hors de la liste attendue (prix étrangers). */
  foreign: string[];
  /** Prix attendus non acceptés. */
  missing: string[];
}

/** Égalité EXACTE (produit par produit) entre attendu et accepté RELU. Pure. */
function portalMatches(conf: Stripe.BillingPortal.Configuration, expected: PortalProducts): PortalCheck {
  const accepted = acceptedProductsOf(conf);
  const settingsOk = upgradeSettingsOk(conf);
  const want = normalizePortalProducts(expected);
  if (!accepted) return { ok: false, determinate: false, accepted: null, settingsOk, foreign: [], missing: [] };
  const acc = new Set(accepted.flatMap((p) => p.prices));
  const exp = new Set(want.flatMap((p) => p.prices));
  return {
    ok: settingsOk && JSON.stringify(accepted) === JSON.stringify(want),
    determinate: true,
    accepted,
    settingsOk,
    foreign: [...acc].filter((id) => !exp.has(id)).sort(),
    missing: [...exp].filter((id) => !acc.has(id)).sort(),
  };
}

/** Description lisible d'un contrôle en échec (journal, BO). Pure. */
function describePortalCheck(configurationId: string, check: PortalCheck, expected: PortalProducts): string {
  const exp = expected.flatMap((p) => p.prices).sort().join(',');
  if (!check.determinate) return `portail ${configurationId} : prix autorisés NON relus (propriété features.subscription_update.products absente de la réponse Stripe, état indéterminé) ; attendus ${exp}`;
  const acc = (check.accepted ?? []).flatMap((p) => p.prices).sort().join(',') || '∅ (liste explicitement vide)';
  const detail = [
    check.foreign.length ? `prix étrangers ${check.foreign.join(',')}` : '',
    check.missing.length ? `prix manquants ${check.missing.join(',')}` : '',
    check.settingsOk ? '' : 'paramètres de montée en gamme non conformes',
  ].filter(Boolean).join(' ; ');
  return `portail ${configurationId} : prix acceptés ${acc} ≠ attendus ${exp}${detail ? ` (${detail})` : ''}`;
}

/** Stripe refuse l'expansion demandée (propriété non extensible). */
function isExpandRejection(e: unknown): boolean {
  const err = e as { type?: string; statusCode?: number; message?: string };
  return (err?.type === 'StripeInvalidRequestError' || err?.statusCode === 400) && /expand/i.test(err?.message ?? '');
}

async function findConfigurationId(stripe: Stripe, known: string | null, env: NodeJS.ProcessEnv): Promise<string | null> {
  const fromEnv = env.STRIPE_PORTAL_UPGRADE_CONFIGURATION_ID?.trim();
  if (fromEnv) return fromEnv;
  if (known) {
    try {
      const conf = await stripe.billingPortal.configurations.retrieve(known);
      if (conf.active) return conf.id;
    } catch { /* supprimée ou d'un autre compte : recherche */ }
  }
  for await (const conf of stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
    if (conf.metadata?.[PORTAL_CONFIG_METADATA_KEY] === PORTAL_CONFIG_METADATA_VALUE) return conf.id;
  }
  return null;
}

interface PortalRead {
  conf: Stripe.BillingPortal.Configuration;
  reading: PortalReading;
  /** Stripe a refusé l'expansion : lecture sans `products` (indéterminée). */
  expandRejected: boolean;
}

/**
 * Relecture d'une configuration AVEC l'expansion du champ includable
 * `features.subscription_update.products` (lot 53I). Si Stripe refusait
 * l'expansion, relecture simple : la propriété absente laisse l'état
 * INDÉTERMINÉ (jamais « vide »).
 */
async function rereadConfiguration(stripe: Stripe, id: string): Promise<PortalRead> {
  try {
    const conf = await stripe.billingPortal.configurations.retrieve(id, { expand: [PORTAL_PRODUCTS_EXPAND] });
    return { conf, reading: readPortalProducts(conf), expandRejected: false };
  } catch (e) {
    if (!isExpandRejection(e)) throw e;
    console.warn(JSON.stringify({ evt: 'billing.portal.expand_rejected', configurationId: id, error: (e as Error).message }));
    const conf = await stripe.billingPortal.configurations.retrieve(id);
    return { conf, reading: readPortalProducts(conf), expandRejected: true };
  }
}

function subscriptionUpdateFor(products: PortalProducts) {
  // Jamais de liste vide écrite (elle retirerait toutes les cibles de montée en gamme).
  if (products.length === 0 || products.some((p) => p.prices.length === 0)) {
    throw new PortalConfigError('PORTAL_INCOMPLETE', 'liste de prix autorisés vide : écriture refusée');
  }
  return {
    enabled: true,
    default_allowed_updates: ['price'] as Array<'price'>,
    // Prorata facturé et encaissé immédiatement (et non reporté, LK-51).
    proration_behavior: 'always_invoice' as const,
    products,
  };
}

/** Écriture (mise à jour) avec expansion ; repli sans expansion si Stripe la refuse. */
async function writeConfiguration(stripe: Stripe, id: string, products: PortalProducts): Promise<void> {
  const params = { features: { subscription_update: subscriptionUpdateFor(products) } };
  try {
    await stripe.billingPortal.configurations.update(id, { ...params, expand: [PORTAL_PRODUCTS_EXPAND] });
  } catch (e) {
    if (!isExpandRejection(e)) throw e;
    await stripe.billingPortal.configurations.update(id, params);
  }
}

/** Configuration d'un autre mode Stripe que le contexte : refus (aucun mélange test / live). */
function assertSameMode(conf: Stripe.BillingPortal.Configuration, mode: string | null): void {
  if (typeof conf.livemode === 'boolean' && mode && conf.livemode !== (mode === 'live')) {
    throw new PortalConfigError('PORTAL_MODE_MISMATCH', `configuration ${conf.id} en mode ${conf.livemode ? 'live' : 'test'} ≠ contexte ${mode}`);
  }
}

interface PortalSyncResult {
  configurationId: string;
  fingerprint: string;
  changed: boolean;
}

/**
 * Aligne la configuration sur UNE révision (active, ou candidate à valider
 * AVANT activation) et la vérifie. Lève si la révision est absente, si deux
 * prix d'un même produit ont la même périodicité (AVANT tout appel Stripe),
 * si la grille complète exigée n'est pas conforme (produits approuvés, un
 * mensuel + un annuel par produit), si la relecture ne permet pas de lire
 * les prix autorisés (indéterminé) ou ne montre pas EXACTEMENT les prix
 * attendus.
 */
export async function syncUpgradePortal(
  opts: { reason: string; force?: boolean; /** Révision à valider AVANT activation (EX-012). */ snapshot?: CatalogSnapshot; persist?: boolean;
    /** Grille complète exigée (six prix) — publication. */ requireComplete?: boolean },
  d: CatalogDeps = catalogDeps(),
): Promise<PortalSyncResult> {
  const context = d.context();
  const ctx = context.catalogContext;
  const state = await d.store.getState(ctx);
  const snapshot = opts.snapshot ?? state?.activeSnapshot;
  if (!snapshot || Object.keys(snapshot.entries).length === 0) throw new Error('Aucune révision active : portail non synchronisable');
  const refs = portalPriceRefs(snapshot);
  const fpAnomaly = catalogFingerprint(ctx, 'portal');
  if (opts.requireComplete && refs.length !== CATALOG_COUPLES.length) {
    throw new PortalConfigError('PORTAL_INCOMPLETE', `${refs.length} prix au lieu de ${CATALOG_COUPLES.length}`);
  }
  const dup = duplicateIntervals(refs);
  if (dup.length) {
    await d.anomalies.report({
      fingerprint: fpAnomaly,
      title: 'Catalogue Stripe : portail non modifié (deux prix de même périodicité pour un produit)',
      detail: { duplicates: dup, reason: opts.reason },
    }).catch(() => undefined);
    throw new PortalConfigError('PORTAL_DUPLICATE_INTERVAL', dup.join(' ; '));
  }
  if (opts.requireComplete) {
    const issues = completeGridIssues(refs, await d.store.listApprovedProducts(ctx));
    if (issues.length) {
      await d.anomalies.report({ fingerprint: fpAnomaly, title: 'Catalogue Stripe : portail non modifié (grille non conforme)', detail: { issues, reason: opts.reason } }).catch(() => undefined);
      throw new PortalConfigError('PORTAL_PRODUCT_NOT_APPROVED', issues.join(' ; '));
    }
  }
  const products = portalProductsFor(snapshot);
  const stripe = d.stripe();

  let configurationId = await findConfigurationId(stripe, state?.portalConfigurationId ?? null, d.env);
  const now = d.now();
  if (configurationId && !opts.force && !opts.snapshot) {
    const fp = portalFingerprint(ctx, configurationId, products);
    const fresh = state?.portalVerifiedAt && now.getTime() - state.portalVerifiedAt.getTime() < REVERIFY_AFTER_MS;
    if (state?.portalFingerprint === fp && state.portalConfigurationId === configurationId && fresh) {
      return { configurationId, fingerprint: fp, changed: false };
    }
  }

  const subscriptionUpdate = subscriptionUpdateFor(products);
  if (!configurationId) {
    const params = {
      name: 'Verebona — montée en gamme immédiate',
      metadata: { [PORTAL_CONFIG_METADATA_KEY]: PORTAL_CONFIG_METADATA_VALUE },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_update: subscriptionUpdate,
      },
    };
    let created: Stripe.BillingPortal.Configuration;
    try {
      created = await stripe.billingPortal.configurations.create({ ...params, expand: [PORTAL_PRODUCTS_EXPAND] });
    } catch (e) {
      if (!isExpandRejection(e)) throw e;
      created = await stripe.billingPortal.configurations.create(params);
    }
    configurationId = created.id;
  } else {
    // Seuls les champs gérés par ce parcours (LK-49).
    await writeConfiguration(stripe, configurationId, products);
  }

  // Vérification sur la RÉPONSE STRIPE RELUE (jamais sur le tableau envoyé).
  const reread = await rereadConfiguration(stripe, configurationId);
  assertSameMode(reread.conf, context.mode);
  const check = portalMatches(reread.conf, products);
  if (!check.ok) {
    const message = describePortalCheck(configurationId, check, products);
    await d.anomalies.report({
      fingerprint: fpAnomaly,
      title: check.determinate
        ? 'Catalogue Stripe : portail de montée en gamme désaligné'
        : 'Catalogue Stripe : prix autorisés du portail illisibles (état indéterminé)',
      detail: { configurationId, expected: products, accepted: check.accepted, determinate: check.determinate, expandRejected: reread.expandRejected, foreign: check.foreign, missing: check.missing, settingsOk: check.settingsOk, reason: opts.reason },
    }).catch(() => undefined);
    throw new PortalConfigError(check.determinate ? 'PORTAL_MISMATCH' : 'PORTAL_UNVERIFIABLE', message);
  }
  const fingerprint = portalFingerprint(ctx, configurationId, products);
  if (opts.persist !== false) await d.store.setPortal(ctx, configurationId, fingerprint, now);
  await d.anomalies.resolve(fpAnomaly).catch(() => undefined);
  console.info(JSON.stringify({ evt: 'billing.portal.synced', context: ctx, configurationId, reason: opts.reason, prices: products.flatMap((p) => p.prices).length, verified: 'reread' }));
  return { configurationId, fingerprint, changed: true };
}

/** Configuration précédente, conservée AVANT toute modification (lot 49A). */
export interface PortalBackup {
  configurationId: string;
  /** Lot 53I : `null` = prix autorisés NON relus (indéterminé) — jamais « vide ». */
  products: PortalProducts | null;
  settingsOk: boolean;
}

/** Photographie de la configuration actuelle du portail (`null` si aucune), relue AVEC expansion. */
export async function capturePortalConfiguration(d: CatalogDeps = catalogDeps()): Promise<PortalBackup | null> {
  const state = await d.store.getState(d.context().catalogContext);
  const stripe = d.stripe();
  const id = await findConfigurationId(stripe, state?.portalConfigurationId ?? null, d.env);
  if (!id) return null;
  const { conf, reading } = await rereadConfiguration(stripe, id);
  return { configurationId: id, products: reading.state === 'present' ? reading.products : null, settingsOk: upgradeSettingsOk(conf) };
}

/**
 * Restaure le portail de l'ancienne révision après un échec AVANT activation
 * (lot 49A) : configuration sauvegardée si elle a été RELUE (déterminée),
 * non vide et conforme ; sinon (sauvegarde absente, indéterminée ou vide)
 * alignement sur la révision active (ancienne). Vérifie par relecture
 * étendue. Lève `PORTAL_RESTORE_FAILED` (les montées en gamme restent alors
 * bloquées par le contrôle au clic tant que le portail ne correspond pas).
 */
export async function restorePortalConfiguration(
  backup: PortalBackup | null,
  oldSnapshot: CatalogSnapshot | null,
  reason: string,
  d: CatalogDeps = catalogDeps(),
): Promise<{ configurationId: string; source: 'backup' | 'active-revision'; backup: 'used' | 'absent' | 'indeterminate' | 'empty' | 'non-compliant' }> {
  const ctx = d.context().catalogContext;
  const backupState = !backup ? 'absent' : backup.products === null ? 'indeterminate' : backup.products.length === 0 ? 'empty' : !backup.settingsOk ? 'non-compliant' : 'used';
  try {
    if (backup && backupState === 'used') {
      const products = backup.products!;
      const stripe = d.stripe();
      await writeConfiguration(stripe, backup.configurationId, products);
      const reread = await rereadConfiguration(stripe, backup.configurationId);
      const check = portalMatches(reread.conf, products);
      if (!check.ok) throw new Error(`relecture : ${describePortalCheck(backup.configurationId, check, products)}`);
      if (oldSnapshot) await d.store.setPortal(ctx, backup.configurationId, portalFingerprint(ctx, backup.configurationId, portalProductsFor(oldSnapshot)), d.now());
      console.info(JSON.stringify({ evt: 'billing.portal.restored', context: ctx, configurationId: backup.configurationId, reason, source: 'backup' }));
      return { configurationId: backup.configurationId, source: 'backup', backup: 'used' };
    }
    if (!oldSnapshot) throw new Error(`ni sauvegarde exploitable (${backupState}) ni ancienne révision`);
    const r = await syncUpgradePortal({ reason: `${reason}:restore`, snapshot: oldSnapshot, force: true, persist: true }, d);
    console.info(JSON.stringify({ evt: 'billing.portal.restored', context: ctx, configurationId: r.configurationId, reason, source: 'active-revision', backup: backupState }));
    return { configurationId: r.configurationId, source: 'active-revision', backup: backupState };
  } catch (e) {
    throw new PortalConfigError('PORTAL_RESTORE_FAILED', (e as Error).message);
  }
}

/** États pendant lesquels le portail peut différer de la révision active. */
const TRANSITION_STATES = new Set(['PREPARED', 'VALIDATING', 'PUBLISHING', 'READY', 'RECOVERING', 'FAILED']);
/** Au-delà, un état intermédiaire figé n'est plus « en cours » mais bloqué (lot 53I). */
const PORTAL_STUCK_AFTER_MS = 30 * 60_000;

/**
 * Identifiant de configuration aligné sur la révision active (appelé au clic).
 *
 * Hors transition : alignement (au besoin) puis vérification. Pendant une
 * transition (publication en cours, échec, activation) : LECTURE SEULE — le
 * parcours n'est ouvert que si le portail correspond exactement à la
 * révision active (relue avec expansion) ; sinon `PORTAL_UPDATING`
 * (publication en cours, transitoire) ou `PORTAL_BLOCKED` (publication en
 * ÉCHEC : durable, lot 53I). Un clic ne réécrit jamais le portail d'une
 * publication en cours (lot 49A).
 */
export async function ensureUpgradePortalConfiguration(d: CatalogDeps = catalogDeps()): Promise<string> {
  const ctx = d.context().catalogContext;
  const state = await d.store.getState(ctx);
  const activating = Boolean(state?.activatingUntil && state.activatingUntil.getTime() > d.now().getTime());
  if (state && (TRANSITION_STATES.has(state.publicationState) || activating)) {
    // Échec, ou état intermédiaire figé depuis plus de 30 min : blocage DURABLE
    // (pas de « réessayez dans quelques minutes ») ; sinon transitoire.
    const stuck = state.publicationState !== 'FAILED' && Boolean(state.updatedAt && d.now().getTime() - state.updatedAt.getTime() > PORTAL_STUCK_AFTER_MS);
    const blockedCode: PortalErrorCode = !activating && (state.publicationState === 'FAILED' || stuck) ? 'PORTAL_BLOCKED' : 'PORTAL_UPDATING';
    if (!state.activeSnapshot) throw new PortalConfigError(blockedCode, 'aucune révision active');
    const stripe = d.stripe();
    const id = await findConfigurationId(stripe, state.portalConfigurationId, d.env);
    if (!id) throw new PortalConfigError(blockedCode, 'aucune configuration de portail');
    const { conf } = await rereadConfiguration(stripe, id);
    const check = portalMatches(conf, portalProductsFor(state.activeSnapshot));
    if (!check.ok) {
      console.warn(JSON.stringify({ evt: 'billing.portal.upgrade_blocked', context: ctx, configurationId: id, publicationState: state.publicationState, determinate: check.determinate, code: blockedCode }));
      throw new PortalConfigError(blockedCode, `portail ${id} différent de la révision active ou illisible (${state.publicationState})`);
    }
    return id;
  }
  return (await syncUpgradePortal({ reason: 'upgrade-click' }, d)).configurationId;
}
