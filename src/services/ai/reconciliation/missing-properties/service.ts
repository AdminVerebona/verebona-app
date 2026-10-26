/**
 * Lot 88B — propriétés métier MANQUANTES d'un objet : état (lecture seule,
 * contrôle de cohérence, mode à blanc compris) et réparation (T3 puis
 * writer canonique).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CHAÎNE (une seule par fonction, aucun writer concurrent)
 *   1. propriétés VIDES de l'objet d'après le REGISTRE canonique
 *      (`catalog.ts`), corrections / décisions de l'utilisateur protégées ;
 *   2. contexte transversal collecté largement et sans filtrage sémantique
 *      (`collect.ts`), borné et paginé, troncature tracée (`context.ts`) ;
 *   3. empreinte du contexte : une propriété déjà décidée dans CE contexte
 *      et pour CETTE version du prompt T3 n'est jamais resoumise ;
 *   4. T3 — branche KNOWLEDGE_QUERY existante, contrat d'entrée v2, SEULEMENT
 *      si le prompt actif porte ce contrat (sinon : constat, aucun appel) —
 *      dans le budget PARTAGÉ du compte (`T3_KNOWLEDGE_QUERY_DAILY_MAX`) ;
 *   5. validation serveur et décision par propriété (`decide.ts`) ;
 *   6. décision positive : écriture par `writeCanonicalAssetFields` /
 *      `writeCanonicalEntityFields` (origine RECONCILIATION, valeur attendue
 *      vide : contrôle optimiste, préséance des origines, miroirs, journal
 *      0216, « Ce que j'ai fait »), puis preuves `field_evidence` des
 *      éléments cités ; abstention : rien n'est écrit, cause tracée ;
 *   7. journal `property_recovery_runs` / `property_recovery_decisions`.
 *
 * Lot 91B — AUCUNE SORTIE SILENCIEUSE : chaque issue qui empêche l'arbitrage
 * (contrat T3 absent, nouvelle tentative pas encore due, pannes répétées,
 * budget épuisé, panne IA, campagne à blanc, anti-boucle…) est persistée
 * dans `property_recovery_runs` AVANT de rendre la main — compte, objet,
 * propriétés, déclencheur, campagne, empreinte du contexte, état du contrat
 * T3, version du prompt, cause, date, appels IA, prochaine tentative. Si le
 * journal est inutilisable : anomalie de Supervision (`MEMORY_UNAVAILABLE`)
 * et le contrôle de cohérence reste non résolu.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { knowledgeBounds, type KnowledgeBounds } from '../knowledge-query/context';
import type { KnowledgeCall, KnowledgeCallResult, KnowledgeCapability } from '../knowledge-query/model';
import type { ValueNormalizers } from '../knowledge-query/validate';
import { missingPropertyCatalog, type MissingPropertyCatalog } from './catalog';
import {
  MISSING_PROPERTIES_CONTRACT_VERSION, MISSING_PROPERTIES_PENDING_CONTRACT, MISSING_PROPERTIES_PROJECTION_ORIGIN, MISSING_PROPERTIES_PROJECTION_RULE,
  MISSING_PROPERTIES_SOURCE_TYPE, contractStateOf,
  missingPropertiesVariables, type PropertyContextDocument, type PropertyContextElement, type PropertyQuestion,
} from './contract';
import { planPropertyContext, propertyContextFingerprint, propertyQuestionFingerprint, type PlannedPropertyContext } from './context';
import { decideProperties, unattachedRejections, type PageAnswer, type PropertyDecision, type PropertyFinding } from './decide';
import type { CollectedContext, LoadedSubject, SubjectRef } from './collect';
import type { GateStatus, LatestOutcome, StoredDecision, StoredRun } from './store';

/**
 * Propriétés au plus par appel (déclaré ; `T3_MISSING_PROPERTIES_PER_CALL`,
 * 12 = nombre maximal de constats d'une réponse du contrat ; borné à 40).
 */
