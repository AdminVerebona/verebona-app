/**
 * POST /api/auth/mfa/passkey/register — premier facteur « Clé d'accès » dans
 * le contexte PROVISOIRE d'enrôlement (lot 110B, ticket §2, §4).
 *   { stage: 'options' }                         → défi (UV requise) ;
 *   { stage: 'verify', challengeId, response }    → validation WebAuthn
 *     complète, activation, 10 codes de récupération (affichage unique).
 * Aucune activation sur un simple retour de l'interface.
 */
import type { NextRequest } from 'next/server';
import { withPending, mfaJson, mfaError, bodyOf } from '@/lib/auth/mfa/http';
import { passkeyRegistrationOptions, verifyPasskeyRegistration } from '@/lib/auth/mfa/passkeys';
import { markPendingFactorEnrolled } from '@/lib/auth/mfa/pending';
import { finishFactorEnrollment } from '@/lib/auth/mfa/enrollment';
import { mfaBlockedResponse, recordMfaFailure } from '@/lib/auth/mfa/throttle';
import { MFA_MESSAGES } from '@/lib/auth/mfa/constants';

export async function POST(request: NextRequest) {
  return withPending(request, async (ctx) => {
    if (ctx.purpose !== 'enroll') return mfaError(409, 'MFA_WRONG_STEP', 'Cette étape n’est pas disponible.');
    if (ctx.factorEnrolledAt) return mfaError(409, 'MFA_FACTOR_ALREADY_ENROLLED', 'Votre méthode de sécurité est déjà configurée : confirmez la conservation de vos codes.');
    const body = await bodyOf(request);
    const binding = `pending:${ctx.pid}`;
    if (body.stage === 'options') {
      const r = await passkeyRegistrationOptions({ userId: ctx.userId, userName: ctx.email, displayName: ctx.firstName || ctx.email, binding });
      if (!r.ok) return mfaError(409, 'PASSKEY_LIMIT', 'Nombre maximal de clés d’accès atteint.');
      return mfaJson({ options: r.options, challengeId: r.challengeId });
    }
    const blocked = await mfaBlockedResponse(request, ctx.userId);
    if (blocked) return blocked;
    const r = await verifyPasskeyRegistration({ userId: ctx.userId, challengeId: body.challengeId, response: body.response, binding, name: body.name });
    if (!r.ok) {
      await recordMfaFailure(request, ctx.userId, `passkey_register_${r.reason}`);
      return mfaError(r.reason === 'duplicate' ? 409 : 401, r.reason === 'duplicate' ? 'PASSKEY_DUPLICATE' : 'PASSKEY_VERIFICATION_FAILED',
        r.reason === 'duplicate' ? 'Cette clé d’accès est déjà enregistrée.' : MFA_MESSAGES.passkeyFailed);
    }
    await markPendingFactorEnrolled(ctx.pid, 'passkey');
    const { recoveryCodes } = await finishFactorEnrollment({ request, userId: ctx.userId, event: 'passkey_added', factor: 'passkey', forceNewCodes: true });
    return mfaJson({ success: true, passkey: r.passkey, recoveryCodes });
  });
}
