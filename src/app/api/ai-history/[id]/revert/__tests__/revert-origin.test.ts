/**
 * CDC 15 T3-02 (lot 13) — la valeur restaurée par une annulation est USER.
 * Lot 16b-3 : `CANONICAL_WRITE_MODE` retiré — clé du registre : primitive
 * seule ; clé hors registre : fiche JSON.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  deleted: 0,
  write: vi.fn(async () => ({ field: { outcome: 'written' } })),
  entry: { id: 5, accountId: 7, assetId: 1, fieldKey: 'acquisitionDate', oldValue: '2020-01-01' as string | null },
}));
vi.mock('@/lib/auth-guards', () => ({ getSession: async () => ({ currentAccountId: 7, userId: 3 }) }));
vi.mock('@/services/canonical/asset-state', () => ({ writeCanonicalAssetField: h.write }));
vi.mock('@/db', async () => {
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    db: {
      select: () => {
        let table = '';
        const c = {
          from: (t: never) => { table = getTableName(t); return c; }, where: () => c,
          limit: async () => (table === 'ai_field_updates' ? [h.entry]
            : [{ keyCharacteristics: JSON.stringify({ acquisitionDate: '2024-01-02', acquisitionDate__origin: 'RECONCILIATION', acquisitionDate__authority: 60 }), name: 'b' }]),
        };
        return c;
      },
      update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { h.updates.push(v); } }) }),
      delete: () => ({ where: async () => { h.deleted += 1; } }),
    },
  };
});

import { POST } from '../route';

const call = () => POST(new Request('http://x', { method: 'POST' }) as never, { params: Promise.resolve({ id: '5' }) });
afterEach(() => { delete process.env.CANONICAL_WRITE_MODE; h.updates = []; h.write.mockClear(); });

describe('POST /api/ai-history/[id]/revert', () => {
  it('clé hors registre : valeur restaurée avec origine USER et date (plus d’autorité de preuve)', async () => {
    h.entry.fieldKey = 'x.y';
    try {
      await call();
    } finally {
      h.entry.fieldKey = 'acquisitionDate';
    }
    expect(h.write).not.toHaveBeenCalled();
    const kc = JSON.parse(h.updates[0].keyCharacteristics as string);
    expect(kc).toMatchObject({ 'x.y': '2020-01-01', 'x.y__origin': 'USER', 'x.y__updatedAt': expect.any(String) });
  });

  it('clé du registre : writeCanonicalAssetField, origine USER — même avec le commutateur retiré posé à legacy', async () => {
    for (const v of [undefined, 'legacy']) {
      if (v) process.env.CANONICAL_WRITE_MODE = v;
      h.write.mockClear();
      await call();
      expect(h.write).toHaveBeenCalledWith(expect.objectContaining({ key: 'acquisitionDate', value: '2020-01-01', origin: 'USER', actorUserId: 3 }));
      expect(h.write.mock.calls[0]).not.toContainEqual(expect.objectContaining({ mode: expect.anything() }));
      expect(h.updates).toHaveLength(0);
    }
  });
});
