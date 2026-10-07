/**
 * Messages des refus de résolution « À traiter » — lot 32 (L32-1).
 *
 * Avant : un toast unique « La valeur n’a pas pu être appliquée. » quelle que
 * soit la cause (carte déjà traitée, valeur refusée, champ sans objet…).
 * La route renvoie désormais le code ET ce message ; la file et la mascotte
 * l'affichent tels quels (module sans dépendance, lisible côté client).
 */
export const RESOLVE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  NOT_FOUND: 'Cette action n’existe plus : la liste a été actualisée.',
  ALREADY_RESOLVED: 'Cette action a déjà été traitée.',
  FIELD_NOT_RESOLVABLE: 'Cette information ne peut pas être modifiée depuis la carte : ouvrez l’élément pour la compléter.',
  INVALID_VALUE: 'Cette valeur n’est pas valide pour ce champ. Choisissez « Autre » pour la corriger.',
  STALE: 'L’information a changé entre-temps : la carte a été retirée.',
  FIELD_NOT_APPLICABLE: 'Cette information ne s’applique pas à ce bien : la carte a été retirée.',
};

export const RESOLVE_DEFAULT_ERROR = 'La valeur n’a pas pu être appliquée. Réessayez dans un instant.';

/** Message affichable d'un refus (code de la route), sinon le message générique. */
export function resolveErrorMessage(code: string | null | undefined): string {
  return (code && RESOLVE_ERROR_MESSAGES[code]) || RESOLVE_DEFAULT_ERROR;
}

/** Refus après lequel la carte n'est plus active : la retirer de l'écran. */
export function resolveErrorClosesCard(code: string | null | undefined): boolean {
  return code === 'NOT_FOUND' || code === 'ALREADY_RESOLVED' || code === 'STALE' || code === 'FIELD_NOT_APPLICABLE';
}
