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
  /** Appels RÉELS au fournisseur provoqués (0 ou 1). */
  providerCalls: number;
  /** Réponse servie par le cache temporaire (aucun appel). */
  cacheHit: boolean;
  /** Décision mémorisée réutilisée (aucun appel). */
  reused: boolean;
  /** Motifs de la réévaluation (null : réutilisation ou mémoire indisponible). */
  reevaluation: string[] | null;
  memoryId: number | null;
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
}

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
    const r = await deps.resolve(input, idempotencyKey ? { idempotencyKey } : {});
    const source: AiReviewOutcome['source'] = r.aiSource;
    return { r, out: { decision: { ...r.decision, aiSource: source }, source, providerCalls: r.aiSource === 'PROVIDER' || r.providerContacted ? 1 : 0, cacheHit: r.aiSource === 'CACHE' } };
  };

  // Mémoire indisponible : comportement antérieur au lot 99A.
  let pret = false;
  try { pret = await deps.ready(); } catch { pret = false; }
  if (!pret) {
    const { out } = await appeler();
    return { ...out, reused: false, reevaluation: null, memoryId: null };
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
    const { out } = await appeler();
    return { ...out, reused: false, reevaluation: null, memoryId: null };
  }

  const now = deps.now();
  const force = !!p.force;
  if (isReusable(active, fp.fingerprint, now, force)) {
    await deps.noteReused(active!.id);
    await deps.count({ kind: 'DECISION_REUSED', accountId: p.accountId, treatment: 'T3', operationCode: T3_VALUE_CONFLICT_OPERATION });
    return {
      decision: { ...active!.decision, aiSource: 'MEMORY' }, source: 'MEMORY', providerCalls: 0, cacheHit: false,
      reused: true, reevaluation: null, memoryId: active!.id,
    };
  }

  const motifs = force ? ['FORCED'] : reevaluationReasons(active?.parts ?? null, fp.parts);
  // Clé du cache des réponses alignée sur l'empreinte ; une relance forcée ne lit jamais le cache.
  const cle = `t3vc:a${p.accountId}:${fp.fingerprint}${force ? `:forced:${randomUUID()}` : ''}`;
  const { r, out } = await appeler(cle);

  if (r.aiSource === 'FAILED' && !r.providerContacted) {
    // Refus AVANT contact du fournisseur (arrêt d'urgence, plafond, compte inéligible) : rien à mémoriser.
    return { ...out, reused: false, reevaluation: motifs, memoryId: null };
  }
  let memoryId: number | null = null;
  try {
    memoryId = await deps.record(key, {
      fingerprint: fp.fingerprint, parts: fp.parts, operationCode: T3_VALUE_CONFLICT_OPERATION, aiConfigSignature: aiSig,
      outcome: memoryOutcomeOf(r), decision: sansOrigine(r.decision),
      aiSource: r.aiSource === 'FAILED' ? 'UNAVAILABLE' : r.aiSource, aiTraceId: r.traceId,
      forced: force, forcedReason: force ? p.force!.reason.slice(0, 300) : null,
      retryAfter: r.aiSource === 'FAILED' ? new Date(now.getTime() + failureRetryMinutes() * 60_000) : null,
      supersedeReason: motifs.join(','),
    });
  } catch (e) {
    if (await annule(e)) throw e;
    console.error('[t3-decision-memory] décision non mémorisée (non bloquant) :', (e as Error).message);
  }
  if (force) await deps.count({ kind: 'DECISION_FORCED', accountId: p.accountId, treatment: 'T3', operationCode: T3_VALUE_CONFLICT_OPERATION });
  else if (active) await deps.count({ kind: 'DECISION_REEVALUATED', accountId: p.accountId, treatment: 'T3', operationCode: T3_VALUE_CONFLICT_OPERATION });
  return { ...out, reused: false, reevaluation: motifs, memoryId };
}

type FingerprintInputVariables = import('./fingerprint').FingerprintInput['variables'];
