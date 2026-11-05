/**
 * Réauthentification FORTE (step-up 5 min) — lot 110B, ticket §6.
 *
 * Enregistre la clé d'accès et l'application d'authentification comme
 * méthodes de réauthentification du lot 92 (`reauth.ts`). La preuve émise
 * (`issueReauthProof`) est liée à l'utilisateur ET à la session (`sid`) et
 * porte le niveau 2 ; elle vaut 5 minutes, pour les SEULES opérations de
 * sécurité du compte (facteurs, codes, e-mail, mot de passe, Google / Apple,
 * autres appareils, suppression du compte). Aucune fonction métier (ZIP,
 * dossiers, exports, transmission) ne la demande : test d'architecture.
 *
 * Importé pour son effet par les routes qui listent / vérifient les méthodes.
 */
import { registerReauthMethod } from '../reauth';
import { mfaBlockedResponse, recordMfaFailure, recordMfaSuccess } from './throttle';
import { MFA_MESSAGES } from './constants';
import { hasActiveTotp, verifyTotp } from './totp';
import { listPasskeys } from './db';

registerReauthMethod({
  id: 'totp',
  label: 'Code de l’application d’authentification',
  kind: 'totp',
  async isAvailableFor(userId) {
    return hasActiveTotp(userId);
  },
  async verify({ request, userId, input }) {
    const blocked = await mfaBlockedResponse(request, userId);
    if (blocked) return { status: 'blocked', response: blocked };
    const r = await verifyTotp(userId, input.code);
    if (r === 'ok') {
      await recordMfaSuccess(userId);
      return { status: 'success' };
    }
    if (r === 'key_unavailable') return { status: 'failed', code: 'MFA_UNAVAILABLE', message: 'Vérification momentanément impossible. Réessayez plus tard.', httpStatus: 503 };
    await recordMfaFailure(request, userId, 'totp_stepup');
    return { status: 'failed', code: 'INVALID_MFA_CODE', message: MFA_MESSAGES.invalidCode, httpStatus: 401 };
  },
});

registerReauthMethod({
  id: 'passkey',
  label: 'Clé d’accès',
  kind: 'passkey',
  async isAvailableFor(userId) {
    return (await listPasskeys(userId)).length > 0;
  },
});

export const STEP_UP_METHODS_REGISTERED = true;
