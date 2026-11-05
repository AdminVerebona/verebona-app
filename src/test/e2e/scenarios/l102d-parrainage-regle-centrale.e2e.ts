/**
 * Lot 102D — parrainage : règle centrale unique, sur PostgreSQL réel.
 *
 *   AC-1  lien /r/<code> → `rt` signé ; inscription : attribution ET événement
 *         de parrainage créés à l'inscription (instant d'usage conservé)
 *   AC-2  inscription plus de 90 jours après l'usage du lien → refusée (motif)
 *   AC-3  auto-parrainage à l'inscription (même personne, e-mail normalisé)
 *   AC-4  premier paiement MENSUEL → rien ne qualifie ; passage à l'annuel
 *         payé → qualifie ; aucune notification à ce moment
 *   AC-5  traitement planifié : délai de rétractation en cours → attente
 *         (motif), sans appel Stripe ; après → 1 mois offert au parrain,
 *         notification APRÈS l'attribution ; rejeu idempotent
 *   AC-6  rétractation du filleul → parrainage annulé tout de suite
 *   AC-7  auto-parrainage au paiement (même carte) → annulé, motif
 *   AC-8  migration 0920 rejouable ; gabarit d'invitation complété sauf retouche BO
 */
import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { runMigrationSql } from '@/db/migration-index';

const APP = 'https://app.e2e.verebona.test';
const DAY = 24 * 60 * 60 * 1000;
const etat = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  return { emits: [] as Array<{ type: string; entityId?: unknown; dedupeKey?: string }> };
});

vi.mock('@/lib/notifications', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emit: async (e: { type: string; entityId?: unknown; dedupeKey?: string }) => { etat.emits.push(e); return { ok: true }; },
}));

function fakeStripe(o: { cardFingerprint?: string; referrerFingerprint?: string } = {}) {
  const calls = { retrieve: 0, update: [] as Array<Record<string, unknown>> };
  const charge = {
    id: 'ch_l102d', status: 'succeeded', paid: true, amount: 5900, amount_captured: 5900, amount_refunded: 0, currency: 'eur',
    created: 1_760_000_000, disputed: false, payment_intent: 'pi_l102d',
    payment_method_details: { card: { fingerprint: o.cardFingerprint ?? 'fp_filleul' } }, billing_details: { address: null },
  };
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        calls.retrieve++;
        if (id.startsWith('sub_parrain')) {
          return { id, status: 'active', metadata: {}, trial_end: null, items: { data: [{ current_period_end: Math.floor((Date.now() + 20 * DAY) / 1000), price: { recurring: { interval: 'month' } } }] } };
        }
        return { id, status: 'active', cancel_at_period_end: false, cancel_at: null, canceled_at: null, items: { data: [{ price: { recurring: { interval: 'year' } } }] } };
      },
      update: async (_id: string, p: Record<string, unknown>) => { calls.update.push(p); return {}; },
    },
    invoicePayments: { list: () => (async function* () { yield { id: 'inpay_l102d', payment: { type: 'payment_intent', payment_intent: { id: 'pi_l102d', latest_charge: charge } } }; })() },
    charges: { retrieve: async () => charge },
    paymentIntents: { retrieve: async () => ({ id: 'pi_l102d', latest_charge: charge }) },
    disputes: { list: async () => ({ data: [] }) },
    invoices: { list: async () => ({ data: [] }) },
    paymentMethods: { list: async () => ({ data: [{ card: { fingerprint: o.referrerFingerprint ?? 'fp_parrain' }, billing_details: { address: null } }] }) },
    customers: { retrieve: async () => ({ id: 'cus_parrain', address: null }) },
  };
  return { stripe: stripe as never, calls };
}

