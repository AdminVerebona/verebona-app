/**
 * POST /api/auth/mfa/totp/verify — seconde étape par l'application
 * d'authentification (lot 110B). Contexte provisoire « challenge » exigé ;
 * limiteur compte + IP ; anti-rejeu par intervalle ; succès → session
 * COMPLÈTE de niveau 2.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { withPending, mfaJson, mfaError, bodyOf, expiredResponse } from '@/lib/auth/mfa/http';
import { verifyTotp } from '@/lib/auth/mfa/totp';
import { mfaBlockedResponse, recordMfaFailure, recordMfaSuccess } from '@/lib/auth/mfa/throttle';
import { completeStrongSession } from '@/lib/auth/mfa/primary';
import { MFA_MESSAGES } from '@/lib/auth/mfa/constants';

export async function POST(request: NextRequest) {
  return withPending(request, async (ctx) => {
    if (ctx.purpose !== 'challenge') return mfaError(409, 'MFA_WRONG_STEP', 'Terminez d’abord la configuration de votre sécurité.');
    const blocked = await mfaBlockedResponse(request, ctx.userId);
    if (blocked) return blocked;
    const body = await bodyOf(request);
    const r = await verifyTotp(ctx.userId, body.code);
    if (r === 'key_unavailable') return mfaError(503, 'MFA_METHOD_UNAVAILABLE', 'Vérification momentanément impossible. Utilisez une autre méthode ou réessayez plus tard.');
    if (r !== 'ok') {
      await recordMfaFailure(request, ctx.userId, r === 'replayed' ? 'totp_replayed' : 'totp');
      return mfaError(401, 'INVALID_MFA_CODE', MFA_MESSAGES.invalidCode);
    }
    await recordMfaSuccess(ctx.userId);
    const carrier = NextResponse.json({});
    const done = await completeStrongSession(request, carrier, ctx, 'otp');
    if (!done.ok) return done.code === 'MFA_EXPIRED' ? expiredResponse() : mfaError(403, done.code, 'Connexion impossible pour ce compte.');
    const res = mfaJson({ success: true, redirectTo: done.redirectTo });
    for (const c of carrier.cookies.getAll()) res.cookies.set(c);
    return res;
  });
}
