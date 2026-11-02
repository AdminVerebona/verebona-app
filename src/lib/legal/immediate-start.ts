/**
 * Demande expresse de démarrage immédiat pendant le délai de rétractation —
 * lot 102B. Module PUR (libellés partagés par les écrans et le serveur).
 *
 * Au moment de la souscription payante (parcours Web, avant Stripe Checkout),
 * l'utilisateur coche une case NON pré-cochée par laquelle il demande que
 * l'abonnement commence dès le paiement. Libellé factuel, sans texte
 * juridique, avec renvoi au lien public des CGUV. La demande est prouvée comme
 * une acceptation (version des CGUV + permalien + empreinte + date + contexte
 * IMMEDIATE_START_REQUEST + abonnement concerné).
 *
 * Décision PO : une rétractation reste remboursée INTÉGRALEMENT, même après un
 * démarrage immédiat — aucune déduction n'est calculée ; la preuve sert à la
 * traçabilité.
 */

/** Champ du corps de `POST /api/billing/create-checkout-session`. */
export const IMMEDIATE_START_FIELD = 'immediate_start_requested';

/** Refus quand la case n'a pas été cochée. */
export const IMMEDIATE_START_REQUIRED_CODE = 'IMMEDIATE_START_REQUEST_REQUIRED';

export const IMMEDIATE_START_REQUIRED_MESSAGE =
  'Cochez la case de démarrage immédiat pour continuer vers le paiement.';

/** Libellé de la case (factuel). */
export const IMMEDIATE_START_LABEL =
  'Je demande que mon abonnement commence dès le paiement, sans attendre la fin de mon délai de rétractation.';

/** Précision affichée sous la case (décision PO : remboursement intégral). */
export const IMMEDIATE_START_HINT =
  'Si vous vous rétractez pendant ce délai, vous êtes remboursé intégralement.';

/** Valeur stricte : seule une case explicitement cochée vaut demande. */
export function isImmediateStartRequested(body: Record<string, unknown>): boolean {
  return body[IMMEDIATE_START_FIELD] === true;
}
