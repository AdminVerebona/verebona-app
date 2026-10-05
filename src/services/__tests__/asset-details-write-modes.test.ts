/**
 * Façade `updateAssetDetails` (CDC 15, lots 11 et 13). Lot 16b-3 :
 * `CANONICAL_WRITE_MODE` supprimé — les champs canoniques passent TOUJOURS
 * par la primitive ; le reste de la section est appliqué par le hook
 * `mutate`, sous le même verrou. Primitive simulée (le chemin réel est
 * couvert par canonical-write.pg.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  kcLocked: {} as Record<string, unknown>,
  calls: [] as Array<{ input: Record<string, unknown>; columns: Record<string, unknown> }>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/db', () => {
  const chain = {
    from: () => chain, where: () => chain,
    limit: async () => (h.row ? [h.row] : []),
  };
  return {
    db: {
      select: () => chain,
      update: () => ({ set: (p: Record<string, unknown>) => ({ where: async () => { h.updates.push(p); } }) }),
    },
    pgClient: { unsafe: vi.fn(), begin: vi.fn() },
  };
});
vi.mock('@/services/canonical/asset-state', async (orig) => ({
  ...(await orig<typeof import('@/services/canonical/asset-state')>()),
  writeCanonicalAssetFields: async (
    input: { writes: Array<{ key: string }> } & Record<string, unknown>,
    opts: { mutate: (a: { row: Record<string, unknown>; kc: Record<string, unknown>; results: unknown[] }) => Record<string, unknown> },
  ) => {
    const results = input.writes.map((w) => ({ key: w.key, requestedKey: w.key, outcome: 'written' }));
    const columns = opts.mutate({ row: { status: 'EN_SERVICE', lock_state: 'NONE' }, kc: h.kcLocked, results });
    h.calls.push({ input, columns });
    return { notFound: false, fields: results };
  },
}));
vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));
vi.mock('@/services/to-process/to-process-action.service', () => ({ resolveActionsForData: async () => {} }));

const { updateAssetDetails, canonicalWritesOf } = await import('../asset-details-write.service');

beforeEach(() => {
  h.row = {
    id: 1, accountId: 7, name: 'Clio', category: 'VEHICULE', status: 'EN_SERVICE', lockState: 'NONE',
    keyCharacteristics: JSON.stringify({ mileage: 1000, mileage__origin: 'DOCUMENT_EXTRACTION' }),
  };
  h.kcLocked = { mileage: 1000, mileage__origin: 'DOCUMENT_EXTRACTION', coherenceAlerts: [{ field: 'mileage' }] };
  h.calls = [];
  h.updates = [];
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('updateAssetDetails — écriture canonique seule (lot 16b-3)', () => {
  it('champs du registre → primitive (origine USER) ; colonnes d’identité par le hook ; alerte levée', async () => {
    const r = await updateAssetDetails({
      assetId: 1, accountId: 7, section: 'vehicle_identification',
      fields: { mileage: '2000', name: ' Clio 2 ' }, actorUserId: 3,
    });
    expect(r).toEqual({ updated: true, section: 'vehicle_identification' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].input).toMatchObject({ assetId: 1, accountId: 7, origin: 'USER', actorUserId: 3, emitEvent: false });
    expect((h.calls[0].input.writes as Array<{ key: string }>).map((w) => w.key)).toContain('mileage');
    expect(h.calls[0].columns).toMatchObject({ name: 'Clio 2' });
    expect(h.kcLocked.coherenceAlerts).toEqual([]);
    expect(h.updates).toHaveLength(0); // jamais l'ancien UPDATE Drizzle
  });

  it('un commutateur retiré encore posé (legacy / shadow) ne change rien', async () => {
    for (const v of ['legacy', 'shadow']) {
      vi.stubEnv('CANONICAL_WRITE_MODE', v);
      h.calls = [];
      await updateAssetDetails({ assetId: 1, accountId: 7, section: 'vehicle_usage', fields: { mileage: 3000 } });
      expect(h.calls).toHaveLength(1);
      expect(h.updates).toHaveLength(0);
    }
  });

  it('clé hors registre : origine humaine posée seulement si la valeur change (lot 13)', async () => {
    h.kcLocked = { 'x.y': 'a', 'x.y__origin': 'RECONCILIATION' };
    await updateAssetDetails({ assetId: 1, accountId: 7, section: 'vehicle_identification', fields: { 'x.y': 'a' } });
    expect(h.kcLocked['x.y__origin']).toBe('RECONCILIATION');
    await updateAssetDetails({ assetId: 1, accountId: 7, section: 'vehicle_identification', fields: { 'x.y': 'b' } });
    expect(h.kcLocked).toMatchObject({ 'x.y': 'b', 'x.y__origin': 'USER' });
  });

  it('canonicalWritesOf : clé canonique d’une autre famille résolue comme alias de la famille', () => {
    expect(canonicalWritesOf({ generalCondition: 'BON', name: 'x', pointure: 42 }, 'OBJECT')).toEqual([{ key: 'generalCondition', value: 'BON' }]);
    expect(canonicalWritesOf({ generalCondition: 'BON' }, 'IMMOBILIER')).toEqual([{ key: 'generalCondition', value: 'BON' }]);
    expect(canonicalWritesOf({ generalCondition: 'BON' }, 'VEHICULE')).toEqual([]);
  });
});
