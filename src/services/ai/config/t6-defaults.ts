/**
 * Configuration par défaut de T6 — mascotte d'accueil (CDC Mascotte §19).
 *
 * Sert là où une version ne porte pas encore de ligne T6 : versions
 * antérieures (migration 0166, même contenu) et packages exportés avant
 * l'arrivée de T6. Sans elle, une telle version ne serait plus promouvable.
 */
import type { TreatmentConfig } from './config-types';

/** Charte de voix : le prompt administrable de T6 (T6-009). */
export const T6_DEFAULT_VOICE_CHARTER = `Charte de voix de la mascotte Verebona.
Tu écris ce que dit la mascotte de l'accueil à l'utilisateur.
- Naturelle, concise, chaleureuse sans excès, proactive.
- Vocabulaire simple ; jamais alarmiste, jamais infantilisante.
- Vouvoiement obligatoire. Aucun emoji.
- Une formulation positive seulement si elle correspond réellement au contexte.
- La personnalité ne prend jamais le dessus sur l'information.`;

export function defaultT6Config(): TreatmentConfig {
  return {
    treatment: 'T6',
    prompt: T6_DEFAULT_VOICE_CHARTER,
    primaryModel: 'gemini-3.5-flash-lite',
    fallback1: 'gemini-3.1-flash-lite',
    fallback2: null,
    reasoningPrimary: 'minimal',
    reasoningFallback1: 'minimal',
    reasoningFallback2: null,
    maxOutputTokens: 1024,
    guardrails: [],
    triggers: [],
    cascade: null,
  };
}
