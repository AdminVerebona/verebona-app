import { describe, it, expect, vi, beforeEach } from 'vitest';

let row: Record<string, unknown> | null = null;
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
  },
}));
vi.mock('@/services/funnel-analytics.service', () => ({ trackFunnelEvent: vi.fn() }));

import { getTrialState } from '@/services/trial.service';

const NOW = new Date('2026-09-16T12:00:00Z');
const base = {
  startedAt: new Date('2026-09-11T12:00:00Z'),
  endsAt: new Date('2026-09-18T12:00:00Z'),
  firstBilledAt: null,
  stripeSubscriptionId: null,
};

beforeEach(() => { row = null; });

describe('getTrialState', () => {
  it('essai en cours sans abonnement payé', async () => {
    row = { ...base, status: 'trialing' };
    expect((await getTrialState(1, NOW)).status).toBe('active');
  });

  it('converti dès qu\'un abonnement payé est en place, avant l\'encaissement constaté', async () => {
    row = { ...base, status: 'active', stripeSubscriptionId: 'sub_1' };
    expect((await getTrialState(1, NOW)).status).toBe('converted');
  });

  it('converti après première facturation', async () => {
    row = { ...base, status: 'active', firstBilledAt: NOW };
    expect((await getTrialState(1, NOW)).status).toBe('converted');
  });

  it('un client Stripe sans abonnement actif ne clôt pas l\'essai', async () => {
    row = { ...base, status: 'canceled', stripeSubscriptionId: 'sub_1' };
    expect((await getTrialState(1, NOW)).status).toBe('active');
  });
});
