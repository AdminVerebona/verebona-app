/**
 * Carte Trello #806 (décision du PO du 17/11/2026, §1 : à l'écran on dit désormais « opération ») — aide commune des
 * gardes de vocabulaire de la fiche.
 *
 * Les gardes des lots 114 interdisaient le mot « Opération » sur la fiche. Les textes NOUVEAUX de la carte #806
 * (volet B : nature des liens documentaires, faits qualifiés) l'emploient ; les textes EXISTANTS ne sont pas renommés
 * ici (un passage dédié le fera en fin de lot) et restent sous la garde d'origine. `sansTextes806` retire du rendu
 * les seuls textes nouveaux, en liste FERMÉE : tout autre « Opération » fait toujours échouer la garde.
 */
import { OPERATION_FACT_LABELS } from '../operation-facts';
import { OPERATION_LINK_LABELS } from '../operation-links';

/** Textes fixes nouveaux de la carte #806 (volet B) qui peuvent figurer sur la fiche. */
const VALEURS_806: readonly unknown[] = [...Object.values(OPERATION_LINK_LABELS), ...Object.values(OPERATION_FACT_LABELS)];
export const TEXTES_806: readonly string[] = VALEURS_806.filter((v): v is string => typeof v === 'string');

/** Rendu sans les textes nouveaux de la carte #806 (les plus longs d'abord : aucun reste partiel). */
export function sansTextes806(html: string): string {
  return [...TEXTES_806].sort((a, b) => b.length - a.length).reduce((h, t) => h.split(t).join(''), html);
}
