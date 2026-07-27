/**
 * Registre des prompts — CDC §17.1.
 *
 * Les prompts sont du CODE PRODUIT VERSIONNÉ (id, version, statut, tests, intentions
 * et modèles compatibles). Ils ne sont jamais rédigés dans les routes API (§17.2) ni
 * modifiés sans évaluation (§17.9).
 */
import type { VerebonaIntent } from '../types/intents';

export type PromptStatus = 'draft' | 'candidate' | 'active' | 'archived';

export interface PromptEntry {
  id: string;                 // ex: 'account-summary'
  version: string;            // ex: 'account-summary-v1.3'
  effectiveFrom: string;
  owner: string;
  status: PromptStatus;
  compatibleIntents: VerebonaIntent[];
  compatibleModels: string[]; // alias
  testSuite: string;          // fixtures associées
}

export const PROMPTS: Record<string, PromptEntry> = {
  system: {
    id: 'system', version: 'assistant-system-v1.0', effectiveFrom: '2026-07-16',
    owner: 'PO Verebona', status: 'active', compatibleIntents: [],
    compatibleModels: ['assistant-default', 'assistant-escalation'], testSuite: 'system.fixtures',
  },
  'intent-classification': {
    id: 'intent-classification', version: 'intent-classification-v1.0', effectiveFrom: '2026-07-16',
    owner: 'Responsable technique', status: 'active', compatibleIntents: ['UNKNOWN'],
    compatibleModels: ['assistant-default'], testSuite: 'intent-classification.fixtures',
  },
  'account-summary': {
    id: 'account-summary', version: 'account-summary-v1.3', effectiveFrom: '2026-07-16',
    owner: 'PO Verebona', status: 'active', compatibleIntents: ['ACCOUNT_SUMMARY'],
    compatibleModels: ['assistant-default', 'assistant-escalation'], testSuite: 'account-summary.fixtures',
  },
  'account-comparison': {
    id: 'account-comparison', version: 'account-comparison-v1.2', effectiveFrom: '2026-07-16',
    owner: 'PO Verebona', status: 'active', compatibleIntents: ['ACCOUNT_COMPARISON'],
    compatibleModels: ['assistant-default', 'assistant-escalation'], testSuite: 'account-comparison.fixtures',
  },
  'account-timeline': {
    id: 'account-timeline', version: 'account-timeline-v1.0', effectiveFrom: '2026-07-16',
    owner: 'PO Verebona', status: 'active', compatibleIntents: ['ACCOUNT_TIMELINE'],
    compatibleModels: ['assistant-default'], testSuite: 'account-timeline.fixtures',
  },
  clarification: {
    id: 'clarification', version: 'clarification-v1.1', effectiveFrom: '2026-07-16',
    owner: 'PO Verebona', status: 'active', compatibleIntents: [],
    compatibleModels: ['assistant-default'], testSuite: 'clarification.fixtures',
  },
  'product-help': {
    id: 'product-help', version: 'product-help-v1.0', effectiveFrom: '2026-07-16',
    owner: 'PO Verebona', status: 'active', compatibleIntents: ['PRODUCT_HELP_HOW_TO'],
    compatibleModels: ['assistant-default'], testSuite: 'product-help.fixtures',
  },
};

export function getActivePrompt(id: string): PromptEntry {
  const p = PROMPTS[id];
  if (!p) throw new Error(`Prompt inconnu: ${id}`);
  if (p.status !== 'active') throw new Error(`Prompt ${id} non actif (${p.status})`);
  return p;
}
