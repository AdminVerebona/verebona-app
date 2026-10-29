/**
 * DELETE /api/admin/users/[id]/sessions/[sessionId] — déconnecter UNE session
 * d'un utilisateur depuis le BO (lot 92, CDC 18 §20, §26). Même révocation
 * unitaire que « Déconnecter » côté utilisateur (effet immédiat), journalisée
 * `USER_SESSION_REVOKE`. Désactivé par défaut (USR-D03, `AUTH_BO_SESSION_LIST`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { revokeUserSessionByPublicId } from '@/lib/auth/session-registry';
import { boSessionListEnabled } from '@/lib/auth/bo-session-list';
import { logUserActivity } from '@/lib/audit-logger';
import { parseUserId, invalidUserId } from '../../_shared';

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string; sessionId: string }> }) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const params = await context.params;
  const userId = parseUserId(params.id);
  if (!userId) return invalidUserId();
  if (!boSessionListEnabled()) {
    return NextResponse.json({ error: 'FEATURE_DISABLED', code: 'FEATURE_DISABLED', message: 'Fonction désactivée (AUTH_BO_SESSION_LIST).' }, { status: 404 });
  }
  const publicId = String(params.sessionId ?? '');
  try {
    const revoked = /^[A-Za-z0-9_-]{10,64}$/.test(publicId)
      ? await revokeUserSessionByPublicId(userId, publicId, 'ADMIN_SESSION_REVOKE')
      : null;
    await logAdminAction({
      adminId,
      action: 'USER_SESSION_REVOKE',
      targetType: 'USER',
      targetId: userId,
      result: revoked ? 'SUCCESS' : 'DENIED',
      details: revoked
        ? { clientType: revoked.clientType, deviceLabel: revoked.deviceLabel, browserLabel: revoked.browserLabel }
        : { error: 'SESSION_NOT_FOUND' },
    });
    if (!revoked) {
      return NextResponse.json({ error: 'SESSION_NOT_FOUND', code: 'SESSION_NOT_FOUND', message: 'Cette session n’est plus active.' }, { status: 404 });
    }
    void logUserActivity({
      activityType: 'SESSION_REVOKED',
      userId,
      userEmail: '',
      details: { scope: 'single', by: 'admin', adminId, sid: revoked.sid, reason: 'ADMIN_SESSION_REVOKE' },
      request,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    await logAdminAction({
      adminId, action: 'USER_SESSION_REVOKE', targetType: 'USER', targetId: userId, result: 'FAILURE',
      details: { error: (error as Error).message },
    });
    console.error('[admin/users/sessions] échec :', error);
    return NextResponse.json({ error: 'SESSION_REVOKE_FAILED', code: 'SESSION_REVOKE_FAILED', message: 'La déconnexion de la session a échoué.' }, { status: 500 });
  }
}
