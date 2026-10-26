/**
 * Usage IA n°4 — Intelligence de l'agenda.
 */
export {
  processAgendaCandidates,
} from './agenda-intelligence.service';

export type {
  HomeCategory, AgendaDecision, ExistingAgendaItem,
} from './types';

import { onSourceAnalyzed } from '../source-analysis/events';
import { processAgendaCandidates } from './agenda-intelligence.service';
import { registerJobHandler } from '../queue/queue-worker';
import type { QueuedJob } from '../queue/job-queue.repository';
import type { ExecutionGuard } from '../queue/execution-control';
import type { JobBusinessResult } from '../queue/queue-policy';
import type { AgendaCandidate } from '../source-analysis/types';

type LoadExisting = (accountId: number, assetId: number) => Promise<import('./types').ExistingAgendaItem[]>;
/**
 * Persistance des décisions (`persistAgendaDecisions`, B). `sourceFileId`
 * permet la synchronisation par source (T4-08) — y compris le retrait des
 * anciens éléments automatiques quand une réanalyse ne produit plus aucun
 * candidat.
 */
type Persist = (
  decisions: import('./types').AgendaDecision[], accountId: number, assetId: number,
  opts?: { sourceFileId?: number; analysisComplete?: boolean; incompleteReasons?: string[] },
) => Promise<void | Partial<import('@/services/agenda/agenda-persistence').PersistAgendaSummary>>;

/** Type de cible T4 dans la file : le document source des candidats. */
const T4_TARGET = 'asset_file';

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
interface T4Payload {
  assetId: number;
  userId: number;
  leadSourceId: number;
  candidates: AgendaCandidate[];
  /**
   * CDC 15 T4-08 (relecture lot 14) : l'analyse qui a produit ces candidats
   * est COMPLÈTE (`services/agenda/analysis-completeness.ts`). Seule une
   * analyse complète retire les éléments automatiques qu'elle ne produit
   * plus. Absent (travail antérieur, rattachement tardif) : incomplète.
   */
  analysisComplete?: boolean;
  /** Avertissements d'incomplétude, pour le journal. */
  incompleteReasons?: string[];
  /**
   * Lot 71E (§E) — décisions T4 déjà APPLIQUÉES par une exécution précédente
   * de CE travail (`forJob`), par empreinte de contexte : une reprise ne les
   * redemande pas au modèle. Écrit par l'exécutant, jamais par l'appelant.
   */
  t4Resolved?: { forJob: number; decisions: Record<string, import('./agenda-intelligence.service').StoredT4Decision> };
}

interface T4Deps {
  loadExisting: LoadExisting;
  persist: Persist;
  process: typeof processAgendaCandidates;
  /** Lot 71E (§E) — conservation du contexte de reprise (défaut : `mergeJobPayload`). */
  savePayload?: (jobId: number, executionId: string | null, patch: Record<string, unknown>) => Promise<boolean>;
}

/**
 * Lot 71E (§E) — travail T4 INCOMPLET : au moins un candidat sans décision
 * (échec technique T4) ou une écriture en échec. Erreur ORDINAIRE (jamais
 * `PermanentJobError`) : la file existante le reprend avec temporisation
 * croissante, puis le passe en échec définitif après MAX_ATTEMPTS exécutions
 * (MOD-005) — visible au BO › File IA. Les décisions valides sont déjà
 * appliquées, aucun retrait n'a eu lieu, et la reprise ne redemande que ce
 * qui manque (`t4Resolved`).
 */
type T4IncompleteCode = 'T4_INCOMPLETE' | 'T4_PERSIST_PARTIAL' | 'T4_SYNC_FAILED';
export class T4IncompleteJobError extends Error {
  readonly code: T4IncompleteCode;
  constructor(code: T4IncompleteCode, message: string) {
    super(`${code} : ${message}`);
    this.name = 'T4IncompleteJobError';
    this.code = code;
  }
}

type Bilan = void | Partial<import('@/services/agenda/agenda-persistence').PersistAgendaSummary>;

