/**
 * CDC 15 T3-02 (lot 13) — la valeur restaurée par une annulation est USER.
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
  it('legacy : valeur restaurée avec origine USER et date (plus d’autorité de preuve)', async () => {
    await call();
    const kc = JSON.parse(h.updates[0].keyCharacteristics as string);
    expect(kc).toMatchObject({ acquisitionDate: '2020-01-01', acquisitionDate__origin: 'USER', acquisitionDate__updatedAt: expect.any(String) });
    expect(kc).not.toHaveProperty('acquisitionDate__authority');
  });

  it('enabled + clé du registre : writeCanonicalAssetField, origine USER', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    await call();
    expect(h.write).toHaveBeenCalledWith(expect.objectContaining({ key: 'acquisitionDate', value: '2020-01-01', origin: 'USER', actorUserId: 3, mode: 'enabled' }));
    expect(h.updates).toHaveLength(0);
  });
});
