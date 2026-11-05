/**
 * Lot 111E — remplissage automatique des identifiants (autofill).
 *
 * Source UNIQUE des conventions des champs d'authentification, pour que le
 * système (iOS AutoFill / Mots de passe, services de remplissage Android,
 * gestionnaires des navigateurs, Dashlane, 1Password, Bitwarden…) reconnaisse
 * les champs sans dépendre d'un fournisseur :
 *
 *   identifiant de connexion   type="email" inputMode="email" name="username"
 *                              autoComplete="username"
 *   mot de passe existant      type="password" name="password"
 *                              autoComplete="current-password"
 *   nouveau mot de passe       type="password" name="new-password" (et
 *                              "confirm-password") autoComplete="new-password"
 *   code TOTP / e-mail         inputMode="numeric" autoComplete="one-time-code"
 *
 * Toujours dans un vrai <form>, avec un <label> associé (htmlFor/id). Jamais
 * de faux autoComplete="off" sur un champ d'identifiant ou de mot de passe
 * (le test d'architecture `l111e-autofill-architecture.test.ts` l'interdit).
 *
 * Aucun secret n'est lu, journalisé ni conservé ici : seules des valeurs déjà
 * présentes dans le formulaire, au moment de l'envoi, sont relues.
 */

export const AUTOFILL = Object.freeze({
  username: 'username',
  currentPassword: 'current-password',
  newPassword: 'new-password',
  oneTimeCode: 'one-time-code',
} as const);

/** Valeurs admises pour un champ de mot de passe d'un parcours d'authentification. */
export const PASSWORD_AUTOCOMPLETE_VALUES: readonly string[] = [AUTOFILL.currentPassword, AUTOFILL.newPassword];

/**
 * Valeur d'un champ du formulaire AU MOMENT DE L'ENVOI (DOM), à défaut l'état
 * React. Couvre les remplissages que React n'a pas vus (gestionnaire qui pose
 * la valeur sans événement exploitable, remplissage avant montage, valeur
 * masquée par le navigateur jusqu'au premier geste) : c'est ce que voit
 * l'utilisateur qui est envoyé. À appeler en tête du gestionnaire `onSubmit`,
 * avant toute désactivation des champs (un champ désactivé est absent de
 * FormData).
 */
export function formFieldValue(form: HTMLFormElement | null | undefined, name: string, fallback: string): string {
  if (!form || typeof FormData === 'undefined') return fallback;
  try {
    const v = new FormData(form).get(name);
    return typeof v === 'string' && v !== '' ? v : fallback;
  } catch {
    return fallback;
  }
}
