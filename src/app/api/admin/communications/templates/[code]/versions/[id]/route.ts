/**
 * GET /api/admin/communications/templates/[code]/versions/[id] — contenu
 * complet d'une version de l'historique (comparaison, lot 70A). Lecture seule.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { getVersion } from '@/services/admin/email-template-editor.service';
import { NO_STORE, editorError, serverError } from '../../../_shared';

export async function GET(request: NextRequest, context: { params: Promise<{ code: string; id: string }> }) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  try {
    const { code, id } = await context.params;
    const r = await getVersion(code, id);
    if (!r.ok) return editorError(r);
    return NextResponse.json({ version: r.version }, { headers: NO_STORE });
  } catch (error) {
    return serverError('version', error);
  }
}
