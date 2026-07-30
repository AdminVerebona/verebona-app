/**
 * POST /api/withdrawal/prepare — CDC 6 §12.3 (authentifié).
 *
 * Retourne le récapitulatif contractuel affiché à l'étape 3 (§7.3). Aucune
 * écriture : le brouillon de courte durée évoqué au §12.3 n'apporterait rien
 * ici, l'instantané étant figé à la confirmation même — donc au moment où il
 * a valeur de preuve, et non avant.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { evaluateEligibility, ineligibilityMessage } from '@/services/withdrawal/eligibility.service';
import { buildSummary } from '@/services/withdrawal/summary.service';

export async function POST(req: NextRequest) {
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

  if (eligibility.verdict === 'ineligible' && eligibility.reason) {
    return NextResponse.json(
      {
        eligible: false,
        reason: eligibility.reason,
        message: ineligibilityMessage(eligibility.reason),
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    eligible: true,
    verdict: eligibility.verdict,
    summary: await buildSummary(eligibility, { userId: session.userId }),
  });
}
