/**
 * Lot 101A — contrat de prompt T2 `t2-property-continuity-v1` (étape 11 du
 * guide du PO) : ellipses sur l'objet du tour précédent, propriété EXACTE
 * dans `requestedFacts` (série ≠ numéro de série), ambiguïté jamais tranchée.
 *
 * Le code ne dépend PAS de ce contrat pour être sûr : résolution de l'objet
 * actif (`reference-resolver`), garde-fou de routage (`routing-guard`),
 * retrieval borné et validation des candidats (`candidate-validation`)
 * s'appliquent avant et après le collage. Le marqueur sert à la conformité
 * automatique (registre 99B) et au diagnostic.
 */
export const T2_PROPERTY_CONTINUITY_CONTRACT = 't2-property-continuity-v1';

/** Le prompt T2 porte-t-il le contrat (détection de production) ? */
export function promptCarriesPropertyContinuity(text: string): boolean {
  return String(text ?? '').includes(T2_PROPERTY_CONTINUITY_CONTRACT);
}
