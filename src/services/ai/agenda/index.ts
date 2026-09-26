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
import { registerJobHandler } from '../queue/queue-worker';
import type { QueuedJob } from '../queue/job-queue.repository';
import type { ExecutionGuard } from '../queue/execution-control';
import type { AgendaCandidate } from '../source-analysis/types';

type LoadExisting = (accountId: number, assetId: number) => Promise<import('./types').ExistingAgendaItem[]>;
type Persist = (decisions: import('./types').AgendaDecision[], accountId: number, assetId: number) => Promise<void>;

/** Type de cible T4 dans la file : le document source des candidats. */
export const T4_TARGET = 'asset_file';

/**
 * Contexte d'un travail T4.
 *
 * ⚠️ Exception assumée à la règle « le travail porte des identifiants, pas des
 * données » (job-queue) : les candidats sont PORTÉS par le job. Ils sont
 * produits par T1 et ne sont persistés ailleurs que partiellement
 * (`document_analysis_proposals` n'a ni la récurrence démontrée ni le champ
 * d'origine) : les reconstruire depuis la base dégraderait T4. Ce sont des
 * dates, titres et courts extraits déjà présents dans le compte — aucun
 * secret. Le document relu à l'exécution reste la référence : un bien
 * supprimé entre-temps est ignoré.
 */
export interface T4Payload {
  assetId: number;
  userId: number;
  leadSourceId: number;
  candidates: AgendaCandidate[];
}

export interface T4Deps {
  loadExisting: LoadExisting;
  persist: Persist;
  process: typeof processAgendaCandidates;
  shouldWrite: () => boolean;
}

/**
 * Exécute un travail T4 (pur vis-à-vis de la base : tout passe par `deps`).
 */
export async function runT4Job(job: QueuedJob, guard: ExecutionGuard, deps: T4Deps): Promise<void> {
  const p = (job.payload ?? {}) as Partial<T4Payload>;
  if (!job.accountId || !p.assetId || !Array.isArray(p.candidates) || p.candidates.length === 0) {
    // Malformé ou vide : relancer ne l'améliorera pas.
    console.error(`[agenda] travail T4 ${job.id} sans bien ni candidat exploitable — ignoré.`);
    return;
  }
  const existing = await deps.loadExisting(job.accountId, p.assetId);
  const decisions = await deps.process({
    accountId: job.accountId,
    userId: p.userId,
    assetId: p.assetId,
    candidates: p.candidates,
    existing,
    sourceFileId: p.leadSourceId,
  });

  // Mode observation (§10.2) : les décisions sont produites et mesurables,
  // mais rien n'est écrit.
  if (!deps.shouldWrite()) {
    console.info(
      `[agenda][shadow] ${decisions.length} décision(s) produites sans écriture ` +
      `(compte ${job.accountId}, bien ${p.assetId}).`,
    );
    return;
  }
  // Interrompue (rollback, arrêt d'urgence, désactivation) : aucune écriture.
  await guard.assertActive('écriture des échéances');
  await deps.persist(decisions, job.accountId, p.assetId);
}

/**
 * Met en file durable les candidats d'une analyse (déclencheur
 * `source_analyzed`). Une réanalyse du même document avant exécution
 * REMPLACE les candidats en attente : les plus récents font foi.
 */
export async function enqueueT4Candidates(
  e: { accountId: number; userId: number; assetId: number; leadSourceId: number; candidates: AgendaCandidate[] },
  deps?: {
    enqueue: typeof import('../queue/job-queue.repository').enqueue;
    isTriggerActive: (t: 'T4', code: string) => Promise<boolean>;
  },
): Promise<number | null> {
  const d = deps ?? {
    enqueue: (await import('../queue/job-queue.repository')).enqueue,
    isTriggerActive: (await import('../queue/triggers')).isTriggerActive,
  };
  if (!(await d.isTriggerActive('T4', 'source_analyzed'))) return null;
  const payload: T4Payload = {
    assetId: e.assetId, userId: e.userId, leadSourceId: e.leadSourceId, candidates: e.candidates,
  };
  const { jobId } = await d.enqueue({
    treatment: 'T4',
    scope: { accountId: e.accountId, targetType: T4_TARGET, targetId: e.leadSourceId },
    triggerCode: 'source_analyzed',
    payload: payload as unknown as Record<string, unknown>,
    payloadOnDedupe: 'replace',
  });
  return jobId;
}

/**
 * Abonnement à l'analyse — étape 14 du §4.1.4 — et exécutant T4 de la file.
 * À appeler une fois au démarrage, depuis `instrumentation.ts`, avant le
 * boucleur (c'est le cas).
 *
 * CDC BO IA OPS-001, NFR-003, T4-016, WF-06 (lot IA 2) : T4 ne s'exécute plus
 * EN LIGNE sur un événement en mémoire. L'abonné met les candidats en file
 * durable ; le boucleur exécute. Un T4 coupé (désactivé, suspendu, arrêt
 * d'urgence) n'est plus une perte : les candidats ATTENDENT en file et sont
 * traités à la réactivation (WF-07) — la limite connue du lot 1 est levée.
 */
export function registerAgendaHandlers(loadExisting: LoadExisting, persist: Persist): void {
  registerJobHandler('T4', (job, guard) => runT4Job(job, guard, {
    loadExisting,
    persist,
    process: processAgendaCandidates,
    shouldWrite: () => shouldWrite('AI_AGENDA_ENGINE'),
  }));

  onSourceAnalyzed('AI_AGENDA_ENGINE', async (e) => {
    if (!e.assetId || e.result.agendaCandidates.length === 0) return;
    await enqueueT4Candidates({
      accountId: e.accountId,
      userId: e.userId,
      assetId: e.assetId,
      leadSourceId: e.leadSourceId,
      candidates: e.result.agendaCandidates,
    });
  });
}
