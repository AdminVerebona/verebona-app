/**
 * Lot 85F — NIVEAU 2 de la résolution T3 d'une donnée documentaire :
 * compréhension SÉMANTIQUE de la connaissance T1 persistée (ticket §5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Appelé par la décision centrale « À traiter » (`evaluateFieldRule`)
 * quand le niveau 1 déterministe (faits structurés, alias du registre,
 * libellés reconnus, documents du même contrat, calcul) n'a trouvé AUCUNE
 * valeur. Le code :
 *   1. formule la QUESTION MÉTIER (donnée, type, question de la règle,
 *      constituents de calcul DÉCLARÉS par donnée dans
 *      `document-derivations.ts` — jamais par type de document) ;
 *   2. collecte la connaissance T1 (couches, documents de la même réalité
 *      métier) et la PAGINE dans des bornes de taille (`context.ts`) ;
 *   3. sans connaissance NON STRUCTURÉE : rien à interpréter (NOT_NEEDED —
 *      « information absente » légitime) ;
 *   4. sinon, si la capacité KNOWLEDGE_QUERY est disponible (branche du
 *      prompt T3 livrée par l'équipe IA), soumet chaque page — une seule fois
 *      par entrée (mémoire 0720 : question, contexte, version du prompt),
 *      dans le budget du compte — et VALIDE chaque réponse (`validate.ts`) ;
 *   5. sinon : « interprétation en attente » (PENDING), avec son motif.
 *      L'appelant n'en conclut JAMAIS une information absente.
 * Aucune écriture métier ici : l'appelant fait passer les constats validés
 * par le moteur de décision et le calcul EXISTANTS.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getField } from '@/services/canonical/registry';
import type { ProcessingRule } from '@/services/to-process/rules-catalog';
import {
  CONSTITUENT_VALUE_TYPES, KNOWLEDGE_QUERY_CONTRACT_VERSION, knowledgeQueryVariables,
  type ConstituentRole, type FieldValueType, type KnowledgeConstituent, type KnowledgeQuestion, type T3KnowledgeQueryOutput,
} from './contract';
import { contextFingerprint, knowledgeBounds, planKnowledgePages, questionFingerprint, type KnowledgeBounds } from './context';
import type { CollectedKnowledge } from './collect';
import type { KnowledgeCall, KnowledgeCallResult, KnowledgeCapability } from './model';
import {
  KNOWLEDGE_QUERY_MAX_ATTEMPTS, KNOWLEDGE_QUERY_RETRY_MINUTES, knowledgeQueryDailyMax,
  type KnowledgeEntryKey, type KnowledgeQueryRecord, type StoredKnowledgeQuery,
} from './store';
import {
  contradictoryTargets, effectiveOutcome, mergeFindings, validateKnowledgeAnswer,
  type EffectiveOutcome, type Rejection, type ValidatedFinding, type ValueNormalizers,
} from './validate';

export type SemanticStatus = 'NO_T1_KNOWLEDGE' | 'NOT_NEEDED' | 'ANSWERED' | 'PENDING';
export type PendingReason =
  | 'DISABLED' | 'CAPABILITY_UNAVAILABLE' | 'TRIGGER_NOT_ALLOWED' | 'BUDGET_EXHAUSTED' | 'AI_FAILED' | 'RETRY_SCHEDULED' | 'MEMORY_UNAVAILABLE';
export type SemanticOutcome = EffectiveOutcome | 'INCOMPLETE';

export interface SemanticSummary {
  elements: number;
  unstructured: number;
  byLayer: Record<string, number>;
  documents: Array<{ ref: string; fileId: number; relation: string | null }>;
  pages: number;
  complete: boolean;
  dropped: number;
  cut: number;
  missing: string[];
}

export interface SemanticResolution {
  status: SemanticStatus;
  pendingReason?: PendingReason;
  outcome?: SemanticOutcome;
  findings: ValidatedFinding[];
  rejected: Rejection[];
  /** Cibles en contradiction (aucune écriture). */
  contradictions: string[];
  aiCalled: boolean;
  calls: number;
  /** Réponse reprise de la mémoire (aucun appel). */
  cached: boolean;
  traceIds: string[];
  promptVersion: string | null;
  questionFingerprint: string;
  contextFingerprint: string | null;
  summary: SemanticSummary | null;
  queryId: number | null;
  /** Éléments COUVERTS cités par un constat retenu (unités partiellement structurées, diagnostic). */
  citedCoveredUnits?: Array<{ ref: string; fileId: number; sourceUnitId: string | null }>;
}

