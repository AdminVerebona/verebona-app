/**
 * Mesure de l'activité IA d'une exécution — carte #811 (écart P1-A du #596).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TERMINOLOGIE UNIQUE (appliquée du moteur au BO, sans synonyme)
 *
 *   (i)   décision déterministe      décision prise SANS IA (comptée par le
 *                                    métier : `deterministicDecisions`) ;
 *   (ii)  demande logique            un `AiGateway.execute` : une question
 *                                    posée à la passerelle, quelle qu'en soit
 *                                    l'issue (`logicalRequests`) ;
 *   (iii) réponse du cache           demande servie par le cache temporaire
 *                                    (`cacheResponses`) ou partagée avec une
 *                                    demande identique simultanée
 *                                    (`sharedResponses`) — aucune requête ;
 *   (iv)  décision métier réutilisée mémoire durable T3 (`decisionsReused`),
 *                                    arbitrage utilisateur déjà rendu
 *                                    (`userArbitrationsKept`) — aucune demande ;
 *   (v)   invocation réelle          une REQUÊTE réellement émise vers le
 *                                    fournisseur (`networkRequests`), regroupée
 *                                    par tentative de modèle
 *                                    (`providerAttempts` : analyse ;
 *                                    `repairAttempts` : réparation), par modèle
 *                                    et par rang (`byModelRank`) ;
 *   (vi)  événement d'usage          une ligne `ai_usage_event` (`usageEvents`),
 *                                    dont celles SANS requête émise
 *                                    (`usageEventsWithoutSend` : refus avant
 *                                    appel, rang non sollicité) ; coût OBSERVÉ
 *                                    (consommation rendue par le fournisseur,
 *                                    tarif confirmé), ESTIMÉ (tarif non
 *                                    confirmé) ou INCONNU (`costUnknownEvents`).
 *
 * Une intention (`aiCalled`, `aiCalls++` avant l'appel) n'est JAMAIS une
 * invocation réelle : c'est au mieux une demande déclarée par une phase
 * (`declaredRequests`), conservée à part pour l'historique.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * D'OÙ VIENNENT LES NOMBRES (aucune reconstruction)
 *
 * Trois points de passage obligés alimentent le registre de l'exécution
 * courante (`AsyncLocalStorage`, comme `job-context`) :
 *   · `AiGateway.execute`  → demande logique, réponse du cache / partagée
 *     (lue sur la réponse : `fromCache`, `cacheOutcome`), demande terminée
 *     sans aucun contact ;
 *   · `recordCallTrace`    → événement d'usage, avec les requêtes réellement
 *     émises (`capture.sent`), le modèle, le rang, les jetons et le statut
 *     tarifaire FIGÉS dans la même écriture que `ai_usage_event` ;
 *   · `noteReuse`          → décision réutilisée, arbitrage conservé.
 * Les totaux se concilient donc avec les événements sources (`traceIds`,
 * `ai_usage_event.metadata.networkRequests`), sans double compte : une
 * demande partagée ne compte ses requêtes que chez l'appelant qui les a
 * émises ; une réponse du cache ne reporte ni requête ni coût.
 *
 * Hors d'un registre ouvert : aucun effet (ni coût, ni écriture).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Version de la sémantique des compteurs écrite avec chaque mesure. */
export const AI_ACTIVITY_SEMANTICS = 'ai-activity-v1';

/** Marqueurs de sémantique des compteurs d'un passage (colonne `ai_counters_semantics`). */
export const AI_COUNTERS_MEASURED = 'MEASURED_V1';
/** Demandes déclarées par les phases (aucune passerelle observée : jeux de test, ancien code). */
export const AI_COUNTERS_DECLARED = 'DECLARED';

