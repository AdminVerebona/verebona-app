/**
 * POST /api/auth/mfa/recovery-codes/confirm — l'utilisateur confirme avoir
 * conservé ses 10 codes (case explicite) ; fin de l'enrôlement provisoire →
 * session COMPLÈTE de niveau 2 (lot 110B, ticket §2).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { withPending, mfaJson, mfaError, bodyOf, expiredResponse } from '@/lib/auth/mfa/http';
import { markRecoveryConfirmed } from '@/lib/auth/mfa/db';
import { completeStrongSession } from '@/lib/auth/mfa/primary';
import { regenerateRecoveryCodes } from '@/lib/auth/mfa/recovery-codes';
import { auditMfa } from '@/lib/auth/mfa/notify';

export async function POST(request: NextRequest) {
  return withPending(request, async (ctx) => {
    if (ctx.purpose !== 'enroll' || !ctx.factorEnrolledAt || !ctx.enrolledFactor) return mfaError(409, 'MFA_WRONG_STEP', 'Configurez d’abord votre méthode de sécurité.');
    const body = await bodyOf(request);
    // Codes perdus avant la confirmation (rechargement de la page) : le facteur
    // vient d'être prouvé dans CE contexte — nouveaux codes, anciens invalidés.
    if (body.regenerate === true) {
      const codes = await regenerateRecoveryCodes(ctx.userId);
      auditMfa(request, 'MFA_RECOVERY_CODES_REGENERATED', ctx.userId, { reason: 'enrollment_reload', count: codes.length });
      return mfaJson({ success: true, recoveryCodes: codes });
    }
    if (body.confirmed !== true) return mfaError(400, 'CONFIRMATION_REQUIRED', 'Confirmez avoir conservé vos codes de récupération.');
    await markRecoveryConfirmed(ctx.userId);
    const carrier = NextResponse.json({});
    const done = await completeStrongSession(request, carrier, ctx, ctx.enrolledFactor);
    if (!done.ok) return done.code === 'MFA_EXPIRED' ? expiredResponse() : mfaError(403, done.code, 'Connexion impossible pour ce compte.');
    const res = mfaJson({ success: true, redirectTo: done.redirectTo });
    for (const c of carrier.cookies.getAll()) res.cookies.set(c);
    return res;
  });
}
