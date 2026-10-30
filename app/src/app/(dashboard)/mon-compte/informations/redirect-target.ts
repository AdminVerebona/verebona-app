/**
 * Ancienne adresse `/mon-compte/informations` → `/mon-compte`.
 * Lot 101C : les paramètres (retour Google / Apple `?securite=…&resume=…`) et
 * l'ancre (`#securite`, `#appareils-connectes`) sont conservés — la
 * redirection les perdait, et la carte visée ne s'ouvrait pas.
 */
export function informationsRedirectTarget(search: string, hash: string): string {
  const params = new URLSearchParams(search);
  params.set('tab', 'informations');
  return `/mon-compte?${params.toString()}${hash}`;
}