export interface AiActivityCounters {
  /** (ii) Demandes logiques à la passerelle. */
  logicalRequests: number;
  /** Demandes terminées en échec sans qu'aucune requête n'ait été émise par cet appelant. */
  requestsWithoutContact: number;
  /** (iii) Réponses servies par le cache temporaire. */
  cacheResponses: number;
  /** (iii) Réponses partagées avec une demande identique simultanée. */
  sharedResponses: number;
  /** (iv) Décisions de la mémoire durable réutilisées. */
  decisionsReused: number;
  /** (iv) Arbitrages utilisateur conservés. */
  userArbitrationsKept: number;
  /** (vi) Événements d'usage écrits. */
  usageEvents: number;
  /** (vi) Événements d'usage sans requête émise. */
  usageEventsWithoutSend: number;
  /** (v) Tentatives de modèle (analyse) ayant émis au moins une requête. */
  providerAttempts: number;
  /** (v) Passes de réparation ayant émis au moins une requête. */
  repairAttempts: number;
  /** (v) Requêtes réellement émises vers le fournisseur. */
  networkRequests: number;
  inputTokens: number;
  outputTokens: number;
  /** (vi) Coût observé (micro-dollars) : consommation rendue, tarif confirmé. */
  costObservedMicros: number;
  /** (vi) Coût estimé (micro-dollars) : consommation rendue, tarif non confirmé. */
  costEstimatedMicros: number;
  /** (vi) Événements dont le coût est inconnu (requête émise, consommation ou tarif absent). */
  costUnknownEvents: number;
}

export interface AiModelRankActivity {
  model: string;
  rank: string | null;
  attempts: number;
  networkRequests: number;
  succeeded: number;
  failed: number;
}

export interface AiActivitySnapshot {
  semantics: typeof AI_ACTIVITY_SEMANTICS;
  total: AiActivityCounters;
  byTreatment: Record<string, AiActivityCounters>;
  byOperation: Record<string, AiActivityCounters>;
  byPhase: Record<string, AiActivityCounters>;
  byModelRank: AiModelRankActivity[];
  /** Traces de la passerelle observées (rapprochement avec `ai_usage_event`), bornées. */
  traceIds: string[];
  traceIdsTruncated: boolean;
}

/** Nature du coût d'un événement d'usage. */
export type AiCostNature = 'NONE' | 'OBSERVED' | 'ESTIMATED' | 'UNKNOWN';

export interface AiUsageEventFact {
  traceId: string;
  operationCode: string;
  /** Traitement (T1…T6) ; `null` : usage technique. */
  treatment: string | null;
  model: string;
  rank: string | null;
  callKind: 'analysis' | 'repair';
  status: 'success' | 'error';
  /** Requêtes réellement émises pour cet événement (0 : refus avant appel, rang non sollicité). */
  networkRequests: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number | null;
  costNature: AiCostNature;
}

const AUTRE = 'AUTRE';
const HORS_PHASE = 'HORS_PHASE';
const MAX_TRACE_IDS = 500;

const zero = (): AiActivityCounters => ({
  logicalRequests: 0, requestsWithoutContact: 0, cacheResponses: 0, sharedResponses: 0, decisionsReused: 0,
  userArbitrationsKept: 0, usageEvents: 0, usageEventsWithoutSend: 0, providerAttempts: 0, repairAttempts: 0,
  networkRequests: 0, inputTokens: 0, outputTokens: 0, costObservedMicros: 0, costEstimatedMicros: 0, costUnknownEvents: 0,
});

/** Compteurs à zéro (exporté : valeurs par défaut des consommateurs). */
export function emptyAiActivityCounters(): AiActivityCounters { return zero(); }

type Delta = Partial<AiActivityCounters>;

class Ledger {
  readonly total = zero();
  readonly byTreatment = new Map<string, AiActivityCounters>();
  readonly byOperation = new Map<string, AiActivityCounters>();
  readonly byPhase = new Map<string, AiActivityCounters>();
  readonly byModelRank = new Map<string, AiModelRankActivity>();
  readonly traceIds = new Set<string>();
  traceIdsTruncated = false;

  add(d: Delta, dims: { treatment: string | null; operationCode: string | null; phase: string | null }): void {
    const cibles = [
      this.total,
      seau(this.byTreatment, dims.treatment ?? AUTRE),
      seau(this.byOperation, dims.operationCode ?? AUTRE),
      seau(this.byPhase, dims.phase ?? HORS_PHASE),
    ];
    for (const c of cibles) {
      for (const [k, v] of Object.entries(d) as Array<[keyof AiActivityCounters, number]>) c[k] += v;
    }
  }

  trace(traceId: string | null | undefined): void {
    if (!traceId) return;
    if (this.traceIds.size >= MAX_TRACE_IDS && !this.traceIds.has(traceId)) { this.traceIdsTruncated = true; return; }
    this.traceIds.add(traceId);
  }

