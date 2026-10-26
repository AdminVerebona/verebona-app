/**
 * Configuration Verebona du portail client Stripe — lot 70B (décision PO du
 * 19/10, CDC Centre d'aide AID-BILL-007 « Résilier son abonnement »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÉSILIATION = FIN DE LA RECONDUCTION, IMPOSÉE PAR VEREBONA
 *
 * Toutes les sessions de portail ouvertes par Verebona (« Mon compte », lien
 * permanent `/mon-compte/abonnement/gerer`, e-mail J−7) utilisent CETTE
 * configuration — plus la configuration par défaut du compte Stripe, réglée
 * à la main dans le tableau de bord :
 *
 *   features.subscription_cancel = { enabled: true, mode: 'at_period_end',
 *                                    proration_behavior: 'none' }
 *
 * L'abonnement s'arrête à la fin de la période courante (« Résiliation
 * programmée », `cancel_at_period_end` remonté par le webhook
 * `customer.subscription.updated`) ; ni annulation immédiate ni prorata.
 *
 * ── TROUVER OU CRÉER (même mécanisme que la montée en gamme) ─────────────
 *
 *   1. `STRIPE_PORTAL_CONFIGURATION_ID` (facultative) : identifiant imposé ;
 *      seule la résiliation y est alignée (les autres réglages appartiennent
 *      à qui l'a imposée) ;
 *   2. sinon, configuration ACTIVE portant la métadonnée
 *      `verebona_flow = customer_portal_v1` (la plus ancienne si plusieurs) ;
 *   3. sinon, création automatique.
 *
 * ── LES AUTRES FONCTIONNALITÉS RESTENT CELLES DU PORTAIL ACTUEL ──────────
 *
 * Pour 2 et 3, les autres réglages sont RECOPIÉS de la configuration par
 * défaut du compte (celle que le tableau de bord Stripe modifie) : profil
 * (titre, CGU, confidentialité), mise à jour des informations client,
 * historique des factures, moyens de paiement, changement d'offre (produits
 * et prix autorisés, prorata, report à l'échéance) et motifs de résiliation.
 * La recopie est revérifiée au plus une fois par heure et par instance :
 * un réglage modifié plus tard dans le tableau de bord est repris, sans
 * jamais rouvrir l'annulation immédiate. Changement d'offre dont la liste des
 * prix n'est pas relisible (champ « includable » non renvoyé) : désactivé
 * dans la configuration Verebona plutôt que deviné, et signalé (`notes`).
 * Sans configuration par défaut : factures et moyens de paiement seulement.
 *
 * ── GARDE-FOUS ───────────────────────────────────────────────────────────
 *
 * La configuration est RELUE après écriture et doit être conforme (active,
 * annulation activée en fin de période, aucun prorata). Échec (introuvable,
 * création refusée, non conforme, autre mode Stripe) : `CustomerPortalConfigError`
 * et anomalie BO (domaine `stripe`), résolue automatiquement au succès
 * suivant. Le rappel J−7 se bloque alors (tâche planifiée en échec).
 * ══════════════════════════════════════════════════════════════════════════
 */

const CUSTOMER_PORTAL_METADATA_KEY = 'verebona_flow';
const CUSTOMER_PORTAL_METADATA_VALUE = 'customer_portal_v1';
export const CUSTOMER_PORTAL_CONFIGURATION_NAME = 'Verebona — portail client (résiliation en fin de période)';
/** Champ « includable » de l'API Stripe (voir portal-configuration.service.ts, lot 53I). */
const PRODUCTS_EXPAND = 'features.subscription_update.products';
/** Revérification (recopie + conformité) au plus une fois par heure et par instance. */
const CUSTOMER_PORTAL_REVERIFY_MS = 60 * 60_000;
/** Empreinte de l'anomalie BO (une seule, consolidée). */
export const CUSTOMER_PORTAL_ANOMALY_FINGERPRINT = 'stripe:customer-portal:configuration';

/** Réglage de résiliation imposé par Verebona. */
const VEREBONA_SUBSCRIPTION_CANCEL = { enabled: true, mode: 'at_period_end', proration_behavior: 'none' } as const;

// ── Types minimaux (objets Stripe relus ; injectables dans les tests) ───────

