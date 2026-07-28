/**
 * Usage IA n°4 — Intelligence de l'agenda.
 */
export { processAgendaCandidates } from './agenda-intelligence.service';
export type { AgendaIntelligenceInput } from './agenda-intelligence.service';

export { classifyByRules, getClassificationPatterns } from './rules/deterministic-classification';
export { interpretDate, isPastDue } from './rules/date-interpreter';
export { findDuplicate, titleSimilarity } from './dedupe.service';
export { decideStatus } from './status-reconciler';

export type {
  HomeCategory, AgendaDecision, AgendaDecisionAction, ExistingAgendaItem,
} from './types';

import { onSourceAnalyzed } from '../source-analysis/events';
import { processAgendaCandidates } from './agenda-intelligence.service';

/**
 * Abonnement à l'analyse — étape 14 du §4.1.4.
 * À appeler une fois au démarrage, depuis `instrumentation.ts`.
 */
export function registerAgendaHandlers(
  loadExisting: (accountId: number, assetId: number) => Promise<import('./types').ExistingAgendaItem[]>,
  persist: (decisions: import('./types').AgendaDecision[], accountId: number, assetId: number) => Promise<void>,
): void {
  onSourceAnalyzed(async (e) => {
    if (!e.assetId || e.result.agendaCandidates.length === 0) return;

    const existing = await loadExisting(e.accountId, e.assetId);
    const decisions = await processAgendaCandidates({
      accountId: e.accountId,
      userId: e.userId,
      assetId: e.assetId,
      candidates: e.result.agendaCandidates,
      existing,
      sourceFileId: e.leadSourceId,
    });

    await persist(decisions, e.accountId, e.assetId);
  });
}
