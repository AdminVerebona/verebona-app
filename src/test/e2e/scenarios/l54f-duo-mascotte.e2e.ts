/**
 * Lot 54F — mascotte « Inviter quelqu'un » limitée au PREMIER MOIS de
 * l'abonnement Premium Duo, sur PostgreSQL réel (migration 0385 :
 * colonnes, déclencheur, reprise) avec Stripe SIMULÉ (objets synthétiques,
 * prix Duo inscrit au registre historique, jamais d'appel Stripe) et horloge
 * maîtrisée (instant exact d'un mois calendaire passé à la lecture).
 *
 * DUO-M1-E2E-01 Checkout : compte Duo technique créé AVANT paiement (CANCELED,
 *               aucune date) ; la synchronisation du paiement pose la date ;
 *               proposée à J0, absente à l'instant exact début + 1 mois.
 * DUO-M1-E2E-02 Rejeu du webhook, renouvellement mensuel, resynchronisation,
 *               impayé régularisé, changement de périodicité : date inchangée.
 * DUO-M1-E2E-03 Upgrade Premium → Duo : délai depuis le passage à Duo, pas
 *               depuis le début de Premium.
 * DUO-M1-E2E-04 Changement d'offre BO (`applyPlanChange`) : date posée une
 *               fois ; sortie puis vraie nouvelle souscription : nouvelle période.
 * DUO-M1-E2E-05 Route réelle : invitation envoyée → absente ; annulée ou lien
 *               expiré → aucune réapparition ; invitation manuelle toujours
 *               possible après le mois.
 * DUO-M1-E2E-06 Impayé, résilié, membre invité : absente.
 * DUO-M1-E2E-07 Reprise (migration rejouée, idempotente) : date issue de
 *               l'historique fiable, sinon NULL ; trace d'invitation reprise.
 */
