/**
 * GET /api/withdrawal/eligibility — CDC 6 §12.1 (authentifié).
 *
 * Alimente l'affichage de « Mon compte → Abonnement » (§6.2).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { evaluateEligibility, ineligibilityMessage } from '@/services/withdrawal/eligibility.service';
import { buildSummary } from '@/services/withdrawal/summary.service';
import { getActiveRequestForAccount } from '@/services/withdrawal/withdrawal.service';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const accountId = session.currentAccountId;
  if (!accountId) {
    return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  }

  await ensureMigrations();

  const eligibility = await evaluateEligibility(session.userId, accountId);
  const existing = await getActiveRequestForAccount(accountId);

  // Une éligibilité indéterminable n'est jamais présentée comme un refus
  // (§5.5) : l'utilisateur peut déclarer, l'examen se fera ensuite.
  const eligible = eligibility.verdict !== 'ineligible';

  return NextResponse.json({
    eligible,
    verdict: eligibility.verdict,
    reason: eligibility.reason ?? null,
    message: eligibility.reason ? ineligibilityMessage(eligibility.reason) : null,
    contract: eligibility.contract
      ? await buildSummary(eligibility, { userId: session.userId })
      : null,
    existingRequest: existing
      ? {
          publicReference: existing.publicReference,
          status: existing.status,
          requestedAt: existing.requestedAt,
          cancellationStatus: existing.cancellationStatus,
          amountExpected: existing.amountExpected,
          amountRefunded: existing.amountRefunded,
          dataExportDeadlineAt: existing.dataExportDeadlineAt,
        }
      : null,
  });
}
