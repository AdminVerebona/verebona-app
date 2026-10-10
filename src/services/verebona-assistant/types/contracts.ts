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
    /**
     * `period` : période désignée (« l'an dernier ») — CDC 15 T2-08.
     * `equipment` / `room` : CONSERVÉS tels que compris (lot 29, ticket 13) —
     * jamais rabattus sur `asset`.
     */
    type: 'asset' | 'document' | 'agenda' | 'supplier' | 'help' | 'period' | 'equipment' | 'room';
    value: string;
  }>;
  requiresRetrieval: boolean;
  aiEligible: boolean;
  clarificationRequired: boolean;
  allowedActionTypes: VerebonaActionType[];
  routeReason: string;
  /**
   * Compréhension structurée du master T2 (CDC 15 §24, A4–A5), présente
   * seulement quand la route vient de `t2_understand` : clés canoniques
   * demandées (FIELD_CATALOG, déjà restreintes par le serveur) et filtres
   * explicites. Des INDICES : la cible et les filtres restent résolus et
   * bornés au compte côté serveur (`assistant-targets`, `retrieval`).
   */
  understanding?: RouteUnderstanding;
}

/** Filtres et faits demandés, lus par le master T2 (UNDERSTAND). */
export interface RouteUnderstanding {
  requestedFacts: string[];
  /** Sujets demandés hors FIELD_CATALOG (UNDERSTAND) — indices, jamais des clés. */
  requestedTopics?: string[];
  filters: {
    documentType?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    unlinked?: boolean | null;
    status?: string | null;
    supplier?: string | null;
    upcoming?: boolean | null;
  };
}

/**
 * Événement de chronologie transmis au client (CDC 15 T2-35) : date, libellé
 * et lien vers l'objet d'origine (résolu côté serveur, jamais fourni par le
 * modèle). `date` null : date inconnue.
 */
export interface AssistantTimelineEvent {
  date: string | null;
  text: string;
  /** Objet d'origine (« agenda_12 », « doc_4 »…), ou null. */
  ref: string | null;
  href: string | null;
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
   * Cartes de résultats groupées par type (§11.3, §22.2, §22.3). Absent
   * quand la réponse n'est pas une liste de résultats.
   */
  resultGroups?: import('../core/result-groups').ResultGroup[];
  /**
   * Chronologie structurée (CDC 15 T2-35) : liste « date · libellé » avec
   * lien vers l'objet. Absente hors chronologie ; `answer` en porte la forme
   * texte (une ligne par événement).
   */
  events?: Array<Pick<AssistantTimelineEvent, 'date' | 'text' | 'href'>>;
  /**
   * Erreur fonctionnelle (§27.11), présente quand `status === 'error'` :
   * code stable, libellé Verebona (jamais un message technique brut) et
   * possibilité de réessayer. Le client l'affiche dans le fil (§4.2).
   */
  error?: { code: VerebonaErrorCode; message: string; recoverable: boolean } | null;
  /** §27.11 : codes informatifs non bloquants (voir `AssistantRunResult.notices`). */
  notices?: AssistantNotice[];
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
  /** Plateforme d'affichage (choix des articles d'aide — T2-05). */
  platform?: 'web' | 'mobile';
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
  /**
   * Identifiant serveur de la demande, réservé par la route AVANT le
   * traitement (ligne `verebona_request_runs` en `pending`) : il rend la
   * demande annulable pendant qu'elle s'exécute (§7.8, §27.5) et rattache
   * chaque appel modèle à sa demande (§28.8). Absent : généré par
   * `runAssistant`.
   */
  requestId?: string;
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
  reference?: { type: 'asset' | 'document' | 'agenda_item' | 'equipment' | 'room'; id: number; label?: string | null; method: string };
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
   * Rapport des appels modèle du message, partagé par référence comme le
   * budget : événements de sécurité (§18.7, 37.12), réparation / escalade
   * (§15.4, §18.6), troncature du contexte (§13.9). Jamais fourni par le
   * client ; versé dans la trace de la demande.
   */
  aiReport?: { securityEvents: import('../core/output-safety').SecurityEvent[]; events: string[] };
  /**
   * Fin d'essai ou abonnement absent (§6.5) : l'assistant reste disponible
   * pour la recherche et l'aide, SANS appel intelligent, et explique la
   * limite avec l'action « Voir les offres ».
   */
  planLimit?: 'TRIAL_EXPIRED' | 'SUBSCRIPTION_REQUIRED' | null;
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
    /**
     * Équipement ou pièce choisi (lot 29, ticket 13 §G) : type, identifiant
     * et bien parent conservés pour la reprise.
     */
    entity?: { type: 'equipment' | 'room'; id: number; assetId: number | null } | null;
    /**
     * Champs demandés par la demande initiale (lot 29, ticket 12 AC10) : la
     * reprise lit TOUS les champs, sans re-comprendre la question.
     */
    requestedFacts?: string[];
  };
}

/** Résultat interne complet d'une demande (avant sérialisation API). */
/**
 * Trace d'une demande d'actions (lot 34, ticket T2 « Que dois-je faire
 * aujourd'hui ? »). Codes, dates et identifiants seulement — aucun contenu.
 */