function propertiesPerCall(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.T3_MISSING_PROPERTIES_PER_CALL);
  return Number.isFinite(n) && n >= 1 ? Math.min(40, Math.trunc(n)) : 12;
}
/** Tentatives au plus après une panne IA, pour un même contexte (comme 85F). */
export const RECOVERY_MAX_ATTEMPTS = 3;
const RECOVERY_RETRY_MINUTES = 60;

/** Dépendances injectables (tests : fournisseur simulé, horloge). */
interface RecoveryDeps {
  capability?: () => Promise<KnowledgeCapability>;
  call?: (c: KnowledgeCall) => Promise<KnowledgeCallResult>;
  now?: () => Date;
  bounds?: KnowledgeBounds;
  dailyMax?: number;
  perCall?: number;
}

export type CapabilityState = KnowledgeCapability & { contractCarried: boolean };

export interface ObjectRecoveryState {
  subject: LoadedSubject;
  catalog: MissingPropertyCatalog;
  documents: PropertyContextDocument[];
  plan: PlannedPropertyContext;
  collected: Pick<CollectedContext, 'collectionDropped' | 'missingLayers'>;
  /** Contexte transmis complet (aucune troncature de collecte ni de pagination). */
  complete: boolean;
  contextFingerprint: string;
  capability: CapabilityState;
  /** Version du prompt servant de clé de décision ('' pour un contexte vide : aucune IA en jeu). */
  decisionPromptVersion: string;
  memoryReady: boolean;
  /** Décisions déjà rendues dans ce contexte. */
  decided: Map<string, StoredDecision>;
  /** Propriétés manquantes sans décision dans ce contexte. */
  pending: PropertyQuestion[];
  failedRun: StoredRun | null;
  /** Lot 91B : dernière issue persistée de l'objet (tous contextes), null si aucune ou journal illisible. */
  lastOutcome?: LatestOutcome | null;
}

const sha = (v: unknown, n = 24) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, n);

async function capabilityOf(deps: RecoveryDeps): Promise<CapabilityState> {
  const cap = deps.capability ? await deps.capability() : await (await import('../knowledge-query/model')).knowledgeQueryCapability();
  return { ...cap, contractCarried: cap.available && (cap.contracts ?? []).includes(MISSING_PROPERTIES_CONTRACT_VERSION) };
}

/**
 * État d'un objet en LECTURE SEULE (aucun appel IA, aucune écriture) — null
 * si l'objet n'existe plus dans le compte. Lève sur une lecture en échec.
 */
export async function missingPropertiesState(accountId: number, ref: SubjectRef, deps: RecoveryDeps = {}): Promise<ObjectRecoveryState | null> {
  const collect = await import('./collect');
  const store = await import('./store');
  const subject = await collect.loadSubject(accountId, ref);
  if (!subject || subject.archived) return null;
  const { registryDefinitions } = await import('./catalog');
  const cles = registryDefinitions({ type: subject.type, category: subject.category, subtype: subject.subtype }).map((d) => d.key);
  const vides = cles.filter((k) => !subject.fields[k]);
  const protections = await collect.loadProtections(accountId, subject, vides);
  const catalog = missingPropertyCatalog({
    subject: { type: subject.type, category: subject.category, subtype: subject.subtype },
    current: (k) => subject.fields[k]?.value ?? null, protections,
  });
  const ctx = await collect.collectSubjectContext(accountId, subject, { requestedKeys: catalog.missing.map((m) => m.key) });
  const plan = planPropertyContext(ctx.elements, ctx.documents, deps.bounds ?? knowledgeBounds());
  const complete = plan.complete && Object.keys(ctx.collectionDropped).length === 0 && ctx.missingLayers.length === 0;
  const fp = propertyContextFingerprint(ctx.documents, { pages: plan.pages, complete });
  const capability = await capabilityOf(deps);
  const memoryReady = await store.propertyRecoveryReady();
  const decisionPromptVersion = plan.elements === 0 ? '' : capability.version ?? '';
  const key = { accountId, objectType: subject.type, objectId: subject.id };
  const decided = memoryReady ? await store.decisionsFor(key, fp, decisionPromptVersion, catalog.missing.map((m) => m.key)) : new Map<string, StoredDecision>();
  const pending = catalog.missing.filter((m) => {
    const d = decided.get(m.key);
    return !d || d.questionFp !== propertyQuestionFingerprint(m);
  });
  const failedRun = memoryReady && pending.length && plan.elements > 0 ? await store.failedRunFor(key, fp, decisionPromptVersion) : null;
  const lastOutcome = memoryReady && pending.length ? await store.latestOutcomeFor(key) : null;
  return {
    subject, catalog, documents: ctx.documents, plan, collected: { collectionDropped: ctx.collectionDropped, missingLayers: ctx.missingLayers },
    complete, contextFingerprint: fp, capability, decisionPromptVersion, memoryReady, decided, pending, failedRun, lastOutcome,
  };
}

