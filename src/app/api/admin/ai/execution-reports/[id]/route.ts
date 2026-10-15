/**
 * GET /api/admin/ai/execution-reports/[id] — lot 58C : détail d'un rapport
 * d'exécution T1 / T3 (répartition, corrélations T1 ↔ T3, lignes paginées
 * avec emplacement BDD exact, valeur écrite, résultat réel et motif).
 * `?seq=N` : contenu COMPLET d'une ligne référencée, relu en direct (sinon
 * « non tracé »). Consultation journalisée, réponse `no-store`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readEntryContentForAdmin, readReportDetailForAdmin } from '@/services/ai/execution-report/admin-access';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

const int = (v: string | null) => (v && /^\d{1,10}$/.test(v) ? Number(v) : undefined);
const WORD = /^[A-Z_]{1,40}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  const q = req.nextUrl.searchParams;
  try {
    const seq = int(q.get('seq'));
    if (seq) {
      const c = await readEntryContentForAdmin({ adminUserId: guard.ctx.adminUserId, reportId: Number(id), seq });
      if (!c) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
      return NextResponse.json(c, { headers: { 'Cache-Control': 'no-store' } });
    }
    const section = q.get('section'); const writeResult = q.get('writeResult');
    const d = await readReportDetailForAdmin({
      adminUserId: guard.ctx.adminUserId, reportId: Number(id), offset: int(q.get('offset')), limit: int(q.get('limit')),
      section: section && WORD.test(section) ? section : undefined, writeResult: writeResult && WORD.test(writeResult) ? writeResult : undefined,
    });
    if (!d) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json(d, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/execution-reports/[id]');
  }
}
