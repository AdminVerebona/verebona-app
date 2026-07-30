/**
 * GET /api/withdrawal/{public_reference} — CDC 6 §12.5.
 *
 * « Ne retourne que les données nécessaires au demandeur authentifié ou
 * détenteur d'un jeton sécurisé. »
 *
 * La référence seule ne suffit donc pas : elle figure dans un courriel, qui
 * peut être transféré. L'appelant doit être connecté et propriétaire de la
 * demande, ou présenter un jeton de vérification valide portant sur le même
 * compte.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { getByPublicReference } from '@/services/withdrawal/withdrawal.service';
import { resolveVerificationToken } from '@/services/withdrawal/public-verification.service';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  await ensureMigrations();
  const { reference } = await params;

  const request = await getByPublicReference(reference);

  // Réponse identique qu'il existe ou non : une référence inconnue et une
  // référence appartenant à autrui ne doivent pas se distinguer.
  const notFound = NextResponse.json(
    { error: 'Demande introuvable.', code: 'NOT_FOUND' },
    { status: 404 },
  );
  if (!request) return notFound;

  let authorized = false;

  const token = req.nextUrl.searchParams.get('token');
  if (token) {
    const resolved = await resolveVerificationToken(token);
    authorized = !('failure' in resolved) && resolved.identity.accountId === request.accountId;
  } else {
    try {
      const session = await SessionService.getSession(req);
      authorized = session.userId === request.userId;
    } catch {
      authorized = false;
    }
  }

  if (!authorized) return notFound;

  return NextResponse.json({
    publicReference: request.publicReference,
    status: request.status,
    requestedAt: request.requestedAt,
    cancellationStatus: request.cancellationStatus,
    amountExpected: request.amountExpected,
    amountRefunded: request.amountRefunded,
    currency: request.currency,
    receiptSentAt: request.receiptSentAt,
    dataExportDeadlineAt: request.dataExportDeadlineAt,
  });
}
