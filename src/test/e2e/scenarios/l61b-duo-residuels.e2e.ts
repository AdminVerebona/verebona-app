/**
 * Lot 61B — Premium Duo : écarts résiduels de la proposition « Inviter
 * quelqu'un » (ticket P1, écarts A à F), sur PostgreSQL réel (migrations
 * 0385 puis 0438 : déclencheur, colonnes, reprise), Stripe SIMULÉ (objets
 * synthétiques, prix inscrits au registre historique, jamais d'appel Stripe)
 * et horloge maîtrisée à la lecture.
 *
 * DUO-R-01 (D)  Checkout Duo : date = début Stripe de l'abonnement, jamais
 *               la création technique ni l'heure d'une synchronisation
 *               tardive ; instant exact début + 1 mois : absente.
 * DUO-R-02 (D)  Renouvellement, rejeu, resynchronisation, changement de
 *               périodicité (webhook compris) : date conservée.
 * DUO-R-03 (D)  Upgrade Premium → Duo : sans preuve (retour du portail) date
 *               inconnue, rien n'est proposé ; le webhook de la transition
 *               date la prise d'effet ; jamais le début de Premium.
 * DUO-R-04 (A)  Duo → Premium → Duo via Stripe : sortie (Duo CANCELED,
 *               suggestion absente), nouvelle période au retour ; l'ancien
 *               webhook rejoué n'ouvre pas la nouvelle période.
 * DUO-R-05 (A)  Duo → Standard payé : Duo non actif ; abonnement ancien
 *               terminé reçu après coup : aucune réactivation, aucun effet.
 * DUO-R-06 (C)  Résiliation programmée : suggestion absente, Duo encore
 *               ACTIVE, invitation manuelle toujours possible ; impayé : absente.
 * DUO-R-07 (A)  Vérification croisée : Duo ACTIVE mais offre du compte
 *               perdue (sortie historique non synchronisée) : absente.
 * DUO-R-08 (F)  BO `applyPlanChange` : depuis un impayé → UNPAID_RECOVERY,
 *               sans droits → CANCELED, jamais ACTIVE ; à jour → ACTIVE avec la
 *               date de prise d'effet ; BO puis webhook (et l'inverse) convergent.
 * DUO-R-09 (E)  Acceptation Resend concurrente d'une annulation : trace
 *               durable ; envoi échoué : aucune trace.
 * DUO-R-10 (E)  Remplacement pendant l'expédition : nouvelle demande, le
 *               nouvel invité reçoit SON lien ; trace du premier envoi conservée.
 * DUO-R-11 (E)  Expédition acceptée après l'ouverture d'une nouvelle
 *               souscription : ne pollue pas la nouvelle période.
 * DUO-R-12 (B)  Reprise 0438 : attribution historique corrigée (destinataire
 *               = invité), trace erronée corrigée (e-mail reçu par le
 *               titulaire, envoi échoué, souscription précédente), trace
 *               valide conservée, invitation annulée sans réapparition,
 *               rejouable sans effet.
 */
import type Stripe from 'stripe';
import { beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';

const etat = vi.hoisted(() => ({
  session: { userId: 0, currentAccountId: 0 as number | null },
  /** Transport simulé : remplaçable par test (concurrence). */
  send: null as null | ((p: { to: string; variables: Record<string, string> }) => Promise<{ success: boolean; error?: string }>),
  sent: [] as Array<{ to: string; inviteUrl?: string }>,
}));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/lib/email/email-service', () => ({
  emailService: {
    send: async (p: { to: string; variables: Record<string, string> }) => {
      if (etat.send) return etat.send(p);
      etat.sent.push({ to: p.to, inviteUrl: p.variables?.inviteUrl });
      return { success: true };
    },
  },
}));

const APP = 'https://app.e2e.verebona.test';
const DUO_M = 'price_e2e_duo_r_monthly';
const DUO_Y = 'price_e2e_duo_r_yearly';
const PREM = 'price_e2e_premium_r_monthly';
const STD = 'price_e2e_standard_r_monthly';
const NOW = Math.floor(Date.now() / 1000);
const JOUR = 86400;
const MOIS = 30 * JOUR;

function sub(o: {
  id: string; customer: string; status: Stripe.Subscription.Status; price: string; accountId: number; duoId?: number;
  startDate?: number; periodStart?: number; interval?: 'month' | 'year'; cancelAtPeriodEnd?: boolean; metadata?: Record<string, string>;
}): Stripe.Subscription {
  const ps = o.periodStart ?? NOW;
  return {
    id: o.id, object: 'subscription', customer: o.customer, status: o.status, cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    start_date: o.startDate ?? NOW,
    metadata: { accountId: String(o.accountId), ...(o.duoId ? { duoId: String(o.duoId) } : {}), ...(o.metadata ?? {}) },
    discounts: [], schedule: null,
    items: { data: [{
      id: `si_${o.id}`, quantity: 1,
      price: { id: o.price, unit_amount: 1290, currency: 'eur', product: 'prod_e2e_r', tax_behavior: 'unspecified', recurring: { interval: o.interval ?? 'month', interval_count: 1 } },
      current_period_start: ps, current_period_end: ps + (o.interval === 'year' ? 365 * JOUR : MOIS),
    }] },
  } as unknown as Stripe.Subscription;
}

