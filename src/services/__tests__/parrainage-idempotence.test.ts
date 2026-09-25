/**
 * Une seule attribution de cadeau par événement de parrainage.
 * (Scénarios concurrence et panne exécutés sur PostgreSQL : voir le commit.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let claimOk = true;
const sqls: string[] = [];
vi.mock('@/db', () => {
  const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => [{ stripeSubscriptionId: 'sub_p' }] };
  return {
    db: { ...chain, update: () => ({ set: () => ({ where: async () => {} }) }) },
    pgClient: {
      unsafe: async (sql: string) => {
        sqls.push(sql);
        if (sql.includes("SET reward_status = 'reward_processing'")) return claimOk ? [{ reward_claim_token: 'tok' }] : [];
        return [];
      },
    },
  };
});
vi.mock('@/lib/stripe', () => ({ getStripeServer: () => { throw new Error('non utilisé'); } }));

const { applyReferralRewardOnce, rewardMetadataKey } = await import('../referral-reward.service');

function fakeStripe(metadata: Record<string, string> = {}) {
  const update = vi.fn(async () => ({}));
  return {
    update,
    stripe: { subscriptions: { retrieve: async () => ({ status: 'active', trial_end: null, metadata, items: { data: [{ current_period_end: 1_800_000_000 }] } }), update } } as never,
  };
}

beforeEach(() => { claimOk = true; sqls.length = 0; });

describe('attribution unique', () => {
  it('prise atomique AVANT l’appel Stripe ; clé stable et métadonnée posées', async () => {
    const f = fakeStripe();
    const r = await applyReferralRewardOnce({ id: 7, referrerAccountId: 1 }, new Date('2026-09-25T00:00:00Z'), { stripe: f.stripe });
    expect(r.granted).toBe(true);
    expect(sqls[0]).toContain("reward_status = 'reward_processing'");
    const [, params, opts] = f.update.mock.calls[0] as unknown as [string, { metadata: Record<string, string> }, { idempotencyKey: string }];
    expect(opts.idempotencyKey).toBe('referral-reward-7');
    expect(params.metadata[rewardMetadataKey(7)]).toBeTruthy();
    expect(sqls.at(-1)).toContain("reward_status = 'reward_applied'");
    expect(sqls.at(-1)).toContain('reward_claim_token = $2');
  });

  it('événement déjà pris par une autre exécution : aucun appel Stripe', async () => {
    claimOk = false;
    const f = fakeStripe();
    expect(await applyReferralRewardOnce({ id: 7, referrerAccountId: 1 }, new Date(), { stripe: f.stripe })).toMatchObject({ granted: false, reason: 'CLAIMED_ELSEWHERE' });
    expect(f.update).not.toHaveBeenCalled();
  });

  it('rejeu après panne : la récompense reconnue chez Stripe n’est pas réappliquée', async () => {
    const f = fakeStripe({ [rewardMetadataKey(7)]: '2026-09-24T00:00:00.000Z|2027-02-10T00:00:00.000Z' });
    const r = await applyReferralRewardOnce({ id: 7, referrerAccountId: 1 }, new Date(), { stripe: f.stripe });
    expect(r).toMatchObject({ granted: true, alreadyApplied: true });
    expect(f.update).not.toHaveBeenCalled();
  });

  it('un autre événement légitime du même parrain donne son propre mois', async () => {
    const f = fakeStripe({ [rewardMetadataKey(7)]: 'x|2027-02-10T00:00:00.000Z' });
    await applyReferralRewardOnce({ id: 8, referrerAccountId: 1 }, new Date(), { stripe: f.stripe });
    expect(f.update).toHaveBeenCalledTimes(1);
  });
});
