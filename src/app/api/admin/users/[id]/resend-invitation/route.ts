/**
 * POST /api/admin/users/[id]/resend-invitation — CDC Back-Office V1 USR-A01.
 *
 * Renvoie l'invitation Duo en attente liée à l'utilisateur (émise par lui ou
 * reçue à son adresse), par le même e-mail que le parcours utilisateur. Le
 * destinataire n'est jamais modifiable. 409 si aucune invitation n'est
 * réémissible (motif renvoyé, UX-003). Journalisé (AUD-001).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { resendInvitation } from '@/services/admin/user-detail.service';
import { appBaseUrl } from '@/services/admin/communications.service';
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
    const result = await resendInvitation(userId, appBaseUrl());
    if (!result.ok) {
      await logAdminAction({
        adminId,
        action: 'USER_INVITATION_RESEND',
        targetType: 'USER',
        targetId: userId,
        result: 'DENIED',
        details: { code: result.code },
      });
      return NextResponse.json({ error: result.code, code: result.code, message: result.message }, { status: 409 });
    }
    // Lot 57A (P1-E) : un e-mail NON accepté par le fournisseur n'est plus
    // présenté comme « Invitation renvoyée ». L'invitation reste valable ; la
    // demande est reprise automatiquement (sauf échec définitif).
    if (result.emailStatus !== 'accepted') {
      await logAdminAction({
        adminId,
        action: 'USER_INVITATION_RESEND',
        targetType: 'USER',
        targetId: userId,
        result: 'FAILURE',
        details: { duoId: result.duoId, tokenRenewed: result.renewed, emailStatus: result.emailStatus, error: result.emailError },
      });
      return NextResponse.json(
        {
          error: 'EMAIL_NOT_ACCEPTED',
          code: 'EMAIL_NOT_ACCEPTED',
          emailStatus: result.emailStatus,
          message: result.emailStatus === 'queued'
            ? `Invitation conservée, mais l’e-mail n’a pas été accepté par le prestataire (${result.emailError ?? 'cause inconnue'}). Nouvelle tentative automatique programmée — détail dans Communications › E-mails transactionnels.`
            : `Invitation conservée, mais l’e-mail n’a pas pu être expédié (${result.emailError ?? 'cause inconnue'}). Détail dans Communications › E-mails transactionnels.`,
        },
        { status: 502 },
      );
    }
    await logAdminAction({
      adminId,
      action: 'USER_INVITATION_RESEND',
      targetType: 'USER',
      targetId: userId,
      result: 'SUCCESS',
      details: { duoId: result.duoId, tokenRenewed: result.renewed },
    });
    return NextResponse.json({ success: true, email: result.email, renewed: result.renewed, emailStatus: result.emailStatus });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/users/resend-invitation] échec :', error);
    await logAdminAction({
      adminId,
      action: 'USER_INVITATION_RESEND',
      targetType: 'USER',
      targetId: userId,
      result: 'FAILURE',
      details: { error: (error as Error).message },
    });
    return NextResponse.json(
      { error: 'RESEND_FAILED', code: 'RESEND_FAILED', message: 'Le renvoi de l’invitation a échoué.' },
      { status: 500 },
    );
  }
}
