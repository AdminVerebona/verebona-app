/**
 * GET /api/admin/ai/t2-requests/[requestId] — CDC BO IA LOG-UI-07.
 *
 * Sources réellement utilisées par la réponse (type, identifiant, titre figé,
 * rang, pertinence). Aucun contenu conversationnel ni extrait de document :
 * celui-ci passe par la route à accès restreint `…/content` (LOG-UI-08).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getT2RequestSources } from '@/services/ai/telemetry/t2-request-detail.repository';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { requestId } = await params;
  if (!REQUEST_ID.test(requestId)) return NextResponse.json({ error: 'INVALID_REQUEST_ID' }, { status: 400 });
  try {
    return NextResponse.json({ requestId, sources: await getT2RequestSources(requestId) });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/t2-requests/[requestId]');
  }
}
