/**
 * GET /api/admin/communications/templates/[code] — état de l'éditeur d'un
 * modèle d'e-mail transactionnel (lot 70A) : objet, contenu ou zones,
 * variables, verrous, texte livré, historique des versions.
 *
 * PUT — enregistre `{ subject, body | zones, baseHash, note? }` après
 * validation (variables inconnues / obligatoires, contenu assaini, objet sur
 * une ligne, longueurs bornées). 422 + `issues` si refusé, 409 si le modèle a
 * changé depuis l'ouverture, 403 si le contenu est légalement verrouillé.
 * Journalisé (EMAIL_TEMPLATE_UPDATE, avant / après), y compris les refus.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { getEditorState, saveTemplate } from '@/services/admin/email-template-editor.service';
import { NO_STORE, draftOf, editorError, invalidBody, readJson, serverError } from '../_shared';

export async function GET(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  try {
    const r = await getEditorState((await context.params).code);
    if (!r.ok) return editorError(r);
    return NextResponse.json({ state: r.state }, { headers: NO_STORE });
  } catch (error) {
    return serverError('GET', error);
  }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  let adminId: number;
  let adminEmail: string | undefined;
  try {
    adminId = await requireAdmin(request);
    adminEmail = (await getSession(request)).email;
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const body = await readJson(request);
  if (!body || typeof body.subject !== 'string' || typeof body.baseHash !== 'string') {
    return invalidBody('Corps attendu : { subject, body | zones, baseHash, note? }.');
  }
  try {
    const r = await saveTemplate({
      code: (await context.params).code, ...draftOf(body), baseHash: body.baseHash, note: body.note,
      admin: { id: adminId, email: adminEmail },
    });
    if (!r.ok) return editorError(r);
    return NextResponse.json({ success: true, changed: r.changed, versionNo: r.versionNo }, { headers: NO_STORE });
  } catch (error) {
    return serverError('PUT', error);
  }
}