/** Où et pourquoi une issue est consignée (déclencheur, campagne, corrélation). */
export interface OutcomeOrigin {
  trigger: string;
  runRef?: string | null;
  campaignId?: number | null;
}

/**
 * Lot 91B — consigne une issue SANS appel T3 pour les propriétés en attente
 * de l'objet (contexte courant). Ne lève jamais : journal inutilisable →
 * anomalie de Supervision et `null` (le contrôle de cohérence reste non
 * résolu, son constat le dit).
 */
export async function recordRecoveryOutcome(
  st: ObjectRecoveryState, o: OutcomeOrigin & { status: GateStatus; cause: string; retryAt?: string | null; properties?: readonly string[] },
): Promise<number | null> {
  const store = await import('./store');
  const s = st.subject;
  const keys = [...(o.properties ?? st.pending.map((p) => p.key))];
  try {
    return await store.saveOutcome({
      accountId: s.accountId, objectType: s.type, objectId: s.id, assetId: s.assetId, contextFp: st.contextFingerprint,
      promptVersion: st.decisionPromptVersion, contractVersion: MISSING_PROPERTIES_CONTRACT_VERSION, batchFp: sha(keys), properties: keys,
      status: o.status, cause: o.cause, contractState: contractStateOf(st.capability), campaignId: o.campaignId ?? null,
      contextSummary: contextSummary(st), retryAt: o.retryAt ?? null, trigger: o.trigger, runRef: o.runRef ?? null,
    });
  } catch (e) {
    await store.reportRecoveryStorageUnavailable({ accountId: s.accountId, objectType: s.type, objectId: s.id, status: o.status, error: String((e as Error)?.message ?? e) });
    return null;
  }
}

/** Résumé BORNÉ du contexte (journal, diagnostic) — jamais de contenu. Pure. */
function contextSummary(s: Pick<ObjectRecoveryState, 'documents' | 'plan' | 'collected' | 'complete' | 'catalog'>): Record<string, unknown> {
  return {
    documents: s.documents.slice(0, 30).map((d) => ({ ref: d.ref, fileId: d.fileId, relation: d.relation, documentType: d.documentType })),
    elements: s.plan.elements, byLayer: s.plan.byLayer, pages: s.plan.pages.length, complete: s.complete,
    truncation: { paging: s.plan.droppedByLayer, collection: s.collected.collectionDropped, cutTexts: s.plan.cutElements, missingLayers: s.collected.missingLayers },
    catalog: { missing: s.catalog.missing.length, protected: s.catalog.protectedKeys, excluded: s.catalog.excluded, filled: s.catalog.filled },
  };
}

type RecoveryStatus =
  | 'NOTHING_PENDING' | 'GONE' | 'NO_EVIDENCE' | 'CONTRACT_PENDING' | 'MEMORY_UNAVAILABLE' | 'AI_FAILED' | 'RETRY_SCHEDULED'
  | 'BUDGET_EXHAUSTED' | 'ANSWERED';

