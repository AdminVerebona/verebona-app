/**
 * POST /api/admin/communications/templates/[code]/reset — « Revenir au texte
 * livré avec l'application » (lot 70A) : `{ baseHash }`. Le gabarit redevient
 * non personnalisé (les livraisons futures le mettront à jour). Journalisé
 * (EMAIL_TEMPLATE_RESET, avant / après) ; une version est ajoutée à l'historique.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { resetToShipped } from '@/services/admin/email-template-editor.service';
import { NO_STORE, editorError, invalidBody, readJson, serverError } from '../../_shared';

export async function POST(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  let adminId: number;
  let adminEmail: string | undefined;
  try {
    adminId = await requireAdmin(request);
    adminEmail = (await getSession(request)).email;
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const body = await readJson(request);
  if (!body || typeof body.baseHash !== 'string') return invalidBody('Corps attendu : { baseHash }.');
  try {
    const r = await resetToShipped({ code: (await context.params).code, baseHash: body.baseHash, admin: { id: adminId, email: adminEmail } });
    if (!r.ok) return editorError(r);
    return NextResponse.json({ success: true, versionNo: r.versionNo, changed: r.changed }, { headers: NO_STORE });
  } catch (error) {
    return serverError('reset', error);
  }
}
