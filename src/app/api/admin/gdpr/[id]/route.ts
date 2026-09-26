/**
 * GET   /api/admin/gdpr/[id] — détail d'une demande RGPD (dont commentaire
 *       interne, GDP-013 : jamais exposé à l'utilisateur).
 * PATCH /api/admin/gdpr/[id] — modification d'une demande MANUELLE non
 *       traitée (GDP-014) ; échéance recalculée côté serveur si la date de
 *       réception change. Refus : demande système (GDP-007, GDP-008),
 *       demande traitée (GDP-015), statut à rebours (GDP-012), échéance
 *       fournie (GDP-011). Journalisé, refus compris.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { getGdprRequest, updateManualRequest } from '@/services/gdpr/gdpr-request.repository';
import { gdprApiError, parseId } from '@/services/gdpr/api-errors';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const id = parseId((await params).id);
  if (!id) {
    const e = gdprApiError('NOT_FOUND');
    return NextResponse.json(e.body, { status: e.status });
  }
  try {
    const found = await getGdprRequest(id);
    if (!found) {
      const e = gdprApiError('NOT_FOUND');
      return NextResponse.json(e.body, { status: e.status });
    }
    return NextResponse.json({ request: found });
  } catch (error) {
    console.error('[admin/gdpr/:id] lecture :', error);
    return NextResponse.json({ error: 'GDPR_READ_FAILED', message: 'Impossible de charger la demande.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const id = parseId((await params).id);
  if (!id) {
    const e = gdprApiError('NOT_FOUND');
    return NextResponse.json(e.body, { status: e.status });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    const e = gdprApiError('INVALID_FIELD', 'body');
    return NextResponse.json(e.body, { status: e.status });
  }

  try {
    const outcome = await updateManualRequest(id, body, adminId);
    if (!outcome.ok) {
      if (outcome.error === 'SYSTEM_REQUEST_READ_ONLY' || outcome.error === 'REQUEST_DONE_FROZEN') {
        await logAdminAction({
          adminId, action: 'GDPR_REQUEST_UPDATE', targetType: 'GDPR_REQUEST', targetId: id,
          result: 'DENIED', after: body, details: { reason: outcome.error },
        });
      }
      const e = gdprApiError(outcome.error, outcome.field);
      return NextResponse.json(e.body, { status: e.status });
    }
    const { before, after, dueDateRecomputed } = outcome.value;
    const pick = (r: typeof before) => ({
      userId: r.userId, accountId: r.accountId, rightType: r.rightType, channel: r.channel,
      status: r.status, receivedDate: r.receivedDate, dueDate: r.dueDate,
      internalComment: r.internalComment, result: r.result,
    });
    await logAdminAction({
      adminId, action: 'GDPR_REQUEST_UPDATE', targetType: 'GDPR_REQUEST', targetId: id,
      result: 'SUCCESS', before: pick(before), after: pick(after), details: { dueDateRecomputed },
    });
    return NextResponse.json({ request: after, dueDateRecomputed });
  } catch (error) {
    console.error('[admin/gdpr/:id] modification :', error);
    await logAdminAction({
      adminId, action: 'GDPR_REQUEST_UPDATE', targetType: 'GDPR_REQUEST', targetId: id,
      result: 'FAILURE', after: body, details: { error: (error as Error).message },
    });
    return NextResponse.json(
      { error: 'GDPR_UPDATE_FAILED', message: 'La modification a échoué. Rechargez la demande avant de réessayer.' },
      { status: 500 },
    );
  }
}
