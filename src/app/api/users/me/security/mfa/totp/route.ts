/**
 * Mon compte › Sécurité › Application d'authentification (lot 110B).
 *   POST { stage: 'start' }            → QR + clé (secret EN ATTENTE) ;
 *   POST { stage: 'confirm', code }    → activation (ou REMPLACEMENT) après
 *                                        vérification d'un premier code ;
 *   DELETE                             → retrait (jamais la dernière méthode).
 * Réauthentification fraîche exigée (forte si la MFA est obligatoire).
 */
import type { NextRequest } from 'next/server';
import { mfaJson, mfaError, bodyOf, mfaUnavailable } from '@/lib/auth/mfa/http';
import { requireSecurityStepUp, promoteCurrentSession } from '@/lib/auth/mfa/account-ops';
import { confirmTotpEnrollment, startTotpEnrollment } from '@/lib/auth/mfa/totp';
import { removeTotpFactor } from '@/lib/auth/mfa/factor-ops';
import { finishFactorEnrollment } from '@/lib/auth/mfa/enrollment';
import { auditMfa, notifyMfaEvent } from '@/lib/auth/mfa/notify';
import { mfaBlockedResponse, recordMfaFailure, recordMfaSuccess } from '@/lib/auth/mfa/throttle';
import { MFA_MESSAGES } from '@/lib/auth/mfa/constants';

export async function POST(request: NextRequest) {
  const check = await requireSecurityStepUp(request, 'mfa_totp_enroll');
  if (!check.ok) return check.response;
  const { session } = check;
  const body = await bodyOf(request);
  try {
    if (body.stage === 'start') {
      const s = await startTotpEnrollment(session.userId, session.email);
      return mfaJson({ otpauthUri: s.otpauthUri, secret: s.secret, qrSvg: s.qrSvg, expiresAt: s.expiresAt.toISOString() });
    }
    const blocked = await mfaBlockedResponse(request, session.userId);
    if (blocked) return blocked;
    const r = await confirmTotpEnrollment(session.userId, body.code);
    if (!r.ok) {
      if (r.reason === 'key_unavailable') return mfaError(503, 'MFA_METHOD_UNAVAILABLE', 'L’application d’authentification n’est pas disponible pour le moment.');
      if (r.reason === 'no_pending') return mfaError(410, 'MFA_ENROLLMENT_EXPIRED', 'La configuration a expiré : recommencez en scannant un nouveau QR code.');
      await recordMfaFailure(request, session.userId, 'totp_enroll');
      return mfaError(401, 'INVALID_MFA_CODE', MFA_MESSAGES.invalidCode);
    }
    await recordMfaSuccess(session.userId);
    const { recoveryCodes } = await finishFactorEnrollment({ request, userId: session.userId, event: r.replaced ? 'totp_replaced' : 'totp_enabled', factor: 'totp', forceNewCodes: false });
    const res = mfaJson({ success: true, replaced: r.replaced, recoveryCodes });
    await promoteCurrentSession(request, res, session, 'otp');
    return res;
  } catch (e) {
    const u = mfaUnavailable(e, 'totp');
    if (u) return u;
    throw e;
  }
}

export async function DELETE(request: NextRequest) {
  const check = await requireSecurityStepUp(request, 'mfa_totp_remove');
  if (!check.ok) return check.response;
  const { session } = check;
  const r = await removeTotpFactor(session.userId);
  if (r === 'not_found') return mfaError(404, 'NOT_FOUND', 'Aucune application d’authentification n’est configurée.');
  if (r === 'last_method') return mfaError(409, 'MFA_LAST_METHOD', MFA_MESSAGES.lastMethod);
  auditMfa(request, 'MFA_FACTOR_REMOVED', session.userId, { factor: 'totp' });
  void notifyMfaEvent(session.userId, 'totp_removed');
  return mfaJson({ success: true });
}
