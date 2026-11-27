/**
 * DELETE /api/assets?id= et GET /api/assets/[id]/deletion-summary :
 * propriété du bien vérifiée, suppression totale déléguée au service,
 * paramètres keepDocuments / keepEvents sans effet (retirés).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let assetRow: { id: number; accountId: number; thumbnailUrl: string | null } | null = null;
const deleteAssetCompletely = vi.fn(async () => ({ blobsScheduled: 2 }));
const getAssetDeletionSummary = vi.fn(async () => ({ documents: 12, photos: 3, deadlines: 4, events: 5, rooms: 2, equipments: 1 }));

vi.mock('@/db', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) c[m] = () => c;
  c.limit = async () => (assetRow ? [assetRow] : []);
  return { db: c };
});
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: 1, currentAccountId: 10 }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
class AssetDeletionInventoryChangedError extends Error { inventory = { documents: 13 } }
vi.mock('@/services/assets/asset-deletion.service', () => ({ deleteAssetCompletely, getAssetDeletionSummary, AssetDeletionInventoryChangedError }));
vi.mock('@/services/entitlements.service', () => ({}));
// Lot 85D : la suppression passe par la garde de lecture seule — compte actif ici (le refus est éprouvé par l'e2e L85D-E03).
vi.mock('@/lib/write-access-guard', () => ({ refuserSiLectureSeule: async () => null }));
vi.mock('@/services/funnel-analytics.service', () => ({ trackFunnelEvent: async () => undefined }));
vi.mock('@/lib/feature-flags', () => ({}));

const { DELETE } = await import('../route');
const { GET: summary } = await import('../[id]/deletion-summary/route');

const del = (qs: string) => new NextRequest(`http://x/api/assets?${qs}`, { method: 'DELETE' });
const sum = (id: string) => summary(new NextRequest(`http://x/api/assets/${id}/deletion-summary`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  assetRow = { id: 5, accountId: 10, thumbnailUrl: null };
  deleteAssetCompletely.mockClear();
  getAssetDeletionSummary.mockClear();
});

describe('DELETE /api/assets', () => {
  // Carte #849 (B1) — règle remplacée : la suppression « à l'aveugle » (sans inventaire affiché et confirmé)
  // est refusée ; l'empreinte de l'inventaire est exigée puis transmise au service (revérifiée sous verrou).
  it('#849 : sans empreinte d’inventaire confirmé → 428, rien n’est supprimé', async () => {
    const res = await DELETE(del('id=5'));
    expect(res.status).toBe(428);
    expect((await res.json()).code).toBe('DELETION_INVENTORY_REQUIRED');
    expect(deleteAssetCompletely).not.toHaveBeenCalled();
  });

  it('#849 : inventaire changé depuis l’affichage → 409 avec le nouvel inventaire', async () => {
    deleteAssetCompletely.mockImplementationOnce(async () => { throw new AssetDeletionInventoryChangedError('changé'); });
    const res = await DELETE(del('id=5&inventory=fp1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'DELETION_INVENTORY_CHANGED', details: { inventory: { documents: 13 } } });
  });

  it('supprime selon l’inventaire confirmé, même si un ancien client transmet keepDocuments/keepEvents', async () => {
    const res = await DELETE(del('id=5&keepDocuments=true&keepEvents=true&inventory=fp1'));
    expect(res.status).toBe(200);
    expect(deleteAssetCompletely).toHaveBeenCalledWith(assetRow, { expectedFingerprint: 'fp1' });
    const body = await res.json();
    expect(body.options).toBeUndefined();
    expect(body.blobsScheduled).toBe(2);
  });

  it('refuse le bien d\'un autre compte', async () => {
    assetRow = { id: 5, accountId: 99, thumbnailUrl: null };
    const res = await DELETE(del('id=5&inventory=fp1'));
    expect(res.status).toBe(403);
    expect(deleteAssetCompletely).not.toHaveBeenCalled();
  });
});

describe('GET /api/assets/[id]/deletion-summary', () => {
  it('renvoie le décompte pour le propriétaire', async () => {
    const res = await sum('5');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ assetId: 5, documents: 12, deadlines: 4 });
  });

  it('refuse un autre compte et un bien inconnu', async () => {
    assetRow = { id: 5, accountId: 99, thumbnailUrl: null };
    expect((await sum('5')).status).toBe(403);
    assetRow = null;
    expect((await sum('5')).status).toBe(404);
    expect(getAssetDeletionSummary).not.toHaveBeenCalled();
  });
});
