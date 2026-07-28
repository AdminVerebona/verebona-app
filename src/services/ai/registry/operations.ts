/**
 * Catalogue des opérations techniques — CDC §5.1.
 *
 * Une opération est une ÉTAPE INTERNE rattachée à un usage. Elle ne doit jamais
 * apparaître comme un cas d'usage réglementaire (CDC §5.1, dernière phrase).
 *
 * Source de vérité : ce fichier (versionné en Git). La table `ai_operations` en
 * est une projection synchronisée au démarrage, destinée à l'administration et
 * aux jointures SQL avec les tables de suivi.
 */
import type { AiUseCaseCode } from './use-cases';

export interface AiOperationDefinition {
  operationCode: string;
  useCaseCode: AiUseCaseCode;
  label: string;
  provider: string;
  primaryModel: string;
  /** Ordre de repli appliqué par la gateway (CDC §5.2). */
  fallbackModels: string[];
  /** Code du prompt versionné en base (`ai_prompt_versions.prompt_code`). */
  promptCode?: string;
  timeoutMs: number;
  /** Nom du schéma Zod attendu — contrôlé par `output-validator` (CDC §5.3). */
  outputSchema: string;
  /**
   * Le prompt est fourni à l'appel, pas déclaré ici.
   *
   * Un seul cas légitime : l'évaluation d'une version candidate de prompt
   * (usage 5). L'opération n'a pas de prompt propre — elle exécute celui qui
   * est en cours de validation. Toute autre opération DOIT déclarer un
   * `promptCode`, faute de quoi son comportement échapperait à la gouvernance.
   */
  dynamicPrompt?: boolean;
  /** Une opération inactive ne peut pas être exécutée par la gateway. */
  active: boolean;
  /** false ⇒ n'incrémente pas les compteurs de quota client. */
  billable: boolean;
}

const GEMINI = 'gemini';

/**
 * ⚠️ CDC Assistant V3.1 §15.10 — SÉPARATION DES FAMILLES DE TRAITEMENT
 *
 * « Les modèles utilisés par l'assistant ne doivent pas modifier automatiquement
 *   les modèles utilisés pour l'extraction documentaire, l'enrichissement, la
 *   cohérence, l'analyse d'images ou de vidéos. Chaque famille de traitement
 *   possède sa propre configuration. »
 *
 * Une constante unique partagée par les cinq usages violerait cette règle : un
 * changement de modèle sur l'assistant se propagerait à l'analyse documentaire.
 * D'où trois familles distinctes ci-dessous.
 *
 * §15.13 — aucun alias fournisseur de type `latest`, aucun modèle `preview` en
 * production sans feature flag et validation du jeu d'évaluation.
 */

/** Famille 1 — analyse documentaire, réconciliation, agenda (multimodal, volume). */
const DOC_PRIMARY = 'gemini-3.1-flash-lite';
const DOC_FALLBACKS = ['gemini-3.5-flash', 'gemini-2.5-pro'];

/**
 * Famille 2 — assistant. CDC Assistant §15.11 : alias `assistant-default` et
 * `assistant-escalation`. §31.2 : « aucune utilisation d'un modèle Pro ».
 */
const ASSISTANT_PRIMARY = 'gemini-2.5-flash-lite';   // alias assistant-default
const ASSISTANT_FALLBACKS = ['gemini-3.1-flash-lite']; // alias assistant-escalation

/** Famille 3 — gouvernance : raisonnement sur des prompts, hors chemin utilisateur. */
const GOV_PRIMARY = 'gemini-2.5-pro';
const GOV_FALLBACKS = ['gemini-3.1-flash-lite'];