interface RecoveryResult {
  status: RecoveryStatus;
  /** Lot 91B : cause explicite quand l'arbitrage n'a pas (entièrement) eu lieu. */
  cause?: string | null;
  /** Lot 91B : faux si l'issue n'a pas pu être persistée (journal inutilisable — anomalie ouverte). */
  persisted?: boolean;
  calls: number;
  written: Array<{ key: string; value: unknown; evidenceIds: number[] }>;
  abstained: Array<{ key: string; cause: string }>;
  undecided: string[];
  traceIds: string[];
  runIds: number[];
  contextFingerprint: string | null;
}

async function normaliseurs(): Promise<ValueNormalizers> {
  const { defaultNormalizers } = await import('../knowledge-query/service');
  return defaultNormalizers();
}

/** Lots de propriétés (ordre du registre). Pure. */
function batchesOf<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

const constats = (fs: readonly PropertyFinding[]) => fs.map((f) => ({
  rawValue: f.rawValue, value: f.canonical, evidenceRefs: f.evidenceRefs, excerpt: f.excerpt.slice(0, 400),
  modelConfidence: f.modelConfidence, evidenceConfidence: f.evidenceConfidence, meaning: f.meaning, fileIds: f.fileIds,
}));

/** Provenance des éléments cités par les constats (documents, Opérations, composantes, Agenda, valeurs). Pure. */
function citedProvenance(fs: readonly PropertyFinding[], elements: ReadonlyMap<string, PropertyContextElement>): Record<string, unknown> {
  const refs = [...new Set(fs.flatMap((f) => f.evidenceRefs))];
  const els = refs.map((r) => elements.get(r)).filter((e): e is PropertyContextElement => !!e);
  const uniq = (xs: Array<number | null | undefined>) => [...new Set(xs.filter((x): x is number => Number.isSafeInteger(x)))].sort((a, b) => a - b);
  return {
    refs, layers: [...new Set(els.map((e) => e.layer))].sort(),
    documents: uniq(els.flatMap((e) => e.provenance?.fileIds ?? [])),
    operations: uniq(els.map((e) => e.provenance?.operationId)),
    components: uniq(els.map((e) => e.provenance?.componentId)),
    agenda: uniq(els.flatMap((e) => e.provenance?.agendaItemIds ?? [])),
    canonical: els.filter((e) => e.layer === 'CANONICAL').map((e) => e.kind),
  };
}

/**
 * Réparation : arbitrage T3 des propriétés manquantes non décidées dans le
 * contexte courant, puis écriture canonique des seules valeurs établies.
 * Ne lève que sur une lecture en échec ou une interruption d'exécution ;
 * une panne IA est une issue (AI_FAILED, nouvelle tentative différée).
 */
