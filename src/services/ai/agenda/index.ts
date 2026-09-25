/**
 * Usage IA n°4 — Intelligence de l'agenda.
 */
export { processAgendaCandidates, classifyAgendaCategory } from './agenda-intelligence.service';
export type { AgendaIntelligenceInput } from './agenda-intelligence.service';

export { classifyByRules, getClassificationPatterns } from './rules/deterministic-classification';
export { interpretDate, isPastDue } from './rules/date-interpreter';
export { findDuplicate, titleSimilarity } from './dedupe.service';
export { decideStatus } from './status-reconciler';

export type {
  HomeCategory, AgendaDecision, AgendaDecisionAction, ExistingAgendaItem,
} from './types';

import { onSourceAnalyzed } from '../source-analysis/events';
import { shouldWrite } from '../flags/ai-feature-flags';
import { processAgendaCandidates } from './agenda-intelligence.service';

/** Base illisible : on laisse passer, la garde de la passerelle reste en second rideau. */
async function t4PeutDemarrer(): Promise<boolean> {
  try {
    const { canStart } = await import('../queue/job-queue.repository');
    return await canStart('T4');
  } catch (e) {
    console.warn('[agenda] état T4 illisible, démarrage autorisé :', (e as Error).message);
    return true;
  }
}

/**
 * Abonnement à l'analyse — étape 14 du §4.1.4.
 * À appeler une fois au démarrage, depuis `instrumentation.ts`.
 */
export function registerAgendaHandlers(
  loadExisting: (accountId: number, assetId: number) => Promise<import('./types').ExistingAgendaItem[]>,
  persist: (decisions: import('./types').AgendaDecision[], accountId: number, assetId: number) => Promise<void>,
): void {
  onSourceAnalyzed('AI_AGENDA_ENGINE', async (e) => {
    if (!e.assetId || e.result.agendaCandidates.length === 0) return;

    // CDC BO IA OPS-008, OPS-011, WF-07, WF-08 : T4 coupé (désactivé,
    // suspendu, arrêt d'urgence) ne démarre aucune exécution. Jusqu'ici ce
    // handler ne lisait aucun état : le bouton « Désactiver T4 » était sans
    // effet.
    // ⚠️ Limite connue : T4 n'a pas encore de file durable (lot suivant) — les
    // candidats de CE document ne sont pas conservés ; ils seront reproduits
    // à la prochaine analyse du document. Journalisé pour être visible.
    if (!(await t4PeutDemarrer())) {
      console.warn(
        `[agenda] T4 bloqué — ${e.result.agendaCandidates.length} candidat(s) non traité(s) ` +
        `(compte ${e.accountId}, bien ${e.assetId}, source ${e.leadSourceId}).`,
      );
      return;
    }

    const existing = await loadExisting(e.accountId, e.assetId);
    const decisions = await processAgendaCandidates({
      accountId: e.accountId,
      userId: e.userId,
      assetId: e.assetId,
      candidates: e.result.agendaCandidates,
      existing,
      sourceFileId: e.leadSourceId,
    });

    // Mode observation (§10.2) : les décisions sont produites et mesurables,
    // mais rien n'est écrit. Cette garde manquait — l'abonné persistait quel
    // que soit le mode, ce qui faisait coexister deux écrivains sur le même
    // agenda.
    if (!shouldWrite('AI_AGENDA_ENGINE')) {
      console.info(
        `[agenda][shadow] ${decisions.length} décision(s) produites sans écriture ` +
        `(compte ${e.accountId}, bien ${e.assetId}).`,
      );
      return;
    }

    await persist(decisions, e.accountId, e.assetId);
  });
}
