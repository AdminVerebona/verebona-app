/**
 * T5 — Prompt Control : messages du BO et détection d'un texte hérité.
 *
 * Module PUR (aucune dépendance serveur) : importé à la fois par la
 * validation (`config-validation.service`) et par l'écran du BO
 * (`app/admin/ai-config`), pour que l'information affichée et le contrôle
 * disent exactement la même chose.
 */

/**
 * Information permanente du BO : le texte de T5 ne se règle pas dans la
 * version de configuration, mais dans « Prompts maîtres » (lot 32B, décision
 * PO n° 15).
 */
export const T5_REPOSITORY_PROMPT_MESSAGE =
  'Le prompt de Prompt Control s’administre dans la section « Prompts maîtres » (brouillon, test facultatif, activation, historique), '
  + 'indépendamment de cette version de configuration.';

/** Texte hérité encore présent dans une configuration T5 (non bloquant). */
export const T5_LEGACY_TEXT_MESSAGE =
  'Un ancien texte de configuration est présent mais n’est pas utilisé par T5. Il sera retiré lors de l’enregistrement du brouillon.';

/** Un préambule ou un ancien texte master est-il stocké (non vide) ? */
export function hasLegacyPromptText(c: { prompt?: string | null; masterPrompt?: string | null }): boolean {
  return Boolean(c.prompt && c.prompt.trim() !== '') || Boolean(c.masterPrompt && c.masterPrompt.trim() !== '');
}
