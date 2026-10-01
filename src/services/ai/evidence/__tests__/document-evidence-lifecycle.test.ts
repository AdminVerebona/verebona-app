/**
 * Cycle de vie des preuves au fil du document — CDC 15 T3-03 (lot 13).
 * Dépendances injectées : aucun accès base.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  onDocumentsDeleted, onDocumentAssetChanged, onAssetDeleted, type LifecycleDeps,
} from '../document-evidence-lifecycle';
import type { RolloutMode } from '@/services/canonical/rollout';

function deps(mode: RolloutMode, assetIds: number[] = [10, 11], ids: number[] = [1, 2]) {
  const withdraw = vi.fn(async (p: { mode: string }) => ({ evidenceIds: ids, assetIds, dryRun: p.mode !== 'enabled' }));
  const enqueue = vi.fn(async (_i: unknown) => [1]);
  const d: LifecycleDeps = { mode: () => mode, withdraw: withdraw as never, enqueue };
  return { d, withdraw, enqueue };
}

describe('onDocumentsDeleted', () => {
  it('legacy : rien (ni lecture ni écriture ni file)', async () => {
    const { d, withdraw, enqueue } = deps('legacy');
    expect(await onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55] }, d)).toMatchObject({ mode: 'legacy', withdrawn: 0 });
    expect(withdraw).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('shadow : ce qui serait retiré est calculé (lecture seule), rien en file', async () => {
    const { d, withdraw, enqueue } = deps('shadow');
    const r = await onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55] }, d);
    expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ mode: 'shadow', sourceIds: [55], reason: 'DOCUMENT_DELETED', assetId: null }));
    expect(enqueue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ mode: 'shadow', withdrawn: 2, dryRun: true });
  });

  it('enabled : retrait de toutes les preuves du document puis réconciliation des biens touchés', async () => {
    const { d, withdraw, enqueue } = deps('enabled');
    await onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55, 56] }, d);
    expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ mode: 'enabled', sourceIds: [55, 56] }));
    expect(enqueue).toHaveBeenCalledWith({ accountId: 1, userId: 2, assetIds: [10, 11], sourceFileId: null, reason: 'DOCUMENT_DELETED' });
  });

  it('ne lève jamais', async () => {
    const d: LifecycleDeps = { mode: () => 'enabled', withdraw: vi.fn(async () => { throw new Error('KO'); }) as never, enqueue: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55] }, d)).resolves.toMatchObject({ withdrawn: 0 });
  });
});

describe('onDocumentAssetChanged', () => {
  it('déplacement A → B : retrait sur A seulement, A réconcilié même sans preuve retirée', async () => {
    const { d, withdraw, enqueue } = deps('enabled', [], []);
    const r = await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: 20 }, d);
    expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ sourceIds: [55], assetId: 10, reason: 'DOCUMENT_MOVED' }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ assetIds: [10], sourceFileId: 55 }));
    expect(r.assetIds).toEqual([10]);
  });

  it('détachement : motif DOCUMENT_UNLINKED ; aucun bien d’origine ou même bien : rien', async () => {
    const { d, withdraw } = deps('enabled');
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
    const { d, withdraw, enqueue } = deps('enabled', [10, 11]);
    await onAssetDeleted({ accountId: 1, userId: 2, assetId: 10, fileIds: [55] }, d);
    expect(withdraw).toHaveBeenNthCalledWith(1, expect.objectContaining({ sourceIds: [55], reason: 'ASSET_DELETED' }));
    expect(withdraw).toHaveBeenNthCalledWith(2, expect.objectContaining({ assetId: 10, reason: 'ASSET_DELETED' }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ assetIds: [11] }));
  });
});

describe('relation N-N au déplacement / détachement (0221)', () => {
  const lien = (over: Record<string, unknown>) => ({
    id: 1, accountId: 1, fileId: 55, assetId: 10, roomId: null, equipmentId: null, linkRole: 'PRIMARY', origin: 'USER',
    confidence: null, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date(), removedAt: null, ...over,
  });

  it('liens USER / AI / MIGRATION visant A (bien, pièce) retirés, LEGACY_COLUMN laissé au déclencheur — même en legacy', async () => {
    const avant = [lien({}), lien({ id: 2, roomId: 4, origin: 'AI', linkRole: 'SECONDARY' }), lien({ id: 3, origin: 'LEGACY_COLUMN' }), lien({ id: 4, assetId: 30, origin: 'AI', linkRole: 'SECONDARY' })];
    const unlink = vi.fn(async () => 1);
    const { d } = deps('legacy');
    const r = await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: 20 },
      { ...d, links: { list: async () => avant as never, unlink } });
    expect(unlink.mock.calls.map((c) => (c as unknown as [{ target: unknown; origins: unknown }])[0])).toEqual([
      expect.objectContaining({ target: { assetId: 10, roomId: null, equipmentId: null }, origins: ['USER'] }),
      expect.objectContaining({ target: { assetId: 10, roomId: 4, equipmentId: null }, origins: ['AI'] }),
    ]);
    expect(r.unlinked).toBe(2);
  });

  it('enabled : un bien SECONDAIRE qui porte des preuves mais n’est plus lié perd ses preuves ; un bien lié les garde', async () => {
    const apres = [lien({ assetId: 20, origin: 'LEGACY_COLUMN' }), lien({ id: 4, assetId: 30, origin: 'AI', linkRole: 'SECONDARY' })];
    const { d, withdraw, enqueue } = deps('enabled', [], [9]);
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: 20 }, {
      ...d, links: { list: async () => apres as never, unlink: async () => 0 },
      evidenceAssets: async () => [10, 20, 30, 40],
    });
    const cibles = withdraw.mock.calls.map((c) => (c[0] as unknown as { assetId: number }).assetId);
    expect(cibles).toEqual([10, 40]);
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ assetIds: [40], reason: 'DOCUMENT_UNLINKED' }));
  });

  it('relation N-N vide pour ce document (non rattrapé) : aucun retrait au-delà de A', async () => {
    const { d, withdraw } = deps('enabled');
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: 20 }, {
      ...d, links: { list: async () => [], unlink: async () => 0 }, evidenceAssets: async () => [10, 40],
    });
    expect(withdraw).toHaveBeenCalledTimes(1);
  });
});

describe('agenda T4 au fil du document (corpus §15 E2E-11 / E2E-19)', () => {
  it('suppression : éléments automatiques de chaque source retirés sur tous les biens', async () => {
    const { d } = deps('enabled');
    const agenda = vi.fn(async () => undefined);
    await onDocumentsDeleted({ accountId: 1, userId: 2, fileIds: [55, 56] }, { ...d, agenda });
    expect(agenda.mock.calls).toEqual([[{ accountId: 1, sourceFileId: 55, assetId: null }], [{ accountId: 1, sourceFileId: 56, assetId: null }]]);
  });

  it('déplacement A → B : retrait sur A seulement ; une erreur agenda ne fait pas échouer le déplacement', async () => {
    const { d } = deps('enabled', [], []);
    const agenda = vi.fn(async () => { throw new Error('KO'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 10, toAssetId: 11 }, { ...d, agenda }))
      .resolves.toMatchObject({ mode: 'enabled' });
    expect(agenda).toHaveBeenCalledWith({ accountId: 1, sourceFileId: 55, assetId: 10 });
  });

  it('même bien ou premier rattachement : aucun retrait', async () => {
    const { d } = deps('enabled');
    const agenda = vi.fn(async () => undefined);
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: null, toAssetId: 11 }, { ...d, agenda });
    await onDocumentAssetChanged({ accountId: 1, userId: 2, fileId: 55, fromAssetId: 11, toAssetId: 11 }, { ...d, agenda });
    expect(agenda).not.toHaveBeenCalled();
  });
});
