/**
 * Origine structurée des valeurs — CDC §6.2.
 *
 * « Les valeurs fieldKey_origin = auto/manual stockées dans keyCharacteristics
 *   doivent être migrées vers une origine structurée. Pendant la transition,
 *   elles restent lisibles en compatibilité descendante. »
 *
 * L'origine est ce qui protège une saisie utilisateur : une valeur `USER` n'est
 * jamais écrasée silencieusement (critère d'acceptation n°11). Se tromper ici
 * revient à écraser du travail humain.
 */
import type { FieldOrigin } from '../evidence/evidence.types';

export const FIELD_ORIGINS: FieldOrigin[] = [
  'USER', 'DOCUMENT_EXTRACTION', 'RECONCILIATION', 'IMPORT', 'SYSTEM_RULE', 'ADMIN',
];

/** Origines considérées comme une intervention humaine délibérée. */
const HUMAN_ORIGINS = new Set<FieldOrigin>(['USER', 'ADMIN']);

export function isHumanOrigin(origin: FieldOrigin): boolean {
  return HUMAN_ORIGINS.has(origin);
}

/** Une valeur d'origine automatique peut être remplacée par une meilleure preuve. */
export function isAutomaticOrigin(origin: FieldOrigin): boolean {
  return !HUMAN_ORIGINS.has(origin);
}

/**
 * Lecture rétrocompatible de l'ancien format.
 *
 * L'existant stocke `<fieldKey>_origin = 'auto' | 'manual'` dans le JSON
 * `assets.keyCharacteristics`. Tant que la migration 0107 n'a pas été appliquée
 * partout, les deux formats coexistent. En cas d'absence d'information, on
 * suppose `USER` : c'est le choix prudent, celui qui protège la donnée.
 */
export function readOrigin(
  keyCharacteristics: Record<string, unknown> | null,
  fieldKey: string,
): FieldOrigin {
  if (!keyCharacteristics) return 'USER';

  // Format cible.
  const structured = keyCharacteristics[`${fieldKey}__origin`];
  if (typeof structured === 'string' && (FIELD_ORIGINS as string[]).includes(structured)) {
    return structured as FieldOrigin;
  }

  // Format historique.
  const legacy = keyCharacteristics[`${fieldKey}_origin`];
  if (legacy === 'auto') return 'DOCUMENT_EXTRACTION';
  if (legacy === 'manual') return 'USER';

  // Aucune information : on protège.
  return 'USER';
}

/** Écrit l'origine au format cible, en retirant l'ancienne clé. */
export function writeOrigin(
  keyCharacteristics: Record<string, unknown>,
  fieldKey: string,
  origin: FieldOrigin,
): Record<string, unknown> {
  const next = { ...keyCharacteristics, [`${fieldKey}__origin`]: origin };
  delete next[`${fieldKey}_origin`];
  return next;
}
