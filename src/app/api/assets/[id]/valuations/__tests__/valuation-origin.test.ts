/**
 * CDC 15 T3-02 (lot 13) — une valorisation saisie pose l'origine USER.
 */
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ updates: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/session-service', () => ({ SessionService: { getSession: async () => ({ currentAccountId: 7, userId: 3 }), handleSessionError: vi.fn() } }));
vi.mock('@/lib/asset-quota-guard', () => ({ refuserSiModificationBiensSuspendue: async () => null }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: async () => {} }));
vi.mock('@/db', () => {
  const chain = {
    from: () => chain, where: () => chain,
    limit: async () => [{ id: 1, keyCharacteristics: JSON.stringify({ estimatedValue: 9000, estimatedValue__origin: 'RECONCILIATION', estimatedValue__authority: 60 }) }],
  };
  return {
    db: {
      select: () => chain,
      update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { h.updates.push(v); } }) }),
    },
  };
});

import { POST } from '../route';

describe('POST /api/assets/[id]/valuations', () => {
  it('estimatedValue (et la date) : origine USER + date, autorité de la preuve précédente retirée', async () => {
    const req = new Request('http://x/api/assets/1/valuations', { method: 'POST', body: JSON.stringify({ value: 12000, date: '2026-09-01', source: 'AI' }) });
    const res = await POST(req as never, { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBeLessThan(300);
    const kc = JSON.parse(h.updates[0].keyCharacteristics as string);
    expect(kc).toMatchObject({
      estimatedValue: 12000, estimatedValue__origin: 'USER', estimatedValue__updatedAt: expect.any(String),
      estimatedValueDate: '2026-09-01', estimatedValueDate__origin: 'USER',
    });
    expect(kc).not.toHaveProperty('estimatedValue__authority');
    expect(kc).not.toHaveProperty('estimatedValueMode__origin');
  });
});
