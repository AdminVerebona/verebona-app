/**
 * Revue IA d'un champ ambigu AVEC mémoire durable des décisions — lot 99A
 * (ticket P1 « T3 — Supprimer les appels IA redondants », points A et D).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ (compte 13, préproduction du 27/10/2026)
 *
 * T3 s'exécutait toutes les heures et rappelait le modèle sur le même conflit
 * (même champ, même preuve, même contexte) : la mémoire des arbitrages n'était
 * lue qu'APRÈS l'appel, et le cache des réponses (1 h, la période de T3) ne se
 * renouvelait pas. Résultat : 23 appels facturés en 24 h pour 0 correction.
 *
 * Désormais, AVANT tout appel :
 *   1. l'empreinte du contexte est calculée (`fingerprint.ts` : compte, objet,
 *      champ, preuves et leurs versions, valeur en place, résolution
 *      utilisateur, règles métier, configuration IA effective) ;
 *   2. même empreinte que la décision ACTIVE du champ → la décision est
 *      RÉUTILISÉE telle quelle (abstention, conflit, valeur) : aucun appel,
 *      aucun nouvel arbitrage, compteur de réutilisation ;
 *   3. sinon (contexte changé, relance forcée tracée, échec IA à retenter) :
 *      appel — par le cache des réponses, dont la clé est alignée sur
 *      l'empreinte —, puis la nouvelle décision remplace l'ancienne avec le
 *      motif de la réévaluation.
 * Une exécution horaire n'est JAMAIS, à elle seule, une raison de rappeler.
 *
 * Mémoire indisponible (table absente, `T3_DECISION_MEMORY_ENABLED=0`, lecture
 * en échec) : comportement antérieur (appel), jamais un blocage de T3.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'crypto';
import type { EvidenceCandidate, ReconciliationDecision } from '../types';
import type { ValueConflictOutcome, ValueConflictMasterInput } from '../master/value-conflict';
import { decisionFingerprint, reevaluationReasons, type FingerprintParts } from './fingerprint';
import type { MemoryEntry, MemoryKey, MemoryOutcome, NewDecision } from './store';
import type { ReuseEvent } from '../../reuse/reuse-counters';
import {
  admitDegradedCall, degradedRecently, noteDegraded, technicalCodeOf,
  type DegradedComponent, type DegradedEvent, type DegradedReason, type DegradedScope,
} from '../../degraded/degraded-mode';
import { measureAiActivity } from '../../measure/ai-activity';

export const T3_VALUE_CONFLICT_OPERATION = 't3_value_conflict';

/** Délai avant une nouvelle tentative après un échec IA mémorisé (`T3_DECISION_MEMORY_FAILURE_RETRY_MINUTES`, 360 min). */
export function failureRetryMinutes(): number {
  const v = Number(process.env.T3_DECISION_MEMORY_FAILURE_RETRY_MINUTES);
  return Number.isFinite(v) && v >= 0 ? Math.min(7 * 24 * 60, Math.floor(v)) : 360;
}

export interface AmbiguousFieldInput {
  accountId: number;
  assetId: number;
  /** Clé canonique du champ (alias ramenés au registre). */
  canonicalKey: string;
  decision: ReconciliationDecision;
  candidates: EvidenceCandidate[];
  currentValue: unknown;
  currentOrigin: string;
  /** Relance forcée explicitement tracée (lancement manuel « réévaluer »). */
  force?: { reason: string } | null;
}