export async function recoverMissingProperties(
  accountId: number, ref: SubjectRef,
  opts: { trigger: string; runRef?: string | null; campaignId?: number | null; today: string; deps?: RecoveryDeps },
): Promise<RecoveryResult> {
  const deps = opts.deps ?? {};
  const now = (deps.now ?? (() => new Date()))();
  const res: RecoveryResult = { status: 'NOTHING_PENDING', calls: 0, written: [], abstained: [], undecided: [], traceIds: [], runIds: [], contextFingerprint: null };
  const st = await missingPropertiesState(accountId, ref, deps);
  if (!st) return { ...res, status: 'GONE' };
  res.contextFingerprint = st.contextFingerprint;
  if (!st.pending.length) return res;
  const store = await import('./store');
  const s = st.subject;
  if (!st.memoryReady) {
    // Journal 0770 absent : rien ne peut être persisté — anomalie de Supervision, contrôle non résolu.
    await store.reportRecoveryStorageUnavailable({ accountId, objectType: s.type, objectId: s.id, status: 'MEMORY_UNAVAILABLE', error: 'tables property_recovery_* absentes (migration 0770)' });
    return { ...res, status: 'MEMORY_UNAVAILABLE', cause: 'RECOVERY_LEDGER_MISSING', persisted: false };
  }
  const origine: OutcomeOrigin = { trigger: opts.trigger, runRef: opts.runRef ?? null, campaignId: opts.campaignId ?? null };
  /** Issue sans appel T3 : persistée AVANT de rendre la main (lot 91B). */
  const issue = async (status: RecoveryStatus & GateStatus, cause: string, retryAt?: string | null): Promise<RecoveryResult> => {
    const id = await recordRecoveryOutcome(st, { ...origine, status, cause, retryAt });
    if (id !== null) res.runIds.push(id);
    return { ...res, status, cause, persisted: id !== null, undecided: st.pending.map((p) => p.key) };
  };
  const tracabilite = { cause: null as string | null, contractState: contractStateOf(st.capability), campaignId: opts.campaignId ?? null };
  const base = {
    accountId, objectType: s.type, objectId: s.id, assetId: s.assetId, contextFp: st.contextFingerprint,
    contractVersion: MISSING_PROPERTIES_CONTRACT_VERSION, trigger: opts.trigger, runRef: opts.runRef ?? null,
  };
  /** Analyse persistée ; journal inutilisable → anomalie de Supervision, puis l'erreur remonte (réparation en échec, non résolue). */
  const enregistrer = async (r: Parameters<typeof store.saveRun>[0]): Promise<number> => {
    try {
      return await store.saveRun(r);
    } catch (e) {
      await store.reportRecoveryStorageUnavailable({ accountId, objectType: s.type, objectId: s.id, status: r.status, error: String((e as Error)?.message ?? e) });
      throw e;
    }
  };
  const resume = contextSummary(st);
  const elementsParRef = new Map(st.plan.pages.flatMap((p) => p.elements).map((e) => [e.ref, e]));

  // Contexte vide : rien à soumettre — abstention tracée, aucun appel.
  if (st.plan.elements === 0) {
    const runId = await enregistrer({
      ...base, ...tracabilite, cause: 'EMPTY_CONTEXT', promptVersion: '', batchFp: sha(st.pending.map((p) => p.key)), properties: st.pending.map((p) => p.key),
      status: 'NO_EVIDENCE', pagesTotal: 0, pagesExamined: 0, calls: 0, traceIds: [], contextSummary: resume,
    });
    res.runIds.push(runId);
    for (const p of st.pending) {
      await store.saveDecision({
        ...base, runId, fieldKey: p.key, questionFp: propertyQuestionFingerprint(p), promptVersion: '', decision: 'ABSTAINED', cause: 'NO_EVIDENCE',
        valueBefore: null, valueAfter: null, proposedValue: null, findings: [], rejected: [], evidenceIds: [], provenance: { context: { fingerprint: st.contextFingerprint } },
        writeOutcome: null,
      });
      res.abstained.push({ key: p.key, cause: 'NO_EVIDENCE' });
    }
    return { ...res, status: 'NO_EVIDENCE', cause: 'EMPTY_CONTEXT', persisted: true };
  }
  if (!st.capability.contractCarried) {
    return issue('CONTRACT_PENDING', `${contractStateOf(st.capability)}: le prompt T3 actif ne porte pas le contrat ${MISSING_PROPERTIES_CONTRACT_VERSION} (demande ${MISSING_PROPERTIES_PENDING_CONTRACT})`);
  }
  if (st.failedRun && st.failedRun.attempts >= RECOVERY_MAX_ATTEMPTS) {
    return issue('AI_FAILED', `MAX_ATTEMPTS_REACHED: ${st.failedRun.attempts} pannes IA sur ce contexte (analyse ${st.failedRun.id}) ; reprise à un nouveau contexte ou une nouvelle version du prompt`);
  }
  if (st.failedRun?.retryAt && new Date(st.failedRun.retryAt).getTime() > now.getTime()) {
    return issue('RETRY_SCHEDULED', `RETRY_NOT_DUE: panne IA précédente (analyse ${st.failedRun.id}, tentative ${st.failedRun.attempts}/${RECOVERY_MAX_ATTEMPTS})`, st.failedRun.retryAt);
  }

  const promptVersion = st.decisionPromptVersion;
  const max = deps.dailyMax ?? (await import('../knowledge-query/store')).knowledgeQueryDailyMax();
  const call = deps.call ?? (await import('../knowledge-query/model')).callKnowledgeQueryModel;
  const norm = await normaliseurs();
  let utilises = await store.sharedKnowledgeCallsLastDay(accountId, now);
  const sourceIds = [...new Set(st.documents.map((d) => d.fileId))];
  res.status = 'ANSWERED';

  for (const lot of batchesOf(st.pending, deps.perCall ?? propertiesPerCall())) {
    const batchFp = sha(lot.map((p) => p.key));
    const runBase = { ...base, promptVersion, batchFp, properties: lot.map((p) => p.key), pagesTotal: st.plan.pages.length, contextSummary: resume };
    if (utilises + st.plan.pages.length > max) {
      const cause = `DAILY_BUDGET: ${utilises} appel(s) T3 sur 24 h pour ${max} autorisé(s) (T3_KNOWLEDGE_QUERY_DAILY_MAX), ${st.plan.pages.length} nécessaire(s)`;
      res.runIds.push(await enregistrer({
        ...runBase, ...tracabilite, cause, status: 'BUDGET_EXHAUSTED', pagesExamined: 0, calls: 0, traceIds: [],
        retryAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
      }));
      // Ce lot et les suivants ne sont pas tentés (même cause, persistée) : propriétés non décidées.
      res.undecided.push(...st.pending.slice(st.pending.indexOf(lot[0])).map((p) => p.key));
      res.status = 'BUDGET_EXHAUSTED';
      res.cause = cause;
      break;
    }
    const reponses: PageAnswer[] = [];
    const traces: string[] = [];
    let appels = 0;
    let panne: string | null = null;
    for (const page of st.plan.pages) {
      try {
        const r = await call({
          accountId, sourceIds,
          variables: missingPropertiesVariables({
            subject: { type: s.type, category: s.category, subtype: s.subtype, family: s.family }, properties: lot, documents: st.documents,
            page, today: opts.today, truncated: !st.complete,
          }),
        });
        appels += 1;
        if (r.traceId) traces.push(r.traceId);
        reponses.push({ page, output: r.output });
      } catch (e) {
        const { isExecutionCancelled } = await import('../../queue/execution-control');
        if (isExecutionCancelled(e)) throw e;
        appels += 1;
        panne = String((e as Error)?.message ?? e).slice(0, 300);
        break;
      }
    }
    utilises += appels;
    res.calls += appels;
    res.traceIds.push(...traces);
    if (panne) {
      res.runIds.push(await enregistrer({
        ...runBase, ...tracabilite, cause: `AI_CALL_FAILED: ${panne.slice(0, 200)}`, status: 'AI_FAILED', pagesExamined: reponses.length, calls: appels,
        traceIds: traces, error: panne, retryAt: new Date(now.getTime() + RECOVERY_RETRY_MINUTES * 60_000).toISOString(),
      }));
      res.undecided.push(...lot.map((p) => p.key));
      res.status = 'AI_FAILED';
      res.cause = `AI_CALL_FAILED: ${panne.slice(0, 200)}`;
      break;
    }
    const decisions = decideProperties({ properties: lot, answers: reponses, complete: st.complete, norm });
    const nonDecidees = decisions.filter((d) => d.decision === 'UNDECIDED').map((d) => d.key);
    const runId = await enregistrer({
      ...runBase, ...tracabilite, cause: nonDecidees.length ? `UNDECIDED: réponse plafonnée, redemandée (${nonDecidees.slice(0, 12).join(', ')})` : null,
      status: 'ANSWERED', pagesExamined: reponses.length, calls: appels, traceIds: traces,
      contextSummary: { ...resume, unattachedFindings: unattachedRejections(reponses, lot) },
    });
    res.runIds.push(runId);
    for (const d of decisions) {
      const q = lot.find((x) => x.key === d.key)!;
      if (d.decision === 'UNDECIDED') { res.undecided.push(d.key); continue; }
      const provenance = {
        treatment: { operation: 't3_knowledge_query', task: 'KNOWLEDGE_QUERY', contractVersion: MISSING_PROPERTIES_CONTRACT_VERSION, promptVersion, traceIds: traces.slice(0, 10) },
        cited: citedProvenance(d.findings, elementsParRef),
        context: { fingerprint: st.contextFingerprint, complete: st.complete },
      };
      const commun = {
        ...base, runId, fieldKey: d.key, questionFp: propertyQuestionFingerprint(q), promptVersion, findings: constats(d.findings), rejected: d.rejected,
      };
      if (d.decision === 'ABSTAINED') {
        await store.saveDecision({ ...commun, decision: 'ABSTAINED', cause: d.cause, valueBefore: null, valueAfter: null, proposedValue: d.proposed, evidenceIds: [], provenance, writeOutcome: null });
        res.abstained.push({ key: d.key, cause: d.cause });
        continue;
      }
      const ecrit = await writeEstablished(accountId, s, d, { runId, promptVersion, traceId: traces[0] ?? null, elements: elementsParRef });
      if (ecrit.outcome === 'written') {
        await store.saveDecision({
          ...commun, decision: 'WRITTEN', cause: null, valueBefore: ecrit.previous, valueAfter: ecrit.next, proposedValue: d.value,
          evidenceIds: ecrit.evidenceIds, provenance: { ...provenance, mirrors: ecrit.mirrors, evidenceError: ecrit.evidenceError }, writeOutcome: 'written',
        });
        res.written.push({ key: d.key, value: ecrit.next, evidenceIds: ecrit.evidenceIds });
      } else {
        const cause = ecrit.outcome === 'protected' ? 'USER_PROTECTED' : ecrit.outcome === 'conflict' ? 'CONCURRENT_CHANGE' : 'WRITE_REFUSED';
        await store.saveDecision({
          ...commun, decision: 'ABSTAINED', cause, valueBefore: ecrit.previous, valueAfter: null, proposedValue: d.value, evidenceIds: [],
          provenance: { ...provenance, writeReason: ecrit.reason }, writeOutcome: ecrit.outcome,
        });
        res.abstained.push({ key: d.key, cause });
      }
    }
  }
  return res;
}