export interface KnowledgeMemory {
  ready(): Promise<boolean>;
  find(k: KnowledgeEntryKey): Promise<StoredKnowledgeQuery | null>;
  callsLastDay(accountId: number, now: Date): Promise<number>;
  save(r: KnowledgeQueryRecord): Promise<number>;
}

/** Dépendances injectables (tests : fournisseur simulé, mémoire en mémoire vive). */
export interface KnowledgeQueryDeps {
  capability?: () => Promise<KnowledgeCapability>;
  call?: (c: KnowledgeCall) => Promise<KnowledgeCallResult>;
  collect?: (accountId: number, fileId: number, fieldKey: string, opts: { maxLinkedDocuments: number }) => Promise<CollectedKnowledge>;
  memory?: KnowledgeMemory;
  now?: () => Date;
  bounds?: KnowledgeBounds;
  dailyMax?: number;
}

const typeDeValeur = (key: string): FieldValueType => {
  const t = getField(key)?.valueType;
  if (t === 'date') return 'date';
  if (t === 'number' || t === 'money_eur' || t === 'money_cents') return 'number';
  return 'text';
};

/**
 * Question métier d'une donnée documentaire (pure) : libellé et type du
 * registre, question de la règle, constituants des calculs DÉCLARÉS pour
 * cette donnée (début / durée ; échéancier). Aucun vocabulaire.
 */
export async function buildKnowledgeQuestion(rule: Pick<ProcessingRule, 'code' | 'question'>, key: string): Promise<KnowledgeQuestion> {
  const { derivationFor, scheduleDerivationFor } = await import('@/services/to-process/document-derivations');
  const constituents: KnowledgeConstituent[] = [];
  const ajouter = (role: ConstituentRole, cle: string) => {
    if (constituents.some((c) => c.role === role)) return;
    constituents.push({ role, key: cle, label: getField(cle)?.label ?? null, valueType: CONSTITUENT_VALUE_TYPES[role] });
  };
  const d = derivationFor(key);
  if (d) { ajouter('start', d.start.key); ajouter('duration', d.duration.key); }
  const s = scheduleDerivationFor(key);
  if (s) {
    for (const role of ['firstInstalment', 'lastInstalment', 'count', 'periodicity', 'disbursement', 'repayment'] as const) ajouter(role, s[role].key);
  }
  return { key, label: getField(key)?.label ?? null, valueType: typeDeValeur(key), businessQuestion: rule.question, ruleCode: rule.code, constituents };
}

/** Normaliseurs de valeur : analyseurs EXISTANTS du moteur « À traiter » (dates, durées). */
export async function defaultNormalizers(): Promise<ValueNormalizers> {
  const [{ parseDocumentDate }, { analyzeDuration }] = await Promise.all([
    import('@/services/to-process/document-field-evidence'),
    import('@/services/to-process/document-derivations'),
  ]);
  return { date: (raw) => parseDocumentDate(raw), durationMonths: (raw) => analyzeDuration(raw).months };
}

async function defaultDeps(): Promise<Required<Omit<KnowledgeQueryDeps, 'bounds' | 'dailyMax'>>> {
  const [model, collect, store] = await Promise.all([import('./model'), import('./collect'), import('./store')]);
  return {
    capability: model.knowledgeQueryCapability,
    call: model.callKnowledgeQueryModel,
    collect: collect.collectT1Knowledge,
    memory: { ready: store.knowledgeQueriesReady, find: store.findKnowledgeQuery, callsLastDay: store.knowledgeCallsLastDay, save: store.saveKnowledgeQuery },
    now: () => new Date(),
  };
}

