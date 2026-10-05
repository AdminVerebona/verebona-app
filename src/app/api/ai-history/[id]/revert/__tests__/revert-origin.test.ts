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
  cible: null as null | { type: string; targetId: number },
  entityWrite: vi.fn(async () => ({ notFound: false, skipped: false, field: { outcome: 'written' } })),
  pgQueries: [] as Array<{ q: string; p: unknown[] }>,
}));
vi.mock('@/services/canonical/entity-state/entity-schema', () => ({ aiFieldUpdatesTargetReady: async () => h.cible !== null }));
vi.mock('@/services/canonical/entity-state', () => ({ writeCanonicalEntityField: h.entityWrite }));
vi.mock('@/lib/auth-guards', () => ({ getSession: async () => ({ currentAccountId: 7, userId: 3 }) }));
vi.mock('@/services/canonical/asset-state', () => ({ writeCanonicalAssetField: h.write }));
vi.mock('@/db', async () => {
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    pgClient: {
      unsafe: async (q: string, p: unknown[]) => { h.pgQueries.push({ q, p }); return h.cible ? [h.cible] : []; },
    },
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
afterEach(() => {
  delete process.env.CANONICAL_WRITE_MODE; h.updates = []; h.write.mockClear(); h.entityWrite.mockClear();
  h.cible = null; h.deleted = 0; h.pgQueries = [];
});

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

  it('lot 22 : ligne d’un équipement (cible 0236) → fiche de l’ENTITÉ restaurée en USER, jamais le bien', async () => {
    h.cible = { type: 'EQUIPMENT', targetId: 11 };
    h.entry.fieldKey = 'serialNumber';
    h.entry.oldValue = 'SN-ANCIEN';
    try {
      const res = await call();
      expect(res.status).toBe(200);
    } finally {
      h.entry.fieldKey = 'acquisitionDate';
      h.entry.oldValue = '2020-01-01';
    }
    expect(h.pgQueries[0].q).toContain('target_type');
    expect(h.pgQueries[0].p).toEqual([5, 7]);
    expect(h.entityWrite).toHaveBeenCalledWith(expect.objectContaining({
      target: { type: 'EQUIPMENT', id: 11 }, accountId: 7, key: 'serialNumber', value: 'SN-ANCIEN', origin: 'USER', actorUserId: 3,
      source: { type: 'ai_history_revert', id: 5 },
    }));
    expect(h.write).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
    expect(h.deleted).toBe(1);
  });

  it('lot 22 : entité introuvable → 404, la ligne d’historique reste', async () => {
    h.cible = { type: 'ROOM', targetId: 21 };
    h.entityWrite.mockResolvedValueOnce({ notFound: true, skipped: false, field: null } as never);
    const res = await call();
    expect(res.status).toBe(404);
    expect(h.deleted).toBe(0);
    expect(h.write).not.toHaveBeenCalled();
  });
});
