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
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { CATALOG_COUPLES, coupleKey } from '@/lib/billing/plan-catalog';
import type { CatalogSnapshot } from './catalog-types';
import { catalogDeps, catalogFingerprint, type CatalogDeps } from './price-catalog.service';

export const PORTAL_CONFIG_METADATA_KEY = 'verebona_flow';
export const PORTAL_CONFIG_METADATA_VALUE = 'immediate_upgrade_v1';
/** Revérification minimale d'une configuration alignée. */
const REVERIFY_AFTER_MS = 60 * 60_000;

export type PortalProducts = Array<{ product: string; prices: string[] }>;

export type PortalErrorCode =
  | 'PORTAL_DUPLICATE_INTERVAL'
  | 'PORTAL_INCOMPLETE'
  | 'PORTAL_MISMATCH'
  | 'PORTAL_UPDATING'
  | 'PORTAL_RESTORE_FAILED';

/** Erreur typée du portail (fonctionnelle : jamais reprise en boucle). */
export class PortalConfigError extends Error {
  constructor(public readonly code: PortalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PortalConfigError';
  }
}

/** Prix d'une révision avec leur périodicité (contrôle d'unicité). */
export function portalPriceRefs(snapshot: CatalogSnapshot): Array<{ productId: string; priceId: string; interval: string }> {
  return CATALOG_COUPLES.flatMap((c) => {
    const e = snapshot.entries[coupleKey(c.planCode, c.billingPeriod)];
    return e ? [{ productId: e.productId, priceId: e.priceId, interval: e.interval }] : [];
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
export function normalizePortalProducts(products: Array<{ product: string; prices?: string[] | null }>): PortalProducts {
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

export function portalFingerprint(context: string, configurationId: string, products: PortalProducts): string {
  return createHash('sha256').update(JSON.stringify([context, configurationId, products])).digest('hex').slice(0, 24);
}

/** Prix réellement acceptés par une configuration relue (vérification). */
export function acceptedPrices(conf: Stripe.BillingPortal.Configuration): string[] {
  const products = conf.features?.subscription_update?.products ?? [];
  return products.flatMap((p) => p.prices ?? []).sort();
}

/** Produits et prix acceptés par une configuration relue, forme canonique. */
export function acceptedProducts(conf: Stripe.BillingPortal.Configuration): PortalProducts {
  return normalizePortalProducts((conf.features?.subscription_update?.products ?? []).map((p) => ({ product: p.product, prices: p.prices })));
}

/** Paramètres du parcours de montée en gamme attendus (LK-51). */
export function upgradeSettingsOk(conf: Stripe.BillingPortal.Configuration): boolean {
  const su = conf.features?.subscription_update;
  return su?.enabled === true
    && su.proration_behavior === 'always_invoice'
    && (su.default_allowed_updates ?? []).includes('price');
}

/** Égalité EXACTE (produit par produit) entre attendu et accepté. Pure. */
export function portalMatches(conf: Stripe.BillingPortal.Configuration, expected: PortalProducts): { ok: boolean; accepted: PortalProducts; settingsOk: boolean } {
  const accepted = acceptedProducts(conf);
  const settingsOk = upgradeSettingsOk(conf);
  return { ok: settingsOk && JSON.stringify(accepted) === JSON.stringify(normalizePortalProducts(expected)), accepted, settingsOk };
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

/**
 * Relecture d'une configuration : `features.subscription_update.products`
 * est renvoyé en entier (produit + liste des prix acceptés, sans pagination)
 * — aucune expansion n'est nécessaire, et une expansion non prise en charge
 * ferait échouer la relecture.
 */
async function rereadConfiguration(stripe: Stripe, id: string): Promise<Stripe.BillingPortal.Configuration> {
  return stripe.billingPortal.configurations.retrieve(id);
}

function subscriptionUpdateFor(products: PortalProducts) {
  return {
    enabled: true,
    default_allowed_updates: ['price'] as Array<'price'>,
    // Prorata facturé et encaissé immédiatement (et non reporté, LK-51).
    proration_behavior: 'always_invoice' as const,
    products,
  };
}

export interface PortalSyncResult {
  configurationId: string;
  fingerprint: string;
  changed: boolean;
}

/**
 * Aligne la configuration sur UNE révision (active, ou candidate à valider
 * AVANT activation) et la vérifie. Lève si la révision est absente, si deux
 * prix d'un même produit ont la même périodicité (AVANT tout appel Stripe),
 * ou si la relecture ne montre pas EXACTEMENT les prix attendus.
 */
export async function syncUpgradePortal(
  opts: { reason: string; force?: boolean; /** Révision à valider AVANT activation (EX-012). */ snapshot?: CatalogSnapshot; persist?: boolean;
    /** Grille complète exigée (six prix) — publication. */ requireComplete?: boolean },
  d: CatalogDeps = catalogDeps(),
): Promise<PortalSyncResult> {
  const ctx = d.context().catalogContext;
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
    const created = await stripe.billingPortal.configurations.create({
      name: 'Verebona — montée en gamme immédiate',
      metadata: { [PORTAL_CONFIG_METADATA_KEY]: PORTAL_CONFIG_METADATA_VALUE },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_update: subscriptionUpdate,
      },
    });
    configurationId = created.id;
  } else {
    // Seuls les champs gérés par ce parcours (LK-49).
    await stripe.billingPortal.configurations.update(configurationId, { features: { subscription_update: subscriptionUpdate } });
  }

  const reread = await rereadConfiguration(stripe, configurationId);
  const check = portalMatches(reread, products);
  if (!check.ok) {
    const expected = products.flatMap((p) => p.prices).sort();
    const accepted = check.accepted.flatMap((p) => p.prices).sort();
    await d.anomalies.report({
      fingerprint: fpAnomaly,
      title: 'Catalogue Stripe : portail de montée en gamme désaligné',
      detail: { configurationId, expected: products, accepted: check.accepted, settingsOk: check.settingsOk, reason: opts.reason },
    }).catch(() => undefined);
    throw new PortalConfigError('PORTAL_MISMATCH', `portail ${configurationId} : prix acceptés ${accepted.join(',') || '∅'} ≠ attendus ${expected.join(',')}${check.settingsOk ? '' : ' (paramètres de montée en gamme non conformes)'}`);
  }
  const fingerprint = portalFingerprint(ctx, configurationId, products);
  if (opts.persist !== false) await d.store.setPortal(ctx, configurationId, fingerprint, now);
  await d.anomalies.resolve(fpAnomaly).catch(() => undefined);
  console.info(JSON.stringify({ evt: 'billing.portal.synced', context: ctx, configurationId, reason: opts.reason, prices: products.flatMap((p) => p.prices).length }));
  return { configurationId, fingerprint, changed: true };
}

/** Configuration précédente, conservée AVANT toute modification (lot 49A). */
export interface PortalBackup {
  configurationId: string;
  products: PortalProducts;
  settingsOk: boolean;
}

/** Photographie de la configuration actuelle du portail (`null` si aucune). */
export async function capturePortalConfiguration(d: CatalogDeps = catalogDeps()): Promise<PortalBackup | null> {
  const state = await d.store.getState(d.context().catalogContext);
  const stripe = d.stripe();
  const id = await findConfigurationId(stripe, state?.portalConfigurationId ?? null, d.env);
  if (!id) return null;
  const conf = await rereadConfiguration(stripe, id);
  return { configurationId: id, products: acceptedProducts(conf), settingsOk: upgradeSettingsOk(conf) };
}

/**
 * Restaure le portail de l'ancienne révision après un échec AVANT activation
 * (lot 49A) : configuration sauvegardée si elle existait et était conforme,
 * sinon alignement sur la révision active (ancienne). Vérifie par relecture.
 * Lève `PORTAL_RESTORE_FAILED` (les montées en gamme restent alors bloquées
 * par le contrôle au clic tant que le portail ne correspond pas).
 */
export async function restorePortalConfiguration(
  backup: PortalBackup | null,
  oldSnapshot: CatalogSnapshot | null,
  reason: string,
  d: CatalogDeps = catalogDeps(),
): Promise<{ configurationId: string; source: 'backup' | 'active-revision' }> {
  const ctx = d.context().catalogContext;
  try {
    if (backup && backup.products.length > 0) {
      const stripe = d.stripe();
      await stripe.billingPortal.configurations.update(backup.configurationId, { features: { subscription_update: subscriptionUpdateFor(backup.products) } });
      const reread = await rereadConfiguration(stripe, backup.configurationId);
      const check = portalMatches(reread, backup.products);
      if (!check.ok) throw new Error(`relecture ${check.accepted.flatMap((p) => p.prices).join(',') || '∅'} ≠ sauvegarde`);
      if (oldSnapshot) await d.store.setPortal(ctx, backup.configurationId, portalFingerprint(ctx, backup.configurationId, portalProductsFor(oldSnapshot)), d.now());
      console.info(JSON.stringify({ evt: 'billing.portal.restored', context: ctx, configurationId: backup.configurationId, reason, source: 'backup' }));
      return { configurationId: backup.configurationId, source: 'backup' };
    }
    if (!oldSnapshot) throw new Error('ni sauvegarde ni ancienne révision');
    const r = await syncUpgradePortal({ reason: `${reason}:restore`, snapshot: oldSnapshot, force: true, persist: true }, d);
    console.info(JSON.stringify({ evt: 'billing.portal.restored', context: ctx, configurationId: r.configurationId, reason, source: 'active-revision' }));
    return { configurationId: r.configurationId, source: 'active-revision' };
  } catch (e) {
    throw new PortalConfigError('PORTAL_RESTORE_FAILED', (e as Error).message);
  }
}

/** États pendant lesquels le portail peut différer de la révision active. */
const TRANSITION_STATES = new Set(['PREPARED', 'VALIDATING', 'PUBLISHING', 'READY', 'RECOVERING', 'FAILED']);

/**
 * Identifiant de configuration aligné sur la révision active (appelé au clic).
 *
 * Hors transition : alignement (au besoin) puis vérification. Pendant une
 * transition (publication en cours, échec, activation) : LECTURE SEULE — le
 * parcours n'est ouvert que si le portail correspond exactement à la
 * révision active ; sinon `PORTAL_UPDATING` (message « réessayez »). Un clic
 * ne réécrit jamais le portail d'une publication en cours (lot 49A).
 */
export async function ensureUpgradePortalConfiguration(d: CatalogDeps = catalogDeps()): Promise<string> {
  const ctx = d.context().catalogContext;
  const state = await d.store.getState(ctx);
  const activating = Boolean(state?.activatingUntil && state.activatingUntil.getTime() > d.now().getTime());
  if (state && (TRANSITION_STATES.has(state.publicationState) || activating)) {
    if (!state.activeSnapshot) throw new PortalConfigError('PORTAL_UPDATING', 'aucune révision active');
    const stripe = d.stripe();
    const id = await findConfigurationId(stripe, state.portalConfigurationId, d.env);
    if (!id) throw new PortalConfigError('PORTAL_UPDATING', 'aucune configuration de portail');
    const conf = await rereadConfiguration(stripe, id);
    const check = portalMatches(conf, portalProductsFor(state.activeSnapshot));
    if (!check.ok) {
      console.warn(JSON.stringify({ evt: 'billing.portal.upgrade_blocked', context: ctx, configurationId: id, publicationState: state.publicationState }));
      throw new PortalConfigError('PORTAL_UPDATING', `portail ${id} différent de la révision active (${state.publicationState})`);
    }
    return id;
  }
  return (await syncUpgradePortal({ reason: 'upgrade-click' }, d)).configurationId;
}
