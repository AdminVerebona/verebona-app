/**
 * POST /api/admin/ai/t2-requests/[requestId]/content — CDC BO IA LOG-UI-08,
 * WF-45 : contenu conversationnel T2, accès RESTREINT.
 *
 * Corps : `{ reason }` (justification obligatoire). POST plutôt que GET : la
 * justification ne doit pas finir dans les journaux d'URL, et la réponse ne
 * doit être mise en cache nulle part. Chaque tentative — accordée ou refusée —
 * est tracée (`ai_t2_content_access_log`). Contenu expiré ou purgé : 410.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readT2Content } from '@/services/ai/telemetry/t2-request-detail.repository';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const STATUS = { REASON_REQUIRED: 400, FORBIDDEN: 403, NOT_FOUND: 404, EXPIRED: 410 } as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { requestId } = await params;
  if (!REQUEST_ID.test(requestId)) return NextResponse.json({ error: 'INVALID_REQUEST_ID' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
  try {
    const r = await readT2Content({
      adminUserId: guard.ctx.adminUserId, requestId, reason: typeof body.reason === 'string' ? body.reason : '',
    });
    if (!r.ok) return NextResponse.json({ error: r.code, message: r.message }, { status: STATUS[r.code] });
    return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/t2-requests/[requestId]/content');
  }
}