scenario('L102D-P', 'Parrainage : règle centrale (90 jours, annuel, rétractation, auto-parrainage)', ({ sql, make }) => {
  let n = 0;
  async function parrain(email?: string) {
    n++;
    const owner = await make.user(email ? { email } : {});
    const acc = await make.account({ owner, plan: 'premium' });
    await sql`UPDATE account_subscriptions SET stripe_subscription_id = ${`sub_parrain_${n}`}, stripe_customer_id = 'cus_parrain' WHERE account_id = ${acc.id}`;
    const code = `L102P${String(n).padStart(3, '0')}`;
    const [link] = await sql<{ id: number }[]>`
      INSERT INTO referral_links (account_id, code, created_by_user_id, is_active, created_at, updated_at)
      VALUES (${acc.id}, ${code}, ${acc.ownerUserId}, true, now(), now()) RETURNING id`;
    return { acc, code, linkId: link.id };
  }
  async function filleulInscrit(code: string, opts: { rt?: string | null; email?: string } = {}) {
    const owner = await make.user(opts.email ? { email: opts.email } : {});
    const acc = await make.account({ owner, plan: null });
    const { recordSignupReferral } = await import('@/services/referral-attribution.service');
    const r = await recordSignupReferral({ userId: acc.ownerUserId, accountId: acc.id, rawCode: code, referralTouch: opts.rt ?? null });
    return { acc, r };
  }
  async function premierPaiement(accountId: number, period: 'monthly' | 'yearly', invoice: string) {
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, billing_period, stripe_subscription_id, first_billed_at)
              VALUES (${accountId}, 'premium', 'active', ${period}, ${`sub_filleul_${accountId}`}, now())
              ON CONFLICT (account_id) DO UPDATE SET billing_period = EXCLUDED.billing_period, status = 'active',
                stripe_subscription_id = EXCLUDED.stripe_subscription_id, first_billed_at = COALESCE(account_subscriptions.first_billed_at, now())`;
    const { grantReferralRewardForFirstBilling } = await import('@/services/commercial-model.service');
    return grantReferralRewardForFirstBilling(accountId, invoice);
  }
  const evenement = async (referredAccountId: number) =>
    (await sql<Array<{ id: number; status: string; metadata_json: Record<string, unknown> | null; first_billed_at: Date | null; rewarded_at: Date | null }>>`
      SELECT id, status, metadata_json, first_billed_at, rewarded_at FROM referral_events WHERE referred_account_id = ${referredAccountId}`)[0];

  it('AC-1 — /r/<code> signe l’instant d’usage ; l’inscription crée l’attribution et l’événement', async () => {
    const { acc: p, code } = await parrain();
    const { GET } = await import('@/app/r/[code]/route');
    const res = await GET(new NextRequest(`${APP}/r/${code}`), { params: Promise.resolve({ code }) });
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/signup');
    expect(loc.searchParams.get('ref')).toBe(code);
    const rt = loc.searchParams.get('rt');
    expect(rt).toMatch(/^\d{9,11}\.[A-Za-z0-9_-]{22}$/);
    expect(res.headers.get('set-cookie')).toBeNull();

    const { acc, r } = await filleulInscrit(code, { rt });
    expect(r?.referrerAccountId).toBe(p.id);
    const [ctx] = await sql<Array<{ validation_status: string; code_source: string; code_used_at: Date; expires_at: Date }>>`
      SELECT validation_status, code_source, code_used_at, expires_at FROM signup_contexts WHERE account_id = ${acc.id}`;
    expect(ctx.validation_status).toBe('valid');
    expect(ctx.code_source).toBe('referral_link');
    expect(Math.round((new Date(ctx.expires_at).getTime() - new Date(ctx.code_used_at).getTime()) / DAY)).toBe(90);
    const ev = await evenement(acc.id);
    expect(ev.status).toBe('link_used');
    expect(ev.metadata_json?.attribution).toBe('signup');
  });

  it('AC-2 — inscription 91 jours après l’usage du lien : aucune attribution, motif conservé', async () => {
    const { code } = await parrain();
    const { createReferralTouch } = await import('@/services/referral/referral-touch');
    const ancien = createReferralTouch(code, new Date(Date.now() - 91 * DAY));
    const { acc, r } = await filleulInscrit(code, { rt: ancien });
    expect(r).toBeNull();
    const [ctx] = await sql<Array<{ validation_status: string; validation_message: string }>>`
      SELECT validation_status, validation_message FROM signup_contexts WHERE account_id = ${acc.id}`;
    expect(ctx).toEqual({ validation_status: 'rejected', validation_message: 'ATTRIBUTION_WINDOW_EXPIRED' });
    expect(await evenement(acc.id)).toBeUndefined();
    // Jeton signé pour un AUTRE code : le code vaut « saisi à l'inscription » → attribué.
    const { code: autre } = await parrain();
    const { r: r2 } = await filleulInscrit(autre, { rt: ancien });
    expect(r2).not.toBeNull();
  });

  it('AC-3 — auto-parrainage à l’inscription (même personne, adresse normalisée) : refusé', async () => {
    const { code } = await parrain('camille.l102d@gmail.com');
    const { acc, r } = await filleulInscrit(code, { email: 'Camille.L102D+bis@gmail.com' });
    expect(r).toBeNull();
    const [ctx] = await sql<Array<{ validation_message: string }>>`SELECT validation_message FROM signup_contexts WHERE account_id = ${acc.id}`;
    expect(ctx.validation_message).toBe('SELF_REFERRAL_SAME_PERSON');
    expect(await evenement(acc.id)).toBeUndefined();
  });

  it('AC-4 — premier paiement mensuel : ne qualifie pas ; passage à l’annuel payé : qualifie, sans notification', async () => {
    const { code } = await parrain();
    const { acc } = await filleulInscrit(code);
    etat.emits.length = 0;
    expect(await premierPaiement(acc.id, 'monthly', 'in_l102d_m1')).toBe(false);
    let ev = await evenement(acc.id);
    expect(ev.status).toBe('link_used');
    expect((ev.metadata_json?.rewardPending as { reason: string }).reason).toBe('NOT_YEARLY');
    expect(await premierPaiement(acc.id, 'yearly', 'in_l102d_y1')).toBe(true);
    ev = await evenement(acc.id);
    expect(ev.status).toBe('first_billed');
    expect(ev.first_billed_at).not.toBeNull();
    expect(etat.emits.filter((e) => e.type === 'REFERRAL_REWARD_GRANTED')).toEqual([]);
  });

  it('AC-5 — délai de rétractation en cours : attente sans Stripe ; ensuite 1 mois offert puis notification ; rejeu sans effet', async () => {
    const { acc: p, code } = await parrain();
    const { acc } = await filleulInscrit(code);
    expect(await premierPaiement(acc.id, 'yearly', 'in_l102d_y2')).toBe(true);
    const { runReferralRewards } = await import('@/services/referral/referral-rewards.job');

    // 15 jours après le paiement : délai légal clos au plus tôt au 14ᵉ jour + marge d'un jour.
    // Instants fixés côté test (et non `now()` de la base) : la présélection du job compare à `now − 14 j`,
    // une seconde de marge évite toute dépendance à l'horloge ou à la lenteur de l'exécuteur CI.
    const t0 = new Date();
    const paye = new Date(t0.getTime() - 14 * DAY - 1_000);
    await sql`UPDATE referral_events SET first_billed_at = ${paye.toISOString()}::timestamptz WHERE referred_account_id = ${acc.id}`;
    const f1 = fakeStripe();
    const r1 = await runReferralRewards(t0, { stripe: f1.stripe });
    let ev = await evenement(acc.id);
    expect(ev.rewarded_at).toBeNull();
    expect((ev.metadata_json?.rewardPending as { reason: string } | undefined)?.reason, JSON.stringify({ r1, ev })).toBe('WITHDRAWAL_PERIOD_RUNNING');

    await sql`UPDATE referral_events SET first_billed_at = now() - interval '40 days' WHERE referred_account_id = ${acc.id}`;
    etat.emits.length = 0;
    const f2 = fakeStripe();
    await runReferralRewards(new Date(), { stripe: f2.stripe });
    ev = await evenement(acc.id);
    expect(ev.status).toBe('reward_granted');
    expect(ev.rewarded_at).not.toBeNull();
    expect(f2.calls.update).toHaveLength(1);
    expect(Object.keys(f2.calls.update[0].metadata as object)).toContain(`vb_referral_reward_${ev.id}`);
    expect(etat.emits.filter((e) => e.type === 'REFERRAL_REWARD_GRANTED' && e.entityId === ev.id)).toHaveLength(1);
    const [sub] = await sql<Array<{ current_period_end_at: Date }>>`SELECT current_period_end_at FROM account_subscriptions WHERE account_id = ${p.id}`;
    expect(new Date(sub.current_period_end_at).getTime()).toBeGreaterThan(Date.now() + 40 * DAY);

    const f3 = fakeStripe();
    await runReferralRewards(new Date(), { stripe: f3.stripe });
    expect(f3.calls.update).toHaveLength(0);
  });

  it('AC-6 — rétractation du filleul : parrainage annulé tout de suite, motif conservé', async () => {
    const { code } = await parrain();
    const { acc } = await filleulInscrit(code);
    await premierPaiement(acc.id, 'yearly', 'in_l102d_y3');
    await sql`INSERT INTO withdrawal_requests (public_reference, account_id, user_id, stripe_subscription_id, status, cancellation_status)
              VALUES (${`RET-L102D-${acc.id}`}, ${acc.id}, ${acc.ownerUserId}, ${`sub_filleul_${acc.id}`}, 'received', 'pending')`;
    const { runReferralRewards } = await import('@/services/referral/referral-rewards.job');
    const r = await runReferralRewards(new Date(), { stripe: fakeStripe().stripe });
    expect(r.canceledByWithdrawal).toBeGreaterThanOrEqual(1);
    const ev = await evenement(acc.id);
    expect(ev.status).toBe('canceled');
    expect((ev.metadata_json?.rewardIneligibility as { reason: string }).reason).toBe('WITHDRAWAL_EXERCISED');
  });

  it('AC-7 — même carte que le parrain : annulé (auto-parrainage), aucun mois offert', async () => {
    const { code } = await parrain();
    const { acc } = await filleulInscrit(code);
    await premierPaiement(acc.id, 'yearly', 'in_l102d_y4');
    await sql`UPDATE referral_events SET first_billed_at = now() - interval '40 days' WHERE referred_account_id = ${acc.id}`;
    const f = fakeStripe({ cardFingerprint: 'fp_meme', referrerFingerprint: 'fp_meme' });
    const { runReferralRewards } = await import('@/services/referral/referral-rewards.job');
    await runReferralRewards(new Date(), { stripe: f.stripe });
    const ev = await evenement(acc.id);
    expect(ev.status).toBe('canceled');
    expect((ev.metadata_json?.rewardIneligibility as { reason: string }).reason).toBe('SELF_REFERRAL_SAME_PAYMENT_METHOD');
    expect(f.calls.update).toHaveLength(0);
  });

  it('AC-8 — migration 0920 rejouable ; le gabarit d’invitation porte les paramètres centraux', async () => {
    const migration = await readFile(join(process.cwd(), 'src/db/migrations/0920_l102d_parrainage_regle_centrale.sql'), 'utf8');
    await runMigrationSql(sql, migration);
    await runMigrationSql(sql, migration);
    const [t] = await sql<Array<{ body: string }>>`SELECT body FROM email_templates WHERE type = 'REFERRAL_INVITATION'`;
    for (const v of ['{{referralTermsUrl}}', '{{referralWindowDays}}', '{{referralReward}}']) expect(t.body).toContain(v);
    const { referralInvitationRuleVariables } = await import('@/services/referral/referral-invitation.service');
    expect(await referralInvitationRuleVariables()).toMatchObject({ referralWindowDays: '90', referralReward: 'un mois offert' });
  });
});
