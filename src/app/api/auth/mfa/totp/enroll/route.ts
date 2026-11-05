/**
 * POST /api/auth/mfa/totp/enroll — premier facteur « Mot de passe et code de
 * sécurité » dans le contexte PROVISOIRE d'enrôlement (lot 110B, ticket §2).
 *
 *   { stage: 'start' }            → QR + clé copiable (secret EN ATTENTE) ;
 *   { stage: 'confirm', code }    → premier code RÉELLEMENT vérifié avant
 *                                   activation ; puis 10 codes de
 *                                   récupération (affichage unique). La
 *                                   session complète n'est émise qu'après la
 *                                   confirmation de leur conservation
 *                                   (`/api/auth/mfa/recovery-codes/confirm`).
 */
import type { NextRequest } from 'next/server';
import { withPending, mfaJson, mfaError, bodyOf, mfaUnavailable } from '@/lib/auth/mfa/http';
import { confirmTotpEnrollment, startTotpEnrollment } from '@/lib/auth/mfa/totp';
import { mfaBlockedResponse, recordMfaFailure, recordMfaSuccess } from '@/lib/auth/mfa/throttle';
import { markPendingFactorEnrolled } from '@/lib/auth/mfa/pending';
import { finishFactorEnrollment } from '@/lib/auth/mfa/enrollment';
import { MFA_MESSAGES } from '@/lib/auth/mfa/constants';

export async function POST(request: NextRequest) {
  return withPending(request, async (ctx) => {
    if (ctx.purpose !== 'enroll') return mfaError(409, 'MFA_WRONG_STEP', 'Cette étape n’est pas disponible.');
    if (ctx.factorEnrolledAt) return mfaError(409, 'MFA_FACTOR_ALREADY_ENROLLED', 'Votre méthode de sécurité est déjà configurée : confirmez la conservation de vos codes.');
    const body = await bodyOf(request);
    if (body.stage === 'start') {
      try {
        const s = await startTotpEnrollment(ctx.userId, ctx.email);
        return mfaJson({ otpauthUri: s.otpauthUri, secret: s.secret, qrSvg: s.qrSvg, expiresAt: s.expiresAt.toISOString() });
      } catch (e) {
        return mfaUnavailable(e, 'totp') ?? Promise.reject(e);
      }
    }
    const blocked = await mfaBlockedResponse(request, ctx.userId);
    if (blocked) return blocked;
    const r = await confirmTotpEnrollment(ctx.userId, body.code);
    if (!r.ok) {
      if (r.reason === 'key_unavailable') return mfaError(503, 'MFA_METHOD_UNAVAILABLE', 'L’application d’authentification n’est pas disponible pour le moment.');
      if (r.reason === 'no_pending') return mfaError(410, 'MFA_ENROLLMENT_EXPIRED', 'La configuration a expiré : recommencez en scannant un nouveau QR code.');
      await recordMfaFailure(request, ctx.userId, 'totp_enroll');
      return mfaError(401, 'INVALID_MFA_CODE', MFA_MESSAGES.invalidCode);
    }
    await recordMfaSuccess(ctx.userId);
    await markPendingFactorEnrolled(ctx.pid, 'otp');
    const { recoveryCodes } = await finishFactorEnrollment({
      request, userId: ctx.userId, event: r.replaced ? 'totp_replaced' : 'totp_enabled', factor: 'totp', forceNewCodes: true,
    });
    return mfaJson({ success: true, recoveryCodes });
  });
}