type Product = { product: string; prices?: string[] | null; adjustable_quantity?: { enabled?: boolean; maximum?: number | null; minimum?: number | null } | null };
interface PortalConfigurationLike {
  id: string;
  active?: boolean;
  is_default?: boolean;
  livemode?: boolean;
  created?: number;
  metadata?: Record<string, string> | null;
  business_profile?: { headline?: string | null; privacy_policy_url?: string | null; terms_of_service_url?: string | null } | null;
  features?: {
    customer_update?: { enabled?: boolean; allowed_updates?: string[] | null } | null;
    invoice_history?: { enabled?: boolean } | null;
    payment_method_update?: { enabled?: boolean } | null;
    subscription_cancel?: {
      enabled?: boolean; mode?: string | null; proration_behavior?: string | null;
      cancellation_reason?: { enabled?: boolean; options?: string[] | null } | null;
    } | null;
    subscription_update?: {
      enabled?: boolean; default_allowed_updates?: string[] | null; proration_behavior?: string | null;
      products?: Product[] | null;
      schedule_at_period_end?: { conditions?: Array<{ type: string }> | null } | null;
    } | null;
  } | null;
}

/** Sous-ensemble du client Stripe utilisé (injectable dans les tests). */
export interface CustomerPortalConfigStripe {
  billingPortal: {
    configurations: {
      list(params: { active?: boolean; is_default?: boolean; limit?: number; starting_after?: string; expand?: string[] }): Promise<{ data: unknown[]; has_more?: boolean }>;
      retrieve(id: string, params?: { expand?: string[] }): Promise<unknown>;
      create(params: Record<string, unknown>): Promise<unknown>;
      update(id: string, params: Record<string, unknown>): Promise<unknown>;
    };
  };
}

type CustomerPortalConfigErrorCode =
  | 'PORTAL_CONFIG_NOT_FOUND'
  | 'PORTAL_CONFIG_INACTIVE'
  | 'PORTAL_CONFIG_NOT_COMPLIANT'
  | 'PORTAL_CONFIG_MODE_MISMATCH'
  | 'PORTAL_CONFIG_STRIPE_ERROR';

class CustomerPortalConfigError extends Error {
  constructor(public readonly code: CustomerPortalConfigErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CustomerPortalConfigError';
  }
}

interface CustomerPortalConfigResult {
  configurationId: string;
  source: 'env' | 'metadata' | 'created';
  /** Configuration écrite chez Stripe lors de cet appel (création ou alignement). */
  changed: boolean;
  /** Écarts assumés de la recopie (changement d'offre non relisible…). */
  notes: string[];
  /** Résultat mémorisé (aucun appel Stripe). */
  cached: boolean;
}

// ── Règles pures ────────────────────────────────────────────────────────────

/** Résiliation conforme à la règle Verebona (fin de période, sans prorata). Pure. */
export function customerPortalCancelCompliant(conf: PortalConfigurationLike | null | undefined): boolean {
  const c = conf?.features?.subscription_cancel;
  if (!c || c.enabled !== true || c.mode !== 'at_period_end') return false;
  return c.proration_behavior == null || c.proration_behavior === 'none';
}

/** Configuration utilisable : active et conforme. Pure. */
export function customerPortalConfigurationUsable(conf: PortalConfigurationLike | null | undefined): boolean {
  return !!conf && conf.active !== false && customerPortalCancelCompliant(conf);
}

