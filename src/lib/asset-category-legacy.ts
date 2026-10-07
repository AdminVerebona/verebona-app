/**
 * Anciens libellés de catégorie de bien — TABLE UNIQUE (lot 30).
 *
 * Module SANS dépendance : `asset-capabilities` (importé par `types/domain`)
 * et `asset-taxonomy` (qui importe `types/domain`) le lisent tous deux, sans
 * cycle. Auparavant, « local commercial » / « local professionnel » étaient
 * déclarés deux fois (taxonomie et capacités).
 *
 * Deux natures :
 *
 *   · RENOMMÉ : ancien libellé ou variante d'écriture d'une catégorie
 *     ACTUELLE (« Garage » → « Garage/box », « mobil home » → « Mobil-home »).
 *     Normalisé partout : affichage, saisie, recherche, assistant.
 *
 *   · ÉQUIVALENT DE CAPACITÉ : ancien libellé CONSERVÉ tel quel à l'affichage
 *     (« Studio » reste « Studio »), rattaché à une catégorie actuelle pour
 *     les seules fonctions offertes (pièces, CIL). Jamais proposé à la création.
 */

/** Ancien libellé (minuscules) → libellé actuel de la taxonomie. */
export const RENAMED_ASSET_CATEGORIES: Readonly<Record<string, string>> = {
  garage: 'Garage/box',
  box: 'Garage/box',
  'local commercial': 'Local professionnel/commercial',
  'local professionnel': 'Local professionnel/commercial',
  'mobil home': 'Mobil-home',
  mobilhome: 'Mobil-home',
  'camping car': 'Camping-car',
  campingcar: 'Camping-car',
};

/** Ancien libellé conservé (minuscules) → catégorie actuelle dont il a les capacités. */
export const CAPABILITY_EQUIVALENT_CATEGORIES: Readonly<Record<string, string>> = {
  studio: 'Appartement',
  villa: 'Maison',
  'propriété': 'Maison',
};

/** Catégorie actuelle d'un libellé stocké, au sens des capacités (renommé, puis équivalent). */
export function capabilityCategoryOf(subtype: string | null | undefined): string | null {
  if (!subtype) return null;
  const key = subtype.trim().toLowerCase();
  if (!key) return null;
  return RENAMED_ASSET_CATEGORIES[key] ?? CAPABILITY_EQUIVALENT_CATEGORIES[key] ?? subtype.trim();
}
