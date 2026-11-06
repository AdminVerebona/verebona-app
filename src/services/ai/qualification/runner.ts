/**
 * Exécution des cas d'un couple — lot 86A (CDC Pilotage IA V2 P5 : QUAL-01,
 * QUAL-05, ACT-01, R06, CFG-03 ; décision PO n° 14).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN MOTEUR PARALLÈLE (OBJ-05)
 *
 * Chaque cas passe par la passerelle de PRODUCTION (`AiGateway.execute`) :
 * prompt maître, constructeur de requête unique, validation discriminée,
 * capture à la source (82C), trace, coût. Le couple désigné est forcé par
 * les leviers EXISTANTS :
 *   · révision ÉPINGLÉE (`runInJobContext({ configRevisionId })`, lot 54) :
 *     la configuration testée — candidate non active comprise — s'applique à
 *     l'appel sans jamais être activée ;
 *   · rang (`firstModelIndex`) et UNE seule tentative (`maxModelAttempts: 1`) :
 *     aucun secours ne peut répondre à la place du candidat — un succès
 *     obtenu par un autre modèle ne qualifie jamais le couple (QUAL-01, R06) ;
 *   · clé d'idempotence propre à la campagne, au couple, au cas, à
 *     l'observation et à l'essai : jamais de réponse en cache (QUAL-05) ;
 *   · déclencheur `qualification` : appels TECHNIQUES (jamais une exécution
 *     métier), hors plafond de coût du compte (campagne d'administration).
 * Une erreur fournisseur transitoire rend l'essai non concluant et entraîne
 * UN nouvel essai (décision 14) ; un refus de requête est une incompatibilité
 * de RÉGLAGE du couple, jamais une indisponibilité du modèle (R45).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { AiGatewayRequest, AiGatewayResponse } from '../gateway/types';
import type { AiJobContext } from '../queue/job-context';
import type { MasterFileReader } from '../governance/master-corpus/cases';
import { AI_OPERATIONS } from '../registry/operations';
import { outputSha256, type QualificationCase } from './cases';
import { runBounded, type PoolTask } from './concurrency';
import type { CoupleDescriptor } from './couples';
import { isSynchronousTreatment, QUALIFICATION_THRESHOLDS, type QualificationThresholds } from './thresholds';
import type { CaseObservation, ConcurrencyReport } from './verdict';

export type GatewayCall = (req: AiGatewayRequest<unknown>, ctx: AiJobContext) => Promise<AiGatewayResponse<unknown>>;

/** Appel réel : passerelle de production, révision épinglée par le contexte d'exécution. */
export const productionGatewayCall: GatewayCall = async (req, ctx) => {
  const [{ AiGateway }, { runInJobContext }] = await Promise.all([import('../gateway/ai-gateway'), import('../queue/job-context')]);
  return runInJobContext(ctx, () => AiGateway.execute(req));
};

/**
 * Lot 103G : cas non exécuté faute de PRÉREQUIS d'exploitation (cause établie,
 * jamais « non établie ») — compte technique de qualification (corpus) ou
 * compte de données d'un rejeu devenu non éligible (C-Q10).
 */
export type PrerequisiteBlock = 'TECHNICAL_ACCOUNT' | 'REPLAY_ACCOUNT' | 'BUDGET';

/** Lot 113I : préfixe stable d'un essai NON appelé faute de réservation budgétaire (WAITING_BUDGET, jamais un défaut). */
export const BUDGET_REASON_PREFIX = 'budget d’amélioration';

/**
 * Lot 113I : codes d'échec levés AVANT tout contact fournisseur (aucune facturation possible) — la réservation est
 * libérée. Tout autre échec est réputé « appel envoyé, coût à rapprocher » (FIN-005).
 */
const NOT_SENT = new Set(['ACCOUNT_INELIGIBLE', 'REQUEST_BUILD_FAILED', 'AI_SUSPENDED', 'COST_CAP_REACHED', 'MASTER_PROMPT_INVALID']);

export type Observation = CaseObservation & { advisory: boolean; blockedBy?: PrerequisiteBlock };

/** Préfixe stable des motifs « prérequis » (reconnu par la reprise automatique et le BO). */
export const PREREQUISITE_REASON_PREFIX = 'prérequis d’exploitation';

