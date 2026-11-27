import { NextRequest, NextResponse } from 'next/server';
import { apiError, type ErrorCode } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { reactivateAsset } from '@/services/assets/asset-reactivation.service';

/**
 * POST /api/assets/[id]/reactivate — carte #849 (A2) : « Remettre en service »
 * un bien TRANSMIS. Contrôle atomique du quota de biens actifs (refus clair si
 * plein), idempotent (déjà en service → 200 `alreadyActive`). Bien d'un autre
 * compte : 404 (jamais distingué d'un bien inconnu).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    const { id } = await params;
    const assetId = Number.parseInt(id, 10);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');
    // Compte en lecture seule (essai échu, impayé…) : aucune écriture.
    const refus = await refuserSiLectureSeule(session.currentAccountId);
    if (refus) return refus;
    const r = await reactivateAsset({ accountId: session.currentAccountId, userId: session.userId ?? null, assetId });
    if (!r.ok) return apiError(r.status, r.code as ErrorCode, r.message, 'details' in r ? r.details : undefined);
    return NextResponse.json({ assetId, status: 'EN_SERVICE', alreadyActive: r.alreadyActive }, { status: 200 });
  } catch (error) {
    console.error('[assets/reactivate] error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Une erreur interne est survenue.');
  }
}
