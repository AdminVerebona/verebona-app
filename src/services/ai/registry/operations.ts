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
import { EXTRACT_SOURCE_PROMPT_VERSION } from '../source-analysis/prompt-version';

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
  /**
   * Plancher de tokens de sortie, appliqué par la gateway au-dessus du plafond
   * de la configuration versionnée.
   *
   * Pour une opération dont la sortie est intrinsèquement longue — réécrire des
   * prompts complets —, un plafond réglé pour des réponses courtes tronque le
   * JSON : la sortie devient invalide et l'appel échoue sur tous les modèles.
   */
  minOutputTokens?: number;
  /**
   * Format de la sortie validée (cf. `output-validator`). `json` par défaut ;
   * `text` : la réponse brute est validée par le schéma de l'appelant.
   */
  outputFormat?: 'json' | 'text';
  /** Mode JSON natif du fournisseur (`responseMimeType: application/json`). */
  jsonResponse?: boolean;
  /**
   * Prompt HISTORIQUE, composé par l'appelant à partir de son gabarit du dépôt
   * (`src/services/document-ai/prompts/…`) et transmis dans la variable
   * `LEGACY_PROMPT` d'un prompt technique de simple relais.
   *
   * Plan de retrait WF-41 : ces modules passent par la passerelle (trace,
   * coût, garde d'exploitation, disjoncteur, clé du BO, modèles de la version
   * figée) SANS changer leur prompt ni leur contrat de sortie. Le préambule
   * administrable du traitement n'y est donc PAS ajouté : il est rédigé pour
   * le prompt technique de l'usage (sortie et schéma propres), et le préfixer
   * à un prompt au contrat différent reproduirait le désaccord prompt/schéma
   * de la panne du 18/09/2026.
   */
  legacyPrompt?: boolean;
  /**
   * Variables transmises SANS masquage (`redaction.ts`).
   *
   * ⚠️ ÉCART ASSUMÉ AU §5.6 (minimisation), limité aux prompts historiques
   * relayés (`legacyPrompt`) — décision de la revue de migration WF-41.
   * Le masquage porte sur des suites de 13 à 19 chiffres, IBAN et NIR : sur
   * le texte d'un document (DOCX lu, texte extrait), il effaçait les SIRET,
   * numéros de contrat, numéros de série et IBAN fournisseurs que ces modules
   * ont précisément pour rôle d'extraire — alors que le même document en PDF,
   * transmis en pièce jointe, n'est jamais masqué. Avant la migration, ces
   * modules envoyaient le texte intégral : ce comportement est conservé.
   * Le contrôle de démarrage refuse cette exemption hors `legacyPrompt`.
   */
  unredactedVariables?: readonly string[];
  /** Une opération inactive ne peut pas être exécutée par la gateway. */
  active: boolean;
  /** false ⇒ n'incrémente pas les compteurs de quota client. */
  billable: boolean;
}

const GEMINI = 'gemini';

/**
 * Variable de relais des prompts historiques (`legacy_*_v1.txt`), exemptée de
 * masquage — voir `unredactedVariables`. Même nom que
 * `gateway/legacy-prompt#LEGACY_PROMPT_VARIABLE`.
 */
const LEGACY_RELAY_VARIABLES = ['LEGACY_PROMPT'] as const;

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
/**
 * ⚠️ MODÈLE CHANGÉ APRÈS CONSTAT EN PRÉPRODUCTION — 18/09/2026.
 *
 * `gemini-2.5-flash-lite`, valeur retenue par le CDC Assistant du 16/07/2026,
 * renvoie désormais :
 *
 *   404 — This model models/gemini-2.5-flash-lite is no longer available to
 *   new users. Please update your code to use models/gemini-3.5-flash-lite.
 *
 * Le CDC ne fige pas ce nom : il demande « le modèle stable le moins coûteux
 * compatible avec le besoin », et note la valeur du jour en bas de page. La
 * remplacer est donc conforme, et ne pas la remplacer rendrait l'assistant
 * inutilisable pour tout compte récent.
 *
 * `gemini-3.5-flash-lite` figure au catalogue public tarifaire : le contrôle de
 * démarrage passera après un `/api/cron/ai/refresh-model-pricing`.
 *
 * L'escalade reste `gemini-3.1-flash-lite`, qui répond toujours — et aucun
 * modèle Pro n'entre ici, conformément au §31.2.
 */