const has = (o: object | null | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/**
 * Paramètres (création / mise à jour) de la configuration Verebona : les
 * réglages de la configuration par défaut recopiés, la résiliation imposée.
 * Pure. `defaultConf` relu AVEC l'expansion des produits, ou `null`.
 */
export function mirroredCustomerPortalParams(defaultConf: PortalConfigurationLike | null): { params: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const f = defaultConf?.features ?? null;
  const features: Record<string, unknown> = {
    invoice_history: { enabled: defaultConf ? f?.invoice_history?.enabled === true : true },
    payment_method_update: { enabled: defaultConf ? f?.payment_method_update?.enabled === true : true },
    customer_update: f?.customer_update?.enabled
      ? { enabled: true, allowed_updates: [...(f.customer_update.allowed_updates ?? [])].sort() }
      : { enabled: false },
  };

  const su = f?.subscription_update;
  if (su?.enabled) {
    const products = has(su, 'products') && su.products !== undefined ? (su.products ?? []) : null;
    if (products === null) {
      notes.push('changement d’offre de la configuration par défaut non recopié : liste des prix autorisés non relue');
      features.subscription_update = { enabled: false };
    } else if (products.length === 0 || products.some((p) => !p.prices?.length)) {
      notes.push('changement d’offre de la configuration par défaut non recopié : liste des prix autorisés vide');
      features.subscription_update = { enabled: false };
    } else {
      const update: Record<string, unknown> = {
        enabled: true,
        default_allowed_updates: [...(su.default_allowed_updates ?? [])].sort(),
        products: [...products]
          .sort((a, b) => a.product.localeCompare(b.product))
          .map((p) => ({
            product: p.product,
            prices: [...(p.prices ?? [])].sort(),
            ...(p.adjustable_quantity?.enabled
              ? { adjustable_quantity: { enabled: true, ...(p.adjustable_quantity.minimum != null ? { minimum: p.adjustable_quantity.minimum } : {}), ...(p.adjustable_quantity.maximum != null ? { maximum: p.adjustable_quantity.maximum } : {}) } }
              : {}),
          })),
      };
      if (su.proration_behavior) update.proration_behavior = su.proration_behavior;
      const conditions = su.schedule_at_period_end?.conditions;
      if (conditions?.length) update.schedule_at_period_end = { conditions: conditions.map((c) => ({ type: c.type })).sort((a, b) => a.type.localeCompare(b.type)) };
      features.subscription_update = update;
    }
  } else {
    features.subscription_update = { enabled: false };
  }

  const reason = f?.subscription_cancel?.cancellation_reason;
  features.subscription_cancel = {
    ...VEREBONA_SUBSCRIPTION_CANCEL,
    ...(reason?.enabled ? { cancellation_reason: { enabled: true, options: [...(reason.options ?? [])].sort() } } : {}),
  };

  const params: Record<string, unknown> = { features };
  const bp = defaultConf?.business_profile;
  if (bp && (bp.headline || bp.privacy_policy_url || bp.terms_of_service_url)) {
    params.business_profile = {
      ...(bp.headline ? { headline: bp.headline } : {}),
      ...(bp.privacy_policy_url ? { privacy_policy_url: bp.privacy_policy_url } : {}),
      ...(bp.terms_of_service_url ? { terms_of_service_url: bp.terms_of_service_url } : {}),
    };
  }
  return { params, notes };
}

/**
 * La configuration relue diffère-t-elle des paramètres voulus ? Pure. La
 * vue relue passe par la même normalisation que la recopie (même forme,
 * mêmes tris) ; la résiliation est comparée sur la valeur RÉELLEMENT relue.
 */
function customerPortalNeedsUpdate(current: PortalConfigurationLike, wanted: Record<string, unknown>): boolean {
  if (!customerPortalCancelCompliant(current)) return true;
  const cur = mirroredCustomerPortalParams(current).params;
  const view = (p: Record<string, unknown>) => JSON.stringify({ business_profile: p.business_profile ?? null, features: p.features });
  return view(cur) !== view(wanted);
}

// ── Accès Stripe ────────────────────────────────────────────────────────────

function isExpandRejection(e: unknown): boolean {
  const err = e as { type?: string; statusCode?: number; message?: string };
  return (err?.type === 'StripeInvalidRequestError' || err?.statusCode === 400) && /expand/i.test(err?.message ?? '');
}
function isMissing(e: unknown): boolean {
  const err = e as { code?: string; statusCode?: number };
  return err?.code === 'resource_missing' || err?.statusCode === 404;
}

async function retrieveExpanded(stripe: CustomerPortalConfigStripe, id: string): Promise<PortalConfigurationLike> {
  try {
    return await stripe.billingPortal.configurations.retrieve(id, { expand: [PRODUCTS_EXPAND] }) as PortalConfigurationLike;
  } catch (e) {
    if (!isExpandRejection(e)) throw e;
    return await stripe.billingPortal.configurations.retrieve(id) as PortalConfigurationLike;
  }
}

async function listAll(stripe: CustomerPortalConfigStripe, params: { active?: boolean; is_default?: boolean }): Promise<PortalConfigurationLike[]> {
  const out: PortalConfigurationLike[] = [];
  let starting_after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await stripe.billingPortal.configurations.list({ ...params, limit: 100, ...(starting_after ? { starting_after } : {}) });
    const data = (res?.data ?? []) as PortalConfigurationLike[];
    out.push(...data);
    if (!res?.has_more || data.length === 0) break;
    starting_after = data[data.length - 1].id;
  }
  return out;
}

/** Configuration par défaut du compte Stripe (relue avec les produits), ou `null`. */
export async function readDefaultPortalConfiguration(stripe: CustomerPortalConfigStripe): Promise<PortalConfigurationLike | null> {
  const [def] = await listAll(stripe, { is_default: true });
  if (!def) return null;
  return retrieveExpanded(stripe, def.id).catch(() => def);
}

