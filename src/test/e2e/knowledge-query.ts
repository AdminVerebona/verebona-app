/**
 * Lot 85F — harnais e2e : capacité T3 KNOWLEDGE_QUERY « livrée » (version BO
 * de test du prompt T3 : texte du dépôt + section de la branche — aucun
 * fichier de prompt modifié) et réponse simulée du modèle.
 *
 * Pour les scénarios dont l'interprétation sémantique n'est PAS le sujet
 * (lots 58B, 72, 76…) : ils décrivent une donnée inconnue de TOUTE la
 * connaissance T1. Sans capacité, le lot 85F les met en « interprétation en
 * attente » (aucune nouvelle carte) ; avec la capacité livrée et une
 * interprétation sans résultat (NOT_FOUND par défaut), le comportement
 * qu'ils vérifient est inchangé.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach } from 'vitest';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';
import { setDefaultResponder } from './replay-gateway';

export const KNOWLEDGE_NOT_FOUND = () => ({ task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'aucune information (simulé e2e)' });

/** Pose la capacité et le modèle simulé avant chaque test du fichier ; les retire à la fin. */
export function useKnowledgeQueryDelivered(respond: (input: ProviderCallInput) => unknown = KNOWLEDGE_NOT_FOUND): void {
  const texte = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
  beforeEach(async () => {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: 98599, treatment: 'T3', versionNumber: 859,
      content: `${texte}\n\nBRANCHE TASK = KNOWLEDGE_QUERY\n\n(Section de test e2e : réponse simulée.)\n` }]);
    (await import('@/services/ai/reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests();
    setDefaultResponder('t3_knowledge_query', 'KNOWLEDGE_QUERY', respond);
  });
  afterAll(async () => {
    setDefaultResponder('t3_knowledge_query', 'KNOWLEDGE_QUERY', null);
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    (await import('@/services/ai/reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests();
  });
}