const ASSISTANT_PRIMARY = 'gemini-3.5-flash-lite';   // alias assistant-default
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
    promptCode: EXTRACT_SOURCE_PROMPT_VERSION, timeoutMs: 90_000,
    outputSchema: 'ExtractSourceOutput', active: true, billable: true,
  },
  classify_document: {
    operationCode: 'classify_document', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'Classification documentaire',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'classify_document_v2', timeoutMs: 30_000,
    outputSchema: 'ClassifyDocumentOutput', active: true, billable: false,
  },
  classify_category: {
    operationCode: 'classify_category', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'Classement par catégorie documentaire',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'classify_category_v1', timeoutMs: 20_000,
    // Non facturée : le §4.3 tranche déterministiquement la majorité des cas,
    // et cet appel ne porte que sur les types réellement ambigus.
    outputSchema: 'ClassifyCategoryOutput', active: true, billable: false,
  },
  classify_rubric: {
    operationCode: 'classify_rubric', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'Classement par Rubrique documentaire (CDC V2)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'classify_rubric_v1', timeoutMs: 20_000,
    // Non facturée, et sollicitée bien plus rarement que `classify_category` :
    // le §2.2 rend la Rubrique déductible dès qu'un Type V2 est déterminé, ce
    // qui écarte l'appel modèle pour la majorité des documents.
    outputSchema: 'ClassifyRubricOutput', active: true, billable: false,
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
  // Revalidation ciblée d'un fait (T2) : relit le contenu persisté ou la
  // page utile de la source pour UNE question — jamais une analyse T1
  // complète. Coût imputé à l'assistant, qui l'a déclenchée.
  revalidate_fact: {
    operationCode: 'revalidate_fact', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: 'Revalidation ciblée d’un fait documentaire',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'revalidate_fact_v1', timeoutMs: 20_000,
    outputSchema: 'RevalidationOutput', active: true, billable: true,
  },
  generate_answer: {
    operationCode: 'generate_answer', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: 'Génération de la réponse sourcée',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'generate_answer_v3', timeoutMs: 12_000,
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
  // Prompt Control (T5) — CDC BO IA SCR-06 : une demande en langage naturel,
  // T5 choisit lui-même le ou les prompts T1–T4 à faire évoluer. Prompt propre
  // (`prompt_control_v2`), distinct d'`analyze_instruction` qui sert encore la
  // route historique `prompt-changes` avec un autre format de sortie.
  control_prompts: {
    operationCode: 'control_prompts', useCaseCode: 'AI_GOVERNANCE',
    label: 'Prompt Control — diagnostic et réécriture des prompts administrables',
    provider: GEMINI, primaryModel: GOV_PRIMARY, fallbackModels: GOV_FALLBACKS,
    promptCode: 'prompt_control_v2', timeoutMs: 120_000, minOutputTokens: 32_768,
    outputSchema: 'PromptControlOutput', active: true, billable: false,
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

  // ── Usage 6 — Mascotte d'accueil (T6) ─────────────────────────────────────
  // Synchrone, hors file (BO-003). Délai court : l'accueil ne réessaie pas et
  // bascule sur le texte déterministe (RUN-002) — un modèle lent vaut un échec.
  formulate_mascot: {
    operationCode: 'formulate_mascot', useCaseCode: 'HOME_MASCOT',
    label: "Formulation du discours de la mascotte d'accueil",
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'mascot_t6_v1', timeoutMs: 8_000,
    outputSchema: 'MascotT6Output', active: true, billable: false,
  },

  // ══════════════════════════════════════════════════════════════════════════
  // MODULES HISTORIQUES MIGRÉS SUR LA PASSERELLE — plan de retrait WF-41 (E-05)
  //
  // Anciennement hors passerelle (`legacy-gemini-access`, supprimé) : chacun
  // appelait le SDK avec ses propres modèles. Ils passent désormais par
  // `AiGateway.execute` — trace d'exécution, coût et jetons, arrêt d'urgence et
  // état du traitement, disjoncteur, clé du BO — avec les modèles de la version
  // de configuration de LEUR traitement (T1 à T4).
  //
  // Prompt et contrat de sortie inchangés (`legacyPrompt`, `outputFormat:
  // 'text'`) : le prompt est composé par le module à partir de son gabarit, la
  // réponse brute lui est rendue et il l'analyse comme avant.
  //
  // Déclarées APRÈS les opérations nominales de chaque usage : le disjoncteur
  // sonde les modèles de la PREMIÈRE opération active d'un usage.
  // ══════════════════════════════════════════════════════════════════════════

  // T1 — analyse documentaire historique (`gemini-client`, passes
  // `extract_full` et `detect_groups`). Pas de délai dans l'ancien client :
  // 5 min, la durée maximale d'attente d'une vidéo côté fournisseur.
  legacy_document_analysis: {
    operationCode: 'legacy_document_analysis', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'Analyse documentaire historique (passe unique, regroupement)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'legacy_document_analysis_v1', timeoutMs: 300_000,
    outputSchema: 'LegacyRawText', outputFormat: 'text', jsonResponse: true, legacyPrompt: true, unredactedVariables: LEGACY_RELAY_VARIABLES,
    active: true, billable: true,
  },

  // T3 — complétion des champs d'un bien et cohérence (usages historiques 3 à 5).
  legacy_asset_suggest: {
    operationCode: 'legacy_asset_suggest', useCaseCode: 'DATA_RECONCILIATION',
    label: "Suggestions IA à la demande pour l'onglet Informations d'un bien",
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'legacy_asset_suggest_v1', timeoutMs: 120_000,
    outputSchema: 'LegacyRawText', outputFormat: 'text', legacyPrompt: true, unredactedVariables: LEGACY_RELAY_VARIABLES,
    active: true, billable: false,
  },
  legacy_apply_suggestions: {
    operationCode: 'legacy_apply_suggestions', useCaseCode: 'DATA_RECONCILIATION',
    label: "Complétion silencieuse des champs vides d'un bien",
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'legacy_apply_suggestions_v1', timeoutMs: 120_000,
    outputSchema: 'LegacyRawText', outputFormat: 'text', jsonResponse: true, legacyPrompt: true, unredactedVariables: LEGACY_RELAY_VARIABLES,
    active: true, billable: true,
  },
  legacy_enrich_coherence: {
    operationCode: 'legacy_enrich_coherence', useCaseCode: 'DATA_RECONCILIATION',
    label: "Enrichissement et contrôle de cohérence combinés d'un bien",
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'legacy_enrich_coherence_v1', timeoutMs: 45_000,
    outputSchema: 'LegacyRawText', outputFormat: 'text', jsonResponse: true, legacyPrompt: true, unredactedVariables: LEGACY_RELAY_VARIABLES,
    active: true, billable: true,
  },

  // T2 — recherche historique (usages 6 et 7), famille de modèles assistant
  // (§15.10). Délais repris des modules (course contre un minuteur).
  legacy_semantic_search: {
    operationCode: 'legacy_semantic_search', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: 'Recherche sémantique historique (repli de la recherche classique)',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'legacy_semantic_search_v1', timeoutMs: 30_000,
    outputSchema: 'LegacyRawText', outputFormat: 'text', legacyPrompt: true, unredactedVariables: LEGACY_RELAY_VARIABLES,
    active: true, billable: false,
  },
  legacy_intelligent_search: {
    operationCode: 'legacy_intelligent_search', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: 'Réponse générative historique de la recherche intelligente',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'legacy_intelligent_search_v1', timeoutMs: 25_000,
    outputSchema: 'LegacyRawText', outputFormat: 'text', legacyPrompt: true, unredactedVariables: LEGACY_RELAY_VARIABLES,
    active: true, billable: true,
  },

  // T4 — classement action / information d'une échéance (usage historique 8).
  legacy_classify_home_category: {
    operationCode: 'legacy_classify_home_category', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: "Classement action / information d'une échéance (moteur historique)",
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'legacy_classify_home_category_v1', timeoutMs: 30_000,
    outputSchema: 'LegacyRawText', outputFormat: 'text', legacyPrompt: true, unredactedVariables: LEGACY_RELAY_VARIABLES,
    active: true, billable: false,
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
