/**
 * Lot 70B — décision PO 19/10 n° 2 : portail Stripe en résiliation « fin de
 * période » imposée par Verebona (CDC Centre d'aide AID-BILL-007). Stripe
 * SIMULÉ (`src/test/fakes/stripe-portal-configurations.ts`). Le parcours
 * complet (route, rappel J−7, webhook) est dans
 * `src/test/e2e/scenarios/l70b-portail-resiliation.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePortalConfigurations } from '@/test/fakes/stripe-portal-configurations';

const anomalies = vi.hoisted(() => ({ reported: [] as Array<{ fingerprint: string; title: string }>, resolved: [] as string[] }));
vi.mock('@/db', () => ({ pgClient: { unsafe: async () => [] }, db: {} }));
vi.mock('@/services/admin/anomaly.service', () => ({
  reportAnomaly: async (i: { fingerprint: string; title: string }) => { anomalies.reported.push(i); return 1; },
  autoResolveAnomaly: async (f: string) => { anomalies.resolved.push(f); return true; },
}));

const svc = await import('../customer-portal-configuration.service');
const { createCustomerPortalSession, PortalConfigurationUnavailableError } = await import('../customer-portal.service');

const ENV = { STRIPE_SECRET_KEY: 'sk_test_simule' } as unknown as NodeJS.ProcessEnv;
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** Configuration par défaut « réelle » typique : factures, CB, infos client, changement d'offre, annulation IMMÉDIATE. */
const DEFAULT_FEATURES = {
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
  subscription_update: {
    enabled: true, default_allowed_updates: ['price'], proration_behavior: 'create_prorations',
    products: [{ product: 'prod_premium', prices: ['price_py', 'price_pm'] }],
  },
  subscription_cancel: { enabled: true, mode: 'immediately', proration_behavior: 'create_prorations', cancellation_reason: { enabled: true, options: ['too_expensive', 'other'] } },
};

function setup(opts: Parameters<typeof createFakePortalConfigurations>[0] = { defaultConfiguration: { features: DEFAULT_FEATURES, business_profile: { headline: 'Verebona', terms_of_service_url: 'https://verebona.fr/cgv' } } }) {
  const fake = createFakePortalConfigurations(opts);
  const sessions: Array<Record<string, unknown>> = [];
  const stripe = {
    billingPortal: {
      configurations: fake.configurations,
      sessions: { create: async (p: Record<string, unknown>) => { sessions.push(p); return { url: `https://billing.stripe.com/p/session/test_${sessions.length}` }; } },
    },
  };
  return { fake, stripe, sessions };
}

beforeEach(() => {
  svc.resetCustomerPortalConfigurationCache();
  anomalies.reported.length = 0;
  anomalies.resolved.length = 0;
});

