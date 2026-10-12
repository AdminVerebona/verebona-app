import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { parseOperationListFilters } from '@/services/business-operations/diagnostics/model';
import { OperationDiagnosticsService } from '@/services/business-operations/diagnostics/service';
import { diagnosticsError, guardAdmin, NO_STORE } from './_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/operations — liste filtrable et paginée des Opérations (lot
 * 47A, CDC Opérations V1 C26.1, B23) : compte, type (`NULL` = non qualifié),
 * statut, état (actives / invalidées / fusionnées), sans bien, sans source,
 * période de création. Lecture seule.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const filters = parseOperationListFilters(request.nextUrl.searchParams);
    return NextResponse.json(await new OperationDiagnosticsService().list(filters), { headers: NO_STORE });
  } catch (e) {
    return diagnosticsError(e, 'liste');
  }
}
