/**
 * GET /api/admin/ai/execution-reports — lot 58C : rapports d'exécution T1 / T3
 * (en-têtes seulement : statut, étapes, compteurs — aucune valeur de
 * document). Filtres : traitement, compte, document, bien, statut ; paginé.
 * Les passages T3 sans appel modèle n'ont pas de ligne « Appels modèles » :
 * leur rapport se consulte ici.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listExecutionReports } from '@/services/ai/execution-report/repository';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

const int = (v: string | null) => (v && /^\d{1,10}$/.test(v) ? Number(v) : undefined);

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const q = req.nextUrl.searchParams;
  try {
    const r = await listExecutionReports({
      treatment: q.get('treatment') ?? undefined, accountId: int(q.get('accountId')), fileId: int(q.get('fileId')),
      assetId: int(q.get('assetId')), status: q.get('status') ?? undefined,
      offset: int(q.get('offset')), limit: int(q.get('limit')),
    });
    return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/execution-reports');
  }
}
