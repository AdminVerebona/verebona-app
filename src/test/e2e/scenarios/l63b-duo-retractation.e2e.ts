/**
 * Lot 63B — Premium Duo : la rétractation (14 jours) FERME le Duo (décision
 * PO du 16/10), sur PostgreSQL réel (déclencheur 0438), Stripe simulé.
 *
 * L63-DUO-01  Rétractation confirmée (coupure locale `enterRecoveryMode`) :
 *             Duo CANCELED, date de sortie posée, invitation annulée, second
 *             utilisateur retiré (REMOVED, offre ramenée à la sienne), compte
 *             WITHDRAWN.
 * L63-DUO-02  Idempotence : rejouée, rien ne bouge (date de sortie conservée).
 * L63-DUO-03  Webhook / resynchronisation d'un abonnement rétracté encore
 *             « actif » chez Stripe (annulation pas encore aboutie, événement
 *             ancien ou rejoué) : Duo jamais réactivé ; Duo encore ouvert
 *             (chemin local non passé) → fermé par la synchronisation.
 * L63-DUO-04  BO (`applyPlanChange`, compte WITHDRAWN) : Duo CANCELED et
 *             partage terminé.
 * L63-DUO-05  Suppression du compte (reprise, coupure locale non passée) : le
 *             Duo est fermé et le membre sorti AVANT la cascade — le membre
 *             garde son compte et retrouve sa propre offre.
 * L63-DUO-06  Impayé Duo (UNPAID_RECOVERY) puis rétractation : fermé quand
 *             même, membre retiré (pas de mode récupération sur un Duo fermé).
 */
