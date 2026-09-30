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

/**
 * Cible « prompt maître » d'une opération HISTORIQUE (CDC 15 §22.3, §29
 * étape 11, ARCH-03) : le master de son traitement et la branche TASK qui la
 * remplace. Métadonnée seule — le prompt effectif reste `promptCode`, le
 * comportement de production est inchangé tant que la version de
 * configuration n'a pas basculé le traitement en architecture `master` (D-04).
 */
export interface MasterMigrationTarget {
  masterPromptCode: string;
  task: string;
  /** Opération master qui exécute cette branche. */
  operationCode: string;
}

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
   * Opération historique : master et TASK qui la remplacent (§22.3, « toutes
   * celles d'un même traitement doivent référencer le même master prompt et
   * un TASK explicite »). N'influence PAS l'exécution.
   */
  migratesTo?: MasterMigrationTarget;
  /**
   * Variables attendues par le prompt (emplacements `{{X}}`, hors TASK).
   * Facultatif ; déclaré, `prompts:check` vérifie la correspondance exacte
   * avec le fichier.
   */
  promptVariables?: readonly string[];
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
 * Prompt maître T5 (CDC 15 §27) — FICHIER DU DÉPÔT seulement : T5 n'a pas
 * de prompt administrable (§10, T5-003) et ne se modifie jamais lui-même.
 */
const T5_MASTER = 't5_master_v1';
/** Prompt maître T6 (CDC 15 §28) — même valeur que `T6_MASTER_PROMPT_CODE`. */
const T6_MASTER = 't6_master_v1';
export const T5_MASTER_VARIABLES = ['CURRENT_MASTER_PROMPTS', 'INSTRUCTION'] as const;

