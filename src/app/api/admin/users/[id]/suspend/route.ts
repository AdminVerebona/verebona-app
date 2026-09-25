/**
 * POST /api/admin/users/[id]/suspend — CDC Back-Office V1 USR-A02, USR-A03,
 * USR-A05, USR-A09, AUD-003.
 *
 * Désactive l'utilisateur (titulaire compris) et révoque immédiatement toutes
 * ses sessions. Aucun motif obligatoire (un motif facultatif est journalisé),
 * aucun e-mail. Refus 409 LAST_ADMIN pour le dernier administrateur actif.
 *
 * L'identité de l'administrateur provient EXCLUSIVEMENT de la session serveur
 * (`requireAdmin`) — l'ancien en-tête `x-admin-user-id` était forgeable.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { suspendUser, UserAdminError } from '@/services/admin/user-admin.service';
import { parseUserId, invalidUserId, userAdminErrorResponse } from '../_shared';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const userId = parseUserId((await context.params).id);
  if (!userId) return invalidUserId();

  const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

  try {
    const change = await suspendUser(userId);
    await logAdminAction({
      adminId,
      action: 'USER_SUSPEND',
      targetType: 'USER',
      targetId: userId,
      result: 'SUCCESS',
      before: change.before,
      after: change.after,
      details: { reason, sessionsRevoked: true },
    });
    return NextResponse.json({ success: true, status: change.after.status, sessionsRevoked: true });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    const denied = error instanceof UserAdminError;
    await logAdminAction({
      adminId,
      action: 'USER_SUSPEND',
      targetType: 'USER',
      targetId: userId,
      result: denied ? 'DENIED' : 'FAILURE',
      after: { status: 'SUSPENDED' },
      details: { reason, error: denied ? error.code : (error as Error).message },
    });
    if (denied) return userAdminErrorResponse(error);
    console.error('[admin/users/suspend] échec :', error);
    return NextResponse.json(
      { error: 'SUSPEND_FAILED', code: 'SUSPEND_FAILED', message: 'La désactivation a échoué.' },
      { status: 500 },
    );
  }
}