interface CoupleRun {
  observations: Observation[];
  concurrency: ConcurrencyReport;
  servedModels: string[];
  /** Refus de requête observé à l'appel (paramètre refusé par le fournisseur). */
  requestRejected: { parameter: string | null; message: string } | null;
  firstTraceId: string | null;
}

const TRANSIENT = new Set(['PROVIDER_UNAVAILABLE', 'TIMEOUT', 'QUOTA_EXCEEDED']);
const REQUEST_REJECTED = new Set(['MODEL_PARAMETERS_INCOMPATIBLE', 'PROVIDER_REQUEST_REJECTED']);

/** Code d'échec d'une erreur de passerelle (dernier modèle sollicité pour ALL_MODELS_FAILED). */
export function failureCodeOf(e: unknown): string {
  const x = e as { code?: unknown; lastFailureCode?: unknown; name?: unknown };
  if (x && typeof x.code === 'string') return x.code === 'ALL_MODELS_FAILED' && typeof x.lastFailureCode === 'string' ? x.lastFailureCode : x.code;
  return 'UNKNOWN';
}

/** Exécute tous les cas (× observations) d'un couple sous la concurrence existante. */
export async function runCoupleCases(p: {
  couple: CoupleDescriptor;
  cases: readonly QualificationCase[];
  observations: number;
  campaignId: number;
  technicalAccountId: number | null;
  masterText: MasterFileReader;
  call?: GatewayCall;
  thresholds?: QualificationThresholds;
  /**
   * Lot 113I (CDC V2 BUD-03/04, FIN-004) : réservation du budget d'amélioration AVANT CHAQUE essai d'appel, règlement
   * après. `null` / absent : aucun appel payant d'amélioration (test manuel administrateur, fournisseur simulé).
   */
  budget?: import('./improvement-budget').AttemptBudget | null;
}): Promise<CoupleRun> {
  const th = p.thresholds ?? QUALIFICATION_THRESHOLDS;
  const call = p.call ?? productionGatewayCall;
  const op = AI_OPERATIONS[p.couple.operationCode];
  const sync = isSynchronousTreatment(p.couple.treatment, th);
  const target = sync ? th.concurrency.synchronousSimultaneous : th.concurrency.queuedPerTreatment;
  const limit = sync ? th.concurrency.synchronousSimultaneous : th.concurrency.queuedPerWorker;
  const groupLimit = sync ? th.concurrency.synchronousSimultaneous : th.concurrency.queuedPerTreatment;
  let requestRejected: CoupleRun['requestRejected'] = null;
  const ctx: AiJobContext = {
    jobId: null, treatment: p.couple.treatment, configVersionId: p.couple.versionId, configRevisionId: p.couple.revisionId, triggerCode: 'qualification',
  };

  // Essais : cas × observations ; au moins `target` essais simultanés (les
  // premiers cas sont rejoués en observations supplémentaires si besoin).
  const plan: Array<{ c: QualificationCase; obs: number }> = [];
  for (const c of p.cases) for (let o = 1; o <= p.observations; o += 1) plan.push({ c, obs: o });
  for (let i = 0; plan.length && plan.length < target; i += 1) {
    const c = p.cases[i % p.cases.length];
    plan.push({ c, obs: plan.filter((x) => x.c === c).length + 1 });
  }

  const traces = new Map<string, string>();
  const runOne = async (c: QualificationCase, obs: number): Promise<Observation> => {
    const base: Observation = {
      caseId: c.caseId, source: c.source, expectedSource: c.expectedSource, mandatory: c.mandatory, advisory: c.advisory, observation: obs,
      outcome: 'INCONCLUSIVE', defects: [], inconclusiveReason: null, durationMs: null, timeoutMs: p.couple.profile.timeoutMs, costMicros: null,
      servedModel: null, traceId: null, accountId: c.accountId, captureId: c.captureId, historicalSha256: outputSha256(c.historicalOutput),
      observedSha256: null, matchesHistorical: null, manifestCaseId: c.manifestCaseId ?? null, attempts: 0,
    };
    const accountId = c.accountId ?? p.technicalAccountId;
    const technique = c.accountId == null;
    if (!accountId) {
      return { ...base, blockedBy: 'TECHNICAL_ACCOUNT', inconclusiveReason: `${PREREQUISITE_REASON_PREFIX} : compte technique de qualification absent (CORPUS_ACCOUNT_MISSING) — cas du corpus non exécuté` };
    }
    let derniere = '';
    for (let essai = 0; essai <= th.transientRetries; essai += 1) {
      base.attempts = essai + 1;
      const idempotencyKey = `qualif:${p.campaignId}:${p.couple.signature.slice(0, 16)}:${c.caseId}:${obs}:${essai}`;
      // Lot 113I : réservation AVANT l'appel ; refus → aucun appel (WAITING_BUDGET / COST_UNKNOWN), jamais un défaut.
      let reservationId: number | null = null;
      if (p.budget) {
        const r = await p.budget.reserve({
          attemptKey: idempotencyKey, treatment: p.couple.treatment, operationCode: c.operationCode, model: p.couple.model,
          variables: c.variables, attachments: c.attachments?.length ?? 0, maxOutputTokens: p.couple.profile.maxOutputTokens, candidateVersionId: p.couple.versionId,
        }).catch((e) => ({ ok: false as const, code: 'BUDGET_UNAVAILABLE' as const, message: `registre budgétaire illisible (${(e as Error).message.slice(0, 160)}) : aucun appel (fail-closed)` }));
        if (!r.ok) return { ...base, blockedBy: 'BUDGET', inconclusiveReason: `${BUDGET_REASON_PREFIX} (${r.code}) : ${r.message}` };
        if (r.reused) return { ...base, inconclusiveReason: `essai ${idempotencyKey} déjà engagé (${r.state}) : jamais rejoué à l’aveugle (LIF-005)` };
        reservationId = r.reservationId;
      }
      const regler = async (x: { sent: boolean; costMicros: number | null; traceId?: string | null }) => {
        if (reservationId != null && p.budget) await p.budget.settle(reservationId, x).catch((e) => console.error('[qualification] règlement budgétaire :', (e as Error).message));
      };
      try {
        const res = await call({
          useCaseCode: op.useCaseCode, operationCode: c.operationCode, accountId, promptVariables: c.variables,
          // Lot 100B : fichiers RÉELS du cas multimodal (jamais un nom de fichier seul).
          ...(c.attachments?.length ? { attachments: c.attachments } : {}),
          outputSchema: c.outputSchema, acceptedOutputSchemas: c.acceptedOutputSchemas,
          idempotencyKey,
          // costCapExempt : plafond du COMPTE technique seulement (C-Q10) — jamais l'enveloppe d'amélioration, réservée ci-dessus.
          firstModelIndex: p.couple.rank, maxModelAttempts: 1, costCapExempt: true, triggerCode: 'qualification',
        }, { ...ctx, improvementAttemptKey: reservationId != null ? idempotencyKey : null });
        await regler({ sent: !res.fromCache, costMicros: res.fromCache ? 0 : Number.isFinite(res.costMicros) ? res.costMicros : null, traceId: res.traceId });
        const vu: Observation = {
          ...base, durationMs: res.durationMs, costMicros: Number.isFinite(res.costMicros) ? res.costMicros : null, servedModel: res.model,
          traceId: res.traceId, observedSha256: outputSha256(res.data),
          matchesHistorical: c.historicalOutput == null ? null : outputSha256(res.data) === outputSha256(c.historicalOutput),
        };
        if (res.fromCache) return { ...vu, durationMs: null, fromCache: true, inconclusiveReason: 'réponse issue du cache : ne vaut pas une nouvelle mesure (QUAL-05)' };
        // Le modèle SERVI fait foi (`usedFallback` vaut vrai dès qu'un rang > 0 est sollicité, même forcé).
        if (res.model !== p.couple.model) {
          return { ...vu, inconclusiveReason: `réponse servie par ${res.model} : un autre modèle ne qualifie jamais le candidat ${p.couple.model}` };
        }
        if (traces.has(res.traceId)) return { ...vu, inconclusiveReason: `trace ${res.traceId} déjà rattachée à ${traces.get(res.traceId)}` };
        traces.set(res.traceId, `${c.caseId}#${obs}`);
        const ev = await c.evaluate(res.data, { masterText: p.masterText });
        const lu = { ...vu, fromCache: false, criticalDefects: ev.criticalDefects ?? [], decisions: ev.decisions ?? [] };
        if (ev.defects.length) return { ...lu, outcome: 'FAILED', defects: ev.defects };
        if (ev.inconclusive) return { ...lu, inconclusiveReason: ev.inconclusive };
        if (c.expectedSource !== 'REFERENCE') return { ...lu, inconclusiveReason: 'résultat non vérifiable : aucun attendu (non vérifiable = non concluant)' };
        return { ...lu, outcome: 'PASSED' };
      } catch (e) {
        const code = failureCodeOf(e);
        // Lot 113I : échec avant contact fournisseur → libérée ; sinon coût à rapprocher (jamais converti en zéro).
        await regler({ sent: !NOT_SENT.has(code), costMicros: null });
        derniere = `${code} : ${String((e as Error)?.message ?? e).slice(0, 200)}`;
        if (code === 'INVALID_OUTPUT') {
          return { ...base, outcome: 'FAILED', defects: [{ category: 'SCHEMA', message: `sortie non conforme : ${String((e as Error).message).slice(0, 300)}` }] };
        }
        if (REQUEST_REJECTED.has(code)) {
          const parameter = (e as { rejectedParameter?: string }).rejectedParameter ?? null;
          requestRejected ??= { parameter, message: String((e as Error).message).slice(0, 300) };
          return { ...base, inconclusiveReason: `requête refusée (${code}) : incompatibilité de réglage du couple` };
        }
        if (code === 'ACCOUNT_INELIGIBLE') {
          // Lot 103G : cause ÉTABLIE et actionnable (refus C-Q10 avant tout contact fournisseur : aucun appel conclu,
          // latence non mesurable). Jamais rejoué dans la campagne : le compte ne redevient pas éligible en cours d'essai.
          const motif = (e as { reason?: string }).reason ?? 'READ_ONLY';
          return technique
            ? { ...base, blockedBy: 'TECHNICAL_ACCOUNT', inconclusiveReason: `${PREREQUISITE_REASON_PREFIX} : compte technique de qualification ${accountId} non éligible (ACCOUNT_INELIGIBLE : ${motif}) — aucun appel conclu, latence non mesurable` }
            : { ...base, blockedBy: 'REPLAY_ACCOUNT', inconclusiveReason: `${PREREQUISITE_REASON_PREFIX} : compte de données du rejeu non éligible (ACCOUNT_INELIGIBLE : ${motif}, C-Q10) — cas non exécuté` };
        }
        if (TRANSIENT.has(code) && essai < th.transientRetries) continue;
        return { ...base, inconclusiveReason: TRANSIENT.has(code) ? `erreur fournisseur transitoire, nouvel essai épuisé (${derniere})` : `cause non établie (${derniere})` };
      }
    }
    return { ...base, inconclusiveReason: `cause non établie (${derniere})` };
  };

  const tasks: Array<PoolTask<Observation>> = plan.map(({ c, obs }) => ({ key: `${c.caseId}#${obs}`, group: p.couple.treatment, run: () => runOne(c, obs) }));
  const pool = await runBounded(tasks, { limit, groupLimit, keyOf: (r) => `${(r as Observation).caseId}#${(r as Observation).observation}` });
  const observations: Observation[] = [];
  for (const t of tasks) {
    const r = pool.results.get(t.key);
    if (r?.ok) observations.push(r.value);
  }
  // Une même trace pour deux essais = réponse partagée : attribution incorrecte.
  const tracesVues = observations.map((o) => o.traceId).filter((x): x is string => Boolean(x));
  const partagees = tracesVues.length - new Set(tracesVues).size;
  return {
    observations,
    concurrency: {
      mode: sync ? 'SYNCHRONOUS' : 'QUEUED', target: Math.min(target, Math.max(1, plan.length)), limit: groupLimit,
      maxObserved: pool.maxObservedByGroup[p.couple.treatment] ?? 0, submitted: pool.submitted, completed: pool.completed,
      duplicates: pool.duplicates, lost: pool.lost, misattributed: pool.misattributed + partagees,
    },
    servedModels: [...new Set(observations.map((o) => o.servedModel).filter((x): x is string => Boolean(x)))],
    requestRejected,
    firstTraceId: tracesVues[0] ?? null,
  };
}
