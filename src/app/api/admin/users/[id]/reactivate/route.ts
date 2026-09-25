/**
 * POST /api/admin/users/[id]/reactivate — CDC Back-Office V1 USR-A02, USR-A04,
 * USR-A05, AUD-003.
 *
 * Réactive l'utilisateur : accès restauré avec les identifiants existants,
 * sans changement de mot de passe forcé, sans e-mail. Identité de
 * l'administrateur issue de la session serveur (`requireAdmin`), jamais d'un
 * en-tête client.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { reactivateUser, UserAdminError } from '@/services/admin/user-admin.service';
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
    const change = await reactivateUser(userId);
    await logAdminAction({
      adminId,
      action: 'USER_REACTIVATE',
      targetType: 'USER',
      targetId: userId,
      result: 'SUCCESS',
      before: change.before,
      after: change.after,
    });
    return NextResponse.json({ success: true, status: change.after.status });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    const denied = error instanceof UserAdminError;
    await logAdminAction({
      adminId,
      action: 'USER_REACTIVATE',
      targetType: 'USER',
      targetId: userId,
      result: denied ? 'DENIED' : 'FAILURE',
      after: { status: 'ACTIVE' },
      details: { error: denied ? error.code : (error as Error).message },
    });
    if (denied) return userAdminErrorResponse(error);
    console.error('[admin/users/reactivate] échec :', error);
    return NextResponse.json(
      { error: 'REACTIVATE_FAILED', code: 'REACTIVATE_FAILED', message: 'La réactivation a échoué.' },
      { status: 500 },
    );
  }
}