/** Événement `customer.subscription.updated` (objet = instantané, `previous_attributes`). */
function evenement(s: Stripe.Subscription, previousPrice: string | null, createdUnix: number) {
  return {
    type: 'customer.subscription.updated', created: createdUnix,
    data: {
      object: s,
      ...(previousPrice ? { previous_attributes: { items: { data: [{ price: { id: previousPrice } }] } } } : {}),
    },
  } as unknown as Stripe.Event;
}

scenario('L61B-DUO-R', 'Duo : écarts résiduels de « Inviter quelqu’un » (transitions, date réelle, trace, BO, reprise)', ({ sql, make }) => {
  beforeAll(async () => {
    const { getStripeCatalogContext } = await import('@/lib/stripe-client');
    const ctx = getStripeCatalogContext().catalogContext;
    const { pgCatalogStore } = await import('@/services/billing/catalog-store');
    const { versionRowFrom } = await import('@/services/billing/price-history.service');
    const prix = (id: string, plan: 'standard' | 'premium' | 'premium_duo', period: 'monthly' | 'yearly') => pgCatalogStore.upsertPriceVersion(versionRowFrom(
      { id, livemode: false, product: 'prod_e2e_r', lookup_key: null, unit_amount: 1290, currency: 'eur', tax_behavior: 'unspecified', active: true, recurring: { interval: period === 'yearly' ? 'year' : 'month', interval_count: 1 } } as unknown as Stripe.Price,
      plan, period, { catalogContext: ctx }, 'e2e',
    ));
    await prix(DUO_M, 'premium_duo', 'monthly');
    await prix(DUO_Y, 'premium_duo', 'yearly');
    await prix(PREM, 'premium', 'monthly');
    await prix(STD, 'standard', 'monthly');
  });

  /** Titulaire Premium (Stripe) ; Duo technique créé comme au Checkout / upgrade (avant paiement). */
  async function titulaire(opts: { duo?: boolean } = { duo: true }) {
    const acc = await make.account({ plan: 'premium' });
    const customer = `cus_${uid('r')}`;
    const subId = `sub_${uid('r')}`;
    await sql`UPDATE accounts SET stripe_customer_id = ${customer}, subscription_status = 'ACTIVE', plan_type = 'PREMIUM' WHERE id = ${acc.id}`;
    await sql`UPDATE account_subscriptions SET stripe_customer_id = ${customer}, billing_period = 'monthly', status = 'active' WHERE account_id = ${acc.id}`;
    let duoId = 0;
    if (opts.duo !== false) duoId = await duoTechnique(acc.id, acc.ownerUserId, customer);
    return { ...acc, customer, subId, duoId };
  }
  async function duoTechnique(accountId: number, ownerUserId: number, customer: string | null) {
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, stripe_customer_id)
      VALUES (${ownerUserId}, 'CANCELED', ${customer}) RETURNING id`;
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at) VALUES (${id}, ${ownerUserId}, 'ACTIVE', 0, now())`;
    await sql`UPDATE accounts SET duo_account_id = ${id} WHERE id = ${accountId}`;
    return id;
  }
  const duoRow = async (id: number) => {
    const [r] = await sql<{ started: string | null; first: string | null; ended: string | null; status: string; sent: string | null }[]>`
      SELECT duo_subscription_started_at AS started, duo_first_invite_sent_at AS first, duo_subscription_ended_at AS ended,
             subscription_status AS status, pending_invite_sent_at AS sent FROM duo_accounts WHERE id = ${id}`;
    const d = (v: string | null) => (v ? new Date(v) : null);
    return { status: r.status, started: d(r.started), first: d(r.first), ended: d(r.ended), sent: d(r.sent) };
  };
  const sync = async (s: Stripe.Subscription, duoEnteredAt?: Date | null) => {
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    return syncSubscriptionFromStripe({ subscription: s, source: 'e2e', notify: false, duoEnteredAt });
  };
  /** Chemin du webhook `customer.subscription.updated` : preuve de transition lue, puis synchronisation. */
  const webhook = async (s: Stripe.Subscription, previousPrice: string | null, createdUnix: number) => {
    const { duoEntryFromEvent } = await import('@/services/duo/duo-period');
    return sync(s, await duoEntryFromEvent(evenement(s, previousPrice, createdUnix)));
  };
  const lire = async (accountId: number, at: Date = new Date()) => (await import('@/services/home/mascot/duo-invite')).readDuoInvite(accountId, at);
  const echeance = async (d: Date) => (await import('@/services/home/mascot/duo-invite')).addOneCalendarMonth(d);
  const req = (method: string, body?: unknown) => new NextRequest(`${APP}/api/duo/invitation`, {
    method, headers: { 'content-type': 'application/json', host: 'app.e2e.verebona.test' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });

  it('DUO-R-01 — Checkout Duo : date réelle Stripe, jamais la création technique ni l’heure d’une synchronisation tardive', async () => {
    const c = await titulaire();
    await sql`UPDATE duo_accounts SET created_at = now() - interval '5 days' WHERE id = ${c.duoId}`; // création technique ancienne
    expect((await duoRow(c.duoId)).started).toBeNull();
    // Paiement confirmé il y a 3 jours, synchronisé seulement maintenant (webhooks en retard).
    const debut = NOW - 3 * JOUR;
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId: c.duoId, startDate: debut, periodStart: debut }));
    const d = await duoRow(c.duoId);
    expect(d.status).toBe('ACTIVE');
    expect(d.started!.getTime()).toBe(debut * 1000); // ni now(), ni la création technique
    const fin = await echeance(d.started!);
    expect(await lire(c.id, new Date(debut * 1000))).toMatchObject({ title: 'Inviter quelqu’un', href: '/mon-compte#duo-invitation' });
    expect(await lire(c.id, new Date(fin.getTime() - 1))).not.toBeNull();
    expect(await lire(c.id, fin)).toBeNull(); // instant exact : absente (aucun prolongement de 3 jours)
  });

  it('DUO-R-02 — renouvellement, rejeu, resynchronisation, changement de périodicité : date conservée', async () => {
    const c = await titulaire();
    const debut = NOW - JOUR;
    const actif = (o: Partial<Parameters<typeof sub>[0]> = {}) => sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId: c.duoId, startDate: debut, ...o });
    await sync(actif());
    const d0 = (await duoRow(c.duoId)).started!.getTime();
    expect(d0).toBe(debut * 1000);
    await sync(actif()); // rejeu
    await sync(actif({ periodStart: NOW + MOIS })); // renouvellement
    await sync(actif({ status: 'past_due' })); // impayé
    await sync(actif({ periodStart: NOW + MOIS })); // régularisé
    // Changement de périodicité notifié par webhook (prix précédent : Duo mensuel) : pas une entrée en Duo.
    await webhook(actif({ price: DUO_Y, interval: 'year' }), DUO_M, NOW + 10 * JOUR);
    await sync(actif({ price: DUO_Y, interval: 'year' })); // resynchronisation BO
    const d = await duoRow(c.duoId);
    expect(d.status).toBe('ACTIVE');
    expect(d.started!.getTime()).toBe(d0);
  });

  it('DUO-R-03 — upgrade Premium → Duo : date du passage effectif (webhook de la transition), jamais le début de Premium', async () => {
    const c = await titulaire({ duo: false });
    const debutPremium = NOW - 200 * JOUR;
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: PREM, accountId: c.id, startDate: debutPremium }));
    const duoId = await duoTechnique(c.id, c.ownerUserId, c.customer); // comme `ensureDuoAccount`
    const duo = sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId, startDate: debutPremium });
    // Retour du portail (aucune preuve de la date) : Duo actif, date inconnue, rien de proposé.
    await sync(duo);
    let d = await duoRow(duoId);
    expect(d.status).toBe('ACTIVE');
    expect(d.started).toBeNull();
    expect(await lire(c.id)).toBeNull();
    // Webhook de la transition (Premium → Duo) émis 2 h plus tôt : date de prise d'effet.
    const passage = NOW - 7200;
    await webhook(duo, PREM, passage);
    d = await duoRow(duoId);
    expect(d.started!.getTime()).toBe(passage * 1000);
    expect(await lire(c.id)).not.toBeNull();
    // Rejeu du même webhook, renouvellement : inchangé.
    await webhook(duo, PREM, passage + 60);
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId, startDate: debutPremium, periodStart: NOW + MOIS }));
    expect((await duoRow(duoId)).started!.getTime()).toBe(passage * 1000);

    // Webhook traité AVANT le retour du portail : même résultat.
    const c2 = await titulaire({ duo: false });
    await sync(sub({ id: c2.subId, customer: c2.customer, status: 'active', price: PREM, accountId: c2.id, startDate: debutPremium }));
    const duo2 = await duoTechnique(c2.id, c2.ownerUserId, c2.customer);
    const s2 = sub({ id: c2.subId, customer: c2.customer, status: 'active', price: DUO_M, accountId: c2.id, duoId: duo2, startDate: debutPremium });
    await webhook(s2, PREM, passage);
    await sync(s2);
    expect((await duoRow(duo2)).started!.getTime()).toBe(passage * 1000);

    // Retour du portail et webhook traités EN MÊME TEMPS : la date n'est jamais remise à vide.
    const c3 = await titulaire({ duo: false });
    await sync(sub({ id: c3.subId, customer: c3.customer, status: 'active', price: PREM, accountId: c3.id, startDate: debutPremium }));
    const duo3 = await duoTechnique(c3.id, c3.ownerUserId, c3.customer);
    const s3 = sub({ id: c3.subId, customer: c3.customer, status: 'active', price: DUO_M, accountId: c3.id, duoId: duo3, startDate: debutPremium });
    await Promise.all([sync(s3), webhook(s3, PREM, passage), sync(s3)]);
    expect(await duoRow(duo3)).toMatchObject({ status: 'ACTIVE' });
    expect((await duoRow(duo3)).started!.getTime()).toBe(passage * 1000);
  });

  it('DUO-R-04 — Duo → Premium → Duo via Stripe : sortie effective, nouvelle période au retour, ancien webhook sans effet', async () => {
    const c = await titulaire({ duo: false });
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: PREM, accountId: c.id, startDate: NOW - 100 * JOUR }));
    const duoId = await duoTechnique(c.id, c.ownerUserId, c.customer);
    const enDuo = sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId, startDate: NOW - 100 * JOUR });
    const entree1 = NOW - 20 * JOUR;
    await webhook(enDuo, PREM, entree1);
    await sql`UPDATE duo_accounts SET duo_first_invite_sent_at = now() - interval '19 days' WHERE id = ${duoId}`;
    // Sortie vers Premium (même abonnement).
    await webhook(sub({ id: c.subId, customer: c.customer, status: 'active', price: PREM, accountId: c.id, duoId, startDate: NOW - 100 * JOUR }), DUO_M, NOW - 10 * JOUR);
    let d = await duoRow(duoId);
    expect(d.status).toBe('CANCELED');
    expect(d.ended).not.toBeNull();
    expect(await lire(c.id, new Date(entree1 * 1000 + JOUR * 1000))).toBeNull();
    // Rejeu de l'ancien passage à Duo alors que l'abonnement est Premium : aucune réactivation.
    await webhook(sub({ id: c.subId, customer: c.customer, status: 'active', price: PREM, accountId: c.id, duoId, startDate: NOW - 100 * JOUR }), null, entree1);
    expect((await duoRow(duoId)).status).toBe('CANCELED');
    // Retour en Duo : retour du portail d'abord (date inconnue), puis rejeu de l'ANCIEN webhook (antérieur à la sortie) : refusé.
    await sync(enDuo);
    d = await duoRow(duoId);
    expect(d.status).toBe('ACTIVE');
    expect(d.started).toBeNull();
    expect(d.first).toBeNull(); // nouvelle souscription : trace remise à zéro
    await webhook(enDuo, PREM, entree1);
    expect((await duoRow(duoId)).started).toBeNull();
    // Le vrai webhook du retour (postérieur à la sortie) : nouvelle période.
    const entree2 = Math.ceil(Date.now() / 1000) + 1;
    await webhook(enDuo, PREM, entree2);
    d = await duoRow(duoId);
    expect(d.started!.getTime()).toBe(entree2 * 1000);
    expect(await lire(c.id, new Date((entree2 + 1) * 1000))).not.toBeNull();
  });

  it('DUO-R-05 — Duo → Standard payé : Duo non actif ; ancien abonnement terminé reçu après coup : aucun effet', async () => {
    const c = await titulaire();
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId: c.duoId, startDate: NOW - JOUR }));
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: STD, accountId: c.id, startDate: NOW - JOUR }));
    expect((await duoRow(c.duoId)).status).toBe('CANCELED');
    expect(await lire(c.id)).toBeNull();
    // Nouvel abonnement Duo (Checkout) : nouvelle période ; l'ANCIEN abonnement terminé arrive ensuite (désordre).
    const nouveau = `sub_${uid('r2')}`;
    const debut2 = Math.ceil(Date.now() / 1000) + 1; // souscrit après la sortie
    await sync(sub({ id: nouveau, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId: c.duoId, startDate: debut2 }));
    const d = await duoRow(c.duoId);
    expect(d.status).toBe('ACTIVE');
    expect(d.started!.getTime()).toBe(debut2 * 1000);
    expect(await sync(sub({ id: c.subId, customer: c.customer, status: 'canceled', price: STD, accountId: c.id }))).toMatchObject({ skipped: 'STALE_SUBSCRIPTION' });
    expect(await duoRow(c.duoId)).toMatchObject({ status: 'ACTIVE' });
    expect(await lire(c.id, new Date((debut2 + 1) * 1000))).not.toBeNull();
  });

  it('DUO-R-06 — résiliation programmée : suggestion absente, droits et invitation manuelle conservés ; impayé : absente', async () => {
    const c = await titulaire();
    const s = (o: Partial<Parameters<typeof sub>[0]> = {}) => sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId: c.duoId, startDate: NOW - JOUR, ...o });
    await sync(s());
    expect(await lire(c.id)).not.toBeNull();
    await sync(s({ cancelAtPeriodEnd: true }));
    expect(await duoRow(c.duoId)).toMatchObject({ status: 'ACTIVE' }); // droits jusqu'à l'échéance
    expect(await lire(c.id)).toBeNull();
    const { POST, GET } = await import('@/app/api/duo/invitation/route');
    etat.session = { userId: c.ownerUserId, currentAccountId: c.id };
    expect((await POST(req('POST', { email: `ami-r6-${c.id}@test.invalid` }))).status).toBe(200);
    expect(await (await GET(req('GET'))).json()).toMatchObject({ status: 'PENDING' });
    // Résiliation annulée : la suggestion ne revient pas (invitation envoyée).
    await sync(s());
    expect(await lire(c.id)).toBeNull();
    // Impayé.
    const c2 = await titulaire();
    await sync(sub({ id: c2.subId, customer: c2.customer, status: 'past_due', price: DUO_M, accountId: c2.id, duoId: c2.duoId, startDate: NOW - JOUR }));
    expect(await lire(c2.id)).toBeNull();
  });

  it('DUO-R-07 — vérification croisée : Duo ACTIVE mais offre du compte perdue → absente', async () => {
    const c = await titulaire();
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId: c.duoId, startDate: NOW - JOUR }));
    expect(await lire(c.id)).not.toBeNull();
    // État historique : sortie vers Premium jamais reportée sur le Duo.
    await sql`UPDATE accounts SET plan_type = 'PREMIUM' WHERE id = ${c.id}`;
    await sql`UPDATE account_subscriptions SET plan_code = 'premium' WHERE account_id = ${c.id}`;
    expect(await duoRow(c.duoId)).toMatchObject({ status: 'ACTIVE' });
    expect(await lire(c.id)).toBeNull();
    // Compte rétracté.
    await sql`UPDATE accounts SET plan_type = 'PREMIUM_DUO', subscription_status = 'WITHDRAWN' WHERE id = ${c.id}`;
    await sql`UPDATE account_subscriptions SET plan_code = 'premium_duo', status = 'readonly' WHERE account_id = ${c.id}`;
    expect(await lire(c.id)).toBeNull();
  });

  it('DUO-R-08 — BO : aucune activation Duo injustifiée ; BO et Stripe convergent', async () => {
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    const chg = (c: { id: number; ownerUserId: number }, oldPlanType: string, newSubStatus: string, duoEffectiveAt?: Date) => applyPlanChange({
      accountId: c.id, ownerUserId: c.ownerUserId, oldPlanType, newPlanType: 'PREMIUM_DUO', newSubStatus,
      newPremiumUntil: null, newMaxMembers: 2, source: 'admin:e2e', sendEmails: false, duoEffectiveAt,
    });
    const aligner = async (id: number) => sql`UPDATE account_subscriptions SET plan_code = 'premium_duo' WHERE account_id = ${id}`;
    // Impayé → UNPAID_RECOVERY, jamais ACTIVE ; pas de date.
    const a = await titulaire();
    await sql`UPDATE accounts SET subscription_status = 'PAST_DUE' WHERE id = ${a.id}`;
    await chg(a, 'PREMIUM', 'PAST_DUE');
    await aligner(a.id);
    expect(await duoRow(a.duoId)).toMatchObject({ status: 'UNPAID_RECOVERY', started: null });
    expect(await lire(a.id)).toBeNull();
    // Sans droits (abonnement terminé) → CANCELED ; Duo créé par le BO → CANCELED aussi.
    const b = await titulaire();
    await chg(b, 'PREMIUM', 'EXPIRED');
    expect((await duoRow(b.duoId)).status).toBe('CANCELED');
    const b2 = await titulaire({ duo: false });
    await chg(b2, 'PREMIUM', 'EXPIRED');
    const [{ duo_account_id: b2Duo }] = await sql<{ duo_account_id: number }[]>`SELECT duo_account_id FROM accounts WHERE id = ${b2.id}`;
    expect(await duoRow(b2Duo)).toMatchObject({ status: 'CANCELED', started: null });
    // À jour → ACTIVE, date = prise d'effet (marqueur Stripe).
    const c = await titulaire();
    const effet = new Date(Date.now() - 3_600_000);
    await chg(c, 'PREMIUM', 'ACTIVE', effet);
    await aligner(c.id);
    expect(await duoRow(c.duoId)).toMatchObject({ status: 'ACTIVE' });
    expect((await duoRow(c.duoId)).started!.getTime()).toBe(effet.getTime());
    expect(await lire(c.id)).not.toBeNull();
    // Le webhook (écho du changement BO, marqueur identique) arrive ensuite : rien ne bouge.
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId: c.duoId, startDate: NOW - 90 * JOUR,
      metadata: { admin_plan_change: effet.toISOString(), admin_plan_change_to: 'premium_duo' } }));
    expect((await duoRow(c.duoId)).started!.getTime()).toBe(effet.getTime());
    // Ordre inverse : webhook d'abord (marqueur), BO ensuite → même date.
    const e = await titulaire();
    await sql`UPDATE accounts SET stripe_subscription_id = ${e.subId} WHERE id = ${e.id}`;
    await sync(sub({ id: e.subId, customer: e.customer, status: 'active', price: DUO_M, accountId: e.id, duoId: e.duoId, startDate: NOW - 90 * JOUR,
      metadata: { admin_plan_change: effet.toISOString(), admin_plan_change_to: 'premium_duo' } }));
    expect((await duoRow(e.duoId)).started!.getTime()).toBe(effet.getTime());
    await chg(e, 'PREMIUM', 'ACTIVE', new Date());
    expect((await duoRow(e.duoId)).started!.getTime()).toBe(effet.getTime());
    // Webhook impayé puis BO : reste UNPAID_RECOVERY.
    await sync(sub({ id: e.subId, customer: e.customer, status: 'past_due', price: DUO_M, accountId: e.id, duoId: e.duoId, startDate: NOW - 90 * JOUR }));
    await chg(e, 'PREMIUM_DUO', 'PAST_DUE', new Date());
    expect((await duoRow(e.duoId)).status).toBe('UNPAID_RECOVERY');
    expect(await lire(e.id)).toBeNull();
  });

  async function duoActif() {
    const c = await titulaire();
    await sync(sub({ id: c.subId, customer: c.customer, status: 'active', price: DUO_M, accountId: c.id, duoId: c.duoId, startDate: NOW - JOUR }));
    etat.session = { userId: c.ownerUserId, currentAccountId: c.id };
    return c;
  }

  it('DUO-R-09 — acceptation Resend concurrente d’une annulation : trace durable ; envoi échoué : aucune trace', async () => {
    const { POST, DELETE } = await import('@/app/api/duo/invitation/route');
    // Échec du transport : rien n'est présenté comme accepté.
    const k = await duoActif();
    etat.send = async (p) => (p.variables?.inviteUrl ? { success: false, error: 'Resend indisponible' } : { success: true });
    const ko = await (await POST(req('POST', { email: `ko-${k.id}@test.invalid` }))).json();
    expect(ko).toMatchObject({ success: true, emailAccepted: false });
    expect(await duoRow(k.duoId)).toMatchObject({ first: null, sent: null });
    // Annulation : l'invitation n'est jamais partie — la suggestion revient (aucun e-mail accepté).
    expect((await DELETE(req('DELETE'))).status).toBe(200);
    expect(await lire(k.id)).not.toBeNull();

    const c = await duoActif();
    // Le titulaire annule PENDANT l'expédition ; Resend accepte ensuite.
    etat.send = async (p) => {
      if (p.variables?.inviteUrl) await DELETE(req('DELETE')); // seulement pendant l'expédition de l'invitation
      return { success: true };
    };
    const ok = await (await POST(req('POST', { email: `ami-r9-${c.id}@test.invalid` }))).json();
    expect(ok).toMatchObject({ success: true, emailAccepted: true });
    const d = await duoRow(c.duoId);
    expect(d.first).not.toBeNull(); // trace durable malgré l'annulation
    expect(d.sent).toBeNull(); // la date d'envoi affichée ne concerne qu'une invitation en cours
    expect(await lire(c.id)).toBeNull(); // aucune réapparition
    etat.send = null;
    // Invitation manuelle toujours possible.
    expect((await POST(req('POST', { email: `ami-r9b-${c.id}@test.invalid` }))).status).toBe(200);
    expect((await duoRow(c.duoId)).first!.getTime()).toBe(d.first!.getTime());
  });

  it('DUO-R-10 — remplacement pendant l’expédition : nouvelle demande, le nouvel invité reçoit SON lien', async () => {
    const c = await duoActif();
    const { POST } = await import('@/app/api/duo/invitation/route');
    const premier = `p-r10-${c.id}@test.invalid`;
    const second = `s-r10-${c.id}@test.invalid`;
    let remplace: Promise<Response> | null = null;
    const recus: Array<{ to: string; url?: string }> = [];
    etat.send = async (p) => {
      if (!p.variables?.inviteUrl) return { success: true }; // autres e-mails (notifications de la synchronisation)
      recus.push({ to: p.to, url: p.variables?.inviteUrl });
      // Le remplacement est TRAITÉ pendant que la première expédition est en cours.
      if (p.to === premier && !remplace) {
        remplace = POST(req('POST', { email: second })) as unknown as Promise<Response>;
        await remplace;
      }
      return { success: true };
    };
    await POST(req('POST', { email: premier }));
    const r2 = await (await remplace!).json();
    etat.send = null;
    const [{ token }] = await sql<{ token: string }[]>`SELECT pending_invite_token AS token FROM duo_accounts WHERE id = ${c.duoId}`;
    expect(r2).toMatchObject({ success: true, emailAccepted: true });
    expect(recus.map((r) => r.to)).toEqual([premier, second]);
    expect(recus[1].url).toContain(`/duo/join/${token}`); // lien en cours, pas l'ancien
    const jobs = await sql<{ recipient_email: string; status: string }[]>`
      SELECT recipient_email, status FROM transactional_email_jobs WHERE duo_id = ${c.duoId} ORDER BY id`;
    expect(jobs).toEqual([{ recipient_email: premier, status: 'accepted' }, { recipient_email: second, status: 'accepted' }]);
    const d = await duoRow(c.duoId);
    expect(d.first).not.toBeNull();
    expect(d.sent).not.toBeNull();
  });

  it('DUO-R-11 — expédition acceptée après l’ouverture d’une nouvelle souscription : ne pollue pas la nouvelle période', async () => {
    const c = await duoActif();
    const { POST } = await import('@/app/api/duo/invitation/route');
    etat.send = async (p) => {
      if (!p.variables?.inviteUrl) return { success: true };
      // Pendant l'expédition : sortie de l'offre puis nouvelle souscription Duo.
      await sql`UPDATE duo_accounts SET subscription_status = 'CANCELED' WHERE id = ${c.duoId}`;
      await sql`UPDATE duo_accounts SET subscription_status = 'ACTIVE', duo_subscription_started_at = now() WHERE id = ${c.duoId}`;
      return { success: true };
    };
    await POST(req('POST', { email: `old-r11-${c.id}@test.invalid` }));
    etat.send = null;
    const d = await duoRow(c.duoId);
    expect(d.started).not.toBeNull();
    expect(d.first).toBeNull();
  });

  it('DUO-R-12 — reprise 0438 : attribution et traces historiques corrigées sur preuve, traces valides conservées, rejouable', async () => {
    const m0385 = readFileSync(join(process.cwd(), 'src/db/migrations/0385_duo_subscription_started_at.sql'), 'utf8');
    const m0438 = readFileSync(join(process.cwd(), 'src/db/migrations/0438_duo_invite_period_fix.sql'), 'utf8');
    async function existant(statut = 'ACTIVE', debutJours: number | null = 5) {
      const acc = await make.account({ plan: 'premium_duo' });
      await sql`UPDATE accounts SET plan_type = 'PREMIUM_DUO', subscription_status = 'ACTIVE' WHERE id = ${acc.id}`;
      const [{ id }] = await sql<{ id: number }[]>`INSERT INTO duo_accounts (billing_owner_user_id, subscription_status) VALUES (${acc.ownerUserId}, ${statut}) RETURNING id`;
      await sql`UPDATE accounts SET duo_account_id = ${id} WHERE id = ${acc.id}`;
      const debut = debutJours === null ? null : new Date(Date.now() - debutJours * 86_400_000).toISOString();
      await sql`UPDATE duo_accounts SET duo_subscription_started_at = ${debut}::timestamptz WHERE id = ${id}`;
      const [{ email }] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${acc.ownerUserId}`;
      return { ...acc, duoId: id, email };
    }
    const log = async (o: { to: string; recipient: number | null; triggeredBy?: number | null; status?: string; joursAvant: number; jobId?: number | null }) => {
      const [{ id }] = await sql<{ id: number }[]>`
        INSERT INTO email_logs (template_code, recipient_email, recipient_user_id, triggered_by_user_id, email_job_id, subject, status, sent_at)
        VALUES ('DUO_INVITATION', ${o.to}, ${o.recipient}, ${o.triggeredBy ?? null}, ${o.jobId ?? null}, 'Invitation', ${o.status ?? 'sent'},
                ${new Date(Date.now() - o.joursAvant * 86_400_000).toISOString()}::timestamptz) RETURNING id`;
      return id;
    };
    // a) Historique (avant lot 57) : invitation envoyée puis ANNULÉE, journalisée au nom du titulaire.
    const a = await existant();
    const invite = await make.user({ email: `${uid('inv')}@proton.me` });
    const [{ email: inviteEmail }] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${invite.id}`;
    const logA = await log({ to: inviteEmail, recipient: a.ownerUserId, joursAvant: 2 });
    // b) Le titulaire B a été INVITÉ par le Duo de X (format lot 57) ; 0385 l'a pris pour un envoi de B.
    const b = await existant();
    const x = await existant();
    const logB = await log({ to: b.email, recipient: b.ownerUserId, triggeredBy: x.ownerUserId, joursAvant: 1 });
    // c) Envoi historique ÉCHOUÉ.
    const cc = await existant();
    const logC = await log({ to: `echec-${cc.id}@test.invalid`, recipient: cc.ownerUserId, status: 'failed', joursAvant: 1 });
    // d) Trace d'une souscription précédente.
    const dd = await existant();
    // e) Preuve valide (demande durable acceptée), invitation annulée depuis : trace reconstituée.
    const ee = await existant();
    const [{ id: jobE }] = await sql<{ id: number }[]>`
      INSERT INTO transactional_email_jobs (kind, duo_id, triggered_by_user_id, recipient_email, status, attempts, accepted_at)
      VALUES ('DUO_INVITATION', ${ee.duoId}, ${ee.ownerUserId}, 'e@test.invalid', 'accepted', 1, now() - interval '1 day') RETURNING id`;
    await log({ to: 'e@test.invalid', recipient: null, triggeredBy: ee.ownerUserId, joursAvant: 1, jobId: jobE });
    // f) Duo sorti de l'offre : date de sortie reprise.
    const ff = await existant('CANCELED', null);

    // 0385 déjà exécutée (comportement d'origine), puis 0438.
    await sql.begin((tx) => tx.unsafe(m0385));
    await sql`UPDATE duo_accounts SET duo_first_invite_sent_at = (SELECT sent_at FROM email_logs WHERE id = ${logB}) WHERE id = ${b.duoId}`;
    await sql`UPDATE duo_accounts SET duo_first_invite_sent_at = now() - interval '30 days' WHERE id = ${dd.duoId}`;
    expect((await duoRow(cc.duoId)).first).not.toBeNull(); // 0385 : envoi échoué pris pour un envoi
    await sql.begin((tx) => tx.unsafe(m0438));
    const apres = async () => ({
      a: await duoRow(a.duoId), b: await duoRow(b.duoId), c: await duoRow(cc.duoId), d: await duoRow(dd.duoId), e: await duoRow(ee.duoId), f: await duoRow(ff.duoId),
      logA: (await sql`SELECT recipient_user_id, triggered_by_user_id FROM email_logs WHERE id = ${logA}`)[0],
      logB: (await sql`SELECT recipient_user_id, triggered_by_user_id FROM email_logs WHERE id = ${logB}`)[0],
      logC: (await sql`SELECT recipient_user_id, triggered_by_user_id FROM email_logs WHERE id = ${logC}`)[0],
    });
    const r1 = await apres();
    // Attribution : destinataire = invité, émetteur = titulaire.
    expect(r1.logA).toEqual({ recipient_user_id: invite.id, triggered_by_user_id: a.ownerUserId });
    expect(r1.logB).toEqual({ recipient_user_id: b.ownerUserId, triggered_by_user_id: x.ownerUserId }); // format récent : intact
    expect(r1.logC).toEqual({ recipient_user_id: null, triggered_by_user_id: cc.ownerUserId });
    // a) envoyée puis annulée : trace, aucune réapparition.
    expect(r1.a.first).not.toBeNull();
    expect(await lire(a.id)).toBeNull();
    // b) e-mail REÇU par B : pas une invitation de B → trace corrigée, suggestion due.
    expect(r1.b.first).toBeNull();
    expect(await lire(b.id)).not.toBeNull();
    // c) envoi échoué : pas une expédition acceptée.
    expect(r1.c.first).toBeNull();
    // d) souscription précédente : ne pollue pas la période en cours.
    expect(r1.d.first).toBeNull();
    // e) trace valide conservée.
    expect(r1.e.first).not.toBeNull();
    expect(await lire(ee.id)).toBeNull();
    // f) Duo hors offre : date de sortie reprise (borne des dates Stripe futures).
    expect(r1.f.ended).not.toBeNull();
    // Rejouable sans effet.
    await sql.begin((tx) => tx.unsafe(m0438));
    expect(await apres()).toEqual(r1);
  });
});
