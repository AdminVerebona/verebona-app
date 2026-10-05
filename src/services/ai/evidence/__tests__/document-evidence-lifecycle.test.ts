/**
 * Cycle de vie des preuves au fil du document — CDC 15 T3-03 (lot 13).
 * Dépendances injectées : aucun accès base. Lot 16b-3 : commutateur
 * `CANONICAL_WRITE_MODE` supprimé — retrait et réconciliation toujours actifs.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  onDocumentsDeleted, onDocumentAssetChanged, onAssetDeleted, type LifecycleDeps,
} from '../document-evidence-lifecycle';

function deps(assetIds: number[] = [10, 11], ids: number[] = [1, 2]) {
  const withdraw = vi.fn(async (_p: unknown) => ({ evidenceIds: ids, assetIds, dryRun: false }));
  const enqueue = vi.fn(async (_i: unknown) => [1]);
  const d: LifecycleDeps = { withdraw: withdraw as never, enqueue };
  return { d, withdraw, enqueue };
}

describe('onDocumentsDeleted', () => {
  it('un commutateur retiré encore posé (legacy / shadow) ne change rien : retrait réel', async () => {
    for (const v of ['legacy', 'shadow']) {
      vi.stubEnv('CANONICAL_WRITE_MODE', v);
      const { d, withdraw, enqueue } = deps();
      const r = await onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55] }, d);
      expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ sourceIds: [55], reason: 'DOCUMENT_DELETED', assetId: null }));
      expect(withdraw.mock.calls[0][0]).not.toHaveProperty('mode');
      expect(enqueue).toHaveBeenCalled();
      expect(r).toMatchObject({ withdrawn: 2, dryRun: false });
    }
    vi.unstubAllEnvs();
  });

  it('retrait de toutes les preuves du document puis réconciliation des biens touchés', async () => {
    const { d, withdraw, enqueue } = deps();
    await onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55, 56] }, d);
    expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ sourceIds: [55, 56] }));
    expect(enqueue).toHaveBeenCalledWith({ accountId: 1, userId: 2, assetIds: [10, 11], sourceFileId: null, reason: 'DOCUMENT_DELETED' });
  });

  it('ne lève jamais', async () => {
    const d: LifecycleDeps = { withdraw: vi.fn(async () => { throw new Error('KO'); }) as never, enqueue: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55] }, d)).resolves.toMatchObject({ withdrawn: 0 });
  });
});

describe('onDocumentAssetChanged', () => {
  it('déplacement A → B : retrait sur A seulement, A réconcilié même sans preuve retirée', async () => {
    const { d, withdraw, enqueue } = deps([], []);
    const r = await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: 20 }, d);
    expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ sourceIds: [55], assetId: 10, reason: 'DOCUMENT_MOVED' }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ assetIds: [10], sourceFileId: 55 }));
    expect(r.assetIds).toEqual([10]);
  });

  it('détachement : motif DOCUMENT_UNLINKED ; aucun bien d’origine ou même bien : rien', async () => {
    const { d, withdraw } = deps();
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: null }, d);
    expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ reason: 'DOCUMENT_UNLINKED', assetId: 10 }));
    withdraw.mockClear();
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: null, toAssetId: 3 }, d);
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 3, toAssetId: 3 }, d);
    expect(withdraw).not.toHaveBeenCalled();
  });
});

describe('onAssetDeleted', () => {
  it('preuves des documents emportés retirées partout ; le bien supprimé n’est pas réconcilié', async () => {
    const { d, withdraw, enqueue } = deps([10, 11]);
    await onAssetDeleted({ accountId: 1, userId: 2, assetId: 10, fileIds: [55] }, d);
    expect(withdraw).toHaveBeenNthCalledWith(1, expect.objectContaining({ sourceIds: [55], reason: 'ASSET_DELETED' }));
    expect(withdraw).toHaveBeenNthCalledWith(2, expect.objectContaining({ assetId: 10, reason: 'ASSET_DELETED' }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ assetIds: [11] }));
  });
});

describe('relation N-N au déplacement / détachement (0221)', () => {
  const lien = (over: Record<string, unknown>) => ({
    id: 1, accountId: 1, fileId: 55, assetId: 10, roomId: null, equipmentId: null, substructureId: null, linkRole: 'PRIMARY', origin: 'USER',
    confidence: null, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date(), removedAt: null, ...over,
  });

  it('liens USER / AI / MIGRATION visant A (bien, pièce) retirés, LEGACY_COLUMN laissé au déclencheur', async () => {
    // D-G (lot 20) : la pièce d'un lien est une sous-structure (`substructureId`) ; `roomId` historique conservé tel quel.
    const avant = [lien({}), lien({ id: 2, roomId: 4, origin: 'AI', linkRole: 'SECONDARY' }), lien({ id: 3, origin: 'LEGACY_COLUMN' }), lien({ id: 4, assetId: 30, origin: 'AI', linkRole: 'SECONDARY' }),
      lien({ id: 5, substructureId: 6, origin: 'USER', linkRole: 'SECONDARY' })];
    const unlink = vi.fn(async () => 1);
    const { d } = deps();
    const r = await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: 20 },
      { ...d, links: { list: async () => avant as never, unlink } });
    expect(unlink.mock.calls.map((c) => (c as unknown as [{ target: unknown; origins: unknown }])[0])).toEqual([
      expect.objectContaining({ target: { assetId: 10, roomId: null, equipmentId: null, substructureId: null }, origins: ['USER'] }),
      expect.objectContaining({ target: { assetId: 10, roomId: 4, equipmentId: null, substructureId: null }, origins: ['AI'] }),
      expect.objectContaining({ target: { assetId: 10, roomId: null, equipmentId: null, substructureId: 6 }, origins: ['USER'] }),
    ]);
    expect(r.unlinked).toBe(3);
  });

  it('un bien SECONDAIRE qui porte des preuves mais n’est plus lié perd ses preuves ; un bien lié les garde', async () => {
    const apres = [lien({ assetId: 20, origin: 'LEGACY_COLUMN' }), lien({ id: 4, assetId: 30, origin: 'AI', linkRole: 'SECONDARY' })];
    const { d, withdraw, enqueue } = deps([], [9]);
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: 20 }, {
      ...d, links: { list: async () => apres as never, unlink: async () => 0 },
      evidenceAssets: async () => [10, 20, 30, 40],
    });
    const cibles = withdraw.mock.calls.map((c) => (c[0] as unknown as { assetId: number }).assetId);
    expect(cibles).toEqual([10, 40]);
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ assetIds: [40], reason: 'DOCUMENT_UNLINKED' }));
  });

  it('relation N-N vide pour ce document (non rattrapé) : aucun retrait au-delà de A', async () => {
    const { d, withdraw } = deps();
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: 20 }, {
      ...d, links: { list: async () => [], unlink: async () => 0 }, evidenceAssets: async () => [10, 40],
    });
    expect(withdraw).toHaveBeenCalledTimes(1);
  });
});

describe('agenda T4 au fil du document (corpus §15 E2E-11 / E2E-19)', () => {
  it('suppression : éléments automatiques de chaque source retirés sur tous les biens', async () => {
    const { d } = deps();
    const agenda = vi.fn(async () => undefined);
    await onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55, 56] }, { ...d, agenda });
    expect(agenda.mock.calls).toEqual([[{ accountId: 1, sourceFileId: 55, assetId: null }], [{ accountId: 1, sourceFileId: 56, assetId: null }]]);
  });

  it('déplacement A → B : retrait sur A seulement ; une erreur agenda ne fait pas échouer le déplacement', async () => {
    const { d } = deps([], []);
    const agenda = vi.fn(async () => { throw new Error('KO'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: 11 }, { ...d, agenda }))
      .resolves.toMatchObject({ dryRun: false });
    expect(agenda).toHaveBeenCalledWith({ accountId: 1, sourceFileId: 55, assetId: 10 });
  });

  it('même bien ou premier rattachement : aucun retrait', async () => {
    const { d } = deps();
    const agenda = vi.fn(async () => undefined);
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: null, toAssetId: 11 }, { ...d, agenda });
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 11, toAssetId: 11 }, { ...d, agenda });
    expect(agenda).not.toHaveBeenCalled();
  });
});

describe('équipements et pièces (lot 18, R3)', () => {
  const avecEntites = () => {
    const base = deps();
    const entityTargets = vi.fn(async (_a: number, _ids: number[]) => [{ type: 'EQUIPMENT' as const, id: 4 }]);
    const enqueueEntities = vi.fn(async (_i: unknown) => [1]);
    return { ...base, d: { ...base.d, entityTargets, enqueueEntities }, entityTargets, enqueueEntities };
  };

  it('cibles des preuves retirées réconciliées (travail ciblé)', async () => {
    const { d, entityTargets, enqueueEntities } = avecEntites();
    await onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55] }, d);
    expect(entityTargets).toHaveBeenCalledWith(1, [1, 2]);
    expect(enqueueEntities).toHaveBeenCalledWith({
      accountId: 1, userId: 2, targets: [{ type: 'EQUIPMENT', id: 4 }], sourceFileId: 55, reason: 'DOCUMENT_DELETED',
    });
  });

  it('aucune preuve retirée : ni lecture des cibles ni mise en file', async () => {
    const base = deps([], []);
    const entityTargets = vi.fn(async () => []);
    const enqueueEntities = vi.fn(async () => [1]);
    await onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55] }, { ...base.d, entityTargets, enqueueEntities });
    expect(entityTargets).not.toHaveBeenCalled();
    expect(enqueueEntities).not.toHaveBeenCalled();
  });
});
