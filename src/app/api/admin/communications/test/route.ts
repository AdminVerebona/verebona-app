/**
 * POST /api/admin/communications/test — CDC Back-Office V1 COM-010, REC-MOD-02.
 *
 * Corps : `{ eventCode }`. L'e-mail de test part UNIQUEMENT vers l'adresse de
 * l'administrateur connecté, lue dans la session : aucun destinataire n'est
 * accepté du client. Les variables sont celles du propre compte de
 * l'administrateur (COM-007) ; le test part même si le canal est désactivé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { emailService } from '@/lib/email/email-service';
import {
  appBaseUrl,
  findChannelDefinition,
  findEmailTemplate,
  listEventDefinitions,
  loadAdminPreviewContext,
  loadEmailTemplateCodes,
  resolveTemplateVariables,
} from '@/services/admin/communications.service';

export async function POST(request: NextRequest) {
  let adminId: number;
  let adminEmail: string;
  let currentAccountId: number | undefined;
  try {
    adminId = await requireAdmin(request);
    const session = await getSession(request);
    adminEmail = session.email;
    currentAccountId = session.currentAccountId;
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const body = (await request.json().catch(() => null)) as { eventCode?: unknown } | null;
  if (!body || typeof body.eventCode !== 'string') {
    return NextResponse.json({ code: 'INVALID_BODY', message: 'Corps attendu : { eventCode }.' }, { status: 400 });
  }
  if (!adminEmail || !adminEmail.includes('@')) {
    return NextResponse.json({ code: 'INVALID_EMAIL', message: 'Adresse e-mail de l’administrateur introuvable.' }, { status: 400 });
  }

  try {
    const defs = listEventDefinitions(await loadEmailTemplateCodes());
    const found = findChannelDefinition(defs, body.eventCode, 'email');
    const template = found?.event.emailTemplateCode ? await findEmailTemplate(found.event.emailTemplateCode) : null;
    if (!found || !template) {
      return NextResponse.json(
        { code: 'NO_EMAIL_TEMPLATE', message: 'Aucun gabarit e-mail pour ce modèle : envoi de test impossible.' },
        { status: 404 },
      );
    }

    const ctx = await loadAdminPreviewContext(adminId, currentAccountId);
    const { variables, missingCount } = resolveTemplateVariables([template.subject, template.body], ctx, appBaseUrl());
    const result = await emailService.sendTest(template.type, adminEmail, variables);
    if (!result.success) {
      return NextResponse.json(
        { code: 'TEST_SEND_FAILED', message: 'Échec de l’envoi de l’e-mail de test.' },
        { status: 502 },
      );
    }
    return NextResponse.json({ success: true, to: adminEmail, incomplete: missingCount > 0, missingCount });
  } catch (error) {
    console.error('[admin/communications/test] POST :', error);
    return NextResponse.json({ code: 'TEST_SEND_FAILED', message: 'Échec de l’envoi de l’e-mail de test.' }, { status: 500 });
  }
}
