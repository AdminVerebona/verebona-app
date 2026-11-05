/**
 * POST /api/auth/mfa/passkey/verify — vérification WebAuthn COMPLÈTE côté
 * serveur (défi, origine, RP ID, signature, UP + UV) puis session complète de
 * niveau 2 (lot 110B, ticket §3, §4). Corps : { mode, challengeId, response }.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { withPending, mfaJson, mfaError, bodyOf, expiredResponse, mfaUnavailable } from '@/lib/auth/mfa/http';
import { verifyPasskeyAuthentication } from '@/lib/auth/mfa/passkeys';
import { completeStrongSession, openPasskeySession } from '@/lib/auth/mfa/primary';
import { mfaBlockedResponse, recordMfaFailure, recordMfaSuccess } from '@/lib/auth/mfa/throttle';
import { auditMfa } from '@/lib/auth/mfa/notify';
import { clearPendingCookie } from '@/lib/auth/mfa/pending';
import { MFA_MESSAGES, MFA_PASSKEY_LOGIN_BINDING_COOKIE as PASSKEY_LOGIN_BINDING_COOKIE, MFA_PENDING_COOKIE_PATH } from '@/lib/auth/mfa/constants';

function failed(): NextResponse {
  return mfaError(401, 'PASSKEY_VERIFICATION_FAILED', MFA_MESSAGES.passkeyFailed);
}

export async function POST(request: NextRequest) {
  const body = await bodyOf(request);
  if (body.mode === 'login') {
    const blocked = await mfaBlockedResponse(request, null);
    if (blocked) return blocked;
    const binding = request.cookies.get(PASSKEY_LOGIN_BINDING_COOKIE)?.value;
    if (!binding) return failed();
    try {
      const r = await verifyPasskeyAuthentication({
        challengeId: body.challengeId, response: body.response, binding: `anon:${binding}`, purpose: 'passkey_login', expectedUserId: null,
      });
      if (!r.ok) {
        if (r.reason === 'counter' && r.userId) auditMfa(request, 'MFA_PASSKEY_COUNTER_REGRESSION', r.userId, {});
        await recordMfaFailure(request, r.userId ?? null, `passkey_login_${r.reason}`);
        return failed();
      }
      await recordMfaSuccess(r.userId);
      const carrier = NextResponse.json({});
      const returnUrl = typeof body.returnUrl === 'string' ? body.returnUrl : null;
      const done = await openPasskeySession(request, carrier, r.userId, returnUrl);
      if (!done.ok) return mfaError(403, done.code, 'Connexion impossible pour ce compte.');
      const res = mfaJson({ success: true, redirectTo: done.redirectTo });
      for (const c of carrier.cookies.getAll()) res.cookies.set(c);
      res.cookies.set(PASSKEY_LOGIN_BINDING_COOKIE, '', { httpOnly: true, maxAge: 0, path: MFA_PENDING_COOKIE_PATH });
      return res;
    } catch (e) {
      const u = mfaUnavailable(e, 'passkey');
      if (u) return u;
      throw e;
    }
  }
  return withPending(request, async (ctx) => {
    if (ctx.purpose !== 'challenge') return mfaError(409, 'MFA_WRONG_STEP', 'Terminez d’abord la configuration de votre sécurité.');
    const blocked = await mfaBlockedResponse(request, ctx.userId);
    if (blocked) return blocked;
    const r = await verifyPasskeyAuthentication({
      challengeId: body.challengeId, response: body.response, binding: `pending:${ctx.pid}`, purpose: 'passkey_login', expectedUserId: ctx.userId,
    });
    if (!r.ok) {
      if (r.reason === 'counter') auditMfa(request, 'MFA_PASSKEY_COUNTER_REGRESSION', ctx.userId, {});
      await recordMfaFailure(request, ctx.userId, `passkey_${r.reason}`);
      return failed();
    }
    await recordMfaSuccess(ctx.userId);
    const carrier = NextResponse.json({});
    const done = await completeStrongSession(request, carrier, ctx, 'passkey');
    if (!done.ok) {
      if (done.code === 'MFA_EXPIRED') { const res = expiredResponse(); clearPendingCookie(res); return res; }
      return mfaError(403, done.code, 'Connexion impossible pour ce compte.');
    }
    const res = mfaJson({ success: true, redirectTo: done.redirectTo });
    for (const c of carrier.cookies.getAll()) res.cookies.set(c);
    return res;
  });
}
