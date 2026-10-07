/**
 * Page « Renoncer au contrat » (/retractation) — cible du bouton retour (lot 26).
 *
 * La page est publique (§6.1) : on y arrive depuis Mon compte (connecté),
 * depuis le pied de page des écrans de connexion, depuis la vitrine ou par le
 * lien reçu par courriel. Le retour doit ramener chacun à un endroit sensé :
 *
 *   · connecté               → Mon compte ;
 *   · sinon, page précédente → retour navigateur ;
 *   · sinon (onglet neuf, lien de courriel) → écran de connexion.
 *
 * Pure : l'appelant lit la session et l'historique, la décision est testée.
 */
export type WithdrawalBackTarget =
  | { kind: 'link'; href: string; label: string }
  | { kind: 'history'; label: string };

export function resolveWithdrawalBackTarget(input: {
  /** `true` connecté, `false` non connecté, `null` pas encore établi. */
  authenticated: boolean | null;
  /** `document.referrer` (vide quand on arrive d'un onglet neuf ou d'un courriel). */
  referrer: string;
  /** `window.history.length`. */
  historyLength: number;
}): WithdrawalBackTarget {
  if (input.authenticated) {
    return { kind: 'link', href: '/mon-compte', label: 'Retour à mon compte' };
  }
  if (input.referrer.trim() !== '' && input.historyLength > 1) {
    return { kind: 'history', label: 'Retour' };
  }
  return { kind: 'link', href: '/login', label: 'Retour à la connexion' };
}
