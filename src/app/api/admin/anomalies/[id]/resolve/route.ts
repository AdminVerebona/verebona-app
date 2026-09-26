import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { getAnomaly, resolveAnomalyManually } from '@/services/admin/anomaly.service';

/**
 * POST /api/admin/anomalies/:id/resolve — « Marquer résolue » (CDC BO SUP-007).
 *
 * Corps : { cause?, internalComment?, correctiveAction } — l'action
 * corrective est exigée (elle figure dans l'historique, SUP-H01).
 * Idempotent (ERR-002) : une anomalie déjà résolue répond 409 sans nouvelle
 * écriture. Journalisé (AUD-003) par le service.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const adminId = await requireAdmin(request);
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Identifiant invalide', code: 'INVALID_ID' }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const failure = await resolveAnomalyManually(id, adminId, {
      cause: body.cause as string | null,
      internalComment: body.internalComment as string | null,
      correctiveAction: body.correctiveAction as string | null,
    });
    switch (failure) {
      case 'NOT_FOUND':
        return NextResponse.json({ error: 'Anomalie introuvable', code: failure }, { status: 404 });
      case 'ALREADY_RESOLVED':
        return NextResponse.json({ error: 'Cette anomalie est déjà résolue.', code: failure }, { status: 409 });
      case 'CORRECTIVE_ACTION_REQUIRED':
        return NextResponse.json({ error: 'Renseignez l\'action corrective avant de marquer l\'anomalie résolue.', code: failure }, { status: 422 });
    }
    return NextResponse.json({ anomaly: await getAnomaly(id) });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/anomalies] résolution :', error);
    return NextResponse.json(
      { error: 'Résolution impossible', message: (error as Error).message, code: 'ANOMALY_RESOLVE_FAILED' },
      { status: 500 },
    );
  }
}
