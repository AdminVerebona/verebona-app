/**
 * POST /api/users/me/security/reauth/passkey — réauthentification FORTE par
 * clé d'accès (step-up 5 min, lot 110B, ticket §6).
 *   { stage: 'options' }                     → défi lié à CETTE session (UV requise) ;
 *   { stage: 'verify', challengeId, response } → preuve de niveau 2 (`reauth_proofs`).
 */
import type { NextRequest } from 'next/server';
import { mfaJson, mfaError, bodyOf, withSession } from '@/lib/auth/mfa/http';
import { passkeyAuthenticationOptions, verifyPasskeyAuthentication } from '@/lib/auth/mfa/passkeys';
import { issueReauthProof, logReauthFailure, ReauthError } from '@/lib/auth/reauth';
import { mfaBlockedResponse, recordMfaFailure, recordMfaSuccess } from '@/lib/auth/mfa/throttle';
import { MFA_MESSAGES } from '@/lib/auth/mfa/constants';

export async function POST(request: NextRequest) {
  return withSession(request, async (session) => {
    const body = await bodyOf(request);
    const binding = `sid:${session.sid}`;
    if (body.stage === 'options') {
      const { options, challengeId } = await passkeyAuthenticationOptions({ userId: session.userId, binding, purpose: 'passkey_stepup' });
      return mfaJson({ options, challengeId });
    }
    const blocked = await mfaBlockedResponse(request, session.userId);
    if (blocked) return blocked;
    const r = await verifyPasskeyAuthentication({
      challengeId: body.challengeId, response: body.response, binding, purpose: 'passkey_stepup', expectedUserId: session.userId,
    });
    if (!r.ok) {
      await recordMfaFailure(request, session.userId, `passkey_stepup_${r.reason}`);
      logReauthFailure(request, session.userId, 'passkey', 'PASSKEY_VERIFICATION_FAILED');
      return mfaError(401, 'PASSKEY_VERIFICATION_FAILED', MFA_MESSAGES.passkeyFailed);
    }
    await recordMfaSuccess(session.userId);
    try {
      const { expiresAt } = await issueReauthProof(session.userId, session.sid, 'passkey', { request });
      return mfaJson({ success: true, freshUntil: expiresAt.toISOString() });
    } catch (e) {
      if (e instanceof ReauthError) return mfaError(401, 'SESSION_REVOKED', 'Votre session a été fermée : reconnectez-vous.');
      throw e;
    }
  });
}
