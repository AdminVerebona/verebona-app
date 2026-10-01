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

/** Origine lisible dans une valeur quelconque (journal, paramètre d'API). */
export function isFieldOrigin(v: unknown): v is FieldOrigin {
  return typeof v === 'string' && (FIELD_ORIGINS as string[]).includes(v);
}

export interface WriteOriginOptions {
  /**
   * Date de l'écriture (ISO) : posée dans `<champ>__updatedAt`. Absente, la
   * clé n'est pas touchée (comportement historique de `applyDecision`).
   */
  updatedAt?: string;
}

/**
 * Écrit l'origine au format cible, en retirant l'ancienne clé.
 *
 * Écriture HUMAINE (USER, ADMIN) : l'autorité et la date de la preuve qui
 * justifiaient la valeur automatique précédente (`__authority`,
 * `__sourceDate`) sont retirées — elles décriraient une valeur qui n'est plus
 * là, et une prochaine réconciliation les lirait à tort (T3-02).
 */
export function writeOrigin(
  keyCharacteristics: Record<string, unknown>,
  fieldKey: string,
  origin: FieldOrigin,
  opts: WriteOriginOptions = {},
): Record<string, unknown> {
  const next = { ...keyCharacteristics, [`${fieldKey}__origin`]: origin };
  delete next[`${fieldKey}_origin`];
  // Motif de reconstitution de l'origine (rattrapage CDC 15 MIG-03, lot 17) :
  // il décrivait l'origine PRÉCÉDENTE — toute nouvelle écriture d'origine le retire.
  delete next[`${fieldKey}__originBasis`];
  if (opts.updatedAt) next[`${fieldKey}__updatedAt`] = opts.updatedAt;
  if (isHumanOrigin(origin)) {
    delete next[`${fieldKey}__authority`];
    delete next[`${fieldKey}__sourceDate`];
  }
  return next;
}

export type OverwriteDecision =
  | { allowed: true }
  | { allowed: false; reason: 'HUMAN_VALUE_PROTECTED' };

/**
 * Préséance des origines — règle unique de `writeCanonicalAssetField()`
 * (CDC 15 T3-02, DOD-02, critère d'acceptation n°11).
 *
 *   · une écriture humaine (USER, ADMIN) passe toujours : la dernière
 *     intervention humaine l'emporte ;
 *   · une écriture automatique ne remplace JAMAIS une valeur humaine
 *     renseignée — elle devient un conflit à arbitrer (décision T3) ;
 *   · une écriture automatique peut remplir un champ vide, ou remplacer une
 *     valeur automatique (l'arbitrage d'autorité appartient à la décision T3,
 *     pas à la primitive d'écriture).
 *
 * L'origine d'une valeur sans information est lue `USER` (`readOrigin`) :
 * une valeur historique non tracée est protégée.
 */
export function canOverwrite(
  current: { origin: FieldOrigin; empty: boolean },
  incoming: FieldOrigin,
): OverwriteDecision {
  if (isHumanOrigin(incoming)) return { allowed: true };
  if (current.empty) return { allowed: true };
  if (isHumanOrigin(current.origin)) return { allowed: false, reason: 'HUMAN_VALUE_PROTECTED' };
  return { allowed: true };
}
