/**
 * T3 master — branche VALUE_CONFLICT (CDC 15 §25, T3-06, U1 à U6).
 *
 * Remplace, quand la version de configuration déclare T3 en architecture
 * `master`, l'appel `resolve_ambiguity`. Même place dans le moteur (étape 7
 * du §4.2.8, décisions `request_ai_review` seulement), même traduction vers
 * `ReconciliationDecision`, avec trois différences :
 *
 *   · aucune hiérarchie d'autorité dans le prompt (T3-06) : le score
 *     d'autorité de chaque preuve est CALCULÉ PAR LE CODE (`authority-matrix`,
 *     porté par `EvidenceCandidate.authorityScore`) et transmis en donnée,
 *     avec la date, l'origine et la marge d'équivalence du moteur ;
 *   · preuves transmises en ordre neutre (tri par identifiant) ;
 *   · protection U2 revérifiée par le serveur APRÈS le modèle : une valeur
 *     USER/ADMIN non vide n'est jamais remplacée automatiquement, quel que
 *     soit le choix du modèle (la matrice ne demande d'ailleurs d'arbitrage
 *     que sur un champ vide — défense en profondeur).
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { isExecutionCancelled } from '../../queue/execution-control';
import type { ReconciliationDecision, EvidenceCandidate } from '../types';
import { AUTHORITY_EQUIVALENCE_MARGIN } from '../decision/confidence';
import { AUTHORITY_MATRIX_VERSION } from '../decision/authority-matrix';
import {
  T3ValueConflictOutput, closedWorldValueConflict, type T3ValueConflictOutput as Out,
} from './t3-contract';

export interface ValueConflictMasterInput {
  accountId: number;
  assetId: number;
  decision: ReconciliationDecision;
  candidates: EvidenceCandidate[];
  currentValue: unknown;
  currentOrigin: string;
}

/** Valeur protégée (U2) : saisie humaine NON vide. */
export function isProtectedValue(currentValue: unknown, currentOrigin: string): boolean {
  const vide = currentValue === null || currentValue === undefined || String(currentValue).trim() === '';
  return !vide && (currentOrigin === 'USER' || currentOrigin === 'ADMIN');
}

/** Variables structurées du master (branche VALUE_CONFLICT) — pures, testables. */
export function valueConflictVariables(input: ValueConflictMasterInput): Record<string, unknown> {
  const evidences = [...input.candidates]
    .sort((a, b) => a.evidenceId - b.evidenceId)
    .map((c) => ({
      id: c.evidenceId,
      value: c.value,
      authorityScore: c.authorityScore,
      documentType: c.documentType,
      documentDate: c.documentDate ? c.documentDate.toISOString().slice(0, 10) : null,
      origin: c.evidenceOrigin ?? 'TEXT_EXTRACTION',
      confidence: c.confidence,
      ...(c.evidenceOrigin === 'VISUAL_ANALYSIS'
        ? { visualObservation: (c.visualDescription ?? '').slice(0, 300) }
        : { excerpt: c.excerpt.slice(0, 300) }),
    }));
  return {
    FIELD: input.decision.fieldKey,
    CURRENT_STATE: {
      value: input.currentValue ?? null,
      origin: input.currentOrigin,
      protected: isProtectedValue(input.currentValue, input.currentOrigin),
      // Règles serveur transmises en données (U3) : l'autorité est calculée
      // par le code, versionnée, jamais recréée par le modèle.
      authorityMatrixVersion: AUTHORITY_MATRIX_VERSION,
      authorityEquivalenceMargin: AUTHORITY_EQUIVALENCE_MARGIN,
    },
    EVIDENCES: evidences,
    SUBJECT_CONTEXT: null,
    CANDIDATES: null,
    RELATION_TYPE: null,
  };
}

const conflict = (d: ReconciliationDecision, extra: Partial<ReconciliationDecision> = {}): ReconciliationDecision => ({
  ...d, action: 'create_conflict', reasonCode: 'AMBIGUOUS_EVIDENCE', deterministic: false, ...extra,
});

/**
 * Traduction PURE de la sortie master vers la décision du moteur. Mêmes
 * règles que `resolve_ambiguity` (abstention ⇒ conflit ; `certain` seul
 * applique, rétrogradé en `probable`), plus la protection U2.
 */
