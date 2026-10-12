import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { parseHoldFilters } from '@/services/business-operations/diagnostics/model';
import { OperationDiagnosticsService } from '@/services/business-operations/diagnostics/service';
import { diagnosticsError, guardAdmin, NO_STORE } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/operations/holds — candidats T1 en attente (HOLD) ou en
 * arbitrage, avec leur motif lisible (lot 47A, CDC Opérations V1 C5, C26.1) :
 * filtres compte, issue, motif. Lecture seule.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const filters = parseHoldFilters(request.nextUrl.searchParams);
    return NextResponse.json(await new OperationDiagnosticsService().holds(filters), { headers: NO_STORE });
  } catch (e) {
    return diagnosticsError(e, 'candidats en attente');
  }
}