export interface ActionableTrace {
  intent: string;
  /** Famille résolue : ACTIONS_TEMPORAL, ACTIONS_OVERDUE, ACTIONS_URGENT, TO_PROCESS_OPEN, DEADLINES_PERIOD. */
  intentResolution: string;
  /** SUCCESS (y compris 0 résultat) | INSUFFICIENT (bien désigné introuvable, lecture impossible). */
  resolution: 'SUCCESS' | 'INSUFFICIENT';
  requestedTimeScope: string;
  appliedTimeScope: string;
  resolvedStartDate: string | null;
  resolvedEndDate: string | null;
  allowedSourceTypes: string[];
  queriedSources: string[];
  /** Toujours une lecture canonique SQL : jamais plein texte, sémantique ni recherche globale. */
  queryStrategy: 'SQL_CANONICAL';
  assetScope: number[] | null;
  todoCount: number;
  deadlineCount: number;
  actionCount: number;
  overdueCount: number;
  todayCount: number;
  resultCount: number;
  fallbackUsed: false;
  fallbackReason: string | null;
  answeredBy: 'structured';
  results: Array<{
    sourceType: string;
    sourceId: string;
    reasonForInclusion: string;
    status: string;
    dueDate: string | null;
    relatedAssetId: number | null;
    /** Formes du même besoin fusionnées (relations canoniques). */
    mergedSourceIds: string[];
    /** Documents de contexte (jamais des résultats). */
    contextDocumentIds: number[];
  }>;
}

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
  /** Événements de sécurité sur la sortie modèle (§18.7, CA-09, 37.12). */
  securityEvents?: Array<{ code: string; target?: string; detail?: string }>;
  /** Réparation, escalade, troncature de contexte, rejet de génération. */
  aiEvents?: string[];
  /** §28.7 : le retrieval de la demande a été servi par le cache (§43). */
  cacheHit?: boolean;
  /** §27.11 : codes fonctionnels informatifs émis avec la réponse. */
  notices?: VerebonaErrorCode[];
  /**
   * Lot 29 (ticket 8b §K, AC17) : motif DIAGNOSTIQUÉ d'une réponse sans
   * valeur — cible introuvable, ambiguë, indisponible, champ non renseigné,
   * recherche vide, compréhension impossible, erreur de lecture. Distincts :
   * jamais confondus dans un « rien trouvé » unique (`core/t2-diagnostics`).
   */
  diagnostic?: import('../core/t2-diagnostics').T2Diagnostic;
  /**
   * Lot 32 : état EXPLICITE de la compréhension (`core/understanding-status`).
   * `initialStatus` / `reasons` : évaluation du déterministe ; `status` : état
   * final ; `resolvedBy` : qui a complété la compréhension (déterministe, fil,
   * UNDERSTAND, clarification posée) — `null` si elle reste incomplète.
   */
  /**
   * Lot 33 : cascade du Centre d'aide (questions d'utilisation) — requêtes
   * (initiale, élargies, issues d'UNDERSTAND), niveaux exécutés avec leurs
   * candidats, scores et seuils, sources retenues avec l'étape qui les a
   * trouvées, motif du repli (`core/help-cascade`).
   */
  help?: import('../core/help-cascade').HelpCascadeTrace;
  /** Lot 33 : requête de recherche initiale (texte masqué des données sensibles). */
  retrievalQueryInitial?: string;
  /** Lot 33 : requêtes élargies et reformulées réellement exécutées. */
  retrievalQueriesExpanded?: string[];
  /**
   * Lot 33 : motif d'un repli ou d'une escalade non exécutée —
   * AI_NOT_ALLOWED, AI_UNAVAILABLE, AI_BUDGET_BLOCKED, AI_TIMEOUT,
   * UNDERSTAND_NO_QUERY, NO_SOURCE_FOR_SYNTHESIS… Lot 34G, aide :
   * HELP_CORPUS_UNAVAILABLE / _TIMEOUT / _HTTP_ERROR / _INVALID /
   * _WRONG_ENVIRONMENT, NO_RELEVANT_HELP_ARTICLE, HELP_SCORE_INSUFFICIENT,
   * HELP_CONTRADICTION (`core/help-cascade`, `HelpFallbackReason`).
   */
  fallbackReason?: string | null;
  /**
   * Lot 34 : repli générique utilisé (liste d'éléments approchants) — faux
   * pour toute réponse servie par la résolution de l'intention, y compris
   * « aucun résultat ».
   */
  fallbackUsed?: boolean;
  /**
   * Lot 34 : résolution d'une demande d'ACTIONS (À traiter, échéances,
   * retards, période) — lisible d'un coup d'œil dans la trace : intention,
   * période, sources interrogées, compteurs, raison d'inclusion de chaque
   * résultat.
   */
  actionable?: ActionableTrace;
  understanding?: {
    initialStatus: import('../core/understanding-status').UnderstandingStatus;
    status: import('../core/understanding-status').UnderstandingStatus;
    reasons: import('../core/understanding-status').UnderstandingReason[];
    resolvedBy: import('../core/understanding-status').UnderstandingResolver;
  };
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
  contextUpdate?: { type: 'asset' | 'document' | 'agenda_item' | 'equipment' | 'room'; id: number; label?: string | null } | null;
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
  /** Cartes de résultats groupées (§11.3, §22.3). */
  resultGroups?: import('../core/result-groups').ResultGroup[];
  /** Chronologie structurée (CDC 15 T2-35), une entrée par événement. */
  events?: AssistantTimelineEvent[];
  error?: { code: import('./contracts').VerebonaErrorCode; message: string; recoverable: boolean };
  /**
   * §27.11 — codes fonctionnels INFORMATIFS, non bloquants : la réponse est
   * rendue (`status: 'ready'`), mais une condition du §27.11 s'est produite
   * (limite d'offre, aucune source pertinente, action refusée, source
   * devenue indisponible, sortie modèle rejetée, demande refusée).
   */
  notices?: AssistantNotice[];
}

/** Code informatif du §27.11 joint à une réponse rendue. */
export interface AssistantNotice {
  code: VerebonaErrorCode;
  message: string;
}
