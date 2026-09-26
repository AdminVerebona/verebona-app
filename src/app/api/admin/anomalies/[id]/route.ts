import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { getAnomaly, updateAnomalyNotes } from '@/services/admin/anomaly.service';

/**
 * Écran générique de traitement d'une anomalie — CDC Back-Office V1 SUP-006,
 * SUP-007.
 *
 * GET   : détail technique, domaine, compte / utilisateur, occurrences,
 *         récurrence (SUP-010, SUP-011), lien IA (AI-001).
 * PATCH : cause, commentaire interne, action corrective — anomalies ouvertes
 *         uniquement (l'historique ne se réécrit pas).
 */

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function errorResponse(error: unknown, context: string) {
  if (isSessionError(error)) return sessionErrorResponse(error);
  console.error(`[admin/anomalies] ${context} :`, error);
  return NextResponse.json(
    { error: 'Opération impossible', message: (error as Error).message, code: 'ANOMALY_OPERATION_FAILED' },
    { status: 500 },
  );
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Identifiant invalide', code: 'INVALID_ID' }, { status: 400 });
    const anomaly = await getAnomaly(id);
    if (!anomaly) return NextResponse.json({ error: 'Anomalie introuvable', code: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json({ anomaly });
  } catch (error) {
    return errorResponse(error, 'lecture');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Identifiant invalide', code: 'INVALID_ID' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const failure = await updateAnomalyNotes(id, {
      cause: body.cause as string | null,
      internalComment: body.internalComment as string | null,
      correctiveAction: body.correctiveAction as string | null,
    });
    if (failure === 'NOT_FOUND') return NextResponse.json({ error: 'Anomalie introuvable', code: failure }, { status: 404 });
    if (failure === 'ALREADY_RESOLVED') {
      return NextResponse.json({ error: 'Anomalie déjà résolue : elle n\'est plus modifiable.', code: failure }, { status: 409 });
    }
    // ERR-003 : l'état renvoyé est relu en base.
    return NextResponse.json({ anomaly: await getAnomaly(id) });
  } catch (error) {
    return errorResponse(error, 'mise à jour');
  }
}
