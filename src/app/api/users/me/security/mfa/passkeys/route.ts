/**
 * Mon compte › Sécurité › Clés d'accès — ajout (lot 110B, ticket §4, §7).
 *   POST { stage: 'options' }                       → défi (UV requise) ;
 *   POST { stage: 'verify', challengeId, response, name? } → validation complète.
 * Défi lié à CETTE session (`sid`) ; réauthentification fraîche exigée.
 */
import type { NextRequest } from 'next/server';
import { mfaJson, mfaError, bodyOf, mfaUnavailable } from '@/lib/auth/mfa/http';
import { requireSecurityStepUp, promoteCurrentSession } from '@/lib/auth/mfa/account-ops';
import { passkeyRegistrationOptions, verifyPasskeyRegistration } from '@/lib/auth/mfa/passkeys';
import { finishFactorEnrollment } from '@/lib/auth/mfa/enrollment';
import { mfaBlockedResponse, recordMfaFailure } from '@/lib/auth/mfa/throttle';
import { MFA_MESSAGES } from '@/lib/auth/mfa/constants';

export async function POST(request: NextRequest) {
  const check = await requireSecurityStepUp(request, 'mfa_passkey_add');
  if (!check.ok) return check.response;
  const { session } = check;
  const body = await bodyOf(request);
  const binding = `sid:${session.sid}`;
  try {
    if (body.stage === 'options') {
      const r = await passkeyRegistrationOptions({ userId: session.userId, userName: session.email, displayName: session.email, binding });
      if (!r.ok) return mfaError(409, 'PASSKEY_LIMIT', 'Nombre maximal de clés d’accès atteint.');
      return mfaJson({ options: r.options, challengeId: r.challengeId });
    }
    const blocked = await mfaBlockedResponse(request, session.userId);
    if (blocked) return blocked;
    const r = await verifyPasskeyRegistration({ userId: session.userId, challengeId: body.challengeId, response: body.response, binding, name: body.name });
    if (!r.ok) {
      await recordMfaFailure(request, session.userId, `passkey_register_${r.reason}`);
      return mfaError(r.reason === 'duplicate' ? 409 : 401, r.reason === 'duplicate' ? 'PASSKEY_DUPLICATE' : 'PASSKEY_VERIFICATION_FAILED',
        r.reason === 'duplicate' ? 'Cette clé d’accès est déjà enregistrée.' : MFA_MESSAGES.passkeyFailed);
    }
    const { recoveryCodes } = await finishFactorEnrollment({ request, userId: session.userId, event: 'passkey_added', factor: 'passkey', forceNewCodes: false });
    const res = mfaJson({ success: true, passkey: r.passkey, recoveryCodes });
    await promoteCurrentSession(request, res, session, 'passkey');
    return res;
  } catch (e) {
    const u = mfaUnavailable(e, 'passkey');
    if (u) return u;
    throw e;
  }
}