export const AI_OPERATIONS: Record<string, AiOperationDefinition> = {
  // ── Usage 1 — Analyse unifiée des sources (CDC §4.1.4) ────────────────────
  group_sources: {
    operationCode: 'group_sources', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'Regroupement de fichiers en un même document',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'group_sources_v2', timeoutMs: 45_000,
    outputSchema: 'GroupSourcesOutput', active: true, billable: false,
  },
  extract_source: {
    operationCode: 'extract_source', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'Extraction structurée du contenu avec preuves',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'extract_source_v2', timeoutMs: 90_000,
    outputSchema: 'ExtractSourceOutput', active: true, billable: true,
  },
  classify_document: {
    operationCode: 'classify_document', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'Classification documentaire',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'classify_document_v2', timeoutMs: 30_000,
    outputSchema: 'ClassifyDocumentOutput', active: true, billable: false,
  },
  identify_entities: {
    operationCode: 'identify_entities', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'Identification des entités (biens, pièces, équipements, fournisseurs)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'identify_entities_v2', timeoutMs: 45_000,
    outputSchema: 'IdentifyEntitiesOutput', active: true, billable: false,
  },
  propose_links: {
    operationCode: 'propose_links', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'Proposition de rattachements',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'propose_links_v2', timeoutMs: 45_000,
    outputSchema: 'ProposeLinksOutput', active: true, billable: false,
  },

  // ── Usage 2 — Réconciliation (CDC §4.2.8, étape 7 uniquement) ─────────────
  collect_evidence: {
    operationCode: 'collect_evidence', useCaseCode: 'DATA_RECONCILIATION',
    label: 'Collecte des preuves par champ (déterministe)',
    provider: 'none', primaryModel: 'none', fallbackModels: [],
    timeoutMs: 10_000, outputSchema: 'none', active: true, billable: false,
  },
  compare_values: {
    operationCode: 'compare_values', useCaseCode: 'DATA_RECONCILIATION',
    label: 'Comparaison déterministe valeur / preuve',
    provider: 'none', primaryModel: 'none', fallbackModels: [],
    timeoutMs: 10_000, outputSchema: 'none', active: true, billable: false,
  },
  resolve_ambiguity: {
    operationCode: 'resolve_ambiguity', useCaseCode: 'DATA_RECONCILIATION',
    label: 'Arbitrage IA ciblé sur un cas resté ambigu',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'resolve_ambiguity_v1', timeoutMs: 30_000,
    outputSchema: 'ResolveAmbiguityOutput', active: true, billable: true,
  },
  reconcile_links: {
    operationCode: 'reconcile_links', useCaseCode: 'DATA_RECONCILIATION',
    label: 'Réconciliation des liaisons équipements',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'reconcile_links_v1', timeoutMs: 30_000,
    outputSchema: 'ReconcileLinksOutput', active: true, billable: false,
  },

  // ── Usage 3 — Assistant (CDC §4.3.4) ──────────────────────────────────────
  understand_request: {
    operationCode: 'understand_request', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: "Compréhension de la question et sélection des outils",
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'understand_request_v1', timeoutMs: 12_000,
    outputSchema: 'ToolPlanOutput', active: true, billable: false,
  },
  retrieve_data: {
    operationCode: 'retrieve_data', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: 'Exécution des outils de lecture bornés au compte',
    provider: 'none', primaryModel: 'none', fallbackModels: [],
    timeoutMs: 8_000, outputSchema: 'none', active: true, billable: false,
  },
  retrieve_evidence: {
    operationCode: 'retrieve_evidence', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: 'Récupération des preuves documentaires citées',
    provider: 'none', primaryModel: 'none', fallbackModels: [],
    timeoutMs: 8_000, outputSchema: 'none', active: true, billable: false,
  },
  generate_answer: {
    operationCode: 'generate_answer', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: 'Génération de la réponse sourcée',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'generate_answer_v1', timeoutMs: 12_000,
    outputSchema: 'AssistantAnswerOutput', active: true, billable: true,
  },

  // ── Usage 4 — Agenda (CDC §4.4.3) ─────────────────────────────────────────
  detect_dates: {
    operationCode: 'detect_dates', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: 'Interprétation déterministe des dates extraites',
    provider: 'none', primaryModel: 'none', fallbackModels: [],
    timeoutMs: 5_000, outputSchema: 'none', active: true, billable: false,
  },
  classify_event: {
    operationCode: 'classify_event', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: 'Classification action / information (cas ambigus uniquement)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'classify_event_v2', timeoutMs: 15_000,
    outputSchema: 'ClassifyEventOutput', active: true, billable: false,
  },
  deduplicate_event: {
    operationCode: 'deduplicate_event', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: 'Détection de doublon (déterministe)',
    provider: 'none', primaryModel: 'none', fallbackModels: [],
    timeoutMs: 5_000, outputSchema: 'none', active: true, billable: false,
  },
  reconcile_status: {
    operationCode: 'reconcile_status', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: "Mise à jour du statut d'un événement sous preuve explicite",
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'reconcile_status_v1', timeoutMs: 15_000,
    outputSchema: 'ReconcileStatusOutput', active: true, billable: false,
  },

  // ── Usage 5 — Gouvernance (CDC §4.5.3) ────────────────────────────────────
  analyze_instruction: {
    operationCode: 'analyze_instruction', useCaseCode: 'AI_GOVERNANCE',
    label: "Analyse d'impact d'une instruction administrateur",
    provider: GEMINI, primaryModel: GOV_PRIMARY, fallbackModels: GOV_FALLBACKS,
    promptCode: 'analyze_instruction_v1', timeoutMs: 60_000,
    outputSchema: 'InstructionAnalysisOutput', active: true, billable: false,
  },
  propose_change: {
    operationCode: 'propose_change', useCaseCode: 'AI_GOVERNANCE',
    label: 'Proposition de modification de prompt (jamais appliquée directement)',
    provider: GEMINI, primaryModel: GOV_PRIMARY, fallbackModels: GOV_FALLBACKS,
    promptCode: 'propose_change_v1', timeoutMs: 60_000,
    outputSchema: 'PromptChangeProposalOutput', active: true, billable: false,
  },
  evaluate_prompt: {
    operationCode: 'evaluate_prompt', useCaseCode: 'AI_GOVERNANCE',
    label: 'Exécution du corpus de test sur une version candidate',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    // Pas de promptCode : c'est le prompt candidat qui est évalué, transmis
    // par le test-runner via `promptOverride`.
    dynamicPrompt: true,
    timeoutMs: 90_000, outputSchema: 'PromptEvaluationOutput', active: true, billable: false,
  },
};

export type AiOperationCode = keyof typeof AI_OPERATIONS;

export function getOperation(code: string): AiOperationDefinition {
  const op = AI_OPERATIONS[code];
  if (!op) {
    throw new Error(
      `[ai-registry] Opération inconnue « ${code} ». Toute opération doit être déclarée dans operations.ts (CDC §12, critère 5).`,
    );
  }
  return op;
}

/** Opérations effectuant réellement un appel modèle (les autres sont déterministes). */
export function listLlmOperations(): AiOperationDefinition[] {
  return Object.values(AI_OPERATIONS).filter((o) => o.provider !== 'none' && o.active);
}

export function listOperationsByUseCase(useCaseCode: AiUseCaseCode): AiOperationDefinition[] {
  return Object.values(AI_OPERATIONS).filter((o) => o.useCaseCode === useCaseCode);
}