interface WriteOutcome {
  outcome: 'written' | 'unchanged' | 'protected' | 'invalid' | 'conflict' | 'not_found';
  reason?: string;
  previous: unknown;
  next: unknown;
  mirrors: Record<string, unknown>;
  evidenceIds: number[];
  evidenceError?: string | null;
}

/**
 * Écriture d'une valeur ÉTABLIE par le writer canonique de l'objet (valeur
 * attendue : vide — une saisie concurrente l'emporte), puis preuves
 * `field_evidence` des éléments cités qui proviennent d'un document ou d'un
 * élément d'Agenda (une preuve n'est créée qu'après une écriture effective :
 * jamais de proposition parasite sur une valeur protégée).
 */
async function writeEstablished(
  accountId: number, s: LoadedSubject, d: Extract<PropertyDecision, { decision: 'ESTABLISHED' }>,
  o: { runId: number; promptVersion: string; traceId: string | null; elements: ReadonlyMap<string, PropertyContextElement> },
): Promise<WriteOutcome> {
  const source = { type: MISSING_PROPERTIES_SOURCE_TYPE, id: `${MISSING_PROPERTIES_PROJECTION_RULE}:${o.runId}` };
  const trace = { decisionType: 'T3_MISSING_PROPERTY', reasonCode: 'ESTABLISHED_BY_T3', promptVersion: o.promptVersion || null, confidence: 'certain' };
  const ecriture = { key: d.key, value: d.value, expectedCurrent: null, trace };
  let r: { outcome: WriteOutcome['outcome']; reason?: string; previousValue: unknown; nextValue: unknown; mirrors: Record<string, unknown> } | null;
  if (s.type === 'ASSET') {
    const { writeCanonicalAssetFields } = await import('@/services/canonical/asset-state');
    const w = await writeCanonicalAssetFields({ assetId: s.id, accountId, origin: 'RECONCILIATION', source, traceId: o.traceId, writes: [ecriture] });
    r = w.notFound ? null : w.fields[0] ?? null;
  } else {
    const { writeCanonicalEntityFields } = await import('@/services/canonical/entity-state');
    const w = await writeCanonicalEntityFields({ target: { type: 'EQUIPMENT', id: s.id }, accountId, origin: 'RECONCILIATION', source, traceId: o.traceId, writes: [ecriture] });
    r = w.notFound || w.skipped ? null : w.fields[0] ?? null;
  }
  if (!r) return { outcome: 'not_found', previous: null, next: null, mirrors: {}, evidenceIds: [] };
  if (r.outcome !== 'written') return { outcome: r.outcome, reason: r.reason, previous: r.previousValue, next: null, mirrors: {}, evidenceIds: [] };
  let evidenceIds: number[] = [];
  let evidenceError: string | null = null;
  try {
    evidenceIds = await recordCitedEvidence(accountId, s, d, r.nextValue, o);
  } catch (e) {
    // La valeur reste écrite et tracée (journal 0216, décision) ; l'échec de preuve est consigné.
    evidenceError = String((e as Error)?.message ?? e).slice(0, 300);
  }
  return { outcome: 'written', previous: r.previousValue, next: r.nextValue, mirrors: r.mirrors, evidenceIds, evidenceError };
}

