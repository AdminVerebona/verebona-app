/**
 * POST /api/admin/gdpr/[id]/reopen — réouverture d'une demande manuelle
 * traitée (CDC BO GDP-015 à GDP-017, AUD-003).
 *
 * Aucun motif requis. L'échéance réglementaire initiale est conservée.
 * L'administrateur et la date sont tracés sur la demande et au journal.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { reopenManualRequest } from '@/services/gdpr/gdpr-request.repository';
import { gdprApiError, parseId } from '@/services/gdpr/api-errors';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  try {
    const outcome = await reopenManualRequest(id, adminId);
    if (!outcome.ok) {
      await logAdminAction({
        adminId, action: 'GDPR_REQUEST_REOPEN', targetType: 'GDPR_REQUEST', targetId: id,
        result: 'DENIED', details: { reason: outcome.error },
      });
      const e = gdprApiError(outcome.error);
      return NextResponse.json(e.body, { status: e.status });
    }
    const { before, after } = outcome.value;
    await logAdminAction({
      adminId, action: 'GDPR_REQUEST_REOPEN', targetType: 'GDPR_REQUEST', targetId: id,
      result: 'SUCCESS',
      before: { status: before.status, processedAt: before.processedAt, dueDate: before.dueDate },
      after: { status: after.status, reopenedAt: after.reopenedAt, dueDate: after.dueDate },
    });
    return NextResponse.json({ request: after });
  } catch (error) {
    console.error('[admin/gdpr/:id/reopen] échec :', error);
    await logAdminAction({
      adminId, action: 'GDPR_REQUEST_REOPEN', targetType: 'GDPR_REQUEST', targetId: id,
      result: 'FAILURE', details: { error: (error as Error).message },
    });
    return NextResponse.json(
      { error: 'GDPR_REOPEN_FAILED', message: 'La réouverture a échoué. Rechargez la demande avant de réessayer.' },
      { status: 500 },
    );
  }
}
