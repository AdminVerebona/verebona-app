/**
 * GET  /api/admin/gdpr — registre RGPD : demandes ouvertes (défaut) ou
 *      historique, tri, pagination, compteurs (CDC BO GDP-001 à GDP-006,
 *      GDP-018, GDP-019).
 * POST /api/admin/gdpr — création d'une demande manuelle reçue hors
 *      application (GDP-010, GDP-011). L'échéance est calculée ici, jamais
 *      reçue. En-tête `Idempotency-Key` recommandé (ERR-002). Journalisé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { parseListQuery } from '@/services/gdpr/rules';
import { createManualRequest, listGdprRequests } from '@/services/gdpr/gdpr-request.repository';
import { gdprApiError } from '@/services/gdpr/api-errors';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  try {
    const query = parseListQuery(new URL(request.url).searchParams);
    const result = await listGdprRequests(query);
    return NextResponse.json({ ...result, view: query.view, sort: query.sort, dir: query.dir });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/gdpr] liste :', error);
    return NextResponse.json(
      { error: 'GDPR_LIST_FAILED', message: 'Impossible de charger les demandes RGPD.' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    const e = gdprApiError('INVALID_FIELD', 'body');
    return NextResponse.json(e.body, { status: e.status });
  }

  try {
    const outcome = await createManualRequest(body, adminId, request.headers.get('idempotency-key'));
    if (!outcome.ok) {
      const e = gdprApiError(outcome.error, outcome.field);
      return NextResponse.json(e.body, { status: e.status });
    }
    const { request: created, replayed } = outcome.value;
    if (!replayed) {
      await logAdminAction({
        adminId,
        action: 'GDPR_REQUEST_CREATE',
        targetType: 'GDPR_REQUEST',
        targetId: created.id,
        result: 'SUCCESS',
        after: {
          userId: created.userId, accountId: created.accountId, rightType: created.rightType,
          channel: created.channel, status: created.status, receivedDate: created.receivedDate, dueDate: created.dueDate,
        },
      });
    }
    return NextResponse.json({ request: created, replayed }, { status: replayed ? 200 : 201 });
  } catch (error) {
    console.error('[admin/gdpr] création :', error);
    await logAdminAction({
      adminId, action: 'GDPR_REQUEST_CREATE', targetType: 'GDPR_REQUEST', targetId: null,
      result: 'FAILURE', details: { error: (error as Error).message },
    });
    return NextResponse.json(
      { error: 'GDPR_CREATE_FAILED', message: 'La création de la demande a échoué. Rechargez la liste avant de réessayer.' },
      { status: 500 },
    );
  }
}
