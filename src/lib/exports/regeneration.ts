/**
 * Lot 111B — textes de la régénération remplaçante des dossiers V12, partagés
 * par le serveur (historique, DTO) et l'interface (écran de préparation,
 * historique des exports). Module sans dépendance serveur.
 */

/** Affiché avant une régénération explicite — aucune confirmation supplémentaire. */
export const REGENERATION_NOTICE = 'La génération précédente sera remplacée par cette nouvelle version.';

/** Début du libellé d'historique d'une génération remplacée (« … VBN-…, le 05/11/2026 »). */
export const REPLACED_LABEL = 'Annulé — Remplacé par la génération';

/** Libellé court quand la nouvelle référence n'est plus disponible. */
export const REPLACED_FALLBACK_LABEL = 'Annulé — Remplacé par une nouvelle génération';
