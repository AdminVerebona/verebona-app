/**
 * POST /api/auth/mfa/passkey/options — défi WebAuthn de CONNEXION (lot 110B).
 *
 *   { mode: 'pending' } : seconde étape (après mot de passe / Google / Apple)
 *                         — contexte provisoire exigé, clés de CE compte ;
 *   { mode: 'login' }   : connexion par clé d'accès SANS mot de passe — aucun
 *                         compte désigné (clés découvrables), défi lié à ce
 *                         navigateur (cookie aléatoire). Rien n'est révélé.
 * `userVerification: 'required'`. Défi stocké en base, usage unique, 5 min.
 */
import type { NextRequest } from 'next/server';
import { withPending, mfaJson, bodyOf, mfaUnavailable } from '@/lib/auth/mfa/http';
import { passkeyAuthenticationOptions } from '@/lib/auth/mfa/passkeys';
import { randomBinding } from '@/lib/auth/mfa/challenges';
import { mfaBlockedResponse } from '@/lib/auth/mfa/throttle';
import { MFA_PASSKEY_LOGIN_BINDING_COOKIE as PASSKEY_LOGIN_BINDING_COOKIE, MFA_PENDING_COOKIE_PATH, WEBAUTHN_CHALLENGE_TTL_MS } from '@/lib/auth/mfa/constants';

export async function POST(request: NextRequest) {
  const body = await bodyOf(request);
  if (body.mode === 'login') {
    const blocked = await mfaBlockedResponse(request, null);
    if (blocked) return blocked;
    try {
      const binding = randomBinding();
      const { options, challengeId } = await passkeyAuthenticationOptions({ userId: null, binding: `anon:${binding}`, purpose: 'passkey_login' });
      const res = mfaJson({ options, challengeId });
      res.cookies.set(PASSKEY_LOGIN_BINDING_COOKIE, binding, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
        maxAge: Math.floor(WEBAUTHN_CHALLENGE_TTL_MS / 1000), path: MFA_PENDING_COOKIE_PATH,
      });
      return res;
    } catch (e) {
      const u = mfaUnavailable(e, 'passkey');
      if (u) return u;
      throw e;
    }
  }
  return withPending(request, async (ctx) => {
    const { options, challengeId } = await passkeyAuthenticationOptions({ userId: ctx.userId, binding: `pending:${ctx.pid}`, purpose: 'passkey_login' });
    return mfaJson({ options, challengeId });
  });
}
