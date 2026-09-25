/**
 * POST /api/admin/users/[id]/send-password-reset — CDC Back-Office V1 USR-A07,
 * REC-USR-03, AUD-003.
 *
 * Déclenche STRICTEMENT le parcours « Mot de passe oublié » de l'utilisateur :
 * même service (`services/auth/password-reset.service.ts`), même jeton signé,
 * même e-mail, même page. Le BO ne définit jamais de mot de passe.
 * L'ancienne version n'envoyait rien (« would be sent ») et lisait l'identité
 * de l'administrateur dans un en-tête client forgeable.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { startPasswordResetForUser } from '@/services/auth/password-reset.service';
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

  try {
    const result = await startPasswordResetForUser(userId);
    const ok = result.status === 'sent';
    await logAdminAction({
      adminId,
      action: 'USER_PASSWORD_RESET',
      targetType: 'USER',
      targetId: userId,
      result: ok ? 'SUCCESS' : 'FAILURE',
      details: { outcome: result.status },
    });
    if (result.status === 'unknown_email') {
      return NextResponse.json({ error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND', message: 'Utilisateur introuvable.' }, { status: 404 });
    }
    if (result.status === 'send_failed') {
      return NextResponse.json(
        { error: 'EMAIL_SEND_FAILED', code: 'EMAIL_SEND_FAILED', message: "L'e-mail de réinitialisation n'a pas pu être envoyé." },
        { status: 502 },
      );
    }
    return NextResponse.json({ success: true, message: "E-mail de réinitialisation envoyé à l'utilisateur." });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/users/send-password-reset] échec :', error);
    await logAdminAction({
      adminId,
      action: 'USER_PASSWORD_RESET',
      targetType: 'USER',
      targetId: userId,
      result: 'FAILURE',
      details: { error: (error as Error).message },
    });
    return NextResponse.json(
      { error: 'PASSWORD_RESET_FAILED', code: 'PASSWORD_RESET_FAILED', message: 'La réinitialisation a échoué.' },
      { status: 500 },
    );
  }
}
