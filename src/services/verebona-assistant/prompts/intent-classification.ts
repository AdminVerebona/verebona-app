/**
 * Prompt de classification d'intention — intent-classification-v1.0 (CDC §9.4.9 / §17.6).
 * Utilisé UNIQUEMENT en dernier recours, renvoie une intention du catalogue fermé.
 */
import { VEREBONA_INTENTS } from '../types/intents';

export const INTENT_CLASSIFICATION_PROMPT_V1 = [
  'Classe la demande de l’utilisateur dans EXACTEMENT une intention de la liste fermée suivante.',
  'Si aucune ne convient, réponds "UNKNOWN". Ne crée jamais de nouvelle intention.',
  `Liste: ${VEREBONA_INTENTS.join(', ')}.`,
  'Réponds au format JSON: {"intent": "<INTENT>", "confidence": "exact|probable|ambiguous"}.',
].join('\n');