/** Preuves des éléments cités (document → `document`, Agenda → `agenda`) ; idempotentes (empreinte). */
async function recordCitedEvidence(
  accountId: number, s: LoadedSubject, d: Extract<PropertyDecision, { decision: 'ESTABLISHED' }>, value: unknown,
  o: { promptVersion: string; elements: ReadonlyMap<string, PropertyContextElement> },
): Promise<number[]> {
  const [{ recordEvidence }, { normalize }, { resolveAuthority }] = await Promise.all([
    import('../../evidence/field-evidence.service'), import('../decision/normalizers'), import('../decision/authority-matrix'),
  ]);
  const target = s.type === 'ASSET'
    ? { type: 'ASSET' as const, entityId: s.id, label: null, confidence: 'certain' as const }
    : { type: 'EQUIPMENT' as const, entityId: s.id, label: null, confidence: 'certain' as const };
  const out: number[] = [];
  const vus = new Set<string>();
  for (const f of d.findings.filter((x) => x.modelConfidence === 'certain')) {
    for (const ref of f.evidenceRefs) {
      const e = o.elements.get(ref);
      if (!e || e.provenance?.derivedFromSubject) continue;
      const sources: Array<{ type: 'document' | 'agenda'; id: number }> = [
        ...(e.provenance?.fileIds ?? []).map((id) => ({ type: 'document' as const, id })),
        ...(e.provenance?.agendaItemIds ?? []).map((id) => ({ type: 'agenda' as const, id })),
      ];
      for (const src of sources.slice(0, 5)) {
        const cle = `${src.type}:${src.id}:${ref}`;
        if (vus.has(cle)) continue;
        vus.add(cle);
        const documentType = src.type === 'document' ? o.elements.get(`M-${src.id}`)?.value ?? undefined : undefined;
        out.push(await recordEvidence({
          accountId, assetId: s.assetId, fieldKey: d.key, value, normalizedValue: normalize(d.key, value) ?? undefined,
          sourceType: src.type, sourceId: src.id, location: { section: `${MISSING_PROPERTIES_PROJECTION_RULE}:${ref}`, ...(e.page ? { page: e.page } : {}) },
          excerpt: f.excerpt.slice(0, 1_000), documentType, confidence: 'certain',
          authorityScore: resolveAuthority({ fieldKey: d.key, documentType: documentType ?? null }).score,
          promptVersion: o.promptVersion || undefined, canonicalKey: d.key, rawValue: f.rawValue,
          projectionOrigin: MISSING_PROPERTIES_PROJECTION_ORIGIN, projectionRule: MISSING_PROPERTIES_PROJECTION_RULE, target,
        }));
      }
    }
  }
  return [...new Set(out)];
}
