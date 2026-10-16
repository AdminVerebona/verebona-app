/**
 * PATCH /api/admin/communications/email-settings — correction de l'expéditeur
 * des e-mails depuis le BO (lot 61B, audit du ticket P0 e-mails, §3-A
 * « corriger la cause établie » sans SQL).
 *
 * Corps : `{ senderName?, senderEmail?, replyToEmail?, emailsEnabled? }` (au
 * moins un champ ; tout autre champ est refusé). Réservé aux administrateurs ;
 * journalisé (`EMAIL_SETTINGS_UPDATE`, avant / après) ; renvoie la
 * configuration d'envoi effective (présence des secrets, jamais leur valeur).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import {
  getTransactionalEmailConfig,
  updateTransactionalEmailSettings,
  validateEmailSettingsPatch,
} from '@/services/admin/transactional-email-logs.service';

export async function PATCH(request: NextRequest) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const body = await request.json().catch(() => null);
  const check = validateEmailSettingsPatch(body);
  if (!check.ok) {
    return NextResponse.json(
      {
        code: 'INVALID_BODY',
        message: 'Corps attendu : { senderName?, senderEmail?, replyToEmail?, emailsEnabled? } — adresses valides, nom sans retour à la ligne.',
        rejectedFields: check.rejected,
      },
      { status: 400 },
    );
  }
  try {
    const { before, after } = await updateTransactionalEmailSettings(check.patch, adminId);
    await logAdminAction({
      adminId, action: 'EMAIL_SETTINGS_UPDATE', targetType: 'EMAIL_SETTINGS', targetId: 1, result: 'SUCCESS',
      before, after,
    });
    return NextResponse.json({ success: true, config: await getTransactionalEmailConfig() });
  } catch (error) {
    console.error('[admin/communications/email-settings] PATCH :', (error as Error)?.message ?? error);
    await logAdminAction({
      adminId, action: 'EMAIL_SETTINGS_UPDATE', targetType: 'EMAIL_SETTINGS', targetId: 1, result: 'FAILURE',
      after: { ...check.patch }, details: { code: 'EMAIL_SETTINGS_UPDATE_FAILED' },
    });
    return NextResponse.json({ code: 'EMAIL_SETTINGS_UPDATE_FAILED', message: 'Réglage d’expédition non enregistré.' }, { status: 500 });
  }
}
