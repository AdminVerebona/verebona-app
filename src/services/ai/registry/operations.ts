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
   * Plafond de tokens de sortie du CODE, appliqué seulement quand aucune
   * version de configuration ne fixe le sien (CDC 15 T2-43 : une seule
   * source de vérité, la configuration IA effective ; ceci n'en est que la
   * valeur initiale, comme les modèles du référentiel). Absent : défaut du
   * modèle.
   */
  defaultMaxOutputTokens?: number;
  /**
   * Format de la sortie validée (cf. `output-validator`). `json` par défaut ;
   * `text` : la réponse brute est validée par le schéma de l'appelant.
   */
  outputFormat?: 'json' | 'text';
  /** Mode JSON natif du fournisseur (`responseMimeType: application/json`). */
  jsonResponse?: boolean;
  /**
   * Prompt MAÎTRE du traitement (CDC 15 §22, §29.1, D-03). Présent avec `task`
   * sur une opération master : la gateway charge alors le master
   * (`resolveMasterPrompt`) — texte de la version de configuration s'il y en
   * a un, fichier du dépôt sinon —, lui injecte `{{TASK}}`, n'y ajoute AUCUN
   * préambule (§22.3 : pas de concaténation de règles cachées) et vérifie que
   * la sortie porte `task === task` (validation discriminée). Doit être égal à
   * `promptCode`.
   */
  masterPromptCode?: string;
  /** Branche TASK/MODE imposée par le serveur (CDC 15 §22.2, DP-05). */
  task?: string;
  /**
   * Champ discriminant de la sortie d'un master : `task` (défaut) ou `mode`
   * (T2, §24 : `{"mode":"ANSWER",…}`). Utilisé par la validation discriminée.
   */
  taskField?: 'task' | 'mode' | 'none';
  /**
   * Variables attendues par le prompt (emplacements `{{X}}`, hors TASK).
   * Facultatif ; déclaré, `prompts:check` vérifie la correspondance exacte
   * avec le fichier.
   */
  promptVariables?: readonly string[];
  /**
   * Capacités du modèle que l'opération exige EN PLUS de la sortie
   * structurée (déduite de `jsonResponse` / `outputSchema`) — lot 32B :
   * `usableModelsForTreatment` n'admet pour un traitement que les modèles
   * qui les déclarent toutes (registre `models.ts`). `multimodal` : l'appel
   * transmet des fichiers ou des images (`attachments`).
   */
  requiredCapabilities?: readonly ('multimodal' | 'thinking')[];
  /** Une opération inactive ne peut pas être exécutée par la gateway. */
  active: boolean;
  /** false ⇒ n'incrémente pas les compteurs de quota client. */
  billable: boolean;
}

const GEMINI = 'gemini';

/** Prompt maître T1 (CDC 15 §23, §29.1) — même valeur que `T1_MASTER_PROMPT_CODE`. */
const T1_MASTER = 't1_master_v1';
/**
 * Emplacements `{{X}}` du master T1 (hors TASK, fixée par le serveur). Un
 * seul texte pour les deux branches : chaque appel les fournit TOUS (valeur
 * vide ou `null` pour ceux que sa branche n'utilise pas) — le chargeur refuse
 * tout emplacement non substitué. Contrôlé contre le fichier par
 * `prompts:check`.
 */
export const T1_MASTER_VARIABLES = [
  'SOURCES', 'EXISTING_TITLES', 'EXTRACTED_CONTENT', 'KNOWN_TARGET',
  'FIELD_CATALOG', 'DOCUMENT_CATALOG', 'EVENT_CATALOG', 'ENTITY_CONTEXT',
  // Capacités effectives du compte (pièces, équipements) — jamais l'offre.
  // Variable OPTIONNELLE pour un texte de version antérieur qui ne la porte
  // pas (`OPTIONAL_MASTER_VARIABLES`, prompt-loader).
  'ACCOUNT_CAPABILITIES',
] as const;

