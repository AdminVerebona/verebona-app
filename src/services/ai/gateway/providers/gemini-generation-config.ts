/**
 * Paramètres de génération Gemini — CDC BO IA GEN-011, §2.1 (raisonnement).
 *
 * Isolés de l'adaptateur pour être testés sans appel réseau : ce sont les deux
 * réglages qui changent le comportement du modèle à chaque appel.
 */
import type { ReasoningLevel } from '../../config/config-types';

/**
 * Température — GEN-011 : « très basse/glaciale et définie dans le code ».
 *
 * Constante, jamais administrable : le §2.1 range la température parmi les
 * paramètres hors BO. Zéro rend l'extraction et la classification aussi
 * reproductibles que le fournisseur le permet — deux analyses du même document
 * doivent produire les mêmes faits.
 */
export const GEMINI_TEMPERATURE = 0;

/** Configuration de raisonnement transmise dans `generationConfig.thinkingConfig`. */
export type GeminiThinkingConfig =
  | { thinkingLevel: 'low' | 'high' }
  | { thinkingBudget: number };

/**
 * Projection du niveau administré (minimal / standard / étendu) sur le réglage
 * du modèle.
 *
 * ⚠️ Les familles ne parlent pas la même langue :
 *   · Gemini 3.x : `thinkingLevel` (low / high) ;
 *   · Gemini 2.5 : `thinkingBudget` en jetons, avec des bornes propres au
 *     modèle — 2.5 Pro ne peut pas désactiver le raisonnement (minimum 128),
 *     Flash et Flash-Lite le peuvent (0).
 * Envoyer un réglage hors bornes fait échouer l'APPEL, donc en production :
 * chaque valeur ci-dessous est dans les bornes documentées du modèle.
 *
 * `standard` et `null` ne transmettent rien : le défaut du modèle (raisonnement
 * dynamique) EST le niveau standard. Un modèle d'une autre famille (2.0, 1.5)
 * ne raisonne pas : rien n'est transmis, plutôt qu'un paramètre refusé.
 */
export function thinkingConfigFor(model: string, level: ReasoningLevel | null | undefined): GeminiThinkingConfig | undefined {
  if (!level || level === 'standard') return undefined;
  const m = model.toLowerCase();
  if (/^gemini-3(\.|-)/.test(m)) {
    return { thinkingLevel: level === 'minimal' ? 'low' : 'high' };
  }
  if (m.startsWith('gemini-2.5-pro')) {
    return { thinkingBudget: level === 'minimal' ? 128 : 32_768 };
  }
  if (m.startsWith('gemini-2.5-')) {
    return { thinkingBudget: level === 'minimal' ? 0 : 24_576 };
  }
  return undefined;
}

/** `generationConfig` complet d'un appel. */
export function buildGenerationConfig(input: {
  model: string;
  maxOutputTokens?: number;
  reasoning?: ReasoningLevel | null;
}): Record<string, unknown> {
  const thinkingConfig = thinkingConfigFor(input.model, input.reasoning);
  return {
    temperature: GEMINI_TEMPERATURE,
    // Absent = défaut du fournisseur. Le §2.1 rend ce plafond administrable ;
    // l'appliquer ici est ce qui empêche le champ d'être décoratif.
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
}