/**
 * Lot 75F (§D) — synchronisation de la source techniquement en échec
 * (retrait SQL en échec, journal des retraits indisponible, prérequis absent,
 * plan impossible) : motif précis, ou null. Une liste de retraits vide n'est
 * jamais une preuve de réussite : seul `removalOutcome` fait foi.
 */
export function t4SyncFailure(bilan: Bilan): string | null {
  if (!bilan || typeof bilan !== 'object' || bilan.removalOutcome !== 'FAILED') return null;
  const f = bilan.removalFailure;
  return f ? `${f.code} : ${f.message}` : 'REMOVAL_FAILED';
}

/** Lot 75F (§D) — sort de la synchronisation pour le résultat métier du job (compteurs seulement). */
function t4SyncDetail(bilan: Bilan): Record<string, unknown> {
  const b = bilan && typeof bilan === 'object' ? bilan : {};
  return {
    removal: b.removal ?? null, removed: b.removed?.length ?? 0, corrected: b.corrected ?? 0,
    removalOutcome: b.removalOutcome ?? null, blockedBy: b.blockedBy ?? [], preserved: b.preserved?.length ?? 0,
    temporalAmbiguities: b.temporalAmbiguities ?? 0, ambiguousMatches: b.ambiguousMatches ?? 0,
  };
}

/** Lot 71E (§E) — compteurs d'un passage T4 (résultat métier du job ; aucun contenu documentaire). */
export function t4JobCounters(decisions: import('./types').AgendaDecision[]): {
  candidates: number; accepted: number; eventRejected: number; recurrenceRejected: number;
  abstained: number; technicalFailures: number; reused: number;
} {
  const t = decisions.map((d) => d.t4).filter((x): x is NonNullable<typeof x> => Boolean(x));
  const n = (v: string) => t.filter((x) => x.verdict === v).length;
  return {
    candidates: t.length, accepted: n('ACCEPTED'), eventRejected: n('EVENT_REJECTED'), recurrenceRejected: n('RECURRENCE_REJECTED'),
    abstained: n('ABSTAINED'), technicalFailures: n('TECHNICAL_FAILURE'), reused: t.filter((x) => x.reused).length,
  };
}

/**
 * Exécute un travail T4 (pur vis-à-vis de la base : tout passe par `deps`).
 *
 * Lot 16b-2 : `AI_AGENDA_ENGINE` et `AI_T4_EFFECTS` retirés — les décisions
 * sont toujours écrites, avec les effets T4 (synchronisation par source,
 * liens source, nature D-14) ; plus aucun mode observation.
 */
