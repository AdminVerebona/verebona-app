/**
 * GET /api/admin/ai/corpus/report?format=json|csv — lot 100B : rapport
 * exportable du corpus de qualification (couverture, exclusions motivées,
 * coûts mesurés, résultats, verrou A1, vue T2). Aucun contenu de document ni
 * de prompt ; identifiants et empreintes seulement. Administrateurs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const format = req.nextUrl.searchParams.get('format') === 'csv' ? 'csv' : 'json';
    const { corpusReport } = await import('@/services/ai/governance/master-corpus/certification/service');
    const r = await corpusReport(format);
    return new NextResponse(r.body, { headers: { 'Content-Type': r.contentType, 'Content-Disposition': `attachment; filename="${r.filename}"`, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/corpus/report');
  }
}
