import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { positiveInt } from '@/services/business-operations/diagnostics/model';
import { OperationDiagnosticsService } from '@/services/business-operations/diagnostics/service';
import { diagnosticsError, guardAdmin, NO_STORE } from '../_shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/operations/[id] — détail complet d'une Opération (lot 47A,
 * CDC Opérations V1 ch. 21, C26.1) : identité, biens / équipements, sources
 * (rôle, autorité, provenance, motif lisible), composantes et leurs sources,
 * références, détails par type, parent / enfants, fusion, historique,
 * décisions de rapprochement, Agenda et suppressions, candidats T1 et leur
 * issue T3, dernier passage T3 du compte. Lecture seule.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const id = positiveInt((await params).id);
  if (!id) return NextResponse.json({ error: 'Identifiant invalide', code: 'INVALID_ID' }, { status: 400, headers: NO_STORE });
  try {
    const detail = await new OperationDiagnosticsService().detail(id);
    if (!detail) return NextResponse.json({ error: 'Opération introuvable', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
    return NextResponse.json(detail, { headers: NO_STORE });
  } catch (e) {
    return diagnosticsError(e, `détail ${id}`);
  }
}
