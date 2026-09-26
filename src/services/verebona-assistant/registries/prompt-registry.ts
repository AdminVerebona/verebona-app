/**
 * Registre des prompts — CDC §17.1, §17.6, §17.11.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE LE REGISTRE DÉCRIT, ET RIEN D'AUTRE
 *
 * Avant : sept entrées (system, intent-classification, clarification…) dont
 * AUCUNE n'était lue à l'exécution — le prompt réellement envoyé était
 * `generate_answer_v2/v3.txt`, identique pour toutes les intentions.
 *
 * Maintenant :
 *  · prompts MAÎTRES (fichiers versionnés de la passerelle, seed de
 *    `ai_prompt_versions`) : `generate_answer_v3`, `understand_request_v1`,
 *    `revalidate_fact_v1` ;
 *  · consignes de TÂCHE par intention (`prompts/*.ts`), injectées dans la
 *    section « 4. TÂCHE » du prompt maître par `intent-tasks.ts` et TRACÉES
 *    (`verebona_ai_runs.prompt_id / prompt_version`).
 *
 * La clarification et la classification n'ont plus d'entrée « tâche » :
 * la clarification est construite sans modèle (`clarification-builder`), la
 * classification a son prompt maître dédié.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { VerebonaIntent } from '../types/intents';
import { ACCOUNT_SUMMARY_PROMPT_VERSION } from '../prompts/account-summary';
import { ACCOUNT_COMPARISON_PROMPT_VERSION } from '../prompts/account-comparison';
import { ACCOUNT_TIMELINE_PROMPT_VERSION } from '../prompts/account-timeline';
import { PRODUCT_HELP_PROMPT_VERSION } from '../prompts/product-help';

export type PromptStatus = 'draft' | 'candidate' | 'active' | 'archived';

export interface PromptEntry {
  id: string;
  version: string;
  kind: 'master' | 'task';
  status: PromptStatus;
  compatibleIntents: VerebonaIntent[];
  /** Jeu de cas exécutable qui le couvre (§17.9). */
  testSuite: string;
}

const HELP: VerebonaIntent[] = ['PRODUCT_HELP_HOW_TO', 'PRODUCT_HELP_EXPLAIN', 'PRODUCT_HELP_STATUS', 'NAVIGATION_FIND', 'EXPORT_HELP'];

export const PROMPTS: Record<string, PromptEntry> = {
  generate_answer: {
    id: 'generate_answer', version: 'generate_answer_v3', kind: 'master', status: 'active',
    compatibleIntents: [], testSuite: 'src/services/ai/prompts/__tests__/contrat-generate-answer.test.ts',
  },
  understand_request: {
    id: 'understand_request', version: 'understand_request_v1', kind: 'master', status: 'active',
    compatibleIntents: ['UNKNOWN'], testSuite: 'src/services/ai/prompts/__tests__/contrat-understand-request.test.ts',
  },
  'account-summary': {
    id: 'account-summary', version: ACCOUNT_SUMMARY_PROMPT_VERSION, kind: 'task', status: 'active',
    compatibleIntents: ['ACCOUNT_SUMMARY'], testSuite: 'src/services/verebona-assistant/eval',
  },
  'account-comparison': {
    id: 'account-comparison', version: ACCOUNT_COMPARISON_PROMPT_VERSION, kind: 'task', status: 'active',
    compatibleIntents: ['ACCOUNT_COMPARISON'], testSuite: 'src/services/verebona-assistant/eval',
  },
  'account-timeline': {
    id: 'account-timeline', version: ACCOUNT_TIMELINE_PROMPT_VERSION, kind: 'task', status: 'active',
    compatibleIntents: ['ACCOUNT_TIMELINE'], testSuite: 'src/services/verebona-assistant/eval',
  },
  'product-help': {
    id: 'product-help', version: PRODUCT_HELP_PROMPT_VERSION, kind: 'task', status: 'active',
    compatibleIntents: HELP, testSuite: 'src/services/verebona-assistant/eval',
  },
};

export function getActivePrompt(id: string): PromptEntry {
  const p = PROMPTS[id];
  if (!p) throw new Error(`Prompt inconnu: ${id}`);
  if (p.status !== 'active') throw new Error(`Prompt ${id} non actif (${p.status})`);
  return p;
}

/** Consigne de tâche active pour une intention, ou `null` (tâche générique du maître). */
export function taskPromptForIntent(intent: VerebonaIntent): PromptEntry | null {
  return Object.values(PROMPTS).find((p) => p.kind === 'task' && p.status === 'active' && p.compatibleIntents.includes(intent)) ?? null;
}