  modelRank(f: AiUsageEventFact): void {
    const k = `${f.model}|${f.rank ?? ''}`;
    const m = this.byModelRank.get(k) ?? { model: f.model, rank: f.rank, attempts: 0, networkRequests: 0, succeeded: 0, failed: 0 };
    m.attempts += 1;
    m.networkRequests += f.networkRequests;
    if (f.status === 'success') m.succeeded += 1; else m.failed += 1;
    this.byModelRank.set(k, m);
  }

  snapshot(): AiActivitySnapshot {
    const copie = (m: Map<string, AiActivityCounters>) => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, { ...v }]));
    return {
      semantics: AI_ACTIVITY_SEMANTICS, total: { ...this.total },
      byTreatment: copie(this.byTreatment), byOperation: copie(this.byOperation), byPhase: copie(this.byPhase),
      byModelRank: [...this.byModelRank.values()].map((x) => ({ ...x })),
      traceIds: [...this.traceIds], traceIdsTruncated: this.traceIdsTruncated,
    };
  }
}

function seau(m: Map<string, AiActivityCounters>, k: string): AiActivityCounters {
  let c = m.get(k);
  if (!c) { c = zero(); m.set(k, c); }
  return c;
}

interface RequestRecord { networkRequests: number }
interface Store {
  /** Registres ouverts, du plus englobant au plus proche : chaque fait est porté dans TOUS. */
  ledgers: Ledger[];
  phase: string | null;
  request: RequestRecord | null;
}

const storage = new AsyncLocalStorage<Store>();

/** Une exécution mesurée est-elle en cours ? */
export function aiActivityActive(): boolean {
  return (storage.getStore()?.ledgers.length ?? 0) > 0;
}

/**
 * Exécute `fn` dans un registre de mesure et rend son relevé. Les registres
 * s'emboîtent (travail de file → passage du compte → bien) : un fait est
 * compté une fois dans chacun, jamais deux fois dans le même.
 */
export async function measureAiActivity<T>(fn: () => Promise<T>): Promise<{ result: T; activity: AiActivitySnapshot }> {
  const scope = openAiActivity();
  const result = await scope.run(fn);
  return { result, activity: scope.snapshot() };
}

/**
 * Registre dont le relevé reste lisible même si `fn` lève (clôture d'un
 * passage interrompu : les requêtes déjà émises restent comptées).
 */
export function openAiActivity(): { run<T>(fn: () => Promise<T>): Promise<T>; snapshot(): AiActivitySnapshot } {
  const ledger = new Ledger();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const parent = storage.getStore();
      return storage.run({ ledgers: [...(parent?.ledgers ?? []), ledger], phase: parent?.phase ?? null, request: null }, fn);
    },
    snapshot: () => ledger.snapshot(),
  };
}

/** Rattache les faits de `fn` à une phase nommée (ASSETS, OPEN_ACTIONS, DOCUMENT_NAMING…). Sans registre : simple appel. */
export function withAiActivityPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  if (!parent) return fn();
  return storage.run({ ...parent, phase }, fn);
}

/**
 * Change la phase du registre COURANT pour la suite de l'exécution (phases séquentielles d'un passage) ; `null` :
 * hors phase. Les demandes déjà en cours gardent la phase de leur départ. Sans registre : aucun effet.
 */
export function setAiActivityPhase(phase: string | null): void {
  const s = storage.getStore();
  if (s) s.phase = phase;
}

interface RequestMeta { operationCode: string; treatment: string | null }

/**
 * Enveloppe d'une demande logique à la passerelle (appelée par
 * `AiGateway.execute`). L'issue est lue sur ce que la passerelle rend déjà à
 * l'appelant (`fromCache`, `cacheOutcome`) ; une demande qui lève sans avoir
 * émis de requête est comptée « sans contact ».
 */