/** Configuration Verebona existante (métadonnées), la plus ancienne si plusieurs. */
async function findByMetadata(stripe: CustomerPortalConfigStripe): Promise<PortalConfigurationLike | null> {
  const mine = (await listAll(stripe, { active: true }))
    .filter((c) => c.metadata?.[CUSTOMER_PORTAL_METADATA_KEY] === CUSTOMER_PORTAL_METADATA_VALUE && c.active !== false)
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.id.localeCompare(b.id));
  return mine[0] ?? null;
}

function stripeMode(env: NodeJS.ProcessEnv): 'test' | 'live' | null {
  const key = env.STRIPE_SECRET_KEY ?? '';
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  return null;
}

// ── Cache d'instance ────────────────────────────────────────────────────────

let memo: { key: string; at: number; result: Omit<CustomerPortalConfigResult, 'cached'> } | null = null;

/** Tests / reprise : oublie la configuration mémorisée. */
export function resetCustomerPortalConfigurationCache(): void { memo = null; }

interface EnsureCustomerPortalOptions {
  stripe?: CustomerPortalConfigStripe;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Ignore le cache : recherche, recopie et vérification chez Stripe. */
  force?: boolean;
  /** Signalement BO (injectable) ; par défaut, anomalies du BO. */
  anomalies?: { report(i: { title: string; detail: Record<string, unknown> }): Promise<unknown>; resolve(): Promise<unknown> };
}

