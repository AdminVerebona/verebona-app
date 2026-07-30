/**
 * GET /api/admin/withdrawals/{reference} — CDC 6 §16 et §18.
 *
 * Détail d'une demande ET son journal complet. Les deux sont indissociables :
 * l'état courant dit où l'on en est, le journal dit ce qui s'est passé — et
 * c'est la seconde question qui se pose en cas de litige.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { getByPublicReference } from '@/services/withdrawal/withdrawal.service';
import { listWithdrawalEvents } from '@/services/withdrawal/withdrawal-journal.service';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  try {
    await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const { reference } = await params;
  await ensureMigrations();

  const request = await getByPublicReference(reference);
  if (!request) {
    return NextResponse.json({ error: 'Demande introuvable.', code: 'NOT_FOUND' }, { status: 404 });
  }

  return NextResponse.json({
    request: {
      ...request,
      // Les instantanés sont rendus exploitables sans traitement côté client.
      declarationSnapshot: request.declarationSnapshotJson
        ? JSON.parse(request.declarationSnapshotJson)
        : null,
      contractSnapshot: request.contractSnapshotJson
        ? JSON.parse(request.contractSnapshotJson)
        : null,
      stripeRefundIds: JSON.parse(request.stripeRefundIds ?? '[]'),
      stripeRefundStatuses: JSON.parse(request.stripeRefundStatuses ?? '[]'),
    },
    events: await listWithdrawalEvents(reference),
  });
}
