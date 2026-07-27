/**
 * Contrats internes et de sortie — CDC §9.5, §18, §27.
 */
import type { VerebonaIntent } from './intents';
import type { VerebonaActionType, VerebonaAction, ActionIntent } from './actions';
import type { Claim, SupportLevel, ResolvedSource } from './sources';
import type { ClarificationState, MachineState } from './machine';

export const RESPONSE_SCHEMA_VERSION = 'assistant-response-v1.0' as const;

export type Confidence = 'exact' | 'probable' | 'ambiguous';
export type ResponseMode = 'deterministic' | 'classic_search' | 'ai' | 'fallback';

/** Contrat de sortie du routeur — CDC §9.5. `confidence` reste interne. */
export interface IntentRoute {
  intent: VerebonaIntent;
  confidence: Confidence;
  accountScope: string;
  entityHints: Array<{
    type: 'asset' | 'document' | 'agenda' | 'supplier' | 'help';
    value: string;
  }>;
  requiresRetrieval: boolean;
  aiEligible: boolean;
  clarificationRequired: boolean;
  allowedActionTypes: VerebonaActionType[];
  routeReason: string;
}

/**
 * Sortie STRUCTURÉE attendue de Gemini (validée par Zod puis serveur) — CDC §18.2.
 * Le serveur ne consomme jamais de texte libre comme réponse finale (§18.1).
 */
export interface AssistantModelOutput {
  schemaVersion: typeof RESPONSE_SCHEMA_VERSION;
  intent: VerebonaIntent;
  answer: string;
  supportLevel: SupportLevel;
  claims: Claim[];
  actionIntents: ActionIntent[];
  clarification: {
    question: string;
    candidateType: 'asset' | 'document' | 'agenda' | 'supplier';
    candidateIds: string[];
  } | null;
}

/** Réponse finale renvoyée par l'API — CDC §27.1 / §27.2. */
export interface AssistantApiResponse {
  requestId: string;
  messageId: string;
  status: 'ready' | 'error';
  intent: VerebonaIntent;
  mode: ResponseMode;
  answer: string;
  sourcesAvailable: boolean;
  sourceCount?: number;
  actions: VerebonaAction[];
  clarification: {
    clarificationId: string;
    question: string;
    expiresAt: string;
    choices: Array<{ choiceId: string; label: string; secondaryLabel?: string }>;
  } | null;
}

/** Codes fonctionnels stables — CDC §27.11. */
export const VEREBONA_ERROR_CODES = [
  'PLAN_NOT_ELIGIBLE',
  'RATE_LIMITED',
  'NO_RELEVANT_SOURCE',
  'CLARIFICATION_REQUIRED',
  'CLARIFICATION_EXPIRED',
  'ASSISTANT_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'REQUEST_CANCELLED',
  'INVALID_ACTION',
  'SOURCE_UNAVAILABLE',
  'CONVERSATION_EXPIRED',
  'VALIDATION_FAILED',
  'UNSAFE_REQUEST',
] as const;

export type VerebonaErrorCode = (typeof VEREBONA_ERROR_CODES)[number];

export interface AssistantApiError {
  requestId: string;
  status: 'error';
  error: { code: VerebonaErrorCode; message: string; recoverable: boolean };
}

/** Contexte de page transmis par le front — CDC §27.1. */
export interface PageContext {
  route?: string;
  assetId?: string;
  documentId?: string;
  supplierId?: string;
}

/** Requête d'entrée normalisée côté serveur. */
export interface AssistantRequestInput {
  accountId: number;
  userId: number;
  planType: string;
  message: string;
  pageContext?: PageContext;
  clientRequestId: string;
  locale: string; // fr-FR
}

/** Résultat interne complet d'une demande (avant sérialisation API). */
export interface AssistantRunResult {
  requestId: string;
  messageId: string;
  finalState: MachineState;
  mode: ResponseMode;
  route: IntentRoute;
  answer: string;
  supportLevel: SupportLevel | null;
  claims: Claim[];
  sources: ResolvedSource[];
  actions: VerebonaAction[];
  clarification: ClarificationState | null;
  error?: { code: import('./contracts').VerebonaErrorCode; message: string; recoverable: boolean };
}
