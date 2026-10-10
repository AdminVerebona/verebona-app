/**
 * APP-FUNC-31 (impayé sans période de grâce) et APP-PERF-18 (paiement en
 * attente hors du chemin de lecture) — base PostgreSQL réelle.
 *
 * Stripe n'est jamais appelé : les abonnements sont des objets synthétiques
 * passés aux services (prix reconnus par la DOUBLE LECTURE DE TRANSITION des
 * variables STRIPE_PRICE_* posées ici — CDC lookup_key V4, legacy-price-env),
 * et les lectures Stripe des services sont injectées.
 *
 * RECETTE FUNC-31 couverte : abonnement actif ; premier échec ; événement
 * rejoué ; impayé pendant le délai ; consultation / export (lecture) ;
 * ajout de bien, de document, modification, Premium refusés côté serveur ;
 * reconnexion et renouvellement de session pendant l'impayé ; régularisation
 * et rétablissement des droits ; fin du délai (balayage, pas la session) ;
 * Standard, Premium, Premium Duo titulaire et membre ; sortie Duo pendant
 * l'impayé ; rétractation ; résiliation ; événements désordonnés.
 * (Migration d'un compte historique PAST_DUE_GRACE : `mig-0250-impaye-sans-grace.e2e.ts`.)
 *
 * RECETTE PERF-18 : T-01 paiement en attente sans faux droits ; T-02 paiement
 * effectué, webhook absent, retour interrompu → rattrapage appliqué une
 * seule fois ; T-03 demandes concurrentes → une seule vérification Stripe.
 */
import type Stripe from 'stripe';
import { beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';
import type { PlanCode } from '@/lib/stripe-prices';
import { LEGACY_PRICE_VARS } from '@/services/billing/legacy-price-env';

/** Montants d'ancienne grille, propres au scénario (aucune grille de vente lue). */
const MONTHLY_CENTS: Record<PlanCode, number> = { standard: 290, premium: 590, premium_duo: 890 };

const DAY = 24 * 60 * 60 * 1000;
/** Horodatage d'une valeur rendue par le pilote (Date ou texte selon le type). */
const ms = (v: unknown) => new Date(v as string | Date).getTime();

beforeAll(() => {
  for (const v of LEGACY_PRICE_VARS) {
    if (v.billingPeriod) process.env[v.name] = `price_e2e_${v.planCode}_${v.billingPeriod}`;
  }
});

function fakeSub(o: {
  id: string; customer: string; status: Stripe.Subscription.Status; plan: PlanCode;
  accountId: number; duoId?: number;
}): Stripe.Subscription {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: o.id,
    object: 'subscription',
    customer: o.customer,
    status: o.status,
    cancel_at_period_end: false,
    start_date: now - 10 * 86400,
    metadata: { accountId: String(o.accountId), ...(o.duoId ? { duoId: String(o.duoId) } : {}) },
    discounts: [],
    items: {
      data: [{
        price: {
          id: `price_e2e_${o.plan}_monthly`,
          unit_amount: MONTHLY_CENTS[o.plan],
          recurring: { interval: 'month' },
        },
        current_period_start: now - 10 * 86400,
        current_period_end: now + 20 * 86400,
      }],
    },
  } as unknown as Stripe.Subscription;
}

