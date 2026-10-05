/**
 * CDC 15 T2-29 (lot 13) — les preuves revalidées remplacent les anciennes
 * (toujours depuis le lot 16b-3 : `T3_NEGATIVE_RECONCILIATION` retiré). Ordre
 * sûr : projection d'abord, puis remplacement des seules preuves qui ont une
 * remplaçante.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  supersede: vi.fn(async (_p: Record<string, unknown>) => ({ superseded: 1, replacementId: 8 })),
  order: [] as string[],
}));
vi.mock('@/services/ai/evidence/field-evidence.service', () => ({
  supersedeFieldEvidenceExcept: async (p: Record<string, unknown>) => { h.order.push('supersede'); return h.supersede(p); },
}));
vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(), begin: vi.fn() }, db: {} }));

import { replaceRevalidatedEvidence } from '../revalidation.service';

const project = vi.fn(async () => { h.order.push('project'); });
const input = { accountId: 1, fileId: 55, assetId: 10, factKey: 'dateAchat', newValue: '2024-03-04', project };

beforeEach(() => { h.supersede.mockClear(); project.mockClear(); h.order = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { delete process.env.T3_NEGATIVE_RECONCILIATION; });

describe('replaceRevalidatedEvidence', () => {
  it('projection D’ABORD, puis remplacement (clé brute ET canonique) contre la valeur revalidée', async () => {
    expect(await replaceRevalidatedEvidence(input)).toEqual({ superseded: 1, projected: true });
    expect(h.order).toEqual(['project', 'supersede']);
    expect(h.supersede).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 55, assetId: 10, fieldKeys: ['dateAchat', 'acquisitionDate'], keepValue: '2024-03-04',
    }));
    expect(h.supersede.mock.calls[0][0]).not.toHaveProperty('mode');
  });

  it('commutateur retiré encore posé (legacy / shadow) : ignoré, remplacement réel', async () => {
    for (const v of ['legacy', 'shadow']) {
      process.env.T3_NEGATIVE_RECONCILIATION = v;
      h.order = [];
      expect(await replaceRevalidatedEvidence(input)).toEqual({ superseded: 1, projected: true });
      expect(h.order).toEqual(['project', 'supersede']);
    }
  });

  it('projection en échec : AUCUNE preuve retirée, échec journalisé', async () => {
    project.mockRejectedValueOnce(new Error('KO'));
    expect(await replaceRevalidatedEvidence(input)).toEqual({ superseded: 0, projected: false });
    expect(h.supersede).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/aucune preuve retirée/), 'KO');
  });

  it('E2E-T2-22 : preuves remplacées → T3 relancé APRÈS le remplacement ; rien remplacé → pas de relance', async () => {
    const reconcile = vi.fn(async () => { h.order.push('reconcile'); });
    await replaceRevalidatedEvidence({ ...input, reconcile });
    expect(h.order).toEqual(['project', 'supersede', 'reconcile']);
    h.supersede.mockResolvedValueOnce({ superseded: 0, replacementId: 8 });
    await replaceRevalidatedEvidence({ ...input, reconcile });
    expect(reconcile).toHaveBeenCalledTimes(1);
    // Une réconciliation en échec ne fait pas échouer la revalidation.
    await expect(replaceRevalidatedEvidence({ ...input, reconcile: async () => { throw new Error('KO'); } }))
      .resolves.toEqual({ superseded: 1, projected: true });
  });
});
