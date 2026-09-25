/**
 * POST /api/admin/users/[id]/force-logout — CDC Back-Office V1 USR-A06, AUD-003.
 *
 * « Déconnecter toutes les sessions » : révocation globale réelle
 * (`revokeAllUserSessions`) — tout jeton, d'accès comme de renouvellement,
 * émis avant maintenant est refusé. La version précédente ne révoquait rien
 * (« there's no session table ») et vérifiait un Bearer avec un secret de
 * repli, alors que le BO s'authentifie par cookie.
 *
 * Le détail des sessions n'est ni listé ni renvoyé (USR-D03).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { forceLogoutUser, UserAdminError } from '@/services/admin/user-admin.service';
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

  try {
    const { revokedBefore } = await forceLogoutUser(userId);
    await logAdminAction({
      adminId,
      action: 'USER_FORCE_LOGOUT',
      targetType: 'USER',
      targetId: userId,
      result: 'SUCCESS',
      details: { revokedBefore: revokedBefore.toISOString() },
    });
    return NextResponse.json({ success: true, revokedBefore: revokedBefore.toISOString() });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    const denied = error instanceof UserAdminError;
    await logAdminAction({
      adminId,
      action: 'USER_FORCE_LOGOUT',
      targetType: 'USER',
      targetId: userId,
      result: denied ? 'DENIED' : 'FAILURE',
      details: { error: denied ? error.code : (error as Error).message },
    });
    if (denied) return userAdminErrorResponse(error);
    console.error('[admin/users/force-logout] échec :', error);
    return NextResponse.json(
      { error: 'FORCE_LOGOUT_FAILED', code: 'FORCE_LOGOUT_FAILED', message: 'La déconnexion des sessions a échoué.' },
      { status: 500 },
    );
  }
}