export function trackAiLogicalRequest<T>(meta: RequestMeta, fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  if (!parent || parent.ledgers.length === 0) return fn();
  const request: RequestRecord = { networkRequests: 0 };
  const dims = { treatment: meta.treatment, operationCode: meta.operationCode, phase: parent.phase };
  for (const l of parent.ledgers) l.add({ logicalRequests: 1 }, dims);
  return storage.run({ ...parent, request }, async () => {
    try {
      const r = await fn();
      const rep = r as { fromCache?: unknown; cacheOutcome?: unknown; traceId?: unknown } | null;
      if (rep && typeof rep === 'object' && rep.fromCache === true) {
        const d: Delta = rep.cacheOutcome === 'SHARED' ? { sharedResponses: 1 } : { cacheResponses: 1 };
        for (const l of parent.ledgers) l.add(d, dims);
      }
      return r;
    } catch (e) {
      if (request.networkRequests === 0) for (const l of parent.ledgers) l.add({ requestsWithoutContact: 1 }, dims);
      throw e;
    }
  });
}

/** Événement d'usage écrit par `recordCallTrace` (même données que la ligne `ai_usage_event`). */
export function noteAiUsageEvent(f: AiUsageEventFact): void {
  const s = storage.getStore();
  if (!s || s.ledgers.length === 0) return;
  const emis = Math.max(0, Math.floor(f.networkRequests));
  if (s.request) s.request.networkRequests += emis;
  const d: Delta = {
    usageEvents: 1,
    usageEventsWithoutSend: emis === 0 ? 1 : 0,
    providerAttempts: emis > 0 && f.callKind === 'analysis' ? 1 : 0,
    repairAttempts: emis > 0 && f.callKind === 'repair' ? 1 : 0,
    networkRequests: emis,
    inputTokens: Math.max(0, f.inputTokens), outputTokens: Math.max(0, f.outputTokens),
    costObservedMicros: f.costNature === 'OBSERVED' ? Math.max(0, f.costMicros ?? 0) : 0,
    costEstimatedMicros: f.costNature === 'ESTIMATED' ? Math.max(0, f.costMicros ?? 0) : 0,
    costUnknownEvents: f.costNature === 'UNKNOWN' ? 1 : 0,
  };
  const dims = { treatment: f.treatment, operationCode: f.operationCode, phase: s.phase };
  for (const l of s.ledgers) {
    l.add(d, dims);
    l.trace(f.traceId);
    if (emis > 0) l.modelRank(f);
  }
}

/** Décision réutilisée sans demande (mémoire durable, arbitrage utilisateur). */
export function noteAiDecisionReuse(p: { kind: 'DECISION_REUSED' | 'USER_ARBITRATION_KEPT'; operationCode: string | null; treatment: string | null; count?: number }): void {
  const s = storage.getStore();
  if (!s || s.ledgers.length === 0) return;
  const n = Math.max(0, Math.floor(p.count ?? 1));
  if (n === 0) return;
  const d: Delta = p.kind === 'DECISION_REUSED' ? { decisionsReused: n } : { userArbitrationsKept: n };
  for (const l of s.ledgers) l.add(d, { treatment: p.treatment, operationCode: p.operationCode, phase: s.phase });
}

/**
 * Nature du coût d'un événement d'usage (pure).
 *
 *   · aucune requête émise                         → NONE (coût nul certain) ;
 *   · consommation rendue, tarif appliqué          → OBSERVED, ou ESTIMATED si
 *     le tarif appliqué n'est pas confirmé ;
 *   · consommation rendue, tarif absent            → UNKNOWN ;
 *   · réponse reçue sans compteur de jetons        → UNKNOWN ;
 *   · requête émise, AUCUNE réponse (délai dépassé, erreur réseau, cause
 *     indéterminée)                                → UNKNOWN : le fournisseur
 *     a pu consommer sans le dire ;
 *   · requête émise, refus explicite du fournisseur sans consommation
 *     rendue                                       → OBSERVED à 0.
 */
export function aiCostNatureOf(p: {
  networkRequests: number; status: 'success' | 'error'; inputTokens: number; outputTokens: number;
  pricingStatus: string; failureFamily: string | null; priceConfirmed: boolean;
}): AiCostNature {
  if (p.networkRequests <= 0) return 'NONE';
  const jetons = Math.max(0, p.inputTokens) + Math.max(0, p.outputTokens);
  if (jetons > 0) {
    if (p.pricingStatus === 'applied' || p.pricingStatus === 'zero_or_rounded') return p.priceConfirmed ? 'OBSERVED' : 'ESTIMATED';
    return 'UNKNOWN';
  }
  if (p.status === 'success') return 'UNKNOWN';
  return p.failureFamily === null || ['TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN'].includes(p.failureFamily) ? 'UNKNOWN' : 'OBSERVED';
}

