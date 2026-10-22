import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { getAnomaly } from '@/services/admin/anomaly.service';
import { T6_EVALUATION_ANOMALY_PREFIX, resetT6RunsForRetry } from '@/services/home/mascot/t6-evaluation-runs';

/**
 * POST /api/admin/anomalies/:id/t6-retry — lot 78C : REPRISE EXPLICITE des
 * évaluations T6 du compte d'une anomalie « évaluations bloquées ou en
 * échec » (BO › Supervision). Les évaluations en échec, en attente d'essai ou
 * indisponibles repartent à zéro (PENDING) et une pré-génération durable du
 * compte est demandée ; l'anomalie se résout d'elle-même quand les
 * évaluations aboutissent. Journalisé (AUD-003). Aucune autre anomalie.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const adminId = await requireAdmin(request);
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Identifiant invalide', code: 'INVALID_ID' }, { status: 400 });
    const anomaly = await getAnomaly(id);
    if (!anomaly) return NextResponse.json({ error: 'Anomalie introuvable', code: 'NOT_FOUND' }, { status: 404 });
    if (anomaly.technicalDetail?.kind !== 't6_evaluation' || !anomaly.accountId) {
      return NextResponse.json({ error: 'Action réservée aux anomalies d’évaluations T6.', code: 'NOT_T6_EVALUATION' }, { status: 422 });
    }
    const relancees = await resetT6RunsForRetry(anomaly.accountId);
    await logAdminAction({
      adminId, action: 'T6_EVALUATION_RETRY', targetType: 'ANOMALY', targetId: id, result: 'SUCCESS',
      after: { relaunched: relancees },
      details: { accountId: anomaly.accountId, fingerprint: `${T6_EVALUATION_ANOMALY_PREFIX}${anomaly.accountId}` },
    });
    return NextResponse.json({ relaunched: relancees, anomaly: await getAnomaly(id) });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/anomalies] reprise T6 :', error);
    return NextResponse.json({ error: 'Reprise impossible', message: (error as Error).message, code: 'T6_RETRY_FAILED' }, { status: 500 });
  }
}