const realAnomalies: NonNullable<EnsureCustomerPortalOptions['anomalies']> = {
  async report(i) {
    const { reportAnomaly } = await import('@/services/admin/anomaly.service');
    return reportAnomaly({ domain: 'stripe', fingerprint: CUSTOMER_PORTAL_ANOMALY_FINGERPRINT, title: i.title, detail: i.detail });
  },
  async resolve() {
    const { autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
    return autoResolveAnomaly(CUSTOMER_PORTAL_ANOMALY_FINGERPRINT, { origin: 'stripe_customer_portal_configuration' });
  },
};

async function defaultStripe(): Promise<CustomerPortalConfigStripe> {
  const { getStripeServer } = await import('@/lib/stripe');
  return getStripeServer() as unknown as CustomerPortalConfigStripe;
}

/**
 * Identifiant de la configuration Verebona du portail : trouvée (variable,
 * métadonnées) ou créée, alignée, RELUE et conforme. Mémorisée une heure par
 * instance (sauf `force`). Lève `CustomerPortalConfigError` (anomalie BO).
 */
export async function ensureCustomerPortalConfiguration(opts: EnsureCustomerPortalOptions = {}): Promise<CustomerPortalConfigResult> {
  const env = opts.env ?? process.env;
  const now = (opts.now ?? new Date()).getTime();
  const forcedId = env.STRIPE_PORTAL_CONFIGURATION_ID?.trim() || null;
  const mode = stripeMode(env);
  const key = `${mode ?? 'nokey'}:${forcedId ?? '-'}`;
  if (!opts.force && memo && memo.key === key && now - memo.at < CUSTOMER_PORTAL_REVERIFY_MS) {
    return { ...memo.result, cached: true };
  }
  const anomalies = opts.anomalies ?? realAnomalies;
  const stripe = opts.stripe ?? await defaultStripe();
  try {
    const result = await resolveAndAlign(stripe, forcedId, mode);
    memo = { key, at: now, result };
    await anomalies.resolve().catch(() => undefined);
    console.info(JSON.stringify({ evt: 'billing.customer_portal.configuration', configurationId: result.configurationId, source: result.source, changed: result.changed, notes: result.notes }));
    return { ...result, cached: false };
  } catch (e) {
    memo = null;
    const err = e instanceof CustomerPortalConfigError ? e : new CustomerPortalConfigError('PORTAL_CONFIG_STRIPE_ERROR', (e as Error)?.message ?? String(e));
    console.error(JSON.stringify({ evt: 'billing.customer_portal.configuration_failed', code: err.code, error: err.message }));
    await anomalies.report({
      title: 'Portail client Stripe : configuration Verebona (résiliation en fin de période) introuvable ou non conforme',
      detail: { code: err.code, message: err.message, forcedByEnv: Boolean(forcedId), effect: 'rappels J−7 suspendus ; portail ouvert seulement si la configuration par défaut est conforme' },
    }).catch(() => undefined);
    throw err;
  }
}

async function resolveAndAlign(stripe: CustomerPortalConfigStripe, forcedId: string | null, mode: 'test' | 'live' | null): Promise<Omit<CustomerPortalConfigResult, 'cached'>> {
  const assertMode = (c: PortalConfigurationLike) => {
    if (typeof c.livemode === 'boolean' && mode && c.livemode !== (mode === 'live')) {
      throw new CustomerPortalConfigError('PORTAL_CONFIG_MODE_MISMATCH', `configuration ${c.id} en mode ${c.livemode ? 'live' : 'test'} ≠ clé ${mode}`);
    }
  };
  const verify = async (id: string): Promise<PortalConfigurationLike> => {
    const reread = await retrieveExpanded(stripe, id);
    assertMode(reread);
    if (reread.active === false) throw new CustomerPortalConfigError('PORTAL_CONFIG_INACTIVE', `configuration ${id} inactive`);
    if (!customerPortalCancelCompliant(reread)) {
      const c = reread.features?.subscription_cancel;
      throw new CustomerPortalConfigError('PORTAL_CONFIG_NOT_COMPLIANT', `configuration ${id} : annulation ${c?.enabled ? `activée (mode ${c.mode ?? '?'}, prorata ${c.proration_behavior ?? '?'})` : 'désactivée'} — attendu : fin de période, sans prorata`);
    }
    return reread;
  };

  // 1. Identifiant imposé : seule la résiliation est alignée.
  if (forcedId) {
    let conf: PortalConfigurationLike;
    try {
      conf = await retrieveExpanded(stripe, forcedId);
    } catch (e) {
      if (isMissing(e)) throw new CustomerPortalConfigError('PORTAL_CONFIG_NOT_FOUND', `STRIPE_PORTAL_CONFIGURATION_ID=${forcedId} introuvable`);
      throw e;
    }
    assertMode(conf);
    if (conf.active === false) throw new CustomerPortalConfigError('PORTAL_CONFIG_INACTIVE', `STRIPE_PORTAL_CONFIGURATION_ID=${forcedId} inactive`);
    let changed = false;
    if (!customerPortalCancelCompliant(conf)) {
      const reason = conf.features?.subscription_cancel?.cancellation_reason;
      await stripe.billingPortal.configurations.update(forcedId, {
        features: { subscription_cancel: { ...VEREBONA_SUBSCRIPTION_CANCEL, ...(reason?.enabled ? { cancellation_reason: { enabled: true, options: reason.options ?? [] } } : {}) } },
      });
      changed = true;
    }
    await verify(forcedId);
    return { configurationId: forcedId, source: 'env', changed, notes: [] };
  }

  // 2-3. Métadonnées, sinon création ; réglages recopiés de la configuration par défaut.
  const def = await readDefaultPortalConfiguration(stripe);
  const isMine = def?.metadata?.[CUSTOMER_PORTAL_METADATA_KEY] === CUSTOMER_PORTAL_METADATA_VALUE;
  const { params, notes } = mirroredCustomerPortalParams(isMine ? null : def);
  if (!def) notes.push('aucune configuration par défaut : factures et moyens de paiement seulement');

  const existing = await findByMetadata(stripe);
  if (existing) {
    assertMode(existing);
    const current = await retrieveExpanded(stripe, existing.id);
    let changed = false;
    if (customerPortalNeedsUpdate(current, params)) {
      await stripe.billingPortal.configurations.update(existing.id, { ...params, expand: [PRODUCTS_EXPAND] })
        .catch(async (e) => {
          if (!isExpandRejection(e)) throw e;
          return stripe.billingPortal.configurations.update(existing.id, params);
        });
      changed = true;
    }
    await verify(existing.id);
    return { configurationId: existing.id, source: 'metadata', changed, notes };
  }

  const createParams = {
    ...params,
    name: CUSTOMER_PORTAL_CONFIGURATION_NAME,
    metadata: { [CUSTOMER_PORTAL_METADATA_KEY]: CUSTOMER_PORTAL_METADATA_VALUE },
  };
  const created = await stripe.billingPortal.configurations.create({ ...createParams, expand: [PRODUCTS_EXPAND] })
    .catch(async (e) => {
      if (!isExpandRejection(e)) throw e;
      return stripe.billingPortal.configurations.create(createParams);
    }) as PortalConfigurationLike;
  if (!created?.id) throw new CustomerPortalConfigError('PORTAL_CONFIG_NOT_FOUND', 'création refusée (aucun identifiant renvoyé)');
  await verify(created.id);
  return { configurationId: created.id, source: 'created', changed: true, notes };
}