import type Stripe from 'stripe';
import { beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const DUO_M = 'price_e2e_duo_l63_monthly';
const NOW = Math.floor(Date.now() / 1000);
const JOUR = 86400;

function sub(o: { id: string; customer: string; status: Stripe.Subscription.Status; accountId: number; duoId: number; startDate?: number }): Stripe.Subscription {
  return {
    id: o.id, object: 'subscription', customer: o.customer, status: o.status, cancel_at_period_end: false,
    start_date: o.startDate ?? NOW - JOUR,
    metadata: { accountId: String(o.accountId), duoId: String(o.duoId) },
    discounts: [], schedule: null,
    items: { data: [{
      id: `si_${o.id}`, quantity: 1,
      price: { id: DUO_M, unit_amount: 1990, currency: 'eur', product: 'prod_e2e_l63', tax_behavior: 'unspecified', recurring: { interval: 'month', interval_count: 1 } },
      current_period_start: NOW - JOUR, current_period_end: NOW + 29 * JOUR,
    }] },
  } as unknown as Stripe.Subscription;
}

scenario('L63B-DUO', 'Duo : la rétractation ferme le Duo (sortie d’offre, membre, idempotence, webhooks, BO)', ({ sql, make }) => {
  beforeAll(async () => {
    const { getStripeCatalogContext } = await import('@/lib/stripe-client');
    const ctx = getStripeCatalogContext().catalogContext;
    const { pgCatalogStore } = await import('@/services/billing/catalog-store');
    const { versionRowFrom } = await import('@/services/billing/price-history.service');
    await pgCatalogStore.upsertPriceVersion(versionRowFrom(
      { id: DUO_M, livemode: false, product: 'prod_e2e_l63', lookup_key: null, unit_amount: 1990, currency: 'eur', tax_behavior: 'unspecified', active: true, recurring: { interval: 'month', interval_count: 1 } } as unknown as Stripe.Price,
      'premium_duo', 'monthly', { catalogContext: ctx }, 'e2e',
    ));
  });

  /** Titulaire Premium Duo actif + second utilisateur (avec son propre compte Standard) + invitation en attente. */
  async function duoAvecMembre(duoStatus: 'ACTIVE' | 'UNPAID_RECOVERY' = 'ACTIVE') {
    const acc = await make.account({ plan: 'premium_duo' });
    const customer = `cus_${uid('l63')}`;
    const subId = `sub_${uid('l63')}`;
    await sql`UPDATE accounts SET plan_type = 'PREMIUM_DUO', subscription_status = 'ACTIVE', stripe_customer_id = ${customer},
                     stripe_subscription_id = ${subId}, max_members = 2 WHERE id = ${acc.id}`;
    await sql`UPDATE account_subscriptions SET stripe_customer_id = ${customer}, stripe_subscription_id = ${subId}, billing_period = 'monthly'
               WHERE account_id = ${acc.id}`;
    await sql`UPDATE users SET plan_type = 'PREMIUM_DUO' WHERE id = ${acc.ownerUserId}`;
    const [{ id: duoId }] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, stripe_customer_id, stripe_subscription_id,
                                duo_subscription_started_at, pending_invite_email, pending_invite_token,
                                pending_invite_token_expires_at, pending_invite_sent_at, activated_at)
      VALUES (${acc.ownerUserId}, ${duoStatus}, ${customer}, ${subId}, now() - interval '2 days',
              ${`invite-${uid('l63')}@test.invalid`}, ${uid('tok')}, now() + interval '7 days', now(), now())
      RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duoId} WHERE id = ${acc.id}`;
    const membre = await make.user({ planType: 'PREMIUM_DUO' });
    const compteMembre = await make.account({ owner: membre, plan: 'standard' });
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at)
              VALUES (${duoId}, ${acc.ownerUserId}, 'ACTIVE', 0, now()), (${duoId}, ${membre.id}, 'ACTIVE', 1, now())`;
    return { ...acc, customer, subId, duoId, membre, compteMembre };
  }

  const duoRow = async (id: number) => {
    const [r] = await sql<{ status: string; ended: Date | null; started: Date | null; invite: string | null; token: string | null; activated: Date | null }[]>`
      SELECT subscription_status AS status, duo_subscription_ended_at AS ended, duo_subscription_started_at AS started,
             pending_invite_email AS invite, pending_invite_token AS token, activated_at AS activated
        FROM duo_accounts WHERE id = ${id}`;
    return r;
  };
  const membership = async (duoId: number, userId: number) =>
    (await sql<{ status: string; left_at: Date | null }[]>`SELECT status, left_at FROM duo_memberships WHERE duo_id = ${duoId} AND user_id = ${userId}`)[0];
  const planOf = async (userId: number) => (await sql<{ plan_type: string }[]>`SELECT plan_type FROM users WHERE id = ${userId}`)[0]?.plan_type;
  const accountStatus = async (id: number) => (await sql<{ s: string }[]>`SELECT subscription_status AS s FROM accounts WHERE id = ${id}`)[0]?.s;
  const demande = async (c: { id: number; ownerUserId: number; subId: string }) => {
    const ref = `RET-L63-${uid('d')}`;
    await sql`INSERT INTO withdrawal_requests (public_reference, account_id, user_id, stripe_subscription_id, status, cancellation_status)
              VALUES (${ref}, ${c.id}, ${c.ownerUserId}, ${c.subId}, 'received', 'pending')`;
    return ref;
  };
  const sync = async (s: Stripe.Subscription) => {
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    return syncSubscriptionFromStripe({ subscription: s, source: 'e2e', notify: false });
  };

  it('L63-DUO-01 — rétractation confirmée : Duo fermé (CANCELED + date de sortie), invitation annulée, membre retiré', async () => {
    const c = await duoAvecMembre();
    expect((await duoRow(c.duoId)).ended).toBeNull();
    const { enterRecoveryMode } = await import('@/services/withdrawal/withdrawal-processor.service');
    expect(await enterRecoveryMode(c.id)).toBe(true);

    const d = await duoRow(c.duoId);
    expect(d.status).toBe('CANCELED');
    expect(d.ended).not.toBeNull();
    expect(Math.abs(new Date(d.ended!).getTime() - Date.now())).toBeLessThan(60_000);
    expect(d).toMatchObject({ invite: null, token: null, activated: null });
    expect(await accountStatus(c.id)).toBe('WITHDRAWN');
    // Membre : sortie de Duo existante — REMOVED, offre ramenée à la sienne (Standard).
    expect((await membership(c.duoId, c.membre.id)).status).toBe('REMOVED');
    expect((await membership(c.duoId, c.membre.id)).left_at).not.toBeNull();
    expect(await planOf(c.membre.id)).toBe('STANDARD');
    // Son compte et ses données ne sont pas touchés.
    expect(await sql`SELECT 1 FROM accounts WHERE id = ${c.compteMembre.id}`).toHaveLength(1);
    // Adhésion refusée sur un Duo fermé (règle existante).
    const { isDuoJoinable } = await import('@/lib/billing/subscription-status');
    expect(isDuoJoinable(d.status)).toBe(false);
  });

  it('L63-DUO-02 — idempotente : rejouée, date de sortie et membre inchangés', async () => {
    const c = await duoAvecMembre();
    const { enterRecoveryMode } = await import('@/services/withdrawal/withdrawal-processor.service');
    await enterRecoveryMode(c.id);
    const d1 = await duoRow(c.duoId);
    const m1 = await membership(c.duoId, c.membre.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(await enterRecoveryMode(c.id)).toBe(false);
    const { closeDuoForWithdrawal } = await import('@/services/duo/duo-withdrawal.service');
    expect(await closeDuoForWithdrawal(c.id)).toEqual({ duoId: c.duoId, closed: false, removedMembers: 0 });
    const d2 = await duoRow(c.duoId);
    expect(d2.status).toBe('CANCELED');
    expect(new Date(d2.ended!).getTime()).toBe(new Date(d1.ended!).getTime());
    expect(new Date((await membership(c.duoId, c.membre.id)).left_at!).getTime()).toBe(new Date(m1.left_at!).getTime());
  });

  it('L63-DUO-03 — webhook d’un abonnement rétracté encore « actif » : jamais de réactivation ; Duo encore ouvert → fermé', async () => {
    // a) Chemin local passé, puis webhook ancien / rejoué « active ».
    const a = await duoAvecMembre();
    await demande(a);
    const { enterRecoveryMode } = await import('@/services/withdrawal/withdrawal-processor.service');
    await enterRecoveryMode(a.id);
    const ended = (await duoRow(a.duoId)).ended;
    const r = await sync(sub({ id: a.subId, customer: a.customer, status: 'active', accountId: a.id, duoId: a.duoId }));
    expect(r).toMatchObject({ newStatus: 'WITHDRAWN' });
    const d = await duoRow(a.duoId);
    expect(d.status).toBe('CANCELED');
    expect(new Date(d.ended!).getTime()).toBe(new Date(ended!).getTime());
    expect(await accountStatus(a.id)).toBe('WITHDRAWN');
    // Abonnement annulé ensuite (customer.subscription.deleted → synchronisation) : toujours fermé.
    await sync(sub({ id: a.subId, customer: a.customer, status: 'canceled', accountId: a.id, duoId: a.duoId }));
    expect((await duoRow(a.duoId)).status).toBe('CANCELED');

    // b) Demande enregistrée mais coupure locale pas encore passée (Duo ACTIVE) : la synchronisation ferme le Duo.
    const b = await duoAvecMembre();
    await demande(b);
    await sync(sub({ id: b.subId, customer: b.customer, status: 'active', accountId: b.id, duoId: b.duoId }));
    const db2 = await duoRow(b.duoId);
    expect(db2.status).toBe('CANCELED');
    expect(db2.ended).not.toBeNull();
    expect(db2.invite).toBeNull();
    expect((await membership(b.duoId, b.membre.id)).status).toBe('REMOVED');
    expect(await planOf(b.membre.id)).toBe('STANDARD');

    // c) Témoin : un abonnement Duo NON rétracté reste ACTIVE (aucune régression).
    const t = await duoAvecMembre();
    await sync(sub({ id: t.subId, customer: t.customer, status: 'active', accountId: t.id, duoId: t.duoId }));
    expect((await duoRow(t.duoId)).status).toBe('ACTIVE');
    expect((await membership(t.duoId, t.membre.id)).status).toBe('ACTIVE');
  });

  it('L63-DUO-04 — BO : changement d’offre appliqué à un compte rétracté → Duo fermé, partage terminé', async () => {
    const c = await duoAvecMembre();
    await sql`UPDATE accounts SET subscription_status = 'WITHDRAWN' WHERE id = ${c.id}`;
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    await applyPlanChange({
      accountId: c.id, ownerUserId: c.ownerUserId, oldPlanType: 'PREMIUM_DUO', newPlanType: 'PREMIUM_DUO', newSubStatus: 'WITHDRAWN',
      newPremiumUntil: null, newMaxMembers: 2, source: 'admin:e2e', sendEmails: false,
    });
    const d = await duoRow(c.duoId);
    expect(d.status).toBe('CANCELED');
    expect(d.ended).not.toBeNull();
    expect((await membership(c.duoId, c.membre.id)).status).toBe('REMOVED');
    expect(await planOf(c.membre.id)).toBe('STANDARD');
  });

  it('L63-DUO-05 — suppression du compte (reprise) : Duo fermé et membre sorti avant la cascade ; le membre garde son compte', async () => {
    const c = await duoAvecMembre();
    const ref = await demande(c);
    const { deleteAccountNow } = await import('@/services/withdrawal/withdrawal-processor.service');
    expect(await deleteAccountNow({ accountId: c.id, userId: c.ownerUserId }, ref)).toBe('deleted');
    expect(await sql`SELECT 1 FROM accounts WHERE id = ${c.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM duo_accounts WHERE id = ${c.duoId}`).toHaveLength(0);
    // Le membre n'est pas supprimé ; son offre affichée est la sienne, plus « Premium Duo ».
    expect(await sql`SELECT 1 FROM users WHERE id = ${c.membre.id}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM accounts WHERE id = ${c.compteMembre.id}`).toHaveLength(1);
    expect(await planOf(c.membre.id)).toBe('STANDARD');
  });

  it('L63-DUO-06 — Duo en impayé (UNPAID_RECOVERY) rétracté : fermé, membre retiré', async () => {
    const c = await duoAvecMembre('UNPAID_RECOVERY');
    const { closeDuoForWithdrawal } = await import('@/services/duo/duo-withdrawal.service');
    expect(await closeDuoForWithdrawal(c.id)).toEqual({ duoId: c.duoId, closed: true, removedMembers: 1 });
    const d = await duoRow(c.duoId);
    expect(d.status).toBe('CANCELED');
    expect(d.ended).not.toBeNull();
    expect((await membership(c.duoId, c.membre.id)).status).toBe('REMOVED');
  });
});
