import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { positiveInt, resolveDiagPeriod } from '@/services/business-operations/diagnostics/model';
import { OperationDiagnosticsService } from '@/services/business-operations/diagnostics/service';
import { diagnosticsError, guardAdmin, NO_STORE } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/operations/indicators — les 13 indicateurs C26.2 et les
 * anomalies dures (lot 47A) : global ou `accountId`, période `from` / `to`
 * (jours, Paris ; 30 derniers jours par défaut, 366 au plus). Observatoire
 * seulement : aucune valeur ne désactive quoi que ce soit (Q8). Lecture seule.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const sp = request.nextUrl.searchParams;
    const period = resolveDiagPeriod(sp.get('from'), sp.get('to'));
    const report = await new OperationDiagnosticsService().indicators(period, positiveInt(sp.get('accountId')));
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (e) {
    return diagnosticsError(e, 'indicateurs');
  }
}
