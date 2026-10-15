/**
 * GET /api/admin/ai/execution-reports/[id]/export — lot 58C : export JSON
 * EXHAUSTIF d'un rapport (en-tête, corrélations, TOUTES les lignes lues page
 * par page, contenus référencés relus en direct ou « non tracé »). Flux
 * continu : aucune limite silencieuse de taille ; `entriesExported`,
 * `entriesExpected` et `complete` en fin de document. Export journalisé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { exportReportChunks, getExecutionReport } from '@/services/ai/execution-report/repository';
import { journalReportAccess } from '@/services/ai/execution-report/admin-access';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  try {
    const report = await getExecutionReport(Number(id));
    if (!report) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    await journalReportAccess({ adminUserId: guard.ctx.adminUserId, reportId: report.id, purpose: 'export', result: 'SUCCESS', details: { entries: report.entryCount } });
    const now = new Date();
    const it = exportReportChunks(report, now);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await it.next();
          if (done) controller.close(); else controller.enqueue(enc.encode(value));
        } catch (e) {
          // Export interrompu : jamais un JSON tronqué présenté comme complet.
          controller.error(e);
        }
      },
    });
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (req.nextUrl.searchParams.get('download') === '1') {
      headers['content-disposition'] = `attachment; filename="rapport-${report.treatment.toLowerCase()}-${report.id}-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json"`;
    }
    return new NextResponse(stream, { status: 200, headers });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/execution-reports/[id]/export');
  }
}