describe('L70-PORT-01 — paramètres : résiliation imposée, autres fonctionnalités recopiées', () => {
  it('annulation en fin de période sans prorata, même si la configuration par défaut annule immédiatement', () => {
    const { params, notes } = svc.mirroredCustomerPortalParams({ id: 'bpc_def', features: DEFAULT_FEATURES, business_profile: { headline: 'Verebona' } });
    const f = params.features as Record<string, Record<string, unknown>>;
    expect(f.subscription_cancel).toEqual({ enabled: true, mode: 'at_period_end', proration_behavior: 'none', cancellation_reason: { enabled: true, options: ['other', 'too_expensive'] } });
    expect(f.invoice_history).toEqual({ enabled: true });
    expect(f.payment_method_update).toEqual({ enabled: true });
    expect(f.customer_update).toEqual({ enabled: true, allowed_updates: ['address', 'email'] });
    expect(f.subscription_update).toEqual({ enabled: true, default_allowed_updates: ['price'], proration_behavior: 'create_prorations', products: [{ product: 'prod_premium', prices: ['price_pm', 'price_py'] }] });
    expect(params.business_profile).toEqual({ headline: 'Verebona' });
    expect(notes).toEqual([]);
  });

  it('changement d’offre dont les prix ne sont pas relus : désactivé et signalé, jamais deviné', () => {
    const su = { ...DEFAULT_FEATURES.subscription_update } as Record<string, unknown>;
    delete su.products;
    const { params, notes } = svc.mirroredCustomerPortalParams({ id: 'bpc_def', features: { ...DEFAULT_FEATURES, subscription_update: su } });
    expect((params.features as Record<string, unknown>).subscription_update).toEqual({ enabled: false });
    expect(notes[0]).toMatch(/non relue/);
  });

  it('sans configuration par défaut : factures et moyens de paiement seulement', () => {
    const f = svc.mirroredCustomerPortalParams(null).params.features as Record<string, unknown>;
    expect(f).toMatchObject({ invoice_history: { enabled: true }, payment_method_update: { enabled: true }, customer_update: { enabled: false }, subscription_update: { enabled: false } });
  });

  it('conformité : fin de période + aucun prorata ; immédiate, désactivée, prorata : non conformes', () => {
    expect(svc.customerPortalCancelCompliant({ id: 'x', features: { subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' } } })).toBe(true);
    expect(svc.customerPortalCancelCompliant({ id: 'x', features: { subscription_cancel: { enabled: true, mode: 'immediately', proration_behavior: 'none' } } })).toBe(false);
    expect(svc.customerPortalCancelCompliant({ id: 'x', features: { subscription_cancel: { enabled: false, mode: 'at_period_end' } } })).toBe(false);
    expect(svc.customerPortalCancelCompliant({ id: 'x', features: { subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'create_prorations' } } })).toBe(false);
    expect(svc.customerPortalConfigurationUsable({ id: 'x', active: false, features: { subscription_cancel: { enabled: true, mode: 'at_period_end' } } })).toBe(false);
  });
});

describe('L70-PORT-02 — recherche par métadonnées, sinon création ; relue et conforme', () => {
  it('aucune configuration Verebona : création (nom, métadonnées), relue, puis réutilisée sans appel Stripe', async () => {
    const { fake, stripe } = setup();
    const r1 = await svc.ensureCustomerPortalConfiguration({ stripe, env: ENV });
    expect(r1).toMatchObject({ source: 'created', changed: true, cached: false });
    const [mine] = fake.verebonaConfigurations();
    expect(mine.id).toBe(r1.configurationId);
    expect(mine.name).toBe(svc.CUSTOMER_PORTAL_CONFIGURATION_NAME);
    expect(mine.metadata).toEqual({ verebona_flow: 'customer_portal_v1' });
    expect(mine.features).toMatchObject({ subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' }, invoice_history: { enabled: true }, payment_method_update: { enabled: true }, customer_update: { enabled: true } });
    expect((mine.features.subscription_update as { products: unknown[] }).products).toEqual([{ product: 'prod_premium', prices: ['price_pm', 'price_py'] }]);
    // Configuration par défaut jamais modifiée.
    expect(fake.defaultConfiguration()!.features.subscription_cancel).toMatchObject({ mode: 'immediately' });
    expect(fake.calls.update).toEqual([]);

    const before = fake.calls.list + fake.calls.retrieve;
    const r2 = await svc.ensureCustomerPortalConfiguration({ stripe, env: ENV });
    expect(r2).toMatchObject({ configurationId: r1.configurationId, cached: true });
    expect(fake.calls.list + fake.calls.retrieve).toBe(before);
  });

  it('configuration existante alignée : retrouvée par métadonnées, aucune écriture, aucune création', async () => {
    const { fake, stripe } = setup();
    const { configurationId } = await svc.ensureCustomerPortalConfiguration({ stripe, env: ENV });
    svc.resetCustomerPortalConfigurationCache();
    const r = await svc.ensureCustomerPortalConfiguration({ stripe, env: ENV, force: true });
    expect(r).toMatchObject({ configurationId, source: 'metadata', changed: false });
    expect(fake.calls.create).toHaveLength(1);
    expect(fake.calls.update).toEqual([]);
  });

  it('configuration Verebona modifiée à la main (annulation immédiate) : réalignée et relue', async () => {
    const { fake, stripe } = setup();
    const { configurationId } = await svc.ensureCustomerPortalConfiguration({ stripe, env: ENV });
    fake.editInDashboard(configurationId, { features: { subscription_cancel: { mode: 'immediately', proration_behavior: 'create_prorations' } } });
    const r = await svc.ensureCustomerPortalConfiguration({ stripe, env: ENV, force: true });
    expect(r).toMatchObject({ configurationId, source: 'metadata', changed: true });
    expect(fake.store.get(configurationId)!.features.subscription_cancel).toMatchObject({ enabled: true, mode: 'at_period_end', proration_behavior: 'none' });
  });

  it('réglage modifié ensuite dans le tableau de bord (configuration par défaut) : repris, sans rouvrir l’annulation immédiate', async () => {
    const { fake, stripe } = setup();
    const { configurationId } = await svc.ensureCustomerPortalConfiguration({ stripe, env: ENV });
    fake.editInDashboard(fake.defaultConfiguration()!.id, { features: { customer_update: { enabled: false } } });
    await svc.ensureCustomerPortalConfiguration({ stripe, env: ENV, force: true });
    expect(fake.store.get(configurationId)!.features).toMatchObject({ customer_update: { enabled: false }, subscription_cancel: { mode: 'at_period_end' } });
  });

  it('succès : anomalie BO résolue automatiquement', async () => {
    const { stripe } = setup();
    await svc.ensureCustomerPortalConfiguration({ stripe, env: ENV });
    expect(anomalies.resolved).toEqual([svc.CUSTOMER_PORTAL_ANOMALY_FINGERPRINT]);
  });
});

describe('L70-PORT-03 — STRIPE_PORTAL_CONFIGURATION_ID (facultative) force l’identifiant', () => {
  it('identifiant imposé : utilisé, seule la résiliation est alignée, aucune création', async () => {
    const { fake, stripe } = setup();
    const def = fake.defaultConfiguration()!;
    const r = await svc.ensureCustomerPortalConfiguration({ stripe, env: { ...ENV, STRIPE_PORTAL_CONFIGURATION_ID: def.id } });
    expect(r).toMatchObject({ configurationId: def.id, source: 'env', changed: true });
    expect(fake.calls.create).toEqual([]);
    expect(fake.calls.update).toHaveLength(1);
    expect(Object.keys((fake.calls.update[0].params.features as object))).toEqual(['subscription_cancel']);
    expect(fake.store.get(def.id)!.features).toMatchObject({ subscription_cancel: { mode: 'at_period_end', proration_behavior: 'none' }, customer_update: { enabled: true } });
  });

  it('identifiant imposé introuvable : erreur et anomalie BO', async () => {
    const { stripe } = setup();
    await expect(svc.ensureCustomerPortalConfiguration({ stripe, env: { ...ENV, STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_absent' } }))
      .rejects.toMatchObject({ code: 'PORTAL_CONFIG_NOT_FOUND' });
    expect(anomalies.reported.map((a) => a.fingerprint)).toEqual([svc.CUSTOMER_PORTAL_ANOMALY_FINGERPRINT]);
  });
});

describe('L70-PORT-04 — garde-fous', () => {
  it('création refusée : erreur typée + anomalie BO, rien mémorisé', async () => {
    const { fake, stripe } = setup();
    fake.behaviour.failCreate = Object.assign(new Error('Invalid features'), { type: 'StripeInvalidRequestError', statusCode: 400 });
    await expect(svc.ensureCustomerPortalConfiguration({ stripe, env: ENV })).rejects.toMatchObject({ code: 'PORTAL_CONFIG_STRIPE_ERROR' });
    expect(anomalies.reported).toHaveLength(1);
    fake.behaviour.failCreate = null;
    await expect(svc.ensureCustomerPortalConfiguration({ stripe, env: ENV })).resolves.toMatchObject({ source: 'created', cached: false });
  });

  it('écriture sans effet (configuration non conforme après relecture) : refus', async () => {
    const { fake, stripe } = setup();
    const { configurationId } = await svc.ensureCustomerPortalConfiguration({ stripe, env: ENV });
    fake.editInDashboard(configurationId, { features: { subscription_cancel: { enabled: false } } });
    fake.behaviour.ignoreUpdates = true;
    await expect(svc.ensureCustomerPortalConfiguration({ stripe, env: ENV, force: true })).rejects.toMatchObject({ code: 'PORTAL_CONFIG_NOT_COMPLIANT' });
  });

  it('configuration d’un autre mode Stripe (live avec une clé de test) : refus', async () => {
    const { stripe } = setup({ defaultConfiguration: { features: DEFAULT_FEATURES }, livemode: true });
    await expect(svc.ensureCustomerPortalConfiguration({ stripe, env: ENV })).rejects.toMatchObject({ code: 'PORTAL_CONFIG_MODE_MISMATCH' });
  });
});

describe('L70-PORT-05 — toute session de portail ouverte par Verebona utilise la configuration Verebona', () => {
  it('session créée avec `configuration` = configuration Verebona', async () => {
    const { fake, stripe, sessions } = setup();
    const url = await createCustomerPortalSession({ customerId: 'cus_1', returnUrl: 'https://app/mon-compte', stripe: stripe as never, env: ENV });
    expect(url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    expect(sessions).toEqual([{ customer: 'cus_1', return_url: 'https://app/mon-compte', locale: 'fr', configuration: fake.verebonaConfigurations()[0].id }]);
  });

  it('configuration mémorisée supprimée entre-temps : nouvelle recherche puis session (une fois)', async () => {
    const { fake, stripe, sessions } = setup();
    await createCustomerPortalSession({ customerId: 'cus_1', returnUrl: 'r', stripe: stripe as never, env: ENV });
    const old = fake.verebonaConfigurations()[0].id;
    fake.store.delete(old);
    let first = true;
    const orig = stripe.billingPortal.sessions.create;
    stripe.billingPortal.sessions.create = async (p: Record<string, unknown>) => {
      if (first && p.configuration === old) { first = false; throw Object.assign(new Error(`No such configuration: '${old}'`), { type: 'StripeInvalidRequestError', statusCode: 400, param: 'configuration' }); }
      return orig(p);
    };
    await createCustomerPortalSession({ customerId: 'cus_1', returnUrl: 'r', stripe: stripe as never, env: ENV });
    const neu = fake.verebonaConfigurations()[0].id;
    expect(neu).not.toBe(old);
    expect(sessions.at(-1)).toMatchObject({ configuration: neu });
  });

  it('configuration Verebona impossible ET défaut non conforme (annulation immédiate) : refus, aucune session', async () => {
    const { fake, stripe, sessions } = setup();
    fake.behaviour.failCreate = new Error('refus');
    await expect(createCustomerPortalSession({ customerId: 'cus_1', returnUrl: 'r', stripe: stripe as never, env: ENV })).rejects.toBeInstanceOf(PortalConfigurationUnavailableError);
    expect(sessions).toEqual([]);
  });

  it('configuration Verebona impossible mais défaut conforme (fin de période) : session sur le défaut', async () => {
    const { fake, stripe, sessions } = setup({ defaultConfiguration: { features: { ...DEFAULT_FEATURES, subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' } } } });
    fake.behaviour.failCreate = new Error('refus');
    await createCustomerPortalSession({ customerId: 'cus_1', returnUrl: 'r', stripe: stripe as never, env: ENV });
    expect(sessions).toEqual([{ customer: 'cus_1', return_url: 'r', locale: 'fr' }]);
  });

  it('points d’entrée : « Mon compte », lien permanent et e-mail J−7 passent tous par la route unique', () => {
    expect(read('src/lib/billing/open-billing-portal.ts')).toContain("'/api/billing/create-customer-portal-session'");
    expect(read('src/app/(dashboard)/mon-compte/abonnement/gerer/page.tsx')).toContain("'/api/billing/create-customer-portal-session'");
    const route = read('src/app/api/billing/create-customer-portal-session/route.ts');
    expect(route).toContain('createCustomerPortalSession');
    expect(route).toContain('PortalConfigurationUnavailableError');
    // Seule autre session de portail du code : la montée en gamme (flux dédié, configuration dédiée).
    const portal = read('src/services/billing/customer-portal.service.ts');
    expect(portal).toContain('ensureCustomerPortalConfiguration');
  });
});

describe('L70-PORT-06 — contrôle quotidien J−7 sur la configuration Verebona', () => {
  it('le service J−7 vérifie la configuration Verebona (plus la configuration par défaut) ; échec non mémorisé', () => {
    const src = read('src/services/billing/annual-renewal-reminder.service.ts');
    expect(src).toContain('ensureCustomerPortalConfiguration({ stripe, force: true })');
    expect(src).not.toContain('is_default: true');
  });
  it('documentation : plus aucun réglage manuel du portail pour l’annulation', () => {
    const doc = read('docs/exploitation/rappel-renouvellement-annuel.md');
    expect(doc).toContain('STRIPE_PORTAL_CONFIGURATION_ID');
    expect(doc).toMatch(/aucun réglage manuel du portail Stripe/i);
  });
});
