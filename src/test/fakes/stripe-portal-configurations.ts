/**
 * Stripe SIMULÉ — configurations du portail client (`billingPortal.configurations`)
 * pour les tests unitaires et e2e (lot 70B). Comportements reproduits :
 *   · `list` filtré par `active` / `is_default`, pagination simple ;
 *   · `retrieve` : `features.subscription_update.products` est un champ
 *     « includable » — absent sans `expand` (comme l'API 2025-08-27.basil) ;
 *     identifiant inconnu → erreur `resource_missing` ;
 *   · `create` / `update` : fusion des fonctionnalités, valeurs par défaut
 *     de Stripe (annulation désactivée, mode `at_period_end`…).
 * Aucune donnée réelle, aucun appel réseau.
 */

type Json = Record<string, unknown>;

export interface FakePortalConfiguration extends Json {
  id: string;
  object: 'billing_portal.configuration';
  active: boolean;
  is_default: boolean;
  livemode: boolean;
  created: number;
  name: string | null;
  metadata: Record<string, string>;
  business_profile: { headline: string | null; privacy_policy_url: string | null; terms_of_service_url: string | null };
  features: Json;
}

const clone = <T>(v: T): T => structuredClone(v);

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function merge(target: Json, patch: Json): Json {
  const out: Json = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k] as Json, v) : clone(v);
  }
  return out;
}

const DEFAULT_FEATURES: Json = {
  customer_update: { enabled: false, allowed_updates: [] },
  invoice_history: { enabled: false },
  payment_method_update: { enabled: false },
  subscription_cancel: { enabled: false, mode: 'at_period_end', proration_behavior: 'none', cancellation_reason: { enabled: false, options: [] } },
  subscription_update: { enabled: false, default_allowed_updates: [], proration_behavior: 'none', products: [], schedule_at_period_end: { conditions: [] } },
};

export interface FakePortalOptions {
  /** Configuration par défaut du compte (réglée dans le tableau de bord) ; `null` : aucune. */
  defaultConfiguration?: { features?: Json; business_profile?: Json; metadata?: Record<string, string> } | null;
  livemode?: boolean;
}

export function createFakePortalConfigurations(opts: FakePortalOptions = {}) {
  const store = new Map<string, FakePortalConfiguration>();
  let seq = 0;
  const calls = { list: 0, retrieve: 0, create: [] as Json[], update: [] as Array<{ id: string; params: Json }> };
  const behaviour = {
    /** `create` refusé (ex. paramètres invalides). */
    failCreate: null as Error | null,
    /** Toute opération refusée (Stripe indisponible). */
    down: null as Error | null,
    /** `update` accepté mais SANS effet (simule une configuration verrouillée). */
    ignoreUpdates: false,
  };

  const make = (p: Json, extra: Partial<FakePortalConfiguration> = {}): FakePortalConfiguration => {
    seq += 1;
    const conf: FakePortalConfiguration = {
      id: `bpc_fake_${seq}`,
      object: 'billing_portal.configuration',
      active: true,
      is_default: false,
      livemode: opts.livemode ?? false,
      created: 1_700_000_000 + seq,
      name: (p.name as string) ?? null,
      metadata: (p.metadata as Record<string, string>) ?? {},
      business_profile: merge({ headline: null, privacy_policy_url: null, terms_of_service_url: null }, (p.business_profile as Json) ?? {}) as FakePortalConfiguration['business_profile'],
      features: merge(DEFAULT_FEATURES, (p.features as Json) ?? {}),
      ...extra,
    };
    store.set(conf.id, conf);
    return conf;
  };

  if (opts.defaultConfiguration !== null) {
    make({ features: opts.defaultConfiguration?.features ?? { invoice_history: { enabled: true }, payment_method_update: { enabled: true } }, business_profile: opts.defaultConfiguration?.business_profile, metadata: opts.defaultConfiguration?.metadata }, { is_default: true });
  }

  const view = (c: FakePortalConfiguration, expand?: string[]) => {
    const out = clone(c);
    if (!expand?.includes('features.subscription_update.products')) {
      delete ((out.features as Json).subscription_update as Json).products;
    }
    return out;
  };
  const guard = () => { if (behaviour.down) throw behaviour.down; };
  const missing = (id: string) => Object.assign(new Error(`No such configuration: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404, param: 'configuration' });

  const configurations = {
    async list(p: { active?: boolean; is_default?: boolean; limit?: number; starting_after?: string; expand?: string[] } = {}) {
      guard(); calls.list += 1;
      let all = [...store.values()].sort((a, b) => a.created - b.created);
      if (typeof p.active === 'boolean') all = all.filter((c) => c.active === p.active);
      if (typeof p.is_default === 'boolean') all = all.filter((c) => c.is_default === p.is_default);
      if (p.starting_after) all = all.slice(all.findIndex((c) => c.id === p.starting_after) + 1);
      const limit = p.limit ?? 10;
      return { object: 'list', data: all.slice(0, limit).map((c) => view(c, p.expand)), has_more: all.length > limit };
    },
    async retrieve(id: string, p: { expand?: string[] } = {}) {
      guard(); calls.retrieve += 1;
      const c = store.get(id);
      if (!c) throw missing(id);
      return view(c, p.expand);
    },
    async create(p: Json) {
      guard(); calls.create.push(clone(p));
      if (behaviour.failCreate) throw behaviour.failCreate;
      return view(make(p), p.expand as string[] | undefined);
    },
    async update(id: string, p: Json) {
      guard(); calls.update.push({ id, params: clone(p) });
      const c = store.get(id);
      if (!c) throw missing(id);
      if (!behaviour.ignoreUpdates) {
        const { expand: _e, ...rest } = p;
        void _e;
        const next = merge(c as unknown as Json, rest) as FakePortalConfiguration;
        // Une liste fournie REMPLACE la précédente (comportement Stripe).
        const su = (rest.features as Json | undefined)?.subscription_update as Json | undefined;
        if (su && 'products' in su) ((next.features as Json).subscription_update as Json).products = clone(su.products);
        store.set(id, next);
      }
      return view(store.get(id)!, p.expand as string[] | undefined);
    },
  };

  /** Simule une modification dans le tableau de bord Stripe. */
  const editInDashboard = (id: string, patch: Json) => {
    const c = store.get(id)!;
    store.set(id, merge(c as unknown as Json, patch) as FakePortalConfiguration);
  };
  const defaultConfiguration = () => [...store.values()].find((c) => c.is_default) ?? null;
  const verebonaConfigurations = () => [...store.values()].filter((c) => c.metadata?.verebona_flow === 'customer_portal_v1');

  return { configurations, store, calls, behaviour, editInDashboard, defaultConfiguration, verebonaConfigurations };
}
