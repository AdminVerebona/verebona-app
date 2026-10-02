/**
 * POST /api/admin/ai/assistant-settings/requests/[requestId] — double
 * validation d'un réglage sensible de l'assistant (CDC Assistant §32.7, D-J1).
 *
 * Corps : { decision: 'approve' | 'reject' | 'cancel' }. L'accord exige un
 * administrateur DISTINCT du demandeur ; l'annulation, le demandeur.
 * Chaque décision (et chaque refus) est journalisée.
 */
import { NextRequest, NextResponse } from 'next/server';
import { AssistantSettingRefused, decideAssistantSettingRequest } from '@/services/verebona-assistant/config/assistant-settings';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { requestId } = await params;
  if (!/^\d+$/.test(requestId)) return NextResponse.json({ error: 'INVALID_ID', message: 'Identifiant illisible.' }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { decision?: unknown } | null;
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'reject' && decision !== 'cancel') {
    return NextResponse.json({ error: 'INVALID_BODY', message: '`decision` : approve, reject ou cancel.' }, { status: 400 });
  }
  try {
    return NextResponse.json(await decideAssistantSettingRequest({ requestId: Number(requestId), adminId: guard.ctx.adminUserId, decision }));
  } catch (e) {
    if (e instanceof AssistantSettingRefused) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    return toErrorResponse(e, 'POST /api/admin/ai/assistant-settings/requests/[requestId]');
  }
}
