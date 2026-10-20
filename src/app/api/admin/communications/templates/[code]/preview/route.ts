/**
 * POST /api/admin/communications/templates/[code]/preview — prévisualisation
 * du BROUILLON en cours d'édition (lot 70A), non enregistré : `{ subject,
 * body | zones, selection? }` (sans brouillon : texte en base). Même rendu que
 * l'envoi réel (mise en page de la charte pour un gabarit texte), données du
 * propre compte de l'administrateur (COM-007, COM-008). Les refus de
 * validation sont renvoyés (`issues`) sans bloquer l'aperçu. Lecture seule.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { renderDraft } from '@/services/admin/email-template-editor.service';
import { NO_STORE, draftOf, editorError, invalidBody, previewEventOf, readJson, selectionOf, serverError } from '../../_shared';

export async function POST(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  let adminId: number;
  let accountId: number | undefined;
  try {
    adminId = await requireAdmin(request);
    accountId = (await getSession(request)).currentAccountId;
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const body = await readJson(request);
  if (!body) return invalidBody();
  try {
    const hasDraft = typeof body.subject === 'string';
    const r = await renderDraft({
      code: (await context.params).code,
      draft: hasDraft ? draftOf(body) : null,
      selection: selectionOf(body),
      adminId,
      accountId,
      eventCode: previewEventOf(body),
    });
    if (!r.ok) return editorError(r);
    return NextResponse.json({ ...r.render, valid: r.valid }, { headers: NO_STORE });
  } catch (error) {
    return serverError('preview', error);
  }
}