/** Prompt maître T3 (CDC 15 §25, §29.1) — même valeur que `T3_MASTER_PROMPT_CODE`. */
const T3_MASTER = 't3_master_v1';
/**
 * Emplacements du master T3 (hors TASK). Un seul texte pour les deux
 * branches : chaque appel les fournit TOUS (`null` pour ceux de l'autre
 * branche). Contrôlé contre le fichier par `prompts:check`.
 */
export const T3_MASTER_VARIABLES = [
  'FIELD', 'CURRENT_STATE', 'EVIDENCES', 'SUBJECT_CONTEXT', 'CANDIDATES', 'RELATION_TYPE',
] as const;

/** Prompt maître T4 (CDC 15 §26, §29.1) — même valeur que `T4_MASTER_PROMPT_CODE`. */
const T4_MASTER = 't4_master_v1';
/**
 * Emplacements du master T4 (hors TASK). Un seul texte pour les trois
 * branches : chaque appel les fournit TOUS (`null` pour ceux des autres
 * branches). Contrôlé contre le fichier par `prompts:check`.
 */
export const T4_MASTER_VARIABLES = [
  'EVENT_CONTEXT', 'EVENT_CATALOG', 'EVIDENCE', 'AGENDA_ITEM', 'DOCUMENT_TYPE',
  'TEMPORAL_CONTEXT', 'TEMPORAL_CANDIDATES',
] as const;

/** Prompt maître T2 (CDC 15 §24, §29.1) — même valeur que `T2_MASTER_PROMPT_CODE`. */
const T2_MASTER = 't2_master_v1';
/**
 * Emplacements du master T2 (hors MODE, fixé par le serveur). Un seul texte
 * pour les trois branches : chaque appel les fournit TOUS (`null` pour ceux
 * des autres branches). Contrôlé contre le fichier par `prompts:check`.
 */
export const T2_MASTER_VARIABLES = [
  'QUESTION', 'INTENTS', 'FIELD_CATALOG', 'PAGE_CONTEXT', 'CONVERSATION_CONTEXT',
  'INTENT', 'TODAY', 'RESOLVED_TARGETS', 'CONVERSATION', 'SOURCES',
  'FACT', 'CURRENT_VALUE', 'PROVENANCE_MODE', 'LOCATION', 'CONTENT',
] as const;

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
 * `assistant-escalation`. Valeurs initiales du code (modèles rapides et
 * économiques) ; la configuration versionnée du BO les remplace. Lot 32B :
 * l'ancienne règle « aucun modèle Pro » (CDC Assistant V1, §31.2) n'est plus
 * un interdit — un modèle est admis pour T2 selon ses caractéristiques
 * déclarées (`usableModelsForTreatment`), pas selon son nom ; coût et latence
 * restent bornés par le contrat T2 (appels, délai, plafonds, budget).
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
 * L'escalade reste `gemini-3.1-flash-lite`, qui répond toujours.
 */
const ASSISTANT_PRIMARY = 'gemini-3.5-flash-lite';   // alias assistant-default
const ASSISTANT_FALLBACKS = ['gemini-3.1-flash-lite']; // alias assistant-escalation
/**
 * Plafond de sortie de l'assistant tant qu'aucune version ne fixe le sien
 * (CDC Assistant §31.2). Remplace `VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS`,
 * seconde source de vérité supprimée (CDC 15 T2-43).
 */
export const ASSISTANT_MAX_OUTPUT_TOKENS = 500;

/** Famille 3 — gouvernance : raisonnement sur des prompts, hors chemin utilisateur. */
const GOV_PRIMARY = 'gemini-2.5-pro';
const GOV_FALLBACKS = ['gemini-3.1-flash-lite'];