export async function runT4Job(job: QueuedJob, guard: ExecutionGuard, deps: T4Deps): Promise<void | JobBusinessResult> {
  const p = (job.payload ?? {}) as Partial<T4Payload>;
  // CDC 15 T4-08 (lot 14) : une réanalyse SANS candidat est un travail
  // valide — la synchronisation de la source retire les anciens éléments
  // automatiques qu'elle ne produit plus.
  const vide = Array.isArray(p.candidates) && p.candidates.length === 0;
  if (job.accountId && p.assetId && p.leadSourceId && vide) {
    // Réanalyse vide ET dégradée (contenu inexploitable, extraction
    // partielle, repli…) : elle n'a rien lu — on ne retire rien.
    if (p.analysisComplete !== true) {
      console.info(JSON.stringify({
        event: 't4.empty_reanalysis_ignored', jobId: job.id, sourceFileId: p.leadSourceId, assetId: p.assetId,
        reasons: p.incompleteReasons ?? ['UNKNOWN'],
      }));
      return;
    }
    await guard.assertActive('synchronisation des échéances de la source');
    const bilanVide = await deps.persist([], job.accountId, p.assetId, { sourceFileId: p.leadSourceId, analysisComplete: true });
    // Lot 75F (§D) : retrait attendu techniquement impossible → travail NON
    // réussi, reprise contrôlée par la file (temporisation, MAX_ATTEMPTS).
    const echecVide = t4SyncFailure(bilanVide);
    if (echecVide) {
      await saveRetryContext(job, deps, null, { writeFailures: 0, syncFailure: echecVide });
      throw new T4IncompleteJobError('T4_SYNC_FAILED',
        `synchronisation de la source ${p.leadSourceId} incomplète (réanalyse sans candidat) — ${echecVide} ; aucune échéance retirée ; reprise automatique par la file`);
    }
    const detailVide = t4SyncDetail(bilanVide);
    return { result: Number(detailVide.removed) > 0 ? 'APPLIED' : 'NO_CHANGE', detail: { candidates: 0, writeFailures: 0, ...detailVide } };
  }
  if (!job.accountId || !p.assetId || !Array.isArray(p.candidates) || p.candidates.length === 0) {
    // Malformé ou vide : relancer ne l'améliorera pas.
    console.error(`[agenda] travail T4 ${job.id} sans bien ni candidat exploitable — ignoré.`);
    return;
  }
  const existing = await deps.loadExisting(job.accountId, p.assetId);
  // Lot 71E (§E) : reprise du MÊME travail — décisions déjà appliquées réutilisées.
  const deja = p.t4Resolved && p.t4Resolved.forJob === job.id ? p.t4Resolved.decisions : undefined;
  const decisions = await deps.process({
    accountId: job.accountId,
    userId: p.userId,
    assetId: p.assetId,
    candidates: p.candidates,
    existing,
    sourceFileId: p.leadSourceId,
    ...(deja && Object.keys(deja).length ? { resolvedDecisions: deja } : {}),
  });

  // Interrompue (rollback, arrêt d'urgence, désactivation) : aucune écriture.
  await guard.assertActive('écriture des échéances');
  const bilan = p.leadSourceId
    ? await deps.persist(decisions, job.accountId, p.assetId, {
      sourceFileId: p.leadSourceId, analysisComplete: p.analysisComplete === true, incompleteReasons: p.incompleteReasons,
    })
    : await deps.persist(decisions, job.accountId, p.assetId);

  // ── Lot 71E (§E) : un échec technique n'est jamais un traitement réussi ──
  // Lot 75F (§D) : y compris une synchronisation (retrait) en échec technique.
  const compteurs = t4JobCounters(decisions);
  const echecsEcriture = (bilan && typeof bilan === 'object' ? bilan.writeFailures : 0) ?? 0;
  const echecSync = t4SyncFailure(bilan);
  if (compteurs.technicalFailures > 0 || echecsEcriture > 0 || echecSync) {
    await saveRetryContext(job, deps, { decisions, deja }, { ...compteurs, writeFailures: echecsEcriture, ...(echecSync ? { syncFailure: echecSync } : {}) });
    console.warn(JSON.stringify({ event: 't4.job_incomplete', jobId: job.id, attempt: job.attempts ?? null, ...compteurs, writeFailures: echecsEcriture, syncFailure: echecSync }));
    if (compteurs.technicalFailures > 0) {
      throw new T4IncompleteJobError('T4_INCOMPLETE',
        `${compteurs.technicalFailures} candidat(s) sans décision (échec technique T4) — décisions valides appliquées, aucun retrait ; reprise automatique par la file`);
    }
    if (echecsEcriture > 0) {
      throw new T4IncompleteJobError('T4_PERSIST_PARTIAL',
        `${echecsEcriture} écriture(s) Agenda en échec — aucun retrait ; reprise automatique par la file`);
    }
    throw new T4IncompleteJobError('T4_SYNC_FAILED',
      `synchronisation de la source ${p.leadSourceId ?? '?'} incomplète — ${echecSync} ; décisions valides appliquées ; reprise automatique par la file`);
  }
  const sync = t4SyncDetail(bilan);
  return {
    // ABSTAIN : au moins un candidat sans décision métier (rien créé ni retiré pour lui).
    result: compteurs.abstained > 0 ? 'ABSTAIN'
      : compteurs.accepted + compteurs.recurrenceRejected + Number(sync.removed) + Number(sync.corrected) > 0 ? 'APPLIED' : 'NO_CHANGE',
    detail: { ...compteurs, writeFailures: 0, ...sync },
  };
}

