/**
 * Brouillon de sinistre (lot 53, retour PO D10) — règle PURE partagée par
 * l'interface (`ClaimEditor`, ordinateur et mobile) : un sinistre n'est créé
 * en base qu'à la première sauvegarde EFFECTIVE, c'est-à-dire un correctif
 * qui porte au moins une information (valeur non vide, ligne de liste).
 * Même règle côté serveur : `claimPatchHasContent` (claims/model.ts).
 */
import type { AdditionalInfosPatch } from './additional-infos';

export function draftPatchHasContent(patch: AdditionalInfosPatch): boolean {
  return Object.values(patch.claim ?? {}).some((v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
}