scenario('FUNC31-PERF18', 'Impayé sans grâce et paiement en attente', ({ sql, make }) => {
  async function compte(plan?: 'standard' | 'premium' | 'premium_duo') {
    const acc = await make.account({ plan });
    const customer = `cus_${uid('e2e')}`;
    const subId = `sub_${uid('e2e')}`;
    await sql`UPDATE accounts SET stripe_customer_id = ${customer}, stripe_subscription_id = ${plan ? subId : null},
                subscription_status = ${plan ? 'ACTIVE' : 'TRIALING'}, plan_type = ${plan ? plan.toUpperCase() : 'STANDARD'}
              WHERE id = ${acc.id}`;
    if (plan) await sql`UPDATE account_subscriptions SET stripe_subscription_id = ${subId}, stripe_customer_id = ${customer} WHERE account_id = ${acc.id}`;
    return { ...acc, customer, subId };
  }
  const etat = async (id: number) => (await sql`
    SELECT a.subscription_status, a.unpaid_started_at, a.unpaid_recovery_ends_at, s.status AS sub_status
      FROM accounts a LEFT JOIN account_subscriptions s ON s.account_id = a.id WHERE a.id = ${id}`)[0];

  it('Premium : actif → 1er échec (restreint immédiatement) → rejeu → reconnexion → régularisation', async () => {
    const { getEntitlements, canCreateAsset, canAddDocument, canModifyAssets, canUsePremiumFeature } = await import('@/services/entitlements.service');
    const { startUnpaidCycle } = await import('@/services/billing/unpaid-cycle.service');
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    const { refuserSiLectureSeule, refuserSiPasDIA } = await import('@/lib/write-access-guard');
    const { issueSessionTokens } = await import('@/lib/auth/session-tokens');
    const { verifyToken } = await import('@/lib/jwt');

    const c = await compte('premium');
    // Abonnement actif.
    expect(await getEntitlements(c.id)).toMatchObject({ plan: 'premium', canWrite: true, premiumFeatures: true });

    // ── CA-01 : premier échec → canWrite = false immédiatement ──
    const j0 = new Date();
    const cycle = await startUnpaidCycle(c.id, j0);
    expect(cycle).not.toBeNull();
    // J+90 (à l'heure près : passage à l'heure d'hiver dans l'intervalle).
    expect(Math.abs(cycle!.deadlineAt.getTime() - cycle!.startedAt.getTime() - 90 * DAY)).toBeLessThanOrEqual(3_600_000);
    const ent = await getEntitlements(c.id);
    expect(ent).toMatchObject({ canWrite: false, canRead: true, isRestricted: true, premiumFeatures: false, status: 'past_due' });
    expect(await etat(c.id)).toMatchObject({ subscription_status: 'PAST_DUE', sub_status: 'past_due' });

    // ── CA-06 : créations / modifications / Premium refusées côté serveur ──
    for (const d of [await canCreateAsset(c.id, 0), await canAddDocument(c.id, 0), await canModifyAssets(c.id, 1), await canUsePremiumFeature(c.id)]) {
      expect(d).toMatchObject({ allowed: false, reason: 'SUBSCRIPTION_REQUIRED' });
      expect(d.message).toMatch(/paiement a échoué/);
      expect(d.message).not.toMatch(/gr[âa]ce/i);
    }
    const refus = await refuserSiLectureSeule(c.id);
    expect(refus?.status).toBe(403);
    expect((await refus!.json()).code).toBe('SUBSCRIPTION_REQUIRED');
    expect((await refuserSiPasDIA(c.id))?.status).toBe(403);

    // ── Second événement identique : J0 et échéance inchangés ──
    const rejeu = await startUnpaidCycle(c.id, new Date(j0.getTime() + 3 * DAY));
    expect(rejeu!.startedAt.getTime()).toBe(cycle!.startedAt.getTime());
    expect(rejeu!.deadlineAt.getTime()).toBe(cycle!.deadlineAt.getTime());
    const viaSync = await syncSubscriptionFromStripe({ subscription: fakeSub({ id: c.subId, customer: c.customer, status: 'past_due', plan: 'premium', accountId: c.id }), source: 'e2e', notify: false });
    expect(viaSync?.newStatus).toBe('PAST_DUE');
    expect(ms((await etat(c.id)).unpaid_started_at)).toBe(cycle!.startedAt.getTime());
    expect((await getEntitlements(c.id)).canWrite).toBe(false);

    // ── CA-03 / CA-12 : reconnexion et renouvellement pendant l'impayé ──
    const tokens = await issueSessionTokens({ id: c.ownerUserId, email: c.owner.email, role: 'USER', planType: 'PREMIUM', status: 'ACTIVE' });
    const payload = await verifyToken(tokens.accessToken);
    expect(payload).toMatchObject({ userId: c.ownerUserId, currentAccountId: c.id });
    expect((payload as { hasActiveAccount?: boolean }).hasActiveAccount).toBe(false);

    // ── CA-07 : régularisation → droits de l'offre, cycle refermé ──
    await syncSubscriptionFromStripe({ subscription: fakeSub({ id: c.subId, customer: c.customer, status: 'active', plan: 'premium', accountId: c.id }), source: 'e2e', notify: false });
    expect(await getEntitlements(c.id)).toMatchObject({ plan: 'premium', canWrite: true, premiumFeatures: true });
    expect(await etat(c.id)).toMatchObject({ subscription_status: 'ACTIVE', sub_status: 'active', unpaid_started_at: null, unpaid_recovery_ends_at: null });
  });

  it('Standard : même restriction immédiate', async () => {
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { startUnpaidCycle } = await import('@/services/billing/unpaid-cycle.service');
    const c = await compte('standard');
    await startUnpaidCycle(c.id);
    expect(await getEntitlements(c.id)).toMatchObject({ canWrite: false, canRead: true, isRestricted: true });
  });

  it('CA-17 : événements désordonnés / périmés — aucune réouverture ni restriction indue', async () => {
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { syncSubscriptionFromEvent } = await import('@/services/billing/subscription-sync.service');
    const { isPaymentFailureCurrent, startUnpaidCycle } = await import('@/services/billing/unpaid-cycle.service');
    const c = await compte('premium');
    await startUnpaidCycle(c.id);

    // Un `updated` ANCIEN (instantané « active ») arrive après le past_due :
    // l'état courant relu chez Stripe (past_due) fait foi.
    const courant = fakeSub({ id: c.subId, customer: c.customer, status: 'past_due', plan: 'premium', accountId: c.id });
    await syncSubscriptionFromEvent(
      fakeSub({ id: c.subId, customer: c.customer, status: 'active', plan: 'premium', accountId: c.id }),
      { source: 'e2e', notify: false },
      async () => courant,
    );
    expect((await getEntitlements(c.id)).canWrite).toBe(false);

    // Échec reçu en retard alors que l'abonnement est à jour : ignoré.
    const stripe = (status: string) => ({ stripe: () => ({ subscriptions: { retrieve: async () => ({ status }) } }) as never });
    expect(await isPaymentFailureCurrent(c.subId, stripe('active'))).toBe(false);
    expect(await isPaymentFailureCurrent(c.subId, stripe('past_due'))).toBe(true);
    // Stripe injoignable : l'échec confirmé par l'événement est retenu.
    expect(await isPaymentFailureCurrent(c.subId, { stripe: () => ({ subscriptions: { retrieve: async () => { throw new Error('ECONNRESET'); } } }) as never })).toBe(true);
  });

  it('CA-08 : fin du délai → balayage du cycle (workflow de suppression), pas la session', async () => {
    const { runUnpaidCycleSweep, startUnpaidCycle } = await import('@/services/billing/unpaid-cycle.service');
    const c = await compte('premium');
    const reg = await compte('premium');
    const cycle = await startUnpaidCycle(c.id, new Date(Date.now() - 91 * DAY));
    await startUnpaidCycle(reg.id, new Date(Date.now() - 91 * DAY));
    expect(cycle!.deadlineAt.getTime()).toBeLessThan(Date.now());

    const stripeDeps = {
      stripe: () => ({
        subscriptions: {
          list: async ({ customer }: { customer: string }) => ({
            data: customer === reg.customer
              ? [fakeSub({ id: reg.subId, customer: reg.customer, status: 'active', plan: 'premium', accountId: reg.id })]
              : [{ id: c.subId, status: 'past_due' }],
          }),
        },
      }) as never,
    };
    const r = await runUnpaidCycleSweep({ dryRun: true }, stripeDeps);
    // Sans régularisation : la suppression serait engagée (simulation : rien n'est écrit).
    expect(r.deferred).toContainEqual({ accountId: c.id, reason: 'DRY_RUN' });
    expect(r.failed.find((f) => f.accountId === c.id)).toBeUndefined();
    // Toujours accessible, toujours restreint, jamais « EXPIRED » par une lecture.
    expect((await etat(c.id)).subscription_status).toBe('PAST_DUE');
  });

  it('Rétractation et résiliation : aucun droit rendu, statut propre conservé', async () => {
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { startUnpaidCycle } = await import('@/services/billing/unpaid-cycle.service');
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');

    const w = await compte('premium');
    await sql`UPDATE accounts SET subscription_status = 'WITHDRAWN' WHERE id = ${w.id}`;
    await sql`UPDATE account_subscriptions SET status = 'readonly' WHERE account_id = ${w.id}`;
    await startUnpaidCycle(w.id);
    expect((await etat(w.id)).subscription_status).toBe('WITHDRAWN');
    expect((await getEntitlements(w.id)).canWrite).toBe(false);

    const r = await compte('premium');
    await syncSubscriptionFromStripe({ subscription: fakeSub({ id: r.subId, customer: r.customer, status: 'canceled', plan: 'premium', accountId: r.id }), source: 'e2e', notify: false });
    expect((await etat(r.id)).subscription_status).toBe('EXPIRED');
    expect(await getEntitlements(r.id)).toMatchObject({ canWrite: false, canRead: true, plan: 'none' });
  });

  it('CA-13 : Premium Duo titulaire et membre — restreints dès l’échec, récupération / sortie ouvertes', async () => {
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    const { removeDuoMember, leaveDuo, isDuoUnpaid } = await import('@/services/duo/duo-exit.service');
    const { isDuoJoinable } = await import('@/lib/billing/subscription-status');

    const c = await compte('premium_duo');
    const membre = await make.user();
    const [duo] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, stripe_subscription_id, stripe_customer_id, activated_at)
      VALUES (${c.ownerUserId}, 'ACTIVE', ${c.subId}, ${c.customer}, now()) RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duo.id}, max_members = 2 WHERE id = ${c.id}`;
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at) VALUES
              (${duo.id}, ${c.ownerUserId}, 'ACTIVE', 0, now()), (${duo.id}, ${membre.id}, 'ACTIVE', 1, now())`;
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${membre.id}, 'member', 'active')`;

    await syncSubscriptionFromStripe({ subscription: fakeSub({ id: c.subId, customer: c.customer, status: 'past_due', plan: 'premium_duo', accountId: c.id, duoId: duo.id }), source: 'e2e', notify: false });

    const [d] = await sql`SELECT subscription_status, unpaid_recovery_ends_at FROM duo_accounts WHERE id = ${duo.id}`;
    const a = await etat(c.id);
    expect(d.subscription_status).toBe('UNPAID_RECOVERY');
    expect(ms(d.unpaid_recovery_ends_at)).toBe(ms(a.unpaid_recovery_ends_at));
    // Titulaire comme membre travaillent sur le compte du titulaire : restreint.
    expect(await getEntitlements(c.id)).toMatchObject({ canWrite: false, canRead: true });
    expect(isDuoJoinable(d.subscription_status)).toBe(false);
    expect(isDuoUnpaid(d.subscription_status)).toBe(true);
    // Le titulaire ne peut pas évincer le membre pendant l'impayé (récupération) ;
    // le membre, lui, peut partir avec ses biens.
    expect(await removeDuoMember(c.ownerUserId)).toMatchObject({ ok: false, error: 'DUO_UNPAID' });
    expect(await leaveDuo(membre.id)).toMatchObject({ ok: true, status: 'LEFT' });

    // Régularisation : Duo de nouveau actif, délai effacé.
    await syncSubscriptionFromStripe({ subscription: fakeSub({ id: c.subId, customer: c.customer, status: 'active', plan: 'premium_duo', accountId: c.id, duoId: duo.id }), source: 'e2e', notify: false });
    const [d2] = await sql`SELECT subscription_status, unpaid_recovery_ends_at, first_payment_failed_at FROM duo_accounts WHERE id = ${duo.id}`;
    expect(d2).toMatchObject({ subscription_status: 'ACTIVE', unpaid_recovery_ends_at: null, first_payment_failed_at: null });
    expect((await getEntitlements(c.id)).canWrite).toBe(true);
  });

  it('CA-15 : la base refuse PAST_DUE_GRACE ; l’ancien code reste compatible (normalisation)', async () => {
    const c = await compte('premium');
    // Écriture « ancien code » : statut et colonnes de grâce.
    await sql`UPDATE accounts SET subscription_status = 'PAST_DUE_GRACE', past_due_grace_started_at = now(),
                past_due_grace_ends_at = now() + interval '90 days' WHERE id = ${c.id}`;
    const e = await etat(c.id);
    expect(e.subscription_status).toBe('PAST_DUE');
    expect(e.unpaid_started_at).not.toBeNull();
    // Le nouveau code écrit les nouvelles colonnes : l'ancien les relit (retour arrière).
    await sql`UPDATE accounts SET unpaid_started_at = NULL, unpaid_recovery_ends_at = NULL, subscription_status = 'ACTIVE' WHERE id = ${c.id}`;
    const [old] = await sql`SELECT past_due_grace_started_at FROM accounts WHERE id = ${c.id}`;
    expect(old.past_due_grace_started_at).toBeNull();
  });

  // ── APP-PERF-18 ────────────────────────────────────────────────────────────

  it('T-01 / T-03 : paiement en attente signalé sans droit ; demandes concurrentes → une seule vérification', async () => {
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { reconcilePendingCheckout } = await import('@/services/billing/pending-checkout.service');
    const c = await compte();
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at)
              VALUES (${c.id}, 'premium', 'trialing', now() - interval '1 day')
              ON CONFLICT (account_id) DO UPDATE SET status = 'trialing', trial_ends_at = now() - interval '1 day', first_billed_at = NULL`;
    await sql`UPDATE accounts SET checkout_session_id = ${`cs_${uid('e2e')}`}, checkout_session_created_at = now() WHERE id = ${c.id}`;

    let appels = 0;
    const lent = {
      syncFromCheckoutSession: async () => {
        appels += 1;
        await new Promise((r) => setTimeout(r, 200)); // Stripe lent
        return { status: 'ignored' as const, reason: 'NOT_COMPLETE' as const };
      },
    };
    const now = new Date();
    const issues = await Promise.all(Array.from({ length: 6 }, () => reconcilePendingCheckout(c.id, { now }, lent)));
    expect(appels).toBe(1);
    expect(issues.filter((o) => o === 'PENDING')).toHaveLength(1);
    expect(issues.filter((o) => o === 'NOT_DUE')).toHaveLength(5);
    // Recul : pas de nouvelle vérification avant l'échéance.
    expect(await reconcilePendingCheckout(c.id, { now: new Date(now.getTime() + 30_000) }, lent)).toBe('NOT_DUE');
    expect(appels).toBe(1);
    const [row] = await sql`SELECT checkout_check_attempts, checkout_next_check_at FROM accounts WHERE id = ${c.id}`;
    expect(row.checkout_check_attempts).toBe(1);
    expect(ms(row.checkout_next_check_at)).toBeGreaterThan(now.getTime());
    // Aucun faux droit pendant l'attente (essai échu → lecture seule).
    expect((await getEntitlements(c.id)).canWrite).toBe(false);
  });

  it('T-02 : payé, webhook absent, retour interrompu → rattrapage appliqué une seule fois', async () => {
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { reconcilePendingCheckouts, reconcilePendingCheckout } = await import('@/services/billing/pending-checkout.service');
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    const c = await compte();
    const subId = `sub_${uid('e2e')}`;
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at)
              VALUES (${c.id}, 'premium', 'trialing', now() - interval '1 day')
              ON CONFLICT (account_id) DO UPDATE SET status = 'trialing', trial_ends_at = now() - interval '1 day', first_billed_at = NULL`;
    await sql`UPDATE accounts SET checkout_session_id = ${`cs_${uid('e2e')}`}, checkout_session_created_at = now() - interval '10 minutes',
                checkout_next_check_at = now() - interval '1 second' WHERE id = ${c.id}`;

    let appels = 0;
    const paye = {
      syncFromCheckoutSession: async ({ accountId }: { accountId: number }) => {
        // Le balayage voit tous les paiements en attente de la base : seul
        // celui de ce compte est « payé » ici.
        if (accountId !== c.id) return { status: 'ignored' as const, reason: 'NOT_COMPLETE' as const };
        appels += 1;
        const result = await syncSubscriptionFromStripe({
          subscription: fakeSub({ id: subId, customer: c.customer, status: 'active', plan: 'premium', accountId: c.id }),
          source: 'checkout-return', accountIdHint: c.id, notify: false,
        });
        return { status: 'synced' as const, result: result! };
      },
    };
    const r = await reconcilePendingCheckouts({}, paye);
    expect(r.scanned).toBeGreaterThanOrEqual(1);
    expect(appels).toBe(1);
    expect(await getEntitlements(c.id)).toMatchObject({ plan: 'premium', canWrite: true });
    const [acc] = await sql`SELECT checkout_session_id, checkout_check_attempts, checkout_next_check_at FROM accounts WHERE id = ${c.id}`;
    expect(acc).toMatchObject({ checkout_session_id: null, checkout_check_attempts: 0, checkout_next_check_at: null });

    // Une seule fois : plus rien à vérifier, et le webhook arrivé ensuite ne
    // rejoue pas l'activation.
    expect(await reconcilePendingCheckout(c.id, {}, paye)).toBe('NOT_DUE');
    await syncSubscriptionFromStripe({ subscription: fakeSub({ id: subId, customer: c.customer, status: 'active', plan: 'premium', accountId: c.id }), source: 'webhook:e2e', notify: false });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM subscription_history WHERE account_id = ${c.id}`;
    expect(n).toBe(1);
    expect(appels).toBe(1);
  });

  it('Session Checkout expirée : suivi arrêté, aucun droit accordé', async () => {
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { reconcilePendingCheckout } = await import('@/services/billing/pending-checkout.service');
    const c = await compte();
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at)
              VALUES (${c.id}, 'premium', 'trialing', now() - interval '1 day')
              ON CONFLICT (account_id) DO UPDATE SET status = 'trialing', trial_ends_at = now() - interval '1 day', first_billed_at = NULL`;
    await sql`UPDATE accounts SET checkout_session_id = 'cs_expire', checkout_session_created_at = now() - interval '25 hours' WHERE id = ${c.id}`;
    const o = await reconcilePendingCheckout(c.id, {}, {
      syncFromCheckoutSession: async () => ({ status: 'ignored', reason: 'EXPIRED' }),
    });
    expect(o).toBe('EXPIRED');
    expect((await sql`SELECT checkout_session_id FROM accounts WHERE id = ${c.id}`)[0].checkout_session_id).toBeNull();
    expect((await getEntitlements(c.id)).canWrite).toBe(false);
  });
});
