/**
 * BO « Modèles d'export » — prévisualisation (route) : bien du compte
 * administrateur uniquement, rendu téléchargeable, action journalisée
 * (EXPORT_TEMPLATE_PREVIEW, succès comme échec). Le libellé fait partie de la
 * liste fermée AdminActionType (le build échouait lot 24 faute de l'y avoir).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => 1,
  getSession: async () => ({ currentAccountId: 10 }),
  sessionErrorResponse: () => new Response(null, { status: 401 }),
}));
vi.mock('@/db', () => ({ pgClient: { unsafe: async () => [{ plan_type: 'PREMIUM' }] } }));
const logAdminAction = vi.fn(async (_e: unknown) => {});
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: (e: unknown) => logAdminAction(e) }));
const renderPreviewFile = vi.fn();
vi.mock('@/services/admin/export-preview.service', () => ({
  listAdminOwnAssets: async () => [{ id: 5, name: 'Maison', category: 'MAISON', subtype: null }],
  assetIneligibilityReason: () => null,
  analysePreview: async () => ({ missing: ['DPE'], manifest: { includedDocuments: [] } }),
  previewFileName: () => 'apercu.pdf',
  renderPreviewFile: (...a: unknown[]) => renderPreviewFile(...a),
}));
vi.mock('@/services/exports/dossier-availability', () => ({ loadInactiveDossiers: async () => new Set() }));

const { POST } = await import('../[id]/preview/route');

const call = (assetId: number) => POST(
  new NextRequest('http://localhost/api/admin/export-templates/VENTE/preview', {
    method: 'POST', body: JSON.stringify({ assetId }), headers: { 'Content-Type': 'application/json' },
  }),
  { params: Promise.resolve({ id: 'VENTE' }) },
);

beforeEach(() => {
  logAdminAction.mockClear();
  renderPreviewFile.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/admin/export-templates/[id]/preview', () => {
  it('rendu PDF téléchargeable, données manquantes en en-tête, journal SUCCESS', async () => {
    renderPreviewFile.mockResolvedValue({ buffer: Buffer.from('%PDF'), contentType: 'application/pdf', renderer: 'chromium' });
    const r = await call(5);
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('application/pdf');
    expect(r.headers.get('X-Preview-Filename')).toBe('apercu.pdf');
    expect(JSON.parse(decodeURIComponent(r.headers.get('X-Preview-Missing') ?? ''))).toEqual(['DPE']);
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'EXPORT_TEMPLATE_PREVIEW', result: 'SUCCESS', details: expect.objectContaining({ code: 'VENTE', assetId: 5 }),
    }));
  });

  it('bien d’un autre compte : refusé, aucun rendu', async () => {
    const r = await call(99);
    expect(r.status).toBe(404);
    expect(renderPreviewFile).not.toHaveBeenCalled();
  });

  it('échec du rendu : 500 réessayable, journal FAILURE', async () => {
    renderPreviewFile.mockRejectedValue(new Error('chromium absent'));
    const r = await call(5);
    expect(r.status).toBe(500);
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXPORT_TEMPLATE_PREVIEW', result: 'FAILURE' }));
  });

  it('EXPORT_TEMPLATE_PREVIEW appartient à la liste fermée AdminActionType', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/admin-audit.ts'), 'utf8');
    const union = src.slice(src.indexOf('export type AdminActionType'), src.indexOf('export type AdminTargetType'));
    expect(union).toContain("'EXPORT_TEMPLATE_PREVIEW'");
  });
});