/** Somme de deux jeux de compteurs (pure). */
export function addAiActivityCounters(a: AiActivityCounters, b: Partial<AiActivityCounters>): AiActivityCounters {
  const out = { ...a };
  for (const k of Object.keys(out) as Array<keyof AiActivityCounters>) out[k] += Number(b[k] ?? 0) || 0;
  return out;
}

/** La passerelle a-t-elle été observée par ce relevé ? (au moins une demande logique ou un événement d'usage) */
export function aiActivityObserved(a: AiActivitySnapshot | null | undefined): boolean {
  return !!a && (a.total.logicalRequests > 0 || a.total.usageEvents > 0);
}

export interface MeasuredAiCounters {
  /** `MEASURED_V1` : valeurs mesurées ; `DECLARED` : demandes déclarées par les phases (passerelle non observée). */
  semantics: typeof AI_COUNTERS_MEASURED | typeof AI_COUNTERS_DECLARED;
  /** (v) Requêtes réellement émises, tous traitements. */
  providerCalls: number;
  /** (v) Dont requêtes d'un AUTRE traitement que celui de l'exécution (T4 déclenché pendant T3…). */
  providerCallsOtherTreatments: number;
  /** (v) Tentatives de modèle et passes de réparation ayant émis une requête. */
  providerAttempts: number;
  /** (ii) Demandes logiques. */
  logicalRequests: number;
  /** (iii) Réponses du cache et réponses partagées. */
  cacheResponses: number;
  /** Demandes déclarées par les phases (ancienne sémantique, conservée). */
  declaredRequests: number;
}

/**
 * Compteurs publiés d'une exécution (pure) : la mesure quand la passerelle a
 * été observée — ou quand rien n'a été déclaré —, sinon les demandes
 * déclarées, étiquetées comme telles. Jamais un mélange des deux.
 */
export function publishedAiCounters(
  activity: AiActivitySnapshot | null | undefined, declaredRequests: number, ownTreatment: string,
): MeasuredAiCounters {
  const declares = Math.max(0, Math.floor(declaredRequests));
  if (activity && (aiActivityObserved(activity) || declares === 0)) {
    const propres = activity.byTreatment[ownTreatment]?.networkRequests ?? 0;
    return {
      semantics: AI_COUNTERS_MEASURED, providerCalls: activity.total.networkRequests,
      providerCallsOtherTreatments: activity.total.networkRequests - propres,
      providerAttempts: activity.total.providerAttempts + activity.total.repairAttempts,
      logicalRequests: activity.total.logicalRequests,
      cacheResponses: activity.total.cacheResponses + activity.total.sharedResponses, declaredRequests: declares,
    };
  }
  return {
    semantics: AI_COUNTERS_DECLARED, providerCalls: declares, providerCallsOtherTreatments: 0, providerAttempts: declares,
    logicalRequests: declares, cacheResponses: 0, declaredRequests: declares,
  };
}

/** Relevé compact pour un résumé de travail ou une cellule du BO (pure). */
export function compactAiActivity(a: AiActivitySnapshot): Record<string, unknown> {
  const plat = (m: Record<string, AiActivityCounters>) => Object.fromEntries(Object.entries(m).map(([k, c]) => [k, {
    logicalRequests: c.logicalRequests, networkRequests: c.networkRequests, providerAttempts: c.providerAttempts,
    repairAttempts: c.repairAttempts, cacheResponses: c.cacheResponses + c.sharedResponses, decisionsReused: c.decisionsReused + c.userArbitrationsKept,
    usageEvents: c.usageEvents, costObservedMicros: c.costObservedMicros, costEstimatedMicros: c.costEstimatedMicros, costUnknownEvents: c.costUnknownEvents,
  }]));
  return {
    semantics: a.semantics, total: a.total, byTreatment: plat(a.byTreatment), byOperation: plat(a.byOperation), byPhase: plat(a.byPhase),
    byModelRank: a.byModelRank,
  };
}