/**
 * Lot 71E (§E) — contexte de reprise du MÊME travail : décisions T4
 * APPLIQUÉES (jamais les échecs techniques) et compteurs. Jamais bloquant.
 */
async function saveRetryContext(
  job: QueuedJob, deps: T4Deps,
  applied: { decisions: import('./types').AgendaDecision[]; deja?: Record<string, import('./agenda-intelligence.service').StoredT4Decision> } | null,
  retry: Record<string, unknown>,
): Promise<void> {
  const patch: Record<string, unknown> = { t4Retry: { attempt: job.attempts ?? null, ...retry, at: new Date().toISOString() } };
  if (applied) {
    const { storableT4Decision } = await import('./agenda-intelligence.service');
    const conservees: Record<string, import('./agenda-intelligence.service').StoredT4Decision> = { ...(applied.deja ?? {}) };
    for (const d of applied.decisions) {
      const fp = d.t4?.fingerprint;
      if (!fp || !d.t4 || d.t4.outcome === 'technical_failure') continue;
      const s = storableT4Decision({
        agendaDecision: d.t4.agendaDecision, recurrenceDecision: d.t4.recurrenceDecision,
        classification: {
          category: d.t4.homeCategory, confidence: d.t4.confidence, source: 'model', // échecs techniques exclus ci-dessus
          businessType: d.t4.businessTypeSource === 'T4' ? d.t4.businessType : null, reason: d.t4.reason,
        },
        reason: d.t4.reason, recurrenceReason: d.t4.recurrenceReason, outcome: d.t4.outcome,
        warnings: d.t4.warnings.filter((w) => w !== 'T4_BUSINESS_TYPE_NULL' && !w.startsWith('CANDIDATE_BUSINESS_TYPE_OUT_OF_CATALOG')),
        ...(d.t4.contractVersion ? { contractVersion: d.t4.contractVersion } : {}),
        ...(d.t4.traceId ? { traceId: d.t4.traceId } : {}),
      });
      if (s) conservees[fp] = s;
    }
    patch.t4Resolved = { forJob: job.id, decisions: conservees };
  }
  const save = deps.savePayload ?? (await import('../queue/job-queue.repository')).mergeJobPayload;
  try {
    await save(job.id, job.executionId ?? null, patch);
  } catch (e) {
    // Sans contexte de reprise, la reprise redemandera tout : jamais bloquant.
    console.error(`[agenda] travail T4 ${job.id} : contexte de reprise non conservé —`, (e as Error).message);
  }
}

/**
 * Met en file durable les candidats d'une analyse (déclencheur
 * `source_analyzed`). Une réanalyse du même document avant exécution
 * REMPLACE les candidats en attente : les plus récents font foi.
 */
export async function enqueueT4Candidates(
  e: {
    accountId: number; userId: number; assetId: number; leadSourceId: number; candidates: AgendaCandidate[];
    analysisComplete?: boolean; incompleteReasons?: string[];
  },
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
    ...(e.analysisComplete !== undefined ? { analysisComplete: e.analysisComplete } : {}),
    ...(e.incompleteReasons?.length ? { incompleteReasons: e.incompleteReasons } : {}),
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
  }));

  // Sans drapeau (lot 16b-2) : l'agenda T4 suit toujours l'analyse. Une
  // réanalyse sans candidat est mise en file (synchronisation de la source,
  // T4-08).
  onSourceAnalyzed('agenda', async (e) => {
    if (!e.assetId) return;
    // Complétude de l'analyse (T4-08) : portée jusqu'à la persistance.
    const { analysisCompleteness } = await import('@/services/agenda/analysis-completeness');
    const completude = analysisCompleteness(e.result);
    await enqueueT4Candidates({
      accountId: e.accountId,
      userId: e.userId,
      assetId: e.assetId,
      leadSourceId: e.leadSourceId,
      candidates: e.result.agendaCandidates,
      analysisComplete: completude.complete,
      incompleteReasons: completude.reasons,
    });
  });
}
