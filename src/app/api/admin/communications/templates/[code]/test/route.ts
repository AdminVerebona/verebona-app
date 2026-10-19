/**
 * POST /api/admin/communications/templates/[code]/test — envoi de test du
 * BROUILLON en cours d'édition, AVANT enregistrement (lot 70A). L'e-mail part
 * UNIQUEMENT vers l'adresse de l'administrateur connecté, lue dans la session
 * (aucun destinataire accepté du client), même si le canal est désactivé
 * (COM-010). Refusé (422) si le brouillon ne passe pas la validation.
 * Journalisé (EMAIL_TEMPLATE_TEST).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { sendDraftTest } from '@/services/admin/email-template-editor.service';
import { NO_STORE, draftOf, editorError, invalidBody, readJson, selectionOf, serverError } from '../../_shared';

export async function POST(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  let adminId: number;
  let adminEmail: string;
  let accountId: number | undefined;
  try {
    adminId = await requireAdmin(request);
    const session = await getSession(request);
    adminEmail = session.email;
    accountId = session.currentAccountId;
  } catch (error) {
    return sessionErrorResponse(error);
  }
  if (!adminEmail || !adminEmail.includes('@')) {
    return NextResponse.json({ code: 'INVALID_EMAIL', message: 'Adresse e-mail de l’administrateur introuvable.' }, { status: 400, headers: NO_STORE });
  }
  const body = await readJson(request);
  if (!body || typeof body.subject !== 'string') return invalidBody('Corps attendu : { subject, body | zones, selection? }.');
  try {
    const r = await sendDraftTest({
      code: (await context.params).code, draft: draftOf(body), selection: selectionOf(body),
      admin: { id: adminId, email: adminEmail }, accountId,
    });
    if (!r.ok) return editorError(r);
    return NextResponse.json({ success: true, to: r.to, incomplete: r.incomplete }, { headers: NO_STORE });
  } catch (error) {
    return serverError('test', error);
  }
}