export const AI_OPERATIONS: Record<string, AiOperationDefinition> = {
  // ── Usage 1 — Analyse unifiée des sources (CDC §4.1.4) ────────────────────
  group_sources: {
    operationCode: 'group_sources', useCaseCode: 'SOURCE_ANALYSIS',
    migratesTo: { masterPromptCode: T1_MASTER, task: 'GROUP_UPLOAD', operationCode: 't1_group_upload' },
    label: 'Regroupement de fichiers en un même document',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'group_sources_v2', timeoutMs: 45_000,
    outputSchema: 'GroupSourcesOutput', active: true, billable: false,
  },
  extract_source: {
    operationCode: 'extract_source', useCaseCode: 'SOURCE_ANALYSIS',
    migratesTo: { masterPromptCode: T1_MASTER, task: 'ANALYZE_DOCUMENT', operationCode: 't1_analyze_document' },
    label: 'Extraction structurée du contenu avec preuves',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: EXTRACT_SOURCE_PROMPT_VERSION, timeoutMs: 90_000,
    outputSchema: 'ExtractSourceOutput', active: true, billable: true,
  },
  classify_document: {
    operationCode: 'classify_document', useCaseCode: 'SOURCE_ANALYSIS',
    migratesTo: { masterPromptCode: T1_MASTER, task: 'ANALYZE_DOCUMENT', operationCode: 't1_analyze_document' },
    label: 'Classification documentaire',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'classify_document_v2', timeoutMs: 30_000,
    outputSchema: 'ClassifyDocumentOutput', active: true, billable: false,
  },
  classify_category: {
    operationCode: 'classify_category', useCaseCode: 'SOURCE_ANALYSIS',
    migratesTo: { masterPromptCode: T1_MASTER, task: 'ANALYZE_DOCUMENT', operationCode: 't1_analyze_document' },
    label: 'Classement par catégorie documentaire',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'classify_category_v1', timeoutMs: 20_000,
    // Non facturée : le §4.3 tranche déterministiquement la majorité des cas,
    // et cet appel ne porte que sur les types réellement ambigus.
    // CDC 15 ARCH-02 (lot 12) : fichier `classify_category_v1.txt` absent et
    // aucun appelant — désactivée plutôt que de créer artificiellement le
    // fichier. Conservée pour les traces historiques ; suppression au lot 16.
    outputSchema: 'ClassifyCategoryOutput', active: false, billable: false,
  },
  classify_rubric: {
    operationCode: 'classify_rubric', useCaseCode: 'SOURCE_ANALYSIS',
    migratesTo: { masterPromptCode: T1_MASTER, task: 'ANALYZE_DOCUMENT', operationCode: 't1_analyze_document' },
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
    migratesTo: { masterPromptCode: T1_MASTER, task: 'ANALYZE_DOCUMENT', operationCode: 't1_analyze_document' },
    label: 'Identification des entités (biens, pièces, équipements, fournisseurs)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'identify_entities_v2', timeoutMs: 45_000,
    outputSchema: 'IdentifyEntitiesOutput', active: true, billable: false,
  },
  propose_links: {
    operationCode: 'propose_links', useCaseCode: 'SOURCE_ANALYSIS',
    migratesTo: { masterPromptCode: T1_MASTER, task: 'ANALYZE_DOCUMENT', operationCode: 't1_analyze_document' },
    label: 'Proposition de rattachements',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'propose_links_v2', timeoutMs: 45_000,
    outputSchema: 'ProposeLinksOutput', active: true, billable: false,
  },

  // ── T1 — prompt maître (CDC 15 §23, §29, D-03, D-04, D-06) ──────────────
  // Une seule consigne `t1_master_v1`, deux branches imposées par le
  // serveur. Exécutées seulement quand la version de configuration bascule
  // T1 en architecture `master` (`getPromptArchitecture('T1')`). Mêmes
  // modèles que les étapes qu'elles remplacent ; déclarées APRÈS elles (le
  // disjoncteur sonde la première opération active de l'usage).
  t1_group_upload: {
    operationCode: 't1_group_upload', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'T1 master — regroupement des fichiers déposés (TASK=GROUP_UPLOAD)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: T1_MASTER, masterPromptCode: T1_MASTER, task: 'GROUP_UPLOAD', promptVariables: T1_MASTER_VARIABLES,
    timeoutMs: 45_000, jsonResponse: true,
    outputSchema: 'T1GroupUploadOutput', active: true, billable: false,
  },
  t1_analyze_document: {
    operationCode: 't1_analyze_document', useCaseCode: 'SOURCE_ANALYSIS',
    label: 'T1 master — analyse complète d’un document (TASK=ANALYZE_DOCUMENT)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: T1_MASTER, masterPromptCode: T1_MASTER, task: 'ANALYZE_DOCUMENT', promptVariables: T1_MASTER_VARIABLES,
    timeoutMs: 120_000, jsonResponse: true,
    // D-06 : une seule sortie porte transcription, tableaux et jusqu'à 300
    // faits. Plancher (`minOutputTokens`) et non simple défaut
    // (`defaultMaxOutputTokens`) : le plafond de la version est PAR
    // TRAITEMENT, réglé pour les étapes courtes de T1 ; un JSON tronqué est
    // invalide sur toute la chaîne de modèles (coût ×3, aucun résultat).
    // Même mécanisme que `control_prompts`. 32 768 < limite de sortie des
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
  resolve_ambiguity: {
    operationCode: 'resolve_ambiguity', useCaseCode: 'DATA_RECONCILIATION',
    migratesTo: { masterPromptCode: T3_MASTER, task: 'VALUE_CONFLICT', operationCode: 't3_value_conflict' },
    label: 'Arbitrage IA ciblé sur un cas resté ambigu',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'resolve_ambiguity_v1', timeoutMs: 30_000,
    outputSchema: 'ResolveAmbiguityOutput', active: true, billable: true,
  },
  reconcile_links: {
    operationCode: 'reconcile_links', useCaseCode: 'DATA_RECONCILIATION',
    migratesTo: { masterPromptCode: T3_MASTER, task: 'LINK_AMBIGUITY', operationCode: 't3_link_ambiguity' },
    label: 'Réconciliation des liaisons équipements',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'reconcile_links_v1', timeoutMs: 30_000,
    outputSchema: 'ReconcileLinksOutput', active: true, billable: false,
  },

  // ── T3 — prompt maître (CDC 15 §25, T3-06, T3-07, D-03, D-04) ────────────
  // Exécutées seulement quand la version de configuration bascule T3 en
  // architecture `master` (`getPromptArchitecture('T3')`) ; pas de
  // commutateur d'environnement propre (D-04). Mêmes modèles et même
  // facturation que les étapes qu'elles remplacent ; déclarées APRÈS elles.
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
  understand_request: {
    operationCode: 'understand_request', useCaseCode: 'INTELLIGENT_ASSISTANT',
    migratesTo: { masterPromptCode: T2_MASTER, task: 'UNDERSTAND', operationCode: 't2_understand' },
    label: "Compréhension de la question et sélection des outils",
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'understand_request_v1', timeoutMs: 12_000,
    outputSchema: 'ToolPlanOutput', active: true, billable: false,
    // CDC Assistant §13.9 / §31.2 (budget V1 : 500), CDC 15 T2-43.
    defaultMaxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
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
    migratesTo: { masterPromptCode: T2_MASTER, task: 'REVALIDATE', operationCode: 't2_revalidate' },
    label: 'Revalidation ciblée d’un fait documentaire',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'revalidate_fact_v1', timeoutMs: 20_000,
    outputSchema: 'RevalidationOutput', active: true, billable: true,
    // CDC Assistant §13.9 / §31.2 (budget V1 : 500), CDC 15 T2-43.
    defaultMaxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
  },
  generate_answer: {
    operationCode: 'generate_answer', useCaseCode: 'INTELLIGENT_ASSISTANT',
    migratesTo: { masterPromptCode: T2_MASTER, task: 'ANSWER', operationCode: 't2_answer' },
    label: 'Génération de la réponse sourcée',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'generate_answer_v4', timeoutMs: 12_000,
    outputSchema: 'AssistantAnswerOutput', active: true, billable: true,
    // CDC Assistant §13.9 / §31.2 (budget V1 : 500), CDC 15 T2-43.
    defaultMaxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
  },
  // Lot 15 (T2-36) : même étape, prompt `generate_answer_v5` (règle de
  // longueur de l'intention prioritaire). Sélectionnée SEULEMENT avec
  // ASSISTANT_CANONICAL_READ=enabled ; en legacy, `generate_answer` et
  // `generate_answer_v4` restent inchangés (jamais deux textes sous un nom).
  generate_answer_canonical: {
    operationCode: 'generate_answer_canonical', useCaseCode: 'INTELLIGENT_ASSISTANT',
    migratesTo: { masterPromptCode: T2_MASTER, task: 'ANSWER', operationCode: 't2_answer' },
    label: 'Génération de la réponse sourcée (lecture canonique)',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'generate_answer_v5', timeoutMs: 12_000,
    outputSchema: 'AssistantAnswerOutput', active: true, billable: true,
    defaultMaxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
  },

  // ── T2 — prompt maître (CDC 15 §24, T2-31, T2-35, T2-36, D-03, D-04) ─────
  // Exécutées seulement quand la version de configuration bascule T2 en
  // architecture `master` (`getPromptArchitecture('T2')`). Mêmes modèles,
  // délais, plafond de sortie (min(BO, 500), T2-43) et facturation que les
  // étapes qu'elles remplacent ; déclarées APRÈS elles. Sortie discriminée
  // par `mode` (§24), et non `task`.
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
    timeoutMs: 20_000, jsonResponse: true,
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
  classify_event: {
    operationCode: 'classify_event', useCaseCode: 'AGENDA_INTELLIGENCE',
    migratesTo: { masterPromptCode: T4_MASTER, task: 'CLASSIFY_EVENT', operationCode: 't4_classify_event' },
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
    migratesTo: { masterPromptCode: T4_MASTER, task: 'VERIFY_COMPLETION', operationCode: 't4_verify_completion' },
    label: "Mise à jour du statut d'un événement sous preuve explicite",
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: 'reconcile_status_v1', timeoutMs: 15_000,
    outputSchema: 'ReconcileStatusOutput', active: true, billable: false,
  },

  // ── T4 — prompt maître (CDC 15 §26, T4-10 à T4-14, D-04) ─────────────────
  // Exécutées seulement quand la version de configuration bascule T4 en
  // architecture `master` (`getPromptArchitecture('T4')`). Mêmes modèles et
  // même facturation que les étapes qu'elles remplacent ; déclarées APRÈS
  // elles. TEMPORAL_AMBIGUITY : branche du master, sans appelant au lot 14.
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
  // INACTIVE (relecture du lot 14) : branche déclarée avec son schéma, mais
  // AUCUN appelant dans le code — les dates ambiguës restent traitées par
  // `interpretDate` (règles). Active, elle apparaîtrait dans l'inventaire et
  // la console comme une opération en service. À réactiver avec son premier
  // appelant.
  t4_temporal_ambiguity: {
    operationCode: 't4_temporal_ambiguity', useCaseCode: 'AGENDA_INTELLIGENCE',
    label: 'T4 master — arbitrage d’une ambiguïté temporelle (TASK=TEMPORAL_AMBIGUITY)',
    provider: GEMINI, primaryModel: DOC_PRIMARY, fallbackModels: DOC_FALLBACKS,
    promptCode: T4_MASTER, masterPromptCode: T4_MASTER, task: 'TEMPORAL_AMBIGUITY', promptVariables: T4_MASTER_VARIABLES,
    timeoutMs: 15_000, jsonResponse: true,
    outputSchema: 'T4TemporalAmbiguityOutput', active: false, billable: false,
  },

  // ── Usage 5 — Gouvernance (CDC §4.5.3) ────────────────────────────────────
  analyze_instruction: {
    operationCode: 'analyze_instruction', useCaseCode: 'AI_GOVERNANCE',
    // CDC 15 §27 : T5 remplace `analyze_instruction`, `control_prompts` et
    // `propose_change` par une seule gouvernance (t5_master_v1).
    migratesTo: { masterPromptCode: T5_MASTER, task: 'MODIFY', operationCode: 't5_modify' },
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
    migratesTo: { masterPromptCode: T5_MASTER, task: 'MODIFY', operationCode: 't5_modify' },
    label: 'Prompt Control — diagnostic et réécriture des prompts administrables',
    provider: GEMINI, primaryModel: GOV_PRIMARY, fallbackModels: GOV_FALLBACKS,
    promptCode: 'prompt_control_v2', timeoutMs: 120_000, minOutputTokens: 32_768,
    outputSchema: 'PromptControlOutput', active: true, billable: false,
  },
  propose_change: {
    operationCode: 'propose_change', useCaseCode: 'AI_GOVERNANCE',
    migratesTo: { masterPromptCode: T5_MASTER, task: 'MODIFY', operationCode: 't5_modify' },
    label: 'Proposition de modification de prompt (jamais appliquée directement)',
    provider: GEMINI, primaryModel: GOV_PRIMARY, fallbackModels: GOV_FALLBACKS,
    promptCode: 'propose_change_v1', timeoutMs: 60_000,
    // CDC 15 ARCH-02, T5-01 (lot 12) : fichier `propose_change_v1.txt` absent
    // et aucun appelant — désactivée, suppression au lot 16.
    outputSchema: 'PromptChangeProposalOutput', active: false, billable: false,
  },
  // ── T5 — prompt maître (CDC 15 §27, §29 étape 16, MP-16) ──────────────────
  // Exécutées quand la version de configuration bascule T5 en `master`
  // (D-04). Texte = fichier du dépôt, JAMAIS la version (T5 non
  // administrable). Mêmes modèles et délais que `control_prompts`.
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
  formulate_mascot: {
    operationCode: 'formulate_mascot', useCaseCode: 'HOME_MASCOT',
    migratesTo: { masterPromptCode: T6_MASTER, task: 'FORMULATE', operationCode: 't6_formulate' },
    label: "Formulation du discours de la mascotte d'accueil",
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: 'mascot_t6_v1', timeoutMs: 8_000,
    outputSchema: 'MascotT6Output', active: true, billable: false,
  },
  // T6 — prompt maître (CDC 15 §28), `T6_MASTER_OPERATION_SPEC` de
  // `home/mascot/t6-contract.ts`. Sortie sans discriminant (`taskField:
  // 'none'`) : `schemaVersion` t6-output-v2 strict. Mêmes modèles, délai et
  // facturation que `formulate_mascot` ; bascule par la version (D-04) et
  // AI_HOME_MASCOT.
  t6_formulate: {
    operationCode: 't6_formulate', useCaseCode: 'HOME_MASCOT',
    label: 'T6 master — formulation de la mascotte (MODE=FORMULATE)',
    provider: GEMINI, primaryModel: ASSISTANT_PRIMARY, fallbackModels: ASSISTANT_FALLBACKS,
    promptCode: T6_MASTER, masterPromptCode: T6_MASTER, task: 'FORMULATE', taskField: 'none', promptVariables: ['INPUT_JSON'],
    timeoutMs: 8_000, jsonResponse: true,
    outputSchema: 'T6FormulateOutput', active: true, billable: false,
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

// ── Dépréciation (CDC 15 §29 étape 15, §32, D-02) ───────────────────────────

/**
 * Motif de dépréciation d'une opération — DÉDUIT du registre, jamais saisi
 * à la main (une seule source de vérité) :
 *   · `MIGRATED_TO_MASTER` : opération d'étape remplacée par une branche de
 *     master (`migratesTo`) ; conservée tant que le traitement peut tourner
 *     en `steps` (D-04) ;
 *   · `LEGACY_RELAY` : relais `legacy_*` des prompts historiques (WF-41),
 *     conservé pendant la transition (D-02) et retiré après bascule.
 * Rien n'est supprimé ici : la liste de retrait est produite par
 * `scripts/check-master-cutover.ts`, sur préconditions.
 */
export type DeprecationReason = 'MIGRATED_TO_MASTER' | 'LEGACY_RELAY';

export interface OperationDeprecation {
  reason: DeprecationReason;
  /** Opération master de remplacement, s'il y en a une. */
  replacedBy: string | null;
  masterPromptCode: string | null;
  task: string | null;
}

export function operationDeprecation(op: AiOperationDefinition): OperationDeprecation | null {
  if (op.migratesTo) {
    return {
      reason: 'MIGRATED_TO_MASTER', replacedBy: op.migratesTo.operationCode,
      masterPromptCode: op.migratesTo.masterPromptCode, task: op.migratesTo.task,
    };
  }
  if (op.legacyPrompt) return { reason: 'LEGACY_RELAY', replacedBy: null, masterPromptCode: null, task: null };
  return null;
}

export function isDeprecatedOperation(op: AiOperationDefinition): boolean {
  return operationDeprecation(op) !== null;
}

/** Opérations dépréciées (actives ou non), dans l'ordre du registre. */
export function listDeprecatedOperations(): Array<AiOperationDefinition & { deprecation: OperationDeprecation }> {
  return Object.values(AI_OPERATIONS).flatMap((op) => {
    const d = operationDeprecation(op);
    return d ? [{ ...op, deprecation: d }] : [];
  });
}
