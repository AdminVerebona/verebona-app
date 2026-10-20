/**
 * POST /api/admin/users/[id]/reassign-trial { reason } — lot 72D (décision PO
 * Q4) : « Réattribuer un essai » à un utilisateur dont l'essai a été consommé
 * (notamment par le compte personnel artificiel d'un ancien invité Duo).
 * Manuelle, motif obligatoire, journalisée. Voir `trial-reassign.service.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { reassignTrial, TRIAL_REASSIGN_MESSAGES } from '@/services/admin/trial-reassign.service';
import { parseUserId, invalidUserId } from '../_shared';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const userId = parseUserId((await context.params).id);
  if (!userId) return invalidUserId();
  const body = await request.json().catch(() => ({}));
  const reason = typeof (body as { reason?: unknown }).reason === 'string' ? (body as { reason: string }).reason.trim() : '';
  if (reason.length < 5) {
    return NextResponse.json({ error: 'REASON_REQUIRED', code: 'REASON_REQUIRED', message: 'Motif obligatoire (5 caractères au moins).' }, { status: 400 });
  }
  try {
    const r = await reassignTrial(userId);
    if (!r.ok) {
      await logAdminAction({ adminId, action: 'USER_TRIAL_REASSIGNED', targetType: 'USER', targetId: userId, result: 'DENIED', details: { error: r.error, reason } });
      return NextResponse.json({ error: r.error, code: r.error, message: TRIAL_REASSIGN_MESSAGES[r.error] }, { status: r.error === 'USER_NOT_FOUND' ? 404 : 409 });
    }
    await logAdminAction({
      adminId, action: 'USER_TRIAL_REASSIGNED', targetType: 'USER', targetId: userId, result: 'SUCCESS',
      details: { reason, grantId: r.grantId, before: r.before, after: r.after },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/users/reassign-trial] échec :', error);
    await logAdminAction({ adminId, action: 'USER_TRIAL_REASSIGNED', targetType: 'USER', targetId: userId, result: 'FAILURE', details: { reason, error: (error as Error).message } });
    return NextResponse.json({ error: 'REASSIGN_TRIAL_FAILED', code: 'REASSIGN_TRIAL_FAILED', message: 'La réattribution de l’essai a échoué.' }, { status: 500 });
  }
}
