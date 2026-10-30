/**
 * GET /api/admin/ai/corpus/a1?treatment=T1 — lot 100B (#345, arbitrage A1) :
 * manques de couverture d'un traitement, affichés AVANT une activation
 * manuelle de prompt (information, jamais bloquante). Administrateurs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const t = req.nextUrl.searchParams.get('treatment');
    if (!t || !['T1', 'T2', 'T3', 'T4', 'T6'].includes(t)) return NextResponse.json({ error: 'INVALID_TREATMENT', message: 'Traitement invalide.' }, { status: 400 });
    const { a1NoticesFor } = await import('@/services/ai/governance/master-corpus/certification/service');
    return NextResponse.json(await a1NoticesFor(t as 'T1'), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/corpus/a1');
  }
}