export interface InterpretInput {
  accountId: number;
  fileId: number;
  rule: Pick<ProcessingRule, 'code' | 'question'>;
  key: string;
  /** Déclencheur (trace) ; `allowAi: false` : aucune sollicitation du modèle (écran utilisateur). */
  trigger: string;
  allowAi: boolean;
  runRef?: string | null;
  today: string;
  deps?: KnowledgeQueryDeps;
}

/**
 * Interprétation sémantique de la connaissance T1 pour UNE donnée d'UN
 * document. Ne lève que sur une lecture de la connaissance en échec (jamais
 * confondue avec une absence) ; une panne IA est un état PENDING.
 */
export async function interpretT1Knowledge(i: InterpretInput): Promise<SemanticResolution> {
  const base = await defaultDeps();
  const d = { ...base, ...(i.deps ?? {}) };
  const bounds = i.deps?.bounds ?? knowledgeBounds();
  const now = d.now();
  const question = await buildKnowledgeQuestion(i.rule, i.key);
  const qfp = questionFingerprint(question, KNOWLEDGE_QUERY_CONTRACT_VERSION);
  const vide = (p: Partial<SemanticResolution> & Pick<SemanticResolution, 'status'>): SemanticResolution => ({
    findings: [], rejected: [], contradictions: [], aiCalled: false, calls: 0, cached: false, traceIds: [], promptVersion: null,
    questionFingerprint: qfp, contextFingerprint: null, summary: null, queryId: null, ...p,
  });

  const collected = await d.collect(i.accountId, i.fileId, i.key, { maxLinkedDocuments: bounds.maxLinkedDocuments });
  if (!collected.hasExtraction) return vide({ status: 'NO_T1_KNOWLEDGE' });
  const plan = planKnowledgePages(collected.elements, collected.documents, bounds);
  const summary: SemanticSummary = {
    elements: collected.elements.length, unstructured: plan.unstructured, byLayer: plan.byLayer,
    documents: collected.documents.map((x) => ({ ref: x.ref, fileId: x.fileId, relation: x.relation })),
    pages: plan.pages.length, complete: plan.complete, dropped: plan.droppedElements, cut: plan.cutElements, missing: collected.missing,
  };
  // Aucune connaissance non structurée : les couches structurées ont été examinées par le niveau 1.
  if (plan.unstructured === 0) return vide({ status: 'NOT_NEEDED', summary });
  const cfp = contextFingerprint(collected.documents, plan);

  const cap = await d.capability();
  if (!cap.available) {
    return vide({ status: 'PENDING', pendingReason: cap.reason === 'DISABLED' ? 'DISABLED' : 'CAPABILITY_UNAVAILABLE', summary, contextFingerprint: cfp, promptVersion: cap.version });
  }
  // Sans mémoire, aucun appel : un rappel sans fin serait possible.
  if (!(await d.memory.ready())) return vide({ status: 'PENDING', pendingReason: 'MEMORY_UNAVAILABLE', summary, contextFingerprint: cfp, promptVersion: cap.version });
  const cle: KnowledgeEntryKey = { accountId: i.accountId, fileId: i.fileId, fieldKey: i.key, questionFp: qfp, contextFp: cfp, promptVersion: cap.version ?? '' };
  const memo = await d.memory.find(cle);
  const elementsParRef = new Map(plan.pages.flatMap((p) => p.elements).map((e) => [e.ref, e]));
  const citees = (fs: readonly ValidatedFinding[]) => [...new Set(fs.flatMap((f) => f.evidenceRefs))]
    .map((r) => elementsParRef.get(r)).filter((e) => !!e && e.layer === 'SOURCE_UNIT' && e.covered === true)
    .map((e) => ({ ref: e!.ref, fileId: e!.fileId, sourceUnitId: e!.sourceUnitId ?? null }));
  if (memo?.status === 'ANSWERED') {
    return vide({
      status: 'ANSWERED', outcome: memo.outcome ?? 'NOT_FOUND', findings: memo.findings, rejected: memo.rejected,
      contradictions: contradictoryTargets(memo.findings), cached: true, traceIds: memo.traceIds, promptVersion: cap.version,
      contextFingerprint: cfp, summary, queryId: memo.id, citedCoveredUnits: citees(memo.findings),
    });
  }
  if (memo?.status === 'AI_FAILED') {
    if (memo.attempts >= KNOWLEDGE_QUERY_MAX_ATTEMPTS) return vide({ status: 'PENDING', pendingReason: 'AI_FAILED', summary, contextFingerprint: cfp, promptVersion: cap.version, queryId: memo.id });
    if (memo.retryAt && new Date(memo.retryAt).getTime() > now.getTime()) {
      return vide({ status: 'PENDING', pendingReason: 'RETRY_SCHEDULED', summary, contextFingerprint: cfp, promptVersion: cap.version, queryId: memo.id });
    }
  }
  if (!i.allowAi) return vide({ status: 'PENDING', pendingReason: 'TRIGGER_NOT_ALLOWED', summary, contextFingerprint: cfp, promptVersion: cap.version });
  const max = i.deps?.dailyMax ?? knowledgeQueryDailyMax();
  if ((await d.memory.callsLastDay(i.accountId, now)) + plan.pages.length > max) {
    return vide({ status: 'PENDING', pendingReason: 'BUDGET_EXHAUSTED', summary, contextFingerprint: cfp, promptVersion: cap.version });
  }

  const norm = await defaultNormalizers();
  const lots: ValidatedFinding[][] = [];
  const rejets: Rejection[] = [];
  const declares: T3KnowledgeQueryOutput['outcome'][] = [];
  const traces: string[] = [];
  let calls = 0;
  const enregistrer = (r: Omit<KnowledgeQueryRecord, keyof KnowledgeEntryKey | 'ruleCode' | 'trigger' | 'runRef' | 'contextSummary' | 'pagesTotal'>) =>
    d.memory.save({ ...cle, ruleCode: i.rule.code, trigger: i.trigger, runRef: i.runRef ?? null, contextSummary: summary as never, pagesTotal: plan.pages.length, ...r });
  for (const page of plan.pages) {
    try {
      const sourceIds = [...new Set(collected.documents.map((x) => x.fileId))];
      const r = await d.call({ accountId: i.accountId, sourceIds, variables: knowledgeQueryVariables({ question, documents: collected.documents, page, today: i.today }) });
      calls += 1;
      if (r.traceId) traces.push(r.traceId);
      const v = validateKnowledgeAnswer(r.output, question, page.elements, norm);
      lots.push(v.findings);
      rejets.push(...v.rejected);
      declares.push(v.declared);
    } catch (e) {
      const { isExecutionCancelled } = await import('../../queue/execution-control');
      if (isExecutionCancelled(e)) throw e;
      const cause = String((e as Error)?.message ?? e).slice(0, 300);
      const id = await enregistrer({
        status: 'AI_FAILED', outcome: null, pagesExamined: lots.length, calls: calls + 1, traceIds: traces, findings: [], rejected: rejets, error: cause,
        retryAt: new Date(now.getTime() + KNOWLEDGE_QUERY_RETRY_MINUTES * 60_000).toISOString(),
      }).catch(() => null);
      return vide({ status: 'PENDING', pendingReason: 'AI_FAILED', aiCalled: true, calls: calls + 1, traceIds: traces, summary, contextFingerprint: cfp, promptVersion: cap.version, queryId: id });
    }
  }
  const findings = mergeFindings(lots);
  let outcome: SemanticOutcome = effectiveOutcome(findings, declares, rejets.length);
  // Rien trouvé dans un contexte TRONQUÉ : jamais « information absente ».
  if (outcome === 'NOT_FOUND' && !plan.complete) outcome = 'INCOMPLETE';
  const id = await enregistrer({ status: 'ANSWERED', outcome, pagesExamined: lots.length, calls, traceIds: traces, findings, rejected: rejets });
  return vide({
    status: 'ANSWERED', outcome, findings, rejected: rejets, contradictions: contradictoryTargets(findings), aiCalled: true, calls, traceIds: traces,
    promptVersion: cap.version, contextFingerprint: cfp, summary, queryId: id, citedCoveredUnits: citees(findings),
  });
}