/**
 * Prompt maître T5 (CDC 15 §27). Lot 32B (décision PO n° 15) : administrable
 * depuis le BO (« Prompts maîtres », brouillon → actif) comme T1–T4 et T6 ;
 * le fichier du dépôt en est la version initiale. T5 ne se modifie jamais
 * lui-même : Prompt Control n'a pas T5 pour cible (règle tenue par le serveur).
 */
const T5_MASTER = 't5_master_v1';
/** Prompt maître T6 (CDC 15 §28) — même valeur que `T6_MASTER_PROMPT_CODE`. */
const T6_MASTER = 't6_master_v1';
export const T5_MASTER_VARIABLES = ['CURRENT_MASTER_PROMPTS', 'INSTRUCTION'] as const;

export const AI_OPERATIONS: Record<string, AiOperationDefinition> = {
  // ── Usage 1 — Analyse unifiée des sources (CDC §4.1.4) ────────────────────
  // Lot 16b-3 (retrait de l'ancien moteur) : les opérations d'étapes
  // `group_sources`, `extract_source`, `classify_document`, `classify_rubric`,
  // `identify_entities` et `propose_links` sont SUPPRIMÉES — le prompt maître
  // T1 (`t1_group_upload`, `t1_analyze_document`) est le seul moteur.

  // ── T1 — prompt maître (CDC 15 §23, §29, D-03, D-04, D-06) ──────────────
  // Une seule consigne `t1_master_v1`, deux branches imposées par le
  // serveur ; toujours exécutées (lot 16b-3 : plus d'architecture `steps`
  // pour T1). Le disjoncteur sonde la première opération active de l'usage :
  // `t1_group_upload`, mêmes modèles que `t1_analyze_document`.
  t1_group_upload: {
    operationCode: 't1_group_upload', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'T1 master — regroupement des fichiers déposés (TASK=GROUP_UPLOAD)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: T1_MASTER, masterPromptCode: T1_MASTER, task: 'GROUP_UPLOAD', promptVariables: T1_MASTER_VARIABLES,
    timeoutMs: 45_000, jsonResponse: true, requiredCapabilities: ['multimodal'],
    outputSchema: 'T1GroupUploadOutput', active: true, billable: false,
  },
  t1_analyze_document: {
    operationCode: 't1_analyze_document', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'T1 master — analyse complète d’un document (TASK=ANALYZE_DOCUMENT)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: T1_MASTER, masterPromptCode: T1_MASTER, task: 'ANALYZE_DOCUMENT', promptVariables: T1_MASTER_VARIABLES,
    timeoutMs: 120_000, jsonResponse: true, requiredCapabilities: ['multimodal'],
    // D-06 : une seule sortie porte transcription, tableaux et jusqu'à 300
    // faits. Plancher (`minOutputTokens`) et non simple défaut
    // (`defaultMaxOutputTokens`) : le plafond de la version est PAR
    // TRAITEMENT, réglé pour les étapes courtes de T1 ; un JSON tronqué est
    // invalide sur toute la chaîne de modèles (coût ×3, aucun résultat).
    // Même mécanisme que `t5_modify`. 32 768 < limite de sortie des
    // modèles DOC (65 536).
    minOutputTokens: 32_768,
    outputSchema: 'T1AnalyzeDocumentOutput', active: true, billable: true,
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
  // Lot 16b-3 (retrait de l'ancien moteur) : `resolve_ambiguity` et
  // `reconcile_links` sont SUPPRIMÉES — le prompt maître T3
  // (`t3_value_conflict`, `t3_link_ambiguity`) est le seul moteur.

  // ── T3 — prompt maître (CDC 15 §25, T3-06, T3-07, D-03, D-04) ────────────
  // Toujours exécutées (lot 16b-3 : plus d'architecture `steps` pour T3, ni
  // de drapeau `AI_RECONCILIATION_ENGINE`). Mêmes modèles et même
  // facturation que les étapes qu'elles ont remplacées. Le disjoncteur sonde
  // la première opération active de l'usage : `t3_value_conflict`.
  t3_value_conflict: {
    operationCode: 't3_value_conflict', useCaseCode: 'DATA_RECONCILIATION',
    label: 'T3 master — arbitrage d’un conflit de valeur (TASK=VALUE_CONFLICT)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: T3_MASTER, masterPromptCode: T3_MASTER, task: 'VALUE_CONFLICT', promptVariables: T3_MASTER_VARIABLES,
    timeoutMs: 30_000, jsonResponse: true,
    outputSchema: 'T3ValueConflictOutput', active: true, billable: true,
  },
  t3_link_ambiguity: {
    operationCode: 't3_link_ambiguity', useCaseCode: 'DATA_RECONCILIATION',
    label: 'T3 master — départage d’un rattachement ambigu (TASK=LINK_AMBIGUITY)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: T3_MASTER, masterPromptCode: T3_MASTER, task: 'LINK_AMBIGUITY', promptVariables: T3_MASTER_VARIABLES,
    timeoutMs: 30_000, jsonResponse: true,
    outputSchema: 'T3LinkAmbiguityOutput', active: true, billable: false,
  },

  // ── Usage 3 — Assistant (CDC §4.3.4) ──────────────────────────────────────
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
  // ── T2 — prompt maître (CDC 15 §24, T2-31, T2-35, T2-36, D-03, D-04) ─────
  // Seul moteur de T2 depuis le lot 16b-2 : `understand_request`,
  // `generate_answer`, `generate_answer_canonical`, `revalidate_fact` et les
  // relais `legacy_*_search` sont retirés, et T2 n'a plus d'architecture
  // `steps`. Plafond de sortie min(BO, 500) (T2-43). Sortie discriminée par
  // `mode` (§24), et non `task`. La revalidation ciblée d'un fait relit le
  // contenu persisté ou la page utile de la source pour UNE question —
  // jamais une analyse T1 complète ; coût imputé à l'assistant.
  t2_understand: {
    operationCode: 't2_understand', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: 'T2 master — compréhension de la demande (MODE=UNDERSTAND)',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: T2_MASTER, masterPromptCode: T2_MASTER, task: 'UNDERSTAND', taskField: 'mode', promptVariables: T2_MASTER_VARIABLES,
    timeoutMs: 12_000, jsonResponse: true,
    outputSchema: 'T2UnderstandOutput', active: true, billable: false,
    defaultMaxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
  },
  t2_answer: {
    operationCode: 't2_answer', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: 'T2 master — réponse sourcée (MODE=ANSWER)',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: T2_MASTER, masterPromptCode: T2_MASTER, task: 'ANSWER', taskField: 'mode', promptVariables: T2_MASTER_VARIABLES,
    timeoutMs: 12_000, jsonResponse: true,
    outputSchema: 'T2AnswerOutput', active: true, billable: true,
    defaultMaxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
  },
  t2_revalidate: {
    operationCode: 't2_revalidate', useCaseCode: 'INTELLIGENT_ASSISTANT',
    label: 'T2 master — revalidation ciblée, texte ou visuel (MODE=REVALIDATE)',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: T2_MASTER, masterPromptCode: T2_MASTER, task: 'REVALIDATE', taskField: 'mode', promptVariables: T2_MASTER_VARIABLES,
    timeoutMs: 20_000, jsonResponse: true, requiredCapabilities: ['multimodal'],
    outputSchema: 'T2RevalidateOutput', active: true, billable: true,
    defaultMaxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
  },

  // ── Usage 4 — Agenda (CDC §4.4.3) ─────────────────────────────────────────
  detect_dates: {
    operationCode: 'detect_dates', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: 'Interprétation déterministe des dates extraites',
    provider: 'none', primaryModel: 'none', fallbackModels: [],
    timeoutMs: 5_000, outputSchema: 'none', active: true, billable: false,
  },
  deduplicate_event: {
    operationCode: 'deduplicate_event', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: 'Détection de doublon (déterministe)',
    provider: 'none', primaryModel: 'none', fallbackModels: [],
    timeoutMs: 5_000, outputSchema: 'none', active: true, billable: false,
  },

  // ── T4 — prompt maître (CDC 15 §26, T4-10 à T4-14, D-04) ─────────────────
  // Seul moteur de T4 depuis le lot 16b-2 : `classify_event`,
  // `reconcile_status` et le relais `legacy_classify_home_category` sont
  // retirés, et T4 n'a plus d'architecture `steps`. TEMPORAL_AMBIGUITY :
  // appelée depuis le lot 18 (R5).
  t4_classify_event: {
    operationCode: 't4_classify_event', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: 'T4 master — classification action / information (TASK=CLASSIFY_EVENT)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: T4_MASTER, masterPromptCode: T4_MASTER, task: 'CLASSIFY_EVENT', promptVariables: T4_MASTER_VARIABLES,
    timeoutMs: 15_000, jsonResponse: true,
    outputSchema: 'T4ClassifyEventOutput', active: true, billable: false,
  },
  t4_verify_completion: {
    operationCode: 't4_verify_completion', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: 'T4 master — preuve de réalisation d’une occurrence (TASK=VERIFY_COMPLETION)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: T4_MASTER, masterPromptCode: T4_MASTER, task: 'VERIFY_COMPLETION', promptVariables: T4_MASTER_VARIABLES,
    timeoutMs: 15_000, jsonResponse: true,
    outputSchema: 'T4VerifyCompletionOutput', active: true, billable: false,
  },
  // Active depuis le lot 18 (R5) : appelée par T4 (`resoudreAmbiguiteTemporelle`)
  // quand une date est incertaine (jj/mm ↔ mm/jj, mention relative).
  // Abstention → carte AGENDA-PROPOSAL.
  t4_temporal_ambiguity: {
    operationCode: 't4_temporal_ambiguity', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: 'T4 master — arbitrage d’une ambiguïté temporelle (TASK=TEMPORAL_AMBIGUITY)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: T4_MASTER, masterPromptCode: T4_MASTER, task: 'TEMPORAL_AMBIGUITY', promptVariables: T4_MASTER_VARIABLES,
    timeoutMs: 15_000, jsonResponse: true,
    outputSchema: 'T4TemporalAmbiguityOutput', active: true, billable: false,
  },

  // ── Usage 5 — Gouvernance (CDC §4.5.3) ────────────────────────────────────
  // ── T5 — prompt maître (CDC 15 §27, §29 étape 16, MP-16) ──────────────────
  // Seul moteur de T5 depuis le lot 16b : `analyze_instruction`,
  // `control_prompts` et `propose_change` sont retirés, et T5 n'a plus
  // d'architecture `steps`. Texte = version active « Prompts maîtres » du BO
  // (lot 32B), sinon fichier du dépôt — jamais le texte d'une version de
  // configuration.
  t5_analyze: {
    operationCode: 't5_analyze', useCaseCode: 'AI_GOVERNANCE',
    label: 'T5 master — diagnostic (MODE=ANALYZE)',
    provider: GEMINI, primaryModel: GOV_PRIMARY, fallbackModels: GOV_FALLBACKS,
    promptCode: T5_MASTER, masterPromptCode: T5_MASTER, task: 'ANALYZE', taskField: 'mode', promptVariables: T5_MASTER_VARIABLES,
    timeoutMs: 120_000, jsonResponse: true,
    outputSchema: 'T5AnalyzeOutput', active: true, billable: false,
  },
  t5_modify: {
    operationCode: 't5_modify', useCaseCode: 'AI_GOVERNANCE',
    label: 'T5 master — réécriture des prompts maîtres (MODE=MODIFY)',
    provider: GEMINI, primaryModel: GOV_PRIMARY, fallbackModels: GOV_FALLBACKS,
    promptCode: T5_MASTER, masterPromptCode: T5_MASTER, task: 'MODIFY', taskField: 'mode', promptVariables: T5_MASTER_VARIABLES,
    timeoutMs: 120_000, minOutputTokens: 32_768, jsonResponse: true,
    outputSchema: 'T5ModifyOutput', active: true, billable: false,
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
  // T6 — prompt maître (CDC 15 §28), `T6_MASTER_OPERATION_SPEC` de
  // `home/mascot/t6-contract.ts`. Sortie sans discriminant (`taskField:
  // 'none'`) : `schemaVersion` t6-output-v2 strict. Seul moteur de T6 depuis
  // le lot 16b (`formulate_mascot` et `mascot_t6_v1` retirés).
  t6_formulate: {
    operationCode: 't6_formulate', useCaseCode: 'HOME_MASCOT',
    label: 'T6 master — formulation de la mascotte (MODE=FORMULATE)',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: T6_MASTER, masterPromptCode: T6_MASTER, task: 'FORMULATE', taskField: 'none', promptVariables: ['INPUT_JSON'],
    timeoutMs: 8_000, jsonResponse: true,
    outputSchema: 'T6FormulateOutput', active: true, billable: false,
  },

  // Lot 16b (retrait de l'ancien moteur) : les relais `legacy_*` des modules
  // historiques (plan WF-41) sont tous SUPPRIMÉS — T1 au lot 16b-3a, T3
  // (`legacy_asset_suggest`, `legacy_apply_suggestions`,
  // `legacy_enrich_coherence`) au lot 16b-3b, avec la décision PO D-H1.
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

/** Opération master : exécute une branche TASK d'un prompt maître. */
export function isMasterOperation(op: AiOperationDefinition): op is AiOperationDefinition & {
  masterPromptCode: string; task: string;
} {
  return Boolean(op.masterPromptCode && op.task);
}

/**
 * Branches TASK déclarées pour un prompt maître, toutes opérations actives
 * confondues (CDC 15 §22.2 : le serveur n'impose qu'une branche connue).
 */
export function listMasterTasks(masterPromptCode: string): string[] {
  const tasks = new Set<string>();
  for (const op of Object.values(AI_OPERATIONS)) {
    if (op.active && op.masterPromptCode === masterPromptCode && op.task) tasks.add(op.task);
  }
  return [...tasks];
}

/** Prompts maîtres déclarés, avec leur usage et leurs branches. */
export function listMasterPrompts(): Array<{ masterPromptCode: string; useCaseCode: AiUseCaseCode; tasks: string[] }> {
  const byCode = new Map<string, { masterPromptCode: string; useCaseCode: AiUseCaseCode; tasks: string[] }>();
  for (const op of Object.values(AI_OPERATIONS)) {
    if (!op.active || !isMasterOperation(op)) continue;
    const e = byCode.get(op.masterPromptCode)
      ?? { masterPromptCode: op.masterPromptCode, useCaseCode: op.useCaseCode, tasks: [] };
    if (!e.tasks.includes(op.task)) e.tasks.push(op.task);
    byCode.set(op.masterPromptCode, e);
  }
  return [...byCode.values()];
}

// ── Architecture cible (CDC 15 §29 étape 15, §32, D-02 ; lot 16b) ──────────

/**
 * Lot 16b : plus aucune opération dépréciée (étape historique ou relais
 * legacy). Tout appel modèle passe par une opération MASTER, à la seule
 * exception de l'évaluation d'une version candidate (`dynamicPrompt`), qui
 * exécute le texte soumis. `ai:cutover-check` en fait un garde.
 */
export function isTargetArchitectureOperation(op: AiOperationDefinition): boolean {
  return op.provider === 'none' || isMasterOperation(op) || op.dynamicPrompt === true;
}

/** Opérations ACTIVES hors architecture cible (doit rester vide). */
export function listNonTargetOperations(): AiOperationDefinition[] {
  return Object.values(AI_OPERATIONS).filter((op) => op.active && !isTargetArchitectureOperation(op));
}
