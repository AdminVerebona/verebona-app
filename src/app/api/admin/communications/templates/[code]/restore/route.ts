/**
 * POST /api/admin/communications/templates/[code]/restore — restaure une
 * version de l'historique (lot 70A) : `{ versionId, baseHash }`. La version
 * est revalidée comme un enregistrement ; le gabarit reste personnalisé.
 * Journalisé (EMAIL_TEMPLATE_RESTORE, avant / après).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { restoreVersion } from '@/services/admin/email-template-editor.service';
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
  if (!body || typeof body.baseHash !== 'string') return invalidBody('Corps attendu : { versionId, baseHash }.');
  try {
    const r = await restoreVersion({ code: (await context.params).code, versionId: body.versionId, baseHash: body.baseHash, admin: { id: adminId, email: adminEmail } });
    if (!r.ok) return editorError(r);
    return NextResponse.json({ success: true, versionNo: r.versionNo }, { headers: NO_STORE });
  } catch (error) {
    return serverError('restore', error);
  }
}
