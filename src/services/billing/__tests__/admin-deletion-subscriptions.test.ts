/**
 * Suppression admin — contrôle de TOUS les abonnements connus (V2,
 * historique `accounts`, Duo), statut relu chez Stripe (ACC-A14, §7.4).
 */
import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { findBillingSubscription, type SubscriptionCandidate } from '@/services/account/admin-account-deletion.service';

const cand = (id: string, localStatus: string | null = null, cancel: boolean | null = null): SubscriptionCandidate =>
  ({ stripeSubscriptionId: id, localStatus, localCancelAtPeriodEnd: cancel });

function stripeWith(map: Record<string, { status?: string; cancel_at_period_end?: boolean; error?: { code?: string; statusCode?: number } }>) {
  return {
    subscriptions: {
      retrieve: vi.fn(async (id: string) => {
        const s = map[id];
        if (!s || s.error) throw Object.assign(new Error('x'), s?.error ?? { code: 'resource_missing', statusCode: 404 });
        return { id, status: s.status, cancel_at_period_end: Boolean(s.cancel_at_period_end) };
      }),
    },
  } as unknown as Pick<Stripe, 'subscriptions'>;
}

describe('findBillingSubscription', () => {
  it('ancien abonnement (accounts / duo) encore actif chez Stripe : bloque', async () => {
    const stripe = stripeWith({ sub_v2: { status: 'canceled' }, sub_legacy: { status: 'active' } });
    expect(await findBillingSubscription([cand('sub_v2', 'canceled'), cand('sub_legacy', 'EXPIRED')], stripe)).toBe('sub_legacy');
  });

  it('statut local périmé mais Stripe dit résilié : laisse passer', async () => {
    const stripe = stripeWith({ sub_1: { status: 'canceled' } });
    expect(await findBillingSubscription([cand('sub_1', 'ACTIVE')], stripe)).toBeNull();
  });

  it('résiliation programmée en fin de période : laisse passer', async () => {
    const stripe = stripeWith({ sub_1: { status: 'active', cancel_at_period_end: true } });
    expect(await findBillingSubscription([cand('sub_1')], stripe)).toBeNull();
  });

  it('abonnement inconnu de Stripe : ignoré', async () => {
    expect(await findBillingSubscription([cand('sub_gone', 'ACTIVE')], stripeWith({}))).toBeNull();
  });

  it('Stripe injoignable : repli prudent sur le statut local', async () => {
    const stripe = stripeWith({
      sub_a: { error: { code: 'api_connection_error' } },
      sub_b: { error: { code: 'api_connection_error' } },
    });
    expect(await findBillingSubscription([cand('sub_a', 'EXPIRED')], stripe)).toBeNull();
    expect(await findBillingSubscription([cand('sub_b', 'PAST_DUE_GRACE')], stripe)).toBe('sub_b');
  });
});
