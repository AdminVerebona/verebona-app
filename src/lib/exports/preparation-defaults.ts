/**
 * Choix par défaut du tiroir de préparation — CDC Exports V12 §6.2.
 *
 * Dossier de mise en location (EXP-008), en attendant l'écran de préparation
 * complet : documents proposés NON précochés (un bail ou un état des lieux
 * d'un ancien locataire peut s'y trouver), quatre photos au plus précochées,
 * équipements retenus. Les autres dossiers gardent leur comportement actuel.
 */
export const LOCATION_DEFAULT_PHOTO_COUNT = 4;

/** Documents précochés à l'ouverture : tous, sauf pour la location. */
export function defaultSelectedDocIds(usage: string, docIds: number[]): number[] {
  return usage === 'LOCATION' ? [] : docIds;
}

/** Photos précochées à l'ouverture : toutes, sauf pour la location (4 premières). */
export function defaultSelectedPhotoIds(usage: string, photoIds: number[]): number[] {
  return usage === 'LOCATION' ? photoIds.slice(0, LOCATION_DEFAULT_PHOTO_COUNT) : photoIds;
}
