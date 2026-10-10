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

/** Produits et prix autorisés, regroupés et triés (déterministe). */
export function portalProductsFor(
  snapshot: CatalogSnapshot,
  extra: Array<{ productId: string; priceId: string }> = [],
): Array<{ product: string; prices: string[] }> {
  const byProduct = new Map<string, Set<string>>();
  const add = (productId: string, priceId: string) => byProduct.set(productId, (byProduct.get(productId) ?? new Set()).add(priceId));
  for (const c of CATALOG_COUPLES) {
    const e = snapshot.entries[coupleKey(c.planCode, c.billingPeriod)];
    if (e) add(e.productId, e.priceId);
  }
  for (const x of extra) add(x.productId, x.priceId);
  return [...byProduct].sort(([a], [b]) => a.localeCompare(b)).map(([product, prices]) => ({ product, prices: [...prices].sort() }));
}

export function portalFingerprint(context: string, configurationId: string, products: Array<{ product: string; prices: string[] }>): string {
  return createHash('sha256').update(JSON.stringify([context, configurationId, products])).digest('hex').slice(0, 24);
}

/** Prix réellement acceptés par une configuration relue (vérification). */
export function acceptedPrices(conf: Stripe.BillingPortal.Configuration): string[] {
  const products = conf.features?.subscription_update?.products ?? [];
  return products.flatMap((p) => p.prices ?? []).sort();
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

export interface PortalSyncResult {
  configurationId: string;
  fingerprint: string;
  changed: boolean;
}

/**
 * Aligne la configuration sur la révision active et la vérifie. Lève si la
 * révision est absente ou si la relecture ne montre pas les prix attendus.
 */
export async function syncUpgradePortal(
  opts: { reason: string; force?: boolean; /** Révision à valider AVANT activation (EX-012). */ snapshot?: CatalogSnapshot; persist?: boolean;
    /** Prix supplémentaires acceptés pendant la fenêtre de bascule (ancienne + nouvelle révision). */
    extraPrices?: Array<{ productId: string; priceId: string }> },
  d: CatalogDeps = catalogDeps(),
): Promise<PortalSyncResult> {
  const ctx = d.context().catalogContext;
  const state = await d.store.getState(ctx);
  const snapshot = opts.snapshot ?? state?.activeSnapshot;
  if (!snapshot || Object.keys(snapshot.entries).length === 0) throw new Error('Aucune révision active : portail non synchronisable');
  const products = portalProductsFor(snapshot, opts.extraPrices ?? []);
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

  const subscriptionUpdate = {
    enabled: true,
    default_allowed_updates: ['price'] as Array<'price'>,
    // Prorata facturé et encaissé immédiatement (et non reporté, LK-51).
    proration_behavior: 'always_invoice' as const,
    products,
  };
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

  const reread = await stripe.billingPortal.configurations.retrieve(configurationId);
  const expected = products.flatMap((p) => p.prices).sort();
  const accepted = acceptedPrices(reread);
  const ok = expected.every((id) => accepted.includes(id))
    && reread.features?.subscription_update?.proration_behavior === 'always_invoice'
    && reread.features?.subscription_update?.enabled === true;
  const fpAnomaly = catalogFingerprint(ctx, 'portal');
  if (!ok) {
    await d.anomalies.report({
      fingerprint: fpAnomaly,
      title: 'Catalogue Stripe : portail de montée en gamme désaligné',
      detail: { configurationId, expected, accepted, reason: opts.reason },
    }).catch(() => undefined);
    throw new Error(`Portail ${configurationId} : prix acceptés ${accepted.join(',')} ≠ attendus ${expected.join(',')}`);
  }
  const fingerprint = portalFingerprint(ctx, configurationId, products);
  if (opts.persist !== false) await d.store.setPortal(ctx, configurationId, fingerprint, now);
  await d.anomalies.resolve(fpAnomaly).catch(() => undefined);
  console.info(JSON.stringify({ evt: 'billing.portal.synced', context: ctx, configurationId, reason: opts.reason }));
  return { configurationId, fingerprint, changed: true };
}

/** Identifiant de configuration aligné sur la révision active (appelé au clic). */
export async function ensureUpgradePortalConfiguration(d: CatalogDeps = catalogDeps()): Promise<string> {
  return (await syncUpgradePortal({ reason: 'upgrade-click' }, d)).configurationId;
}
