/**
 * GET /api/admin/ai/config-exports/[id] — lot 54 (54C).
 *
 * Re-télécharge un export passé, OCTET POUR OCTET (texte enregistré au
 * moment de l'export, table immuable) : les modifications ultérieures de la
 * configuration ne l'altèrent jamais. En-tête `X-Content-SHA256` : empreinte
 * à comparer avec celle de l'historique.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getExportFile } from '@/services/ai/config/config-export.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const exportId = parseVersionId(id);
  if (exportId === null) return invalidId(id);
  try {
    const f = await getExportFile(exportId);
    if (!f) return NextResponse.json({ error: 'EXPORT_NOT_FOUND', message: 'Export introuvable.' }, { status: 404 });
    const sha = createHash('sha256').update(f.content, 'utf8').digest('hex');
    return new NextResponse(f.content, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${f.record.fileName}"`,
        'X-Content-SHA256': sha,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-exports/[id]');
  }
}
