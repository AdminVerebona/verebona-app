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
  /** Fil de conversation (à renvoyer avec le message suivant). */
  conversationId?: number | null;
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
  /** Commande préparée : aperçu à confirmer (jamais de paramètres modifiables). */
  commandPlan?: import('../commands/catalog').CommandPlanPreview | null;
  /**
   * Erreur fonctionnelle (§27.11), présente quand `status === 'error'` :
   * code stable, libellé Verebona (jamais un message technique brut) et
   * possibilité de réessayer. Le client l'affiche dans le fil (§4.2).
   */
  error?: { code: VerebonaErrorCode; message: string; recoverable: boolean } | null;
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
  /** Intention d'une question rapide de la mascotte (CDC Mascotte, annexe B). */
  intent?: string;
  assetId?: string;
  documentId?: string;
  supplierId?: string;
}

/** Requête d'entrée normalisée côté serveur. */
export interface AssistantRequestInput {
  accountId: number;
  userId: number;
  /**
   * Offre EFFECTIVE pour l'assistant, dérivée des droits
   * (`assistantPlanFromEntitlements`) et jamais lue telle quelle dans le JWT :
   * l'essai 7 jours vaut Premium (§6.5).
   */
  planType: string;
  message: string;
  pageContext?: PageContext;
  clientRequestId: string;
  locale: string; // fr-FR
  /**
   * Conversation de l'utilisateur à laquelle la demande appartient, résolue
   * côté serveur. Sert à persister dans le bon fil et à rattacher les copies
   * (cache modèle) purgées à l'effacement.
   */
  conversationId?: number;
  /**
   * Reprise structurée après clarification (§20.5) : même demande, même
   * intention, avec le choix de l'utilisateur injecté comme paramètre — et
   * non recollé au texte.
   */
  /**
   * Référence conversationnelle résolue avant le routage (« le deuxième »,
   * « ce document »…), déjà re-vérifiée en base. Jamais fournie par le client.
   */
  reference?: { type: 'asset' | 'document' | 'agenda_item'; id: number; label?: string | null; method: string };
  /** Contexte borné du fil, pour le modèle s'il est appelé. */
  threadContextText?: string;
  /** Une revalidation ciblée a déjà eu lieu pour cette demande (pas de boucle). */
  revalidationDone?: boolean;
  /**
   * Budget d'appels modèle du message (§15.5, CA-07), créé par
   * `runAssistant` et partagé par référence entre classification,
   * revalidation et génération. Jamais fourni par le client.
   */
  aiBudget?: import('../core/ai-call-budget').AiCallBudget;
  /**
   * Message tel que posé, quand `message` ne porte plus que les sous-demandes
   * autorisées d'une requête mixte (historique fidèle).
   */
  originalMessage?: string;
  resume?: {
    clarificationId: string;
    intent: import('./intents').VerebonaIntent;
    assetId?: number | null;
    /** Document fixé par la clarification d'une référence (« ce document »). */
    documentId?: number | null;
    chainDepth: number;
    /** Libellé choisi, affiché dans l'historique à la place de la question rejouée. */
    choiceLabel: string;
  };
}

/** Résultat interne complet d'une demande (avant sérialisation API). */
/**
 * Trace de la cascade T2 (non-escalade) — quel niveau a répondu, et pourquoi
 * les niveaux précédents n'ont pas suffi. Persistée dans
 * `verebona_request_runs.retrieval_methods_json`.
 */
export interface CascadeTrace {
  /**
   * Mémoire du fil : contexte chargé et référence conversationnelle
   * (« le deuxième »…) — détectée, méthode, entité finale.
   */
  reference?: {
    contextMessages: number;
    presentedLists: number;
    detected: string | null;
    outcome: 'none' | 'resolved' | 'ambiguous' | 'unavailable';
    method: string | null;
    entity: { type: string; id: number } | null;
  };
  /** Analyse du périmètre : sous-demandes, classement, motif de blocage. */
  scope?: { kind: string; parts: Array<{ text: string; allowed: boolean; reason: string | null }> };
  /** Revalidations ciblées déclenchées par la demande (mode, résultat). */
  revalidations?: Array<{ factId: number; trigger: string; mode: string; status: string; reused: boolean; reinjectedFactId: number | null; aiCalls: number; model: string | null }>;
  intent: string;
  /** Stratégie ayant produit la réponse (`structured.next_deadline`, `llm.generate_answer`…). */
  strategy: string;
  answeredBy: 'template' | 'structured' | 'retrieval' | 'llm' | 'fallback';
  /** Décision de suffisance du niveau qui a répondu (ou du dernier évalué). */
  sufficiency: string | null;
  /** Motif de chaque escalade, dans l'ordre. Vide si aucune escalade. */
  escalationReasons: string[];
  attempts: Array<{ level: number; strategy: string; status: string; score: number; threshold: number; reason?: string }>;
  sourceCount: number;
  /** Appels modèle réellement effectués (classification + génération). */
  aiCalls: number;
  model: string | null;
  thresholds: { database: number; text: number; source: string };
  latencyMs: number;
}

export interface AssistantRunResult {
  /** Trace de la cascade de non-escalade (§ T2). */
  cascade?: CascadeTrace;
  /**
   * Motif d'un refus au titre des sujets réservés (§13).
   *
   * Sans ce champ, un refus est indiscernable d'une réponse vide dans les
   * journaux : on ne saurait pas si l'assistant a refusé de répondre ou s'il
   * n'a rien trouvé — deux situations qui appellent des suites opposées.
   */
  blockedReason?: 'legal' | 'tax' | 'medical' | 'insurance_advice' | null;
  /**
   * Requête mixte : refus ciblé de la partie interdite, ajouté à la réponse
   * de la partie autorisée.
   */
  partialRefusal?: string | null;
  /** Analyse du périmètre (sous-demandes, classement, motif). */
  scope?: { kind: string; parts: Array<{ text: string; allowed: boolean; reason: string | null }> };
  requestId: string;
  messageId: string;
  /** Fil dans lequel la demande a été enregistrée. */
  conversationId?: number;
  /**
   * Entité désignée par cette demande (référence résolue, choix de
   * clarification) : devient la « dernière entité sélectionnée » du fil.
   */
  contextUpdate?: { type: 'asset' | 'document' | 'agenda_item'; id: number; label?: string | null } | null;
  finalState: MachineState;
  mode: ResponseMode;
  route: IntentRoute;
  answer: string;
  supportLevel: SupportLevel | null;
  claims: Claim[];
  sources: ResolvedSource[];
  actions: VerebonaAction[];
  clarification: ClarificationState | null;
  /** Commande métier préparée, en attente de confirmation explicite. */
  commandPlan?: import('../commands/catalog').CommandPlanPreview | null;
  error?: { code: import('./contracts').VerebonaErrorCode; message: string; recoverable: boolean };
}
