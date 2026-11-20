/**
 * Carte Trello #806 §1 (décision du PO du 17/11/2026 : à l'écran on dit « opération ») — aide commune des gardes de
 * vocabulaire.
 *
 * Règle remplacée (carte #806, décision du PO du 17/11/2026) : les gardes des lots 109, 113 et 114 interdisaient le mot
 * « Opération » à l'écran. Elles interdisent désormais l'ANCIEN terme, « événement de référence » (et « élément de
 * référence »), sous toutes ses formes : singulier, pluriel, majuscules, avec ou sans accents, espaces insécables.
 *
 * `TEXTES_806` reste la liste FERMÉE des textes ajoutés par le volet B de la carte (nature des liens documentaires,
 * faits qualifiés) : ils disaient déjà « opération » avant le renommage général. `sansTextes806` est conservée pour
 * les tests qui veulent isoler ces textes ; plus aucune garde n'en dépend pour tolérer le mot « opération ».
 */
import { OPERATION_FACT_LABELS } from '../operation-facts';
import { OPERATION_LINK_LABELS } from '../operation-links';

/** Ancien terme, interdit dans tout texte visible (toutes formes). */
// `\s` couvre aussi l'espace insécable (U+00A0), l'espace fine insécable (U+202F) et le retour à la ligne.
export const ANCIEN_TERME_806 = /[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence|[ée]l[ée]ments?\s+de\s+r[ée]f[ée]rence/i;

/** Formes que la garde doit reconnaître (preuve que l'expression ne laisse rien passer). */
export const FORMES_ANCIEN_TERME_806: readonly string[] = [
  'événement de référence', 'Événement de référence', 'événements de référence', 'ÉVÉNEMENTS DE RÉFÉRENCE', 'l’événement de référence',
  'evenement de reference', 'évènement de référence', 'événement\u00a0de\u00a0référence', 'événement de\nréférence', 'élément de référence', 'Éléments de référence',
];

/** Textes fixes nouveaux de la carte #806 (volet B) qui peuvent figurer sur la fiche. */
const VALEURS_806: readonly unknown[] = [...Object.values(OPERATION_LINK_LABELS), ...Object.values(OPERATION_FACT_LABELS)];
export const TEXTES_806: readonly string[] = VALEURS_806.filter((v): v is string => typeof v === 'string');

/** Rendu sans les textes nouveaux de la carte #806 (les plus longs d'abord : aucun reste partiel). */
export function sansTextes806(html: string): string {
  return [...TEXTES_806].sort((a, b) => b.length - a.length).reduce((h, t) => h.split(t).join(''), html);
}
