/**
 * Lot 61B — Premium Duo, écarts résiduels de « Inviter quelqu'un » : règles
 * pures (date réelle de début, statut Duo suivant le BO, vérification croisée
 * de l'offre) et propagation de la date d'effet du changement BO. La base
 * réelle (synchronisation, webhooks, BO, routes, reprise 0438) est couverte
 * par `src/test/e2e/scenarios/l61b-duo-residuels.e2e.ts` (DUO-R-01 à 12).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Stripe from 'stripe';
import {
  duoEntryFromEvent,
  duoStartCandidates,
  duoStatusForAccountStatus,
  pickDuoStartDate,
} from '@/services/duo/duo-period';
import { duoInviteFrom } from '@/services/home/mascot/duo-invite';
import { changePlanAsAdmin, type AdminPlanChangeDeps } from '@/services/billing/admin-plan-change.service';
import type { ResolvedPrice } from '@/services/billing/catalog-types';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const T = (iso: string) => new Date(iso);
const unix = (iso: string) => Math.floor(T(iso).getTime() / 1000);

describe('DUO-R-D — date réelle de début du Duo (source Stripe)', () => {
  const s = (o: Partial<Stripe.Subscription>) => ({ id: 'sub_1', start_date: unix('2026-10-01T08:00:00Z'), metadata: {}, ...o }) as Stripe.Subscription;

  it('Checkout (abonnement nouveau pour le compte) : start_date ; abonnement existant (upgrade) : jamais start_date', () => {
    expect(duoStartCandidates({ subscription: s({}), accountSubscriptionIdBefore: null })).toEqual([T('2026-10-01T08:00:00Z')]);
    expect(duoStartCandidates({ subscription: s({}), accountSubscriptionIdBefore: 'sub_ancien' })).toEqual([T('2026-10-01T08:00:00Z')]);
    expect(duoStartCandidates({ subscription: s({}), accountSubscriptionIdBefore: 'sub_1' })).toEqual([]);
  });

  it('preuve du webhook prioritaire ; marqueur BO seulement vers premium_duo', () => {
    const at = T('2026-10-10T10:00:00Z');
    expect(duoStartCandidates({ subscription: s({}), accountSubscriptionIdBefore: 'sub_1', duoEnteredAt: at })).toEqual([at]);
    const marque = s({ metadata: { admin_plan_change: '2026-10-12T09:00:00.000Z', admin_plan_change_to: 'premium_duo' } });
    expect(duoStartCandidates({ subscription: marque, accountSubscriptionIdBefore: 'sub_1' })).toEqual([T('2026-10-12T09:00:00Z')]);
    const versPremium = s({ metadata: { admin_plan_change: '2026-10-12T09:00:00.000Z', admin_plan_change_to: 'premium' } });
    expect(duoStartCandidates({ subscription: versPremium, accountSubscriptionIdBefore: 'sub_1' })).toEqual([]);
  });

  it('jamais antérieure à la dernière sortie (webhook ancien ou rejoué), jamais dans le futur ; sinon NULL', () => {
    const now = T('2026-10-15T12:00:00Z');
    const sortie = T('2026-10-05T00:00:00Z');
    expect(pickDuoStartDate([T('2026-10-01T00:00:00Z')], sortie, now)).toBeNull();
    expect(pickDuoStartDate([T('2026-10-01T00:00:00Z'), T('2026-10-06T00:00:00Z')], sortie, now)).toEqual(T('2026-10-06T00:00:00Z'));
    expect(pickDuoStartDate([T('2026-10-16T00:00:00Z')], null, now)).toBeNull();
    expect(pickDuoStartDate([], null, now)).toBeNull();
  });

  it('webhook : passage d’une autre offre à Premium Duo = event.created ; changement de périodicité Duo, rejeu sans items : null', async () => {
    const plans: Record<string, string> = { p_duo_m: 'premium_duo', p_duo_y: 'premium_duo', p_prem: 'premium' };
    const recognize = async (id: string) => plans[id] ?? null;
    const ev = (cur: string, prev: string | null, type = 'customer.subscription.updated') => ({
      type, created: unix('2026-10-14T07:00:00Z'),
      data: { object: { items: { data: [{ price: { id: cur } }] } }, ...(prev ? { previous_attributes: { items: { data: [{ price: { id: prev } }] } } } : {}) },
    }) as unknown as Stripe.Event;
    expect(await duoEntryFromEvent(ev('p_duo_m', 'p_prem'), recognize)).toEqual(T('2026-10-14T07:00:00Z'));
    expect(await duoEntryFromEvent(ev('p_duo_y', 'p_duo_m'), recognize)).toBeNull();
    expect(await duoEntryFromEvent(ev('p_prem', 'p_duo_m'), recognize)).toBeNull();
    expect(await duoEntryFromEvent(ev('p_duo_m', null), recognize)).toBeNull();
    expect(await duoEntryFromEvent(ev('p_duo_m', 'p_prem', 'customer.subscription.created'), recognize)).toBeNull();
    expect(await duoEntryFromEvent(ev('p_duo_m', 'p_inconnu'), recognize)).toBeNull();
  });

  it('déclencheur 0438 : plus aucun now() pour la date de début', () => {
    const m = src('src/db/migrations/0438_duo_invite_period_fix.sql');
    const fn = m.slice(m.indexOf('CREATE OR REPLACE FUNCTION'), m.indexOf('DROP TRIGGER'));
    expect(fn).not.toMatch(/duo_subscription_started_at\s*:=\s*(coalesce\([^)]*)?now\(\)/i);
    expect(fn).toMatch(/NEW\.duo_subscription_ended_at := now\(\)/);
  });
});

describe('DUO-R-F — BO : le statut Duo suit le statut du compte, jamais ACTIVE forcé', () => {
  it('impayé → UNPAID_RECOVERY ; sans droits → CANCELED ; à jour ou résiliation programmée → ACTIVE', () => {
    expect(duoStatusForAccountStatus('PAST_DUE')).toBe('UNPAID_RECOVERY');
    for (const s of ['EXPIRED', 'WITHDRAWN', 'NONE', null, '']) expect(duoStatusForAccountStatus(s)).toBe('CANCELED');
    for (const s of ['ACTIVE', 'TRIALING', 'CANCELED']) expect(duoStatusForAccountStatus(s)).toBe('ACTIVE');
  });

  it('applyPlanChange n’écrit plus ACTIVE en dur', () => {
    const pe = src('src/lib/plan-enforcement.ts');
    expect(pe).not.toMatch(/set\(\{ subscriptionStatus: 'ACTIVE'/);
    expect(pe).toMatch(/duoStatusForAccountStatus\(newSubStatus\)/);
  });

  it('changement BO avec Stripe : la date d’effet transmise est celle du marqueur posé sur l’abonnement', async () => {
    const update = vi.fn(async () => ({}));
    const applyLocal = vi.fn(async () => undefined);
    const deps: AdminPlanChangeDeps = {
      loadAccount: async () => ({ id: 1, ownerUserId: 10, planType: 'PREMIUM', subscriptionStatus: 'ACTIVE', premiumUntil: null, stripeSubscriptionId: 'sub_1', billingPeriod: 'monthly', scheduledPlanCode: null }),
      stripe: () => ({ subscriptions: { retrieve: async () => ({ id: 'sub_1', status: 'active', schedule: null, items: { data: [{ id: 'si_1', price: { id: 'p', recurring: { interval: 'month' } } }] } }), update } }) as unknown as Pick<Stripe, 'subscriptions'>,
      applyLocal,
      resolvePrice: async () => ({ planCode: 'premium_duo', billingPeriod: 'monthly', priceId: 'price_duo', unitAmountCents: 1290, currency: 'eur', priceRevision: 'r' } as unknown as ResolvedPrice),
      recordOperation: async () => 1,
    };
    const r = await changePlanAsAdmin({ accountId: 1, newPlan: 'PREMIUM_DUO', displayedPriceRevision: 'r' }, deps);
    expect(r.ok).toBe(true);
    const params = (update.mock.calls[0] as unknown as [string, Stripe.SubscriptionUpdateParams])[1];
    const opts = (applyLocal.mock.calls[0] as unknown as [unknown, string, { effectiveAt: Date }])[2];
    expect(params.metadata).toMatchObject({ admin_plan_change_to: 'premium_duo' });
    expect(opts.effectiveAt.toISOString()).toBe((params.metadata as Record<string, string>).admin_plan_change);
  });
});

describe('DUO-R-A/C — vérification croisée de l’offre effective', () => {
  const DUO = { subscriptionStatus: 'ACTIVE', pendingInviteEmail: null, memberships: 0, startedAt: T('2026-10-14T08:30:00Z'), firstInviteSentAt: null };
  it('statut Duo ACTIVE mais offre non confirmée (sortie, résiliation programmée, impayé) : absente', () => {
    const at = T('2026-10-15T08:30:00Z');
    expect(duoInviteFrom({ ...DUO, offerActive: true }, at)).not.toBeNull();
    expect(duoInviteFrom({ ...DUO, offerActive: false }, at)).toBeNull();
    expect(duoInviteFrom({ ...DUO }, at)).toBeNull();
  });

  it('lecture : offre du compte, ligne d’abonnement sans résiliation programmée, même abonnement Stripe', () => {
    const lecture = src('src/services/home/mascot/duo-invite.ts');
    expect(lecture).toMatch(/upper\(coalesce\(a\.plan_type, ''\)\) = 'PREMIUM_DUO'/);
    expect(lecture).toMatch(/upper\(coalesce\(a\.subscription_status, ''\)\) = 'ACTIVE'/);
    expect(lecture).toMatch(/s\.cancel_at_period_end IS NOT TRUE/);
    expect(lecture).toMatch(/a\.stripe_subscription_id = d\.stripe_subscription_id/);
  });
});

describe('DUO-R-E — trace du premier envoi', () => {
  it('posée à l’acceptation sans dépendre du jeton courant, rattachée à la période, dans la transaction de clôture', () => {
    const j = src('src/services/email/transactional-email-jobs.service.ts');
    expect(j).toMatch(/duo_first_invite_sent_at = COALESCE\(duo_first_invite_sent_at, \$3::timestamptz\)\s+WHERE id = \$1 AND duo_subscription_started_at IS NOT DISTINCT FROM \$2::timestamptz/);
    expect(j).toMatch(/pgClient\.begin\(async \(tx\) => \{\s+const exec = tx as unknown as Exec;\s+await close\('accepted'/);
    // Une invitation Duo n'est jamais fusionnée dans une tentative en cours.
    expect(j).toMatch(/kind === 'DUO_INVITATION' \? `\('pending'\)`/);
  });
});