/** La connaissance non structurée existe mais n'a pas (entièrement) été interprétée. Pure. */
export const interpretationPending = (r: SemanticResolution | null | undefined): boolean =>
  !!r && (r.status === 'PENDING' || (r.status === 'ANSWERED' && r.outcome === 'INCOMPLETE'));

/** L'interprétation permet-elle de conclure « information absente de toute la connaissance T1 » ? Pure. */
export const semanticallyAbsent = (r: SemanticResolution | null | undefined): boolean =>
  !r || r.status === 'NOT_NEEDED' || (r.status === 'ANSWERED' && r.outcome === 'NOT_FOUND');

export interface KnowledgeQueryState {
  hasExtraction: boolean;
  /** Connaissance non structurée présente (avant bornes). */
  unstructured: number;
  complete: boolean;
  contextFingerprint: string | null;
  capability: KnowledgeCapability;
  /** Interprétation mémorisée pour la question, le contexte et la version de prompt ACTUELS. */
  memo: StoredKnowledgeQuery | null;
  /** Unités COUVERTES citées par un constat retenu de la mémoire actuelle. */
  citedCoveredUnits: Array<{ ref: string; fileId: number; sourceUnitId: string | null }>;
}

/**
 * État d'interprétation d'une donnée d'un document, en LECTURE SEULE (aucun
 * appel IA, aucune écriture) — contrôle de cohérence COH-T1-KNOWLEDGE-
 * CONSUMPTION, mode à blanc compris. Lève sur une lecture en échec.
 */
