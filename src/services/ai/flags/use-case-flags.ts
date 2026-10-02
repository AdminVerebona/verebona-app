/**
 * Correspondance entre les cinq usages IA et les cinq drapeaux de bascule.
 * CDC Refonte §10.1 et §10.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EXISTE
 *
 * Le CDC énonce deux listes de cinq éléments — les usages (`registry/use-cases`)
 * et les drapeaux (`flags/ai-feature-flags`) — sans jamais écrire la
 * correspondance entre les deux. Chaque module qui en avait besoin la
 * reconstituait donc de tête, ou s'en passait.
 *
 * C'est précisément ce qui a rendu le code indéployable : `assertPricingReady()`
 * bloquait le démarrage en production faute de tarifs, alors que les cinq
 * drapeaux valaient `legacy` et qu'aucun appel modèle ne passait par la nouvelle
 * gateway. Le contrôle était juste ; il portait sur un périmètre qui n'existait
 * pas encore.
 *
 * Une seule table de correspondance, ici, exploitée par tous les contrôles de
 * démarrage et par l'administration.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AI_USE_CASE_CODES, type AiUseCaseCode } from '../registry/use-cases';
import { type AiFlag, type FlagMode, getFlagMode, shouldRunNewEngine } from './ai-feature-flags';

/**
 * Un usage → au plus un drapeau, et un drapeau ne pilote qu'un usage. `null` :
 * usage SANS drapeau, dont le nouveau moteur est le seul (lot 16b : T5
 * gouvernance et T6 mascotte — anciens `AI_PROMPT_GOVERNANCE` et
 * `AI_HOME_MASCOT` —, T2 assistant et T4 agenda — anciens
 * `AI_INTELLIGENT_ASSISTANT` et `AI_AGENDA_ENGINE` — supprimés) : il tourne
 * toujours (`enabled`).
 */
export const USE_CASE_FLAGS: Record<AiUseCaseCode, AiFlag | null> = {
  SOURCE_ANALYSIS: 'AI_UNIFIED_SOURCE_ANALYSIS',
  DATA_RECONCILIATION: 'AI_RECONCILIATION_ENGINE',
  INTELLIGENT_ASSISTANT: null,
  AGENDA_INTELLIGENCE: null,
  AI_GOVERNANCE: null,
  HOME_MASCOT: null,
};

export function getUseCaseFlag(useCaseCode: AiUseCaseCode): AiFlag | null {
  return USE_CASE_FLAGS[useCaseCode];
}

export function getUseCaseMode(useCaseCode: AiUseCaseCode): FlagMode {
  const flag = USE_CASE_FLAGS[useCaseCode];
  return flag ? getFlagMode(flag) : 'enabled';
}

/**
 * L'usage produit-il des décisions ?
 *
 * Vrai en mode `enabled` **et** en mode `shadow` : le mode observation exécute
 * réellement les appels modèles, il n'en applique simplement pas les
 * conclusions. Ses coûts doivent donc être mesurés comme les autres — c'est
 * même le seul moyen de chiffrer une bascule avant de la décider.
 */
export function isUseCaseRunning(useCaseCode: AiUseCaseCode): boolean {
  const flag = USE_CASE_FLAGS[useCaseCode];
  return flag ? shouldRunNewEngine(flag) : true;
}

/** Usages dont le nouveau moteur s'exécute réellement, dans l'ordre du CDC. */
export function listRunningUseCases(): AiUseCaseCode[] {
  return AI_USE_CASE_CODES.filter(isUseCaseRunning);
}

/** Aucun moteur actif ⇒ le socle IA est présent mais hors du chemin d'exécution. */
export function isAnyUseCaseRunning(): boolean {
  return listRunningUseCases().length > 0;
}

/** Instantané destiné à l'administration et à l'inventaire d'exécution. */
export function snapshotUseCaseModes(): Record<AiUseCaseCode, FlagMode> {
  return Object.fromEntries(
    AI_USE_CASE_CODES.map((c) => [c, getUseCaseMode(c)]),
  ) as Record<AiUseCaseCode, FlagMode>;
}