export function translateValueConflict(
  input: ValueConflictMasterInput, raw: Out,
): { decision: ReconciliationDecision; warnings: string[] } {
  const { decision, candidates } = input;
  const { output, warnings } = closedWorldValueConflict(raw, new Set(candidates.map((c) => c.evidenceId)));
  const messages = warnings.map((w) => `${w.code}:${w.id}`);

  if (output.decision === 'abstain') return { decision: conflict(decision), warnings: messages };

  const chosen = candidates.find((c) => c.evidenceId === output.chosenEvidenceId)!;
  const proposition = {
    proposedValue: chosen.value, evidenceIds: [chosen.evidenceId], sourcePriority: chosen.authorityScore,
  };

  // U2 — protection serveur, indépendante du modèle.
  if (isProtectedValue(input.currentValue, input.currentOrigin)) {
    return {
      decision: conflict(decision, { ...proposition, confidence: output.confidence }),
      warnings: [...messages, 'PROTECTED_VALUE'],
    };
  }

  if (output.confidence !== 'certain') {
    return { decision: conflict(decision, { ...proposition, confidence: output.confidence }), warnings: messages };
  }

  return {
    decision: {
      ...decision,
      action: decision.currentValue === null ? 'apply' : 'update',
      ...proposition,
      reasonCode: 'AMBIGUOUS_EVIDENCE',
      // Un avis de modèle n'obtient jamais mieux que « probable » (§4.2.6).
      confidence: 'probable',
      deterministic: false,
    },
    warnings: messages,
  };
}

/** Lot 99A : issue détaillée d'un arbitrage (origine de la réponse, trace). */
export interface ValueConflictOutcome {
  decision: ReconciliationDecision;
  /** PROVIDER : appel réel ; CACHE : réponse servie sans appel ; FAILED : échec (conflit prudent). */
  aiSource: 'PROVIDER' | 'CACHE' | 'FAILED';
  traceId: string | null;
  /** Échec : code de la passerelle (null pour une erreur inconnue). */
  errorCode: string | null;
  /** Échec APRÈS contact du fournisseur (sortie invalide, refus, délai) : mémorisable. */
  providerContacted: boolean;
  /** Le modèle s'est abstenu (BUSINESS_ABSTENTION) : conflit laissé à l'utilisateur. */
  abstained?: boolean;
}

/** Codes d'échec survenus après contact du fournisseur (appel facturable) — lot 99A. */
const ECHECS_APRES_APPEL = new Set(['INVALID_OUTPUT', 'ALL_MODELS_FAILED', 'PROVIDER_REQUEST_REJECTED', 'TIMEOUT']);

/**
 * Arbitrage par le master, avec l'origine de la réponse (lot 99A). Ne lève
 * pas, sauf interruption d'exécution. `idempotencyKey` : clé du cache des
 * réponses alignée sur l'empreinte de la mémoire des décisions.
 */
export async function resolveValueConflictMasterDetailed(
  input: ValueConflictMasterInput, opts: { idempotencyKey?: string } = {},
): Promise<ValueConflictOutcome> {
  try {
    const res = await AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION',
      operationCode: 't3_value_conflict',
      accountId: input.accountId,
      promptVariables: valueConflictVariables(input),
      outputSchema: T3ValueConflictOutput,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    const { decision, warnings } = translateValueConflict(input, res.data);
    if (warnings.length > 0) {
      console.warn(`[t3_value_conflict] ${input.decision.fieldKey} : ${warnings.join(', ')} — arbitrage utilisateur`);
    }
    return {
      decision, aiSource: res.fromCache ? 'CACHE' : 'PROVIDER', traceId: res.traceId ?? null, errorCode: null,
      providerContacted: !res.fromCache, abstained: (res.data as { decision?: unknown } | null)?.decision === 'abstain',
    };
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    console.error('[t3_value_conflict] échec non bloquant :', (e as Error).message);
    const code = (e as { code?: unknown })?.code;
    const errorCode = typeof code === 'string' ? code : null;
    const traceId = (e as { traceId?: unknown })?.traceId;
    return {
      decision: { ...input.decision, action: 'create_conflict', reasonCode: 'AMBIGUOUS_EVIDENCE', deterministic: true },
      aiSource: 'FAILED', traceId: typeof traceId === 'string' ? traceId : null, errorCode,
      providerContacted: errorCode !== null && ECHECS_APRES_APPEL.has(errorCode),
    };
  }
}

/** Arbitrage par le master. Ne lève pas, sauf interruption d'exécution. */
export async function resolveValueConflictMaster(input: ValueConflictMasterInput): Promise<ReconciliationDecision> {
  return (await resolveValueConflictMasterDetailed(input)).decision;
}
