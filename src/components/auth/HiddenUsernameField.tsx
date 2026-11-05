/**
 * Lot 111E — identifiant du compte, invisible, dans un formulaire de NOUVEAU
 * mot de passe (changement, ajout) ou de réauthentification.
 *
 * Recommandation des navigateurs et d'Apple (Password AutoFill) : un champ
 * `autocomplete="username"` dans le même formulaire que le mot de passe
 * indique AU GESTIONNAIRE quel compte enregistrer ou mettre à jour, au lieu
 * de lui faire deviner (ou créer une entrée sans identifiant). Champ en
 * lecture seule, hors tabulation, ignoré des lecteurs d'écran, jamais envoyé
 * au serveur par le code (les appels sont faits en JSON). Rien n'est rendu
 * si l'adresse n'est pas connue.
 */
export function HiddenUsernameField({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  return (
    <input
      type="email"
      name="username"
      autoComplete="username"
      value={value}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      data-testid="hidden-username"
      className="sr-only"
    />
  );
}