export async function knowledgeQueryState(
  accountId: number, fileId: number, rule: Pick<ProcessingRule, 'code' | 'question'>, key: string, deps: KnowledgeQueryDeps = {},
): Promise<KnowledgeQueryState> {
  const d = { ...(await defaultDeps()), ...deps };
  const bounds = deps.bounds ?? knowledgeBounds();
  const capability = await d.capability();
  const collected = await d.collect(accountId, fileId, key, { maxLinkedDocuments: bounds.maxLinkedDocuments });
  if (!collected.hasExtraction) return { hasExtraction: false, unstructured: 0, complete: true, contextFingerprint: null, capability, memo: null, citedCoveredUnits: [] };
  const plan = planKnowledgePages(collected.elements, collected.documents, bounds);
  const cfp = contextFingerprint(collected.documents, plan);
  const question = await buildKnowledgeQuestion(rule, key);
  const memo = (await d.memory.ready())
    ? await d.memory.find({ accountId, fileId, fieldKey: key, questionFp: questionFingerprint(question, KNOWLEDGE_QUERY_CONTRACT_VERSION), contextFp: cfp, promptVersion: capability.version ?? '' })
    : null;
  const parRef = new Map(plan.pages.flatMap((p) => p.elements).map((e) => [e.ref, e]));
  const cites = memo?.status === 'ANSWERED'
    ? [...new Set(memo.findings.flatMap((f) => f.evidenceRefs))].map((r) => parRef.get(r)).filter((e) => !!e && e.layer === 'SOURCE_UNIT' && e.covered === true)
      .map((e) => ({ ref: e!.ref, fileId: e!.fileId, sourceUnitId: e!.sourceUnitId ?? null }))
    : [];
  return { hasExtraction: true, unstructured: plan.unstructured, complete: plan.complete, contextFingerprint: cfp, capability, memo, citedCoveredUnits: cites };
}