export interface AiReviewOutcome {
  decision: ReconciliationDecision;
  /** Origine de la décision (voir `ReconciliationDecision.aiSource`). */
  source: NonNullable<ReconciliationDecision['aiSource']>;
  /** Requêtes réellement émises vers le fournisseur pendant la revue (carte #811 : mesure de la passerelle). */
  providerCalls: number;
  /** Carte #811 : demande d'arbitrage déclarée (0 ou 1) — ancienne valeur de `providerCalls`, conservée à part. */
  declaredRequests?: number;
  /** Réponse servie par le cache temporaire (aucun appel). */
  cacheHit: boolean;
  /** Décision mémorisée réutilisée (aucun appel). */
  reused: boolean;
  /** Motifs de la réévaluation (null : réutilisation ou mémoire indisponible). */
  reevaluation: string[] | null;
  memoryId: number | null;
  /**
   * Carte #811 : passage en mode dégradé — `CALL_WITHOUT_PROTECTION` (appel émis sans mémoire utilisable),
   * `CALL_REFUSED` (budget dégradé épuisé : aucun appel, conflit prudent), `RESULT_NOT_STORED` (décision rendue
   * mais non mémorisée). Absent : fonctionnement sain.
   */
  degraded?: 'CALL_WITHOUT_PROTECTION' | 'CALL_REFUSED' | 'RESULT_NOT_STORED';
}

export interface DecisionMemoryDeps {
  ready(): Promise<boolean>;
  findActive(k: MemoryKey): Promise<MemoryEntry | null>;
  noteReused(id: number): Promise<void>;
  record(k: MemoryKey, d: NewDecision): Promise<number | null>;
  userResolution(accountId: number, assetId: number, fieldKeys: readonly string[]): Promise<string | null>;
  aiConfigSignature(operationCode: string): Promise<string>;
  resolve(input: ValueConflictMasterInput, opts: { idempotencyKey?: string }): Promise<ValueConflictOutcome>;
  count(e: ReuseEvent): Promise<void>;
  now(): Date;
  /** Carte #811 : raison de l'indisponibilité de la mémoire (absent : « migration absente » quand `ready()` est faux). */
  unavailableReason?(): Promise<DegradedReason | null>;
  /** Carte #811 : trace d'un passage en mode dégradé (absent : `degraded/degraded-mode`). */
  noteDegraded?(e: DegradedEvent): void;
  /** Carte #811 : un appel sans protection peut-il partir ? (absent : budget de `degraded/degraded-mode`). */
  admitDegradedCall?(scope: DegradedScope): boolean;
  /** Carte #811 : la portée a-t-elle été dégradée dans l'heure ? (absent : `degraded/degraded-mode`). */
  degradedRecently?(scope: DegradedScope): boolean;
}

/** Signature rendue par la passerelle quand la configuration IA effective n'a pas pu être résolue. */
export const UNRESOLVED_AI_CONFIG_SIGNATURE = 'unresolved';

const defaultDeps: DecisionMemoryDeps = {
  async ready() { return (await import('./store')).memoryReady(); },
  async findActive(k) { return (await import('./store')).findActiveDecision(k); },
  async noteReused(id) { return (await import('./store')).noteDecisionReused(id); },
  async record(k, d) { return (await import('./store')).recordDecision(k, d); },
  async userResolution(a, s, f) { return (await import('./store')).lastUserResolution(a, s, f); },
  async aiConfigSignature(op) { return (await import('../../gateway/ai-gateway')).AiGateway.effectiveConfigSignature(op); },
  async resolve(input, opts) { return (await import('../master/value-conflict')).resolveValueConflictMasterDetailed(input, opts); },
  async count(e) { return (await import('../../reuse/reuse-counters')).noteReuse(e); },
  now: () => new Date(),
  async unavailableReason() { return (await import('./store')).memoryUnavailableReason(); },
};

const annule = async (e: unknown): Promise<boolean> => {
  const { isExecutionCancelled } = await import('../../queue/execution-control');
  return isExecutionCancelled(e);
};

/** Issue mémorisée d'une décision traduite (pure). */
export function memoryOutcomeOf(o: Pick<ValueConflictOutcome, 'decision' | 'aiSource' | 'abstained'>): MemoryOutcome {
  if (o.aiSource === 'FAILED') return 'AI_FAILED';
  switch (o.decision.action) {
    case 'apply': return 'APPLY';
    case 'update': return 'UPDATE';
    case 'keep': return 'KEEP';
    default: return o.abstained ? 'ABSTAIN' : 'CONFLICT';
  }
}

