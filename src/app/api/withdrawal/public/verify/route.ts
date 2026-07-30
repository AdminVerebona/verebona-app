/**
 * GET /api/withdrawal/public/verify?token=… — CDC 6 §6.3 (public).
 *
 * Résout un jeton et retourne le récapitulatif, SANS le consommer : le
 * consommateur doit pouvoir relire, revenir en arrière et réfléchir. La
 * consommation n'a lieu qu'à la confirmation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import {
  resolveVerificationToken,
  recordFailedAttempt,
} from '@/services/withdrawal/public-verification.service';
import { evaluateEligibility, ineligibilityMessage } from '@/services/withdrawal/eligibility.service';
import { buildSummary } from '@/services/withdrawal/summary.service';

const FAILURE_MESSAGES: Record<string, string> = {
  TOKEN_UNKNOWN: 'Ce lien n’est pas reconnu. Recommencez votre demande.',
  TOKEN_EXPIRED: 'Ce lien a expiré. Demandez-en un nouveau.',
  TOKEN_CONSUMED: 'Ce lien a déjà été utilisé pour confirmer une demande.',
  TOO_MANY_ATTEMPTS: 'Ce lien a été désactivé. Recommencez votre demande.',
};

export async function GET(req: NextRequest) {
  await ensureMigrations();

  const token = req.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'Jeton manquant.', code: 'MISSING_TOKEN' }, { status: 400 });
  }

  const resolved = await resolveVerificationToken(token);
  if ('failure' in resolved) {
    await recordFailedAttempt(token);
    return NextResponse.json(
      { error: FAILURE_MESSAGES[resolved.failure], code: resolved.failure },
      { status: 400 },
    );
  }

  const { identity } = resolved;
  const eligibility = await evaluateEligibility(identity.userId, identity.accountId);

  return NextResponse.json({
    verified: true,
    verdict: eligibility.verdict,
    reason: eligibility.reason ?? null,
    message: eligibility.reason ? ineligibilityMessage(eligibility.reason) : null,
    summary: await buildSummary(eligibility, {
      userId: identity.userId,
      firstName: identity.firstName,
      lastName: identity.lastName,
      email: identity.email,
    }),
  });
}
