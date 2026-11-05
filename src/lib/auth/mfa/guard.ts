/**
 * Garde MFA centrale des sessions complètes (lot 110B, ticket §6).
 *
 * Appelée par les DEUX seuls points qui acceptent un jeton d'accès :
 * `SessionService.getSession` (toutes les routes qui passent par lui,
 * `requireAdmin` / BO compris) et `verifySessionAccessToken`
 * (`getCurrentUser` et les routes qui vérifient le jeton elles-mêmes). Le
 * test d'architecture `l110b-mfa-architecture` échoue si un autre module
 * vérifie un jeton d'accès.
 *
 *   · session de niveau 2 (`aal: 2` signé) : aucune lecture, accès normal ;
 *   · session de niveau 1 : décision lue en base (`policy.ts`, sans cache) ;
 *     obligation applicable → seule la liste fermée
 *     `isAllowedWithoutMfa` passe, tout le reste lève `MFA_REQUIRED` (403) ;
 *   · base injoignable : `SESSION_UNAVAILABLE` (503) — jamais un accès.
 */
import { MFA_REQUIRED_CODE, isAllowedWithoutMfa } from './constants';
import { isStrongSession, type AssuranceClaims } from './assurance';
import { mfaRequirementFor } from './policy';

export async function assertMfaSatisfied(
  payload: AssuranceClaims & { userId: number },
  pathname: string,
  method: string,
): Promise<void> {
  if (isStrongSession(payload)) return;
  if (isAllowedWithoutMfa(pathname, method)) return;
  const r = await mfaRequirementFor(payload.userId);
  if (r.required) throw new Error(MFA_REQUIRED_CODE);
}
