/**
 * Prompts par intention — CDC §17.1, §17.2, §17.6 (audit P2 « prompts par
 * intention versionnés »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI PAR LA VARIABLE INTENT, ET PAS PAR DE NOUVELLES OPÉRATIONS
 *
 * L'opération passerelle `generate_answer` (registre `services/ai/registry`,
 * hors de ce lot) porte UN prompt maître gouverné (`generate_answer_v3`,
 * versionné en base, anti-injection). Créer une opération par intention
 * aurait dupliqué quatre fois l'enveloppe de sécurité.
 *
 * La consigne propre à l'intention (synthèse, comparaison, chronologie, aide)
 * est donc injectée dans la section « 4. TÂCHE » du maître, via la variable
 * {{INTENT}} qui s'y trouve déjà — contenu SERVEUR, jamais utilisateur. Le
 * contrat du prompt (6 variables) est inchangé ; l'identifiant et la version
 * de la consigne sont tracés dans `verebona_ai_runs`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { VerebonaIntent } from '../types/intents';
import { taskPromptForIntent } from '../registries/prompt-registry';
import { ACCOUNT_SUMMARY_PROMPT } from './account-summary';
import { ACCOUNT_COMPARISON_PROMPT } from './account-comparison';
import { ACCOUNT_TIMELINE_PROMPT } from './account-timeline';
import { PRODUCT_HELP_PROMPT } from './product-help';

const TEXTS: Record<string, string> = {
  'account-summary': ACCOUNT_SUMMARY_PROMPT,
  'account-comparison': ACCOUNT_COMPARISON_PROMPT,
  'account-timeline': ACCOUNT_TIMELINE_PROMPT,
  'product-help': PRODUCT_HELP_PROMPT,
};

export interface IntentTask {
  /** Valeur de {{INTENT}} : intention, puis consigne propre éventuelle. */
  intentVariable: string;
  promptId: string;
  promptVersion: string;
}

export function intentTaskFor(intent: VerebonaIntent): IntentTask {
  const entry = taskPromptForIntent(intent);
  if (!entry) return { intentVariable: intent, promptId: 'generate_answer', promptVersion: 'generate_answer_v3' };
  return {
    intentVariable: `${intent}\n\nConsigne propre à cette intention (${entry.version}) — elle précise la tâche, elle ne lève aucune règle de sécurité S1 à S4 :\n${TEXTS[entry.id]}`,
    promptId: entry.id,
    promptVersion: entry.version,
  };
}