import type Stripe from 'stripe';
import { beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';

const etat = vi.hoisted(() => ({ session: { userId: 0, currentAccountId: 0 as number | null } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
// Aucun e-mail réel : le service d'envoi est neutralisé (couvert par L53-DUO-MAIL).
vi.mock('@/lib/email/email-service', () => ({ emailService: { send: async () => ({ success: true }) } }));

const APP = 'https://app.e2e.verebona.test';
const DUO_PRICE = 'price_e2e_duo_m1_monthly';
const DUO_PRICE_Y = 'price_e2e_duo_m1_yearly';
const PREMIUM_PRICE = 'price_e2e_premium_m1_monthly';
const NOW = Math.floor(Date.now() / 1000);
const MOIS = 30 * 86400;

function sub(o: { id: string; customer: string; status: Stripe.Subscription.Status; price: string; accountId: number; duoId?: number; periodStart?: number; interval?: 'month' | 'year'; startDate?: number }): Stripe.Subscription {
  const ps = o.periodStart ?? NOW;
  return {
    id: o.id, object: 'subscription', customer: o.customer, status: o.status, cancel_at_period_end: false,
    // Lot 61B : `start_date` d'un abonnement Duo NOUVEAU (Checkout) = sa prise
    // d'effet réelle (données cohérentes) ; pour un abonnement Premium
    // existant passé en Duo, il n'est jamais retenu (DUO-M1-E2E-03).
    start_date: o.startDate ?? NOW - 90 * 86400,
    metadata: { accountId: String(o.accountId), ...(o.duoId ? { duoId: String(o.duoId) } : {}) }, discounts: [], schedule: null,
    items: { data: [{
      id: `si_${o.id}`, quantity: 1,
      price: { id: o.price, unit_amount: 1290, currency: 'eur', product: 'prod_e2e_m1', tax_behavior: 'unspecified', recurring: { interval: o.interval ?? 'month', interval_count: 1 } },
      current_period_start: ps, current_period_end: ps + (o.interval === 'year' ? 365 * 86400 : MOIS),
    }] },
  } as unknown as Stripe.Subscription;
}

scenario('L54F-DUO-M1', 'Duo : « Inviter quelqu’un » limité au premier mois, ouverture fiable', ({ sql, make }) => {
  beforeAll(async () => {
    const { getStripeCatalogContext } = await import('@/lib/stripe-client');
    const ctx = getStripeCatalogContext().catalogContext;
    const { pgCatalogStore } = await import('@/services/billing/catalog-store');
    const { versionRowFrom } = await import('@/services/billing/price-history.service');
    const prix = (id: string, plan: 'premium' | 'premium_duo', period: 'monthly' | 'yearly') => pgCatalogStore.upsertPriceVersion(versionRowFrom(
      { id, livemode: false, product: 'prod_e2e_m1', lookup_key: null, unit_amount: 1290, currency: 'eur', tax_behavior: 'unspecified', active: true, recurring: { interval: period === 'yearly' ? 'year' : 'month', interval_count: 1 } } as unknown as Stripe.Price,
      plan, period, { catalogContext: ctx }, 'e2e',
    ));
    await prix(DUO_PRICE, 'premium_duo', 'monthly');
    await prix(DUO_PRICE_Y, 'premium_duo', 'yearly');
    await prix(PREMIUM_PRICE, 'premium', 'monthly');
  });

  /** Titulaire Premium (Stripe) ; Duo technique créé comme au Checkout (avant paiement). */
  async function titulaire(opts: { duo?: boolean } = { duo: true }) {
    const acc = await make.account({ plan: 'premium' });
    const customer = `cus_${uid('m1')}`;
    const subId = `sub_${uid('m1')}`;
    await sql`UPDATE accounts SET stripe_customer_id = ${customer}, subscription_status = 'ACTIVE', plan_type = 'PREMIUM' WHERE id = ${acc.id}`;
    await sql`UPDATE account_subscriptions SET stripe_customer_id = ${customer}, billing_period = 'monthly', status = 'active' WHERE account_id = ${acc.id}`;
    let duoId = 0;
    if (opts.duo) {
      [{ id: duoId }] = await sql<{ id: number }[]>`
        INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, stripe_customer_id)
        VALUES (${acc.ownerUserId}, 'CANCELED', ${customer}) RETURNING id`;
      await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at) VALUES (${duoId}, ${acc.ownerUserId}, 'ACTIVE', 0, now())`;
      await sql`UPDATE accounts SET duo_account_id = ${duoId} WHERE id = ${acc.id}`;
    }
    return { ...acc, customer, subId, duoId };
  }
  const duoRow = async (id: number) => {
    const [r] = await sql<{ started: string | null; first: string | null; status: string }[]>`
      SELECT duo_subscription_started_at AS started, duo_first_invite_sent_at AS first, subscription_status AS status FROM duo_accounts WHERE id = ${id}`;
    return { status: r.status, started: r.started ? new Date(r.started) : null, first: r.first ? new Date(r.first) : null };
  };
  const sync = async (s: Stripe.Subscription) => {
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    return syncSubscriptionFromStripe({ subscription: s, source: 'e2e', notify: false });
  };
  const lire = async (accountId: number, at: Date) => {
    const { readDuoInvite } = await import('@/services/home/mascot/duo-invite');
    return readDuoInvite(accountId, at);
  };
  const echeance = async (d: Date) => (await import('@/services/home/mascot/duo-invite')).addOneCalendarMonth(d);

  it('DUO-M1-E2E-01 — Checkout : date posée au paiement validé, pas à la création technique ; J0 proposée, instant exact d’un mois absente', async () => {
    const c = await titulaire();
    expect((await duoRow(c.duoId)).started).toBeNull(); // Duo technique avant paiement : aucune date
    expect(await lire(c.id, new Date())).toBeNull();
    // Paiement en attente (3DS) : rien.
    expect(await sync(sub({ id: c.subId, customer: c.customer, status: 'incomplete', price: DUO_PRICE, accountId: c.id, duoId: c.duoId }))).toMatchObject({ skipped: 'INCOMPLETE' });
    expect((await duoRow(c.duoId)).started).toBeNull();

    const paiement = Math.floor(Date.now() / 1000);
    const r = await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_PRICE, accountId: c.id, duoId: c.duoId, startDate: paiement }));
    expect(r).toMatchObject({ planTier: 'premium_duo', newPlanType: 'PREMIUM_DUO', isPaid: true });
    const d = await duoRow(c.duoId);
    expect(d.status).toBe('ACTIVE');
    // Lot 61B : prise d'effet Stripe de l'abonnement Duo, pas la création technique.
    expect(d.started!.getTime()).toBe(paiement * 1000);
    const fin = await echeance(d.started!);
    expect(await lire(c.id, d.started!)).toMatchObject({ title: 'Inviter quelqu’un', href: '/mon-compte#duo-invitation' });
    expect(await lire(c.id, new Date(fin.getTime() - 1))).not.toBeNull();
    expect(await lire(c.id, fin)).toBeNull();
  });

  it('DUO-M1-E2E-02 — rejeu du webhook, renouvellement, resynchronisation, impayé régularisé, changement de périodicité : aucun décalage', async () => {
    const c = await titulaire();
    const actif = (o: Partial<Parameters<typeof sub>[0]> = {}) => sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_PRICE, accountId: c.id, duoId: c.duoId, startDate: NOW, ...o });
    await sync(actif());
    const d0 = (await duoRow(c.duoId)).started!.getTime();
    await new Promise((r) => setTimeout(r, 20));
    await sync(actif()); // rejeu identique
    await sync(actif({ periodStart: NOW + MOIS })); // renouvellement mensuel
    // Impayé (webhook invoice.payment_failed → UNPAID_RECOVERY), puis régularisé.
    await sync(actif({ status: 'past_due' }));
    expect((await duoRow(c.duoId)).status).toBe('UNPAID_RECOVERY');
    expect(await lire(c.id, new Date(d0))).toBeNull(); // impayé : absente
    await sync(actif({ periodStart: NOW + MOIS }));
    // Changement de périodicité (même abonnement, prix annuel).
    await sync(actif({ price: DUO_PRICE_Y, interval: 'year' }));
    // Resynchronisation BO = même synchronisation.
    await sync(actif({ price: DUO_PRICE_Y, interval: 'year' }));
    const d = await duoRow(c.duoId);
    expect(d.status).toBe('ACTIVE');
    expect(d.started!.getTime()).toBe(d0);
  });

  it('DUO-M1-E2E-03 — upgrade Premium → Duo : délai depuis le passage effectif à Duo, pas depuis le début de Premium', async () => {
    const c = await titulaire({ duo: false });
    await sql`UPDATE accounts SET subscription_started_at = now() - interval '200 days' WHERE id = ${c.id}`;
    await sql`INSERT INTO subscription_history (user_id, account_id, old_tier, new_tier, source, created_at)
              VALUES (${c.ownerUserId}, ${c.id}, 'STANDARD', 'PREMIUM', 'e2e', now() - interval '200 days')`;
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: PREMIUM_PRICE, accountId: c.id }));
    expect(await lire(c.id, new Date())).toBeNull();
    // Upgrade : compte Duo technique (comme `ensureDuoAccount`), puis paiement synchronisé.
    const [{ id: duoId }] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, stripe_customer_id) VALUES (${c.ownerUserId}, 'CANCELED', ${c.customer}) RETURNING id`;
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at) VALUES (${duoId}, ${c.ownerUserId}, 'ACTIVE', 0, now())`;
    await sql`UPDATE accounts SET duo_account_id = ${duoId} WHERE id = ${c.id}`;
    // Lot 61B : la date vient de la preuve Stripe du passage à Duo (webhook
    // `customer.subscription.updated`, `previous_attributes`), jamais de
    // l'heure de synchronisation ni du début de Premium (voir DUO-R-03).
    const passage = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    await syncSubscriptionFromStripe({ subscription: sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_PRICE, accountId: c.id, duoId }), source: 'e2e', notify: false, duoEnteredAt: passage });
    const d = await duoRow(duoId);
    expect(d.started!.getTime()).toBe(passage.getTime());
    expect(await lire(c.id, new Date())).not.toBeNull();
  });

  it('DUO-M1-E2E-04 — changement d’offre BO : date posée une fois ; sortie puis nouvelle souscription : nouvelle période', async () => {
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    const c = await titulaire({ duo: false });
    const chg = async (oldPlanType: string, newPlanType: string) => {
      await applyPlanChange({
        accountId: c.id, ownerUserId: c.ownerUserId, oldPlanType, newPlanType, newSubStatus: 'ACTIVE',
        newPremiumUntil: null, newMaxMembers: newPlanType === 'PREMIUM_DUO' ? 2 : 1, source: 'admin:e2e', sendEmails: false,
      } as Parameters<typeof applyPlanChange>[0]);
      // Comme le service BO (`applyLocalPlanChange`) : l'offre lue par les droits suit.
      await sql`UPDATE account_subscriptions SET plan_code = ${newPlanType.toLowerCase()} WHERE account_id = ${c.id}`;
    };
    await chg('PREMIUM', 'PREMIUM_DUO');
    const [{ duo_account_id: duoId }] = await sql<{ duo_account_id: number }[]>`SELECT duo_account_id FROM accounts WHERE id = ${c.id}`;
    const d1 = (await duoRow(duoId)).started!;
    expect(d1).not.toBeNull();
    // Invitation envoyée pendant cette souscription.
    await sql`UPDATE duo_accounts SET duo_first_invite_sent_at = now() WHERE id = ${duoId}`;
    await new Promise((r) => setTimeout(r, 20));
    await chg('PREMIUM_DUO', 'PREMIUM_DUO'); // ex. périodicité changée depuis le BO
    expect((await duoRow(duoId)).started!.getTime()).toBe(d1.getTime());
    // Sortie de l'offre puis VRAIE nouvelle souscription Duo.
    await chg('PREMIUM_DUO', 'PREMIUM');
    expect((await duoRow(duoId)).status).toBe('CANCELED');
    expect(await lire(c.id, new Date())).toBeNull(); // offre perdue
    await sql`UPDATE duo_accounts SET duo_subscription_started_at = duo_subscription_started_at - interval '3 months' WHERE id = ${duoId}`;
    await chg('PREMIUM', 'PREMIUM_DUO');
    const d2 = await duoRow(duoId);
    expect(d2.started!.getTime()).toBeGreaterThan(d1.getTime());
    expect(d2.first).toBeNull(); // nouvelle souscription : aucune invitation encore envoyée
    expect(await lire(c.id, new Date())).not.toBeNull();
  });

  it('DUO-M1-E2E-05 — route réelle : envoi → absente ; annulation / lien expiré → aucune réapparition ; invitation manuelle après le mois', async () => {
    const c = await titulaire();
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_PRICE, accountId: c.id, duoId: c.duoId, startDate: NOW }));
    const { POST, DELETE, GET } = await import('@/app/api/duo/invitation/route');
    etat.session = { userId: c.ownerUserId, currentAccountId: c.id };
    const req = (method: string, body?: unknown) => new NextRequest(`${APP}/api/duo/invitation`, {
      method, headers: { 'content-type': 'application/json', host: 'app.e2e.verebona.test' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(await lire(c.id, new Date())).not.toBeNull();

    expect((await POST(req('POST', { email: `ami-${c.id}@test.invalid` }))).status).toBe(200);
    const first = (await duoRow(c.duoId)).first!;
    expect(first).not.toBeNull();
    expect(await lire(c.id, new Date())).toBeNull();
    // Renvoi : trace inchangée (premier envoi).
    expect((await POST(req('POST', { email: `ami-${c.id}@test.invalid`, resend: true }))).status).toBe(200);
    expect((await duoRow(c.duoId)).first!.getTime()).toBe(first.getTime());
    // Annulation : invitation retirée dans « Mon compte », mascotte toujours muette.
    expect((await DELETE(req('DELETE'))).status).toBe(200);
    expect(await (await GET(req('GET'))).json()).toMatchObject({ status: 'NONE' });
    expect((await duoRow(c.duoId)).first!.getTime()).toBe(first.getTime());
    expect(await lire(c.id, new Date())).toBeNull();
    // Lien expiré : idem.
    await sql`UPDATE duo_accounts SET pending_invite_email = 'x@test.invalid', pending_invite_token_expires_at = now() - interval '1 day' WHERE id = ${c.duoId}`;
    expect(await (await GET(req('GET'))).json()).toMatchObject({ status: 'EXPIRED' });
    await sql`UPDATE duo_accounts SET pending_invite_email = NULL, pending_invite_token = NULL WHERE id = ${c.duoId}`;
    expect(await lire(c.id, new Date())).toBeNull();

    // Après expiration du mois, sans invitation : mascotte muette, invitation manuelle possible.
    const c2 = await titulaire();
    await sync(sub({ id: c2.subId, customer: c2.customer, status: 'active', price: DUO_PRICE, accountId: c2.id, duoId: c2.duoId, startDate: NOW }));
    await sql`UPDATE duo_accounts SET duo_subscription_started_at = now() - interval '2 months' WHERE id = ${c2.duoId}`;
    expect(await lire(c2.id, new Date())).toBeNull();
    etat.session = { userId: c2.ownerUserId, currentAccountId: c2.id };
    expect((await POST(req('POST', { email: `ami2-${c2.id}@test.invalid` }))).status).toBe(200);
    expect(await (await GET(req('GET'))).json()).toMatchObject({ status: 'PENDING' });
  });

  it('DUO-M1-E2E-06 — Duo impayé, résilié, membre (invité ou actif) : absente', async () => {
    const c = await titulaire();
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_PRICE, accountId: c.id, duoId: c.duoId, startDate: NOW }));
    const t = (await duoRow(c.duoId)).started!;
    const membre = await make.account();
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, invited_at) VALUES (${c.duoId}, ${membre.ownerUserId}, 'INVITED', 1, now())`;
    expect(await lire(c.id, t)).toBeNull();
    expect(await lire(membre.id, t)).toBeNull(); // le membre n'est jamais ciblé
    await sql`DELETE FROM duo_memberships WHERE duo_id = ${c.duoId} AND user_id = ${membre.ownerUserId}`;
    expect(await lire(c.id, t)).not.toBeNull();
    // Résiliation Stripe (abonnement courant) : offre perdue.
    await sync(sub({ id: c.subId, customer: c.customer, status: 'canceled', price: DUO_PRICE, accountId: c.id, duoId: c.duoId }));
    expect((await duoRow(c.duoId)).status).toBe('CANCELED');
    expect(await lire(c.id, t)).toBeNull();
  });

  it('DUO-M1-E2E-07 — reprise des comptes existants (migration rejouée, idempotente)', async () => {
    const mig = readFileSync(join(process.cwd(), 'src/db/migrations/0385_duo_subscription_started_at.sql'), 'utf8');
    const existant = async (statut = 'ACTIVE') => {
      const acc = await make.account({ plan: 'premium_duo' });
      await sql`UPDATE accounts SET plan_type = 'PREMIUM_DUO', subscription_status = 'ACTIVE' WHERE id = ${acc.id}`;
      const [{ id }] = await sql<{ id: number }[]>`INSERT INTO duo_accounts (billing_owner_user_id, subscription_status) VALUES (${acc.ownerUserId}, ${statut}) RETURNING id`;
      await sql`UPDATE accounts SET duo_account_id = ${id} WHERE id = ${acc.id}`;
      // Comme avant le lot 54F : aucune date (l'UPDATE ne touche pas le statut).
      await sql`UPDATE duo_accounts SET duo_subscription_started_at = NULL, duo_first_invite_sent_at = NULL WHERE id = ${id}`;
      return { ...acc, duoId: id };
    };
    // a) historique fiable : Premium (ancien) puis passage à Duo il y a 10 jours.
    const a = await existant();
    await sql`INSERT INTO subscription_history (user_id, account_id, old_tier, new_tier, source, created_at) VALUES
      (${a.ownerUserId}, ${a.id}, 'STANDARD', 'PREMIUM', 'e2e', now() - interval '300 days'),
      (${a.ownerUserId}, ${a.id}, 'PREMIUM', 'PREMIUM_DUO', 'e2e', now() - interval '10 days')`;
    // b) aucun historique : date inconnue → NULL, jamais la date de migration.
    const b = await existant();
    // c) passage à Duo puis SORTIE enregistrée (historique incohérent avec l'état) : NULL.
    const cc = await existant();
    await sql`INSERT INTO subscription_history (user_id, account_id, old_tier, new_tier, source, created_at) VALUES
      (${cc.ownerUserId}, ${cc.id}, 'PREMIUM', 'PREMIUM_DUO', 'e2e', now() - interval '20 days'),
      (${cc.ownerUserId}, ${cc.id}, 'PREMIUM_DUO', 'STANDARD', 'e2e', now() - interval '5 days')`;
    // d) passage récent + invitation envoyée puis ANNULÉE (seule trace : journal des e-mails).
    const dd = await existant();
    await sql`INSERT INTO subscription_history (user_id, account_id, old_tier, new_tier, source, created_at)
              VALUES (${dd.ownerUserId}, ${dd.id}, 'PREMIUM', 'PREMIUM_DUO', 'e2e', now() - interval '3 days')`;
    await sql`INSERT INTO email_logs (template_code, recipient_email, recipient_user_id, subject, status, sent_at)
              VALUES ('DUO_INVITATION', 'ami@test.invalid', ${dd.ownerUserId}, 'Invitation', 'sent', now() - interval '2 days')`;

    await sql.begin((tx) => tx.unsafe(mig));
    await sql.begin((tx) => tx.unsafe(mig)); // rejouable sans effet
    // Ordre de production : 0438 (lot 61B) suit 0385 et remplace son déclencheur.
    const m0438 = readFileSync(join(process.cwd(), 'src/db/migrations/0438_duo_invite_period_fix.sql'), 'utf8');
    await sql.begin((tx) => tx.unsafe(m0438));

    const ra = await duoRow(a.duoId);
    expect(Math.round((Date.now() - ra.started!.getTime()) / 86_400_000)).toBe(10);
    expect(await lire(a.id, new Date())).not.toBeNull();
    expect((await duoRow(b.duoId)).started).toBeNull();
    expect(await lire(b.id, new Date())).toBeNull();
    expect((await duoRow(cc.duoId)).started).toBeNull();
    const rd = await duoRow(dd.duoId);
    expect(rd.started).not.toBeNull();
    expect(rd.first).not.toBeNull();
    expect(await lire(dd.id, new Date())).toBeNull();
  });
});
