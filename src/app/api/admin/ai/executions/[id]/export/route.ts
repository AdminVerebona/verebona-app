/**
 * GET /api/admin/ai/executions/[id]/export — BO IA, lot 32 (point 5).
 *
 * Export complet et copiable d'une exécution (`buildExecutionExport`) :
 * même garde administrateur et même source que le détail
 * (`getExecutionDetail`) — rien de plus n'est lu, la rédaction en place
 * s'applique. `?download=1` : proposé en fichier `.json`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getExecutionDetail } from '@/services/ai/telemetry/execution-log.repository';
import { buildExecutionExport, executionExportFileName } from '@/services/ai/telemetry/execution-export';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  try {
    const detail = await getExecutionDetail(Number(id));
    if (!detail) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    const now = new Date();
    const body = buildExecutionExport(detail, now);
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    if (req.nextUrl.searchParams.get('download') === '1') {
      headers['content-disposition'] = `attachment; filename="${executionExportFileName(detail.call.id, now)}"`;
    }
    return new NextResponse(JSON.stringify(body, null, 2), {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/executions/[id]/export');
  }
}
