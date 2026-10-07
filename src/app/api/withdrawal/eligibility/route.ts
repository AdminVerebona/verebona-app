/**
 * GET /api/withdrawal/eligibility — CDC 6 §12.1 (authentifié).
 *
 * Alimente l'affichage de « Mon compte → Abonnement » (§6.2).
 *
 * Lot 32 (PO-Q2) : plus de suivi de demande — la rétractation supprime le
 * compte immédiatement, il n'y a plus rien à suivre depuis Mon compte.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { evaluateEligibility, ineligibilityMessage } from '@/services/withdrawal/eligibility.service';
import { buildSummary } from '@/services/withdrawal/summary.service';
import { shouldOfferWithdrawal } from '@/services/withdrawal/withdrawal-window';

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

  // Une éligibilité indéterminable (panne) n'est jamais présentée comme un
  // refus définitif (§5.5) ; elle ne propose rien non plus (lot 32).
  const eligible = eligibility.verdict !== 'ineligible';

  // Lot 26 : la carte et le bouton « Renoncer au contrat ici » disparaissent à
  // la clôture du délai (J+15 à 00 h 00, Paris). Décidé ici, côté serveur, par
  // la même fonction que le refus de l'API : le client ne recalcule rien.
  // Lot 32 (PO-Q1) : le délai court à partir du PAIEMENT.
  const offerWithdrawal = shouldOfferWithdrawal({
    verdict: eligibility.verdict,
    subscribedAt: eligibility.contract?.paidAt ?? null,
  });

  return NextResponse.json({
    eligible,
    offerWithdrawal,
    verdict: eligibility.verdict,
    reason: eligibility.reason ?? null,
    message: eligibility.reason ? ineligibilityMessage(eligibility.reason) : null,
    contract: eligibility.contract
      ? await buildSummary(eligibility, { userId: session.userId })
      : null,
  });
}