/** Une entrée active est-elle réutilisable telle quelle (pure) ? */
export function isReusable(active: Pick<MemoryEntry, 'fingerprint' | 'outcome' | 'retryAfter'> | null, fingerprint: string, now: Date, forced: boolean): boolean {
  if (!active || forced || active.fingerprint !== fingerprint) return false;
  if (active.outcome !== 'AI_FAILED') return true;
  // Échec IA mémorisé : réutilisé (conflit prudent, aucun appel) jusqu'à l'heure de nouvelle tentative.
  return !!active.retryAfter && active.retryAfter.getTime() > now.getTime();
}

const sansOrigine = (d: ReconciliationDecision): ReconciliationDecision => {
  const { aiSource: _ignore, ...reste } = d;
  return reste;
};

/**
 * Revue IA d'un champ ambigu (décision `request_ai_review`), mémoire consultée
 * AVANT l'appel. Ne lève pas, sauf interruption d'exécution.
 */
export async function reviewAmbiguousField(p: AmbiguousFieldInput, deps: DecisionMemoryDeps = defaultDeps): Promise<AiReviewOutcome> {
  const input: ValueConflictMasterInput = {
    accountId: p.accountId, assetId: p.assetId, decision: p.decision, candidates: p.candidates,
    currentValue: p.currentValue, currentOrigin: p.currentOrigin,
  };
  const appeler = async (idempotencyKey?: string) => {
    // Carte #811 (P1-A) : `providerCalls` = requêtes RÉELLEMENT émises pendant cette revue (mesure de la
    // passerelle : repli, essai sans schéma et réparation compris — 0 pour un refus avant contact). Passerelle non
    // observée (résolveur simulé d'un jeu de test) : valeur déclarée d'avant (0 ou 1).
    const { result: r, activity } = await measureAiActivity(() => deps.resolve(input, idempotencyKey ? { idempotencyKey } : {}));
    const source: AiReviewOutcome['source'] = r.aiSource;
    const declares = r.aiSource === 'PROVIDER' || r.providerContacted ? 1 : 0;
    const providerCalls = activity.total.logicalRequests > 0 ? activity.total.networkRequests : declares;
    return { r, out: { decision: { ...r.decision, aiSource: source }, source, providerCalls, declaredRequests: declares, cacheHit: r.aiSource === 'CACHE' } };
  };

  // ── Carte #811 (P1-C) : modes dégradés TRACÉS et BORNÉS ───────────────────────────────────────────────────
  // Sans mémoire utilisable, chaque passage reposerait la question au fournisseur. L'appel reste permis
  // (continuité métier) mais il est tracé, et il consomme le budget dégradé de la portée ; budget épuisé :
  // aucun appel, conflit prudent laissé à l'utilisateur, rien de mémorisé, reprise à un passage suivant.
  const scope: DegradedScope = { treatment: 'T3', operationCode: T3_VALUE_CONFLICT_OPERATION, accountId: p.accountId };
  const tracer = deps.noteDegraded ?? noteDegraded;
  const admettre = deps.admitDegradedCall ?? admitDegradedCall;
  const recemment = deps.degradedRecently ?? degradedRecently;
  const sansIa = (): AiReviewOutcome => ({
    decision: { ...p.decision, action: 'create_conflict', reasonCode: 'AMBIGUOUS_EVIDENCE', deterministic: true, aiSource: 'FAILED' },
    source: 'FAILED', providerCalls: 0, cacheHit: false, reused: false, reevaluation: null, memoryId: null, degraded: 'CALL_REFUSED',
  });
  const appelDegrade = async (
    component: DegradedComponent, reason: DegradedReason, technicalCode: string | null, idempotencyKey?: string,
  ): Promise<AiReviewOutcome> => {
    if (!admettre(scope)) {
      tracer({ ...scope, component, reason, impact: 'CALL_REFUSED', technicalCode });
      return sansIa();
    }
    tracer({ ...scope, component, reason, impact: 'CALL_WITHOUT_PROTECTION', technicalCode });
    const { out } = await appeler(idempotencyKey);
    return { ...out, reused: false, reevaluation: null, memoryId: null, degraded: 'CALL_WITHOUT_PROTECTION' };
  };

  // Mémoire indisponible : comportement antérieur au lot 99A (appel), désormais tracé et borné.
  let pret = false;
  try { pret = await deps.ready(); } catch { pret = false; }
  if (!pret) {
    let raison: DegradedReason = 'MIGRATION_MISSING';
    try { raison = (await deps.unavailableReason?.()) ?? 'MIGRATION_MISSING'; } catch { raison = 'READ_FAILED'; }
    return appelDegrade('DECISION_MEMORY', raison, null);
  }

  const key: MemoryKey = { accountId: p.accountId, assetId: p.assetId, objectType: 'ASSET', objectId: p.assetId, fieldKey: p.decision.fieldKey };
  let fp: { fingerprint: string; parts: FingerprintParts };
  let active: MemoryEntry | null;
  let aiSig: string;
  try {
    const [user, sig] = await Promise.all([
      deps.userResolution(p.accountId, p.assetId, [p.canonicalKey, p.decision.fieldKey]),
      deps.aiConfigSignature(T3_VALUE_CONFLICT_OPERATION),
    ]);
    aiSig = sig;
    const { valueConflictVariables } = await import('../master/value-conflict');
    const { AUTHORITY_MATRIX_VERSION } = await import('../decision/authority-matrix');
    const { AUTHORITY_EQUIVALENCE_MARGIN } = await import('../decision/confidence');
    fp = decisionFingerprint({
      accountId: p.accountId, objectType: 'ASSET', objectId: p.assetId, fieldKey: p.canonicalKey,
      variables: valueConflictVariables(input) as FingerprintInputVariables,
      currentValue: p.currentValue ?? null, currentOrigin: p.currentOrigin,
      request: {
        reasonCode: p.decision.reasonCode, proposedValue: p.decision.proposedValue ?? null,
        evidenceIds: p.decision.evidenceIds ?? [], confidence: p.decision.confidence,
      },
      rules: { authorityMatrixVersion: AUTHORITY_MATRIX_VERSION, equivalenceMargin: AUTHORITY_EQUIVALENCE_MARGIN },
      userResolution: user, aiConfigSignature: sig,
    });
    active = await deps.findActive(key);
  } catch (e) {
    if (await annule(e)) throw e;
    console.error('[t3-decision-memory] mémoire illisible, appel sans mémoire (non bloquant) :', (e as Error).message);
    return appelDegrade('DECISION_MEMORY', 'READ_FAILED', technicalCodeOf(e));
  }

  const now = deps.now();
  const force = !!p.force;

  // ── Carte #811 (P1-C) : signature de configuration NON RÉSOLUE ────────────────────────────────────────────
  // On ne sait pas quelle configuration IA s'appliquerait : une décision mémorisée ne peut être ni réutilisée
  // (elle serait peut-être obsolète), ni enregistrée sous cette signature (elle serait réutilisée à tort plus
  // tard). L'entrée ACTIVE est laissée intacte : dès que la signature se résout à nouveau, elle redevient
  // réutilisable si — et seulement si — la configuration est bien la même. L'appel, lui, est tracé et borné.
  if (aiSig === UNRESOLVED_AI_CONFIG_SIGNATURE) {
    const cle = `t3vc:a${p.accountId}:${fp.fingerprint}${force ? `:forced:${randomUUID()}` : ''}`;
    return { ...(await appelDegrade('CONFIG_SIGNATURE', 'SIGNATURE_UNRESOLVED', null, cle)), reevaluation: ['AI_CONFIG_UNRESOLVED'] };
  }

  if (isReusable(active, fp.fingerprint, now, force)) {
    await deps.noteReused(active!.id);
    await deps.count({ kind: 'DECISION_REUSED', accountId: p.accountId, treatment: 'T3', operationCode: T3_VALUE_CONFLICT_OPERATION });
    return {
      decision: { ...active!.decision, aiSource: 'MEMORY' }, source: 'MEMORY', providerCalls: 0, cacheHit: false,
      reused: true, reevaluation: null, memoryId: active!.id,
    };
  }

  const motifs = force ? ['FORCED'] : reevaluationReasons(active?.parts ?? null, fp.parts);
  // Carte #811 : la dernière décision de cette portée n'a pas pu être mémorisée (écriture en échec dans l'heure)
  // et aucune entrée n'existe pour ce champ — cet appel est peut-être un RAPPEL : il consomme le budget dégradé.
  if (!force && !active && recemment(scope) && echecsEcriture.has(cleEchec(scope)) && !admettre(scope)) {
    tracer({ ...scope, component: 'DECISION_MEMORY', reason: 'WRITE_FAILED', impact: 'CALL_REFUSED' });
    return { ...sansIa(), reevaluation: motifs };
  }
  // Clé du cache des réponses alignée sur l'empreinte ; une relance forcée ne lit jamais le cache.
  const cle = `t3vc:a${p.accountId}:${fp.fingerprint}${force ? `:forced:${randomUUID()}` : ''}`;
  const { r, out } = await appeler(cle);

  if (r.aiSource === 'FAILED' && !r.providerContacted) {
    // Refus AVANT contact du fournisseur (arrêt d'urgence, plafond, compte inéligible) : rien à mémoriser.
    return { ...out, reused: false, reevaluation: motifs, memoryId: null };
  }
  let memoryId: number | null = null;
  const nouvelle: NewDecision = {
    fingerprint: fp.fingerprint, parts: fp.parts, operationCode: T3_VALUE_CONFLICT_OPERATION, aiConfigSignature: aiSig,
    outcome: memoryOutcomeOf(r), decision: sansOrigine(r.decision),
    aiSource: r.aiSource === 'FAILED' ? 'UNAVAILABLE' : r.aiSource, aiTraceId: r.traceId,
    forced: force, forcedReason: force ? p.force!.reason.slice(0, 300) : null,
    retryAfter: r.aiSource === 'FAILED' ? new Date(now.getTime() + failureRetryMinutes() * 60_000) : null,
    supersedeReason: motifs.join(','),
  };
  let degraded: AiReviewOutcome['degraded'];
  try {
    memoryId = await deps.record(key, nouvelle);
    echecsEcriture.delete(cleEchec(scope));
  } catch (e1) {
    if (await annule(e1)) throw e1;
    // Carte #811 (P1-C) : une seconde tentative immédiate (incident passager), puis dégradation TRACÉE — sans
    // mémoire, le passage suivant reposerait la question (le cache temporaire ne couvre qu'une heure).
    try {
      memoryId = await deps.record(key, nouvelle);
      echecsEcriture.delete(cleEchec(scope));
    } catch (e2) {
      if (await annule(e2)) throw e2;
      console.error('[t3-decision-memory] décision non mémorisée (non bloquant) :', (e2 as Error).message);
      echecsEcriture.add(cleEchec(scope));
      tracer({ ...scope, component: 'DECISION_MEMORY', reason: 'WRITE_FAILED', impact: 'RESULT_NOT_STORED', technicalCode: technicalCodeOf(e2) });
      degraded = 'RESULT_NOT_STORED';
    }
  }
  if (force) await deps.count({ kind: 'DECISION_FORCED', accountId: p.accountId, treatment: 'T3', operationCode: T3_VALUE_CONFLICT_OPERATION });
  else if (active) await deps.count({ kind: 'DECISION_REEVALUATED', accountId: p.accountId, treatment: 'T3', operationCode: T3_VALUE_CONFLICT_OPERATION });
  return { ...out, reused: false, reevaluation: motifs, memoryId, ...(degraded ? { degraded } : {}) };
}

/** Portées dont la dernière écriture en mémoire a échoué (instance courante). */
const echecsEcriture = new Set<string>();
const cleEchec = (s: DegradedScope) => `${s.operationCode ?? ''}|${s.accountId ?? 0}`;

/** Réservé aux tests. */
export function __resetDecisionMemoryDegradedForTests(): void { echecsEcriture.clear(); }

type FingerprintInputVariables = import('./fingerprint').FingerprintInput['variables'];
