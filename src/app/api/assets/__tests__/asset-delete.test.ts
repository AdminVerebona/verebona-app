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
vi.mock('@/services/assets/asset-deletion.service', () => ({ deleteAssetCompletely, getAssetDeletionSummary }));
vi.mock('@/services/entitlements.service', () => ({}));
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
  it('supprime tout, même si un ancien client transmet keepDocuments/keepEvents', async () => {
    const res = await DELETE(del('id=5&keepDocuments=true&keepEvents=true'));
    expect(res.status).toBe(200);
    expect(deleteAssetCompletely).toHaveBeenCalledWith(assetRow);
    const body = await res.json();
    expect(body.options).toBeUndefined();
    expect(body.blobsScheduled).toBe(2);
  });

  it('refuse le bien d\'un autre compte', async () => {
    assetRow = { id: 5, accountId: 99, thumbnailUrl: null };
    const res = await DELETE(del('id=5'));
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
