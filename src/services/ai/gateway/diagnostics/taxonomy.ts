/**
 * Taxonomie des échecs IA — lot 33D (ticket « rendre INVALID_OUTPUT
 * diagnosticable »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVALID_OUTPUT N'EST PLUS UN DIAGNOSTIC
 *
 * `INVALID_OUTPUT` reste le CODE de la passerelle (compatibilité : files,
 * politique d'échec définitif, disjoncteur, écrans existants) mais il est
 * désormais toujours accompagné :
 *   · d'une FAMILLE (`AiFailureFamily`) — la cause réellement remontée par le
 *     moteur ou le fournisseur (TIMEOUT, RATE_LIMIT, SAFETY_BLOCK…) ;
 *   · d'un SOUS-TYPE pour les sorties invalides (`InvalidOutputSubtype`) ;
 *   · de l'ÉTAPE exacte (`AiFailureStage`) ;
 *   · du détail de validation (chemin, attendu, reçu, valeur, message
 *     d'origine du validateur) ;
 *   · de la CHAÎNE DE CONTRÔLES (`ControlChain`) : ce qui a été exécuté,
 *     réussi, échoué ou non exécuté.
 * `UNKNOWN` n'est utilisé que si le moteur ne sait réellement pas classer —
 * et l'étape, l'exception, le message et la pile restent conservés.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Familles d'échec (ticket §1). */
export const AI_FAILURE_FAMILIES = [
  'INVALID_OUTPUT',
  'TIMEOUT',
  'PROVIDER_ERROR',
  'RATE_LIMIT',
  'AUTH_ERROR',
  'CONTEXT_TOO_LARGE',
  'INPUT_ERROR',
  'SAFETY_BLOCK',
  'NETWORK_ERROR',
  'INTERNAL_ERROR',
  'UNKNOWN',
] as const;
export type AiFailureFamily = (typeof AI_FAILURE_FAMILIES)[number];

/** Sous-types d'une sortie invalide (ticket §1). */
export const INVALID_OUTPUT_SUBTYPES = [
  'EMPTY_RESPONSE',
  'MALFORMED_JSON',
  'SCHEMA_VALIDATION_FAILED',
  'MISSING_REQUIRED_FIELD',
  'INVALID_ENUM',
  'INVALID_TYPE',
  'OUTPUT_TRUNCATED',
  'STRUCTURED_OUTPUT_REJECTED',
  'PARSER_ERROR',
  'BUSINESS_VALIDATION_FAILED',
  /**
   * Lot 34D (contrat runtime source unique) : le schéma utilisé pour la
   * validation n'est pas celui transmis au modèle (empreintes différentes).
   * Défaut INTERNE du moteur : diagnostiqué au BO, jamais montré à
   * l'utilisateur final.
   */
  'RUNTIME_CONTRACT_MISMATCH',
  /**
   * Lot 82C (LOG-04, R02 — incident 4694) : requête refusée par le
   * fournisseur parce qu'un PARAMÈTRE nommé n'est pas accepté par ce modèle
   * (niveau ou budget de raisonnement, plafond de sortie, température…).
   * Famille `INPUT_ERROR` (incompatibilité de requête), jamais une
   * indisponibilité du fournisseur ni `UNKNOWN` ; le paramètre est dans
   * `provider.rejectedParameter`.
   */
  'PARAMETER_REJECTED',
  /**
   * Lot 85C (CDC Pilotage IA V2 P4, CFG-03) : combinaison modèle +
   * paramètres CONNUE comme incompatible d'après la fiche de capacités,
   * refusée AVANT tout appel (étape `request_build`, aucun coût). Famille
   * `INPUT_ERROR`, jamais une indisponibilité ; paramètre dans
   * `provider.rejectedParameter`.
   */
  'PARAMETER_INCOMPATIBLE',
  'UNKNOWN',
] as const;
export type InvalidOutputSubtype = (typeof INVALID_OUTPUT_SUBTYPES)[number];

/** Étapes d'un appel modèle (ticket §2). */
export const AI_FAILURE_STAGES = [
  'request_build',
  'provider_request',
  'provider_generation',
  'response_reception',
  'structured_output',
  'json_parse',
  'schema_validation',
  'business_validation',
  'result_mapping',
  'persistence',
  'post_processing',
] as const;
export type AiFailureStage = (typeof AI_FAILURE_STAGES)[number];

/**
 * Étapes où le modèle N'A PAS répondu (par opposition à « a répondu mais
 * Verebona a rejeté sa sortie ») — ticket §2.
 */
export const PRE_RESPONSE_STAGES: readonly AiFailureStage[] = ['request_build', 'provider_request', 'provider_generation'];

/** État d'un contrôle de la chaîne (ticket §6). */
export type ControlState =
  /** Exécuté et réussi tel quel. */
  | 'passed'
  /** Exécuté, échoué puis corrigé (extraction, normalisation, réparation). */
  | 'repaired'
  /** Exécuté et échoué. */
  | 'failed'
  /** Non exécuté (étape précédente en échec). */
  | 'not_run'
  /** Sans objet pour cet appel (structured output non demandé…). */
  | 'not_applicable'
  /** Constaté absent (structured output demandé mais réponse non JSON). */
  | 'absent';

/** Chaîne de contrôles d'un appel, dans l'ordre (ticket §6). */
export interface ControlChain {
  providerResponse: ControlState;
  structuredOutput: ControlState;
  json: ControlState;
  schema: ControlState;
  businessValidation: ControlState;
  persistence: ControlState;
}

export const CONTROL_LABELS: Record<keyof ControlChain, string> = {
  providerResponse: 'Réponse fournisseur',
  structuredOutput: 'Structured output',
  json: 'JSON',
  schema: 'Schéma',
  businessValidation: 'Validation métier',
  persistence: 'Persistance',
};

export function emptyControlChain(): ControlChain {
  return {
    providerResponse: 'not_run', structuredOutput: 'not_run', json: 'not_run',
    schema: 'not_run', businessValidation: 'not_run', persistence: 'not_run',
  };
}

/**
 * Détail d'une erreur de validation (ticket §3). Toutes les valeurs sont
 * déjà masquées (`redact`) et bornées.
 */
export interface ValidationIssueDetail {
  subtype: InvalidOutputSubtype;
  /** Chemin JSONPath (`$.document.purchaseDate`). */
  path: string;
  /** Type ou contrainte attendu (`string | null`, `ISO date`…). */
  expected: string | null;
  /** Type reçu (`object`, `undefined`…). */
  received: string | null;
  /** Valeur reçue, sérialisée et bornée (masquée). */
  receivedValue: string | null;
  /** Valeurs autorisées (enum, littéral, discriminant). */
  allowedValues?: string[];
  /** Champ obligatoire manquant (dernier segment du chemin). */
  missingField?: string;
  /** Message d'origine du validateur. */
  message: string;
}

/** Métadonnées natives du fournisseur (ticket §7, §8). */
export interface ProviderCallMetadata {
  provider: string;
  model: string;
  providerRequestId?: string | null;
  /** Version de modèle réellement servie par le fournisseur. */
  modelVersion?: string | null;
  finishReason?: string | null;
  stopReason?: string | null;
  finishMessage?: string | null;
  safetyReason?: string | null;
  /** `requested_schema` | `json_mode` | `none` | `schema_rejected_retried_without`. */
  structuredOutputStatus?: string | null;
  tokenUsage?: { input: number; output: number; thoughts?: number | null; total?: number | null };
  latencyMs?: number | null;
  /** Plafond de sortie configuré pour l'appel (`null` : défaut du fournisseur). */
  configuredMaxOutputTokens?: number | null;
  /** Fin de génération par plafond de sortie (finish_reason MAX_TOKENS, ou plafond atteint). */
  maxTokensReached?: boolean;
  providerErrorCode?: string | null;
  providerErrorMessage?: string | null;
  httpStatus?: number | null;
  /** Lot 82C : paramètre refusé par le fournisseur (`generationConfig.thinkingConfig.thinkingLevel`…). */
  rejectedParameter?: string | null;
}

/** Transformation appliquée à une sortie avant acceptation (ticket 2, rapport). */
export interface OutputRepairStep {
  /**
   * `json_extraction`, `json_repair`, `normalization` (règles déterministes
   * sûres), `compat_adapter` (adaptateur structurel versionné),
   * `compat_mapping` (lot 34D : mapping EXPLICITE de la table de
   * compatibilité — nom de champ ou valeur d'énumération), `field_pruning`,
   * `ai_repair`.
   */
  stage: 'json_extraction' | 'json_repair' | 'compat_adapter' | 'compat_mapping' | 'normalization' | 'field_pruning' | 'ai_repair';
  /** Règle précise (`null_as_absent`, `date_object_to_iso`, `t1_v1_to_v2`…). */
  rule: string;
  path: string;
  detail?: string;
}

/** Référence du contrat de sortie (ticket §5). */
export interface OutputSchemaRef {
  /** Nom du schéma (`T1AnalyzeDocumentOutput`) ou opération. */
  name: string;
  /** Libellé versionné (`t1_analyze_document@v3`) — « Schema version ». */
  version: string;
  /** Empreinte SHA-256 (12) du schéma JSON dérivé — « Schema hash ». */
  hash: string;
  /** Lot 34D — identifiant du contrat runtime (`T1_ANALYZE_DOCUMENT`). */
  contractId?: string;
  /** Lot 34D — version du contrat runtime (entier du registre). */
  contractVersion?: number;
  /** Lot 34D — structured output transmis au fournisseur pour CET appel. */
  structuredOutput?: boolean;
  /** Lot 34D — empreinte (12) du schéma fournisseur dérivé, s'il a été transmis. */
  providerSchemaHash?: string | null;
  /** Lot 34D — version de la table de compatibilité appliquée. */
  compatTableVersion?: number;
}

/** Statut d'un appel modèle dans le rapport (ticket §9). */
export type CallOutcome = 'SUCCEEDED' | 'REPAIRED' | 'FAILED';

/** Rapport complet d'un appel modèle de la cascade (ticket §9). */
export interface CallDiagnostic {
  outcome: CallOutcome;
  /** `analysis` (appel complet) ou `repair` (passe de réparation ciblée). */
  callKind: 'analysis' | 'repair';
  family: AiFailureFamily | null;
  subtype: InvalidOutputSubtype | null;
  stage: AiFailureStage | null;
  /** Le modèle a-t-il produit une sortie (même rejetée) ? */
  outputReceived: boolean;
  /** Erreur technique d'origine (message, exception, pile interne si UNKNOWN). */
  error: { message: string; exception?: string | null; stack?: string | null } | null;
  issues: ValidationIssueDetail[];
  /** Nombre total d'erreurs de validation (les détails sont bornés à 20). */
  issueCount: number;
  controls: ControlChain;
  provider: ProviderCallMetadata;
  schema: OutputSchemaRef | null;
  /** Corrections appliquées avant acceptation (ou tentées avant rejet). */
  repairs: OutputRepairStep[];
  /** Signature stable de l'échec (comparaison de cascade, rejeu). */
  signature: string | null;
  /** Le fallback précédent a-t-il reçu l'erreur de l'appel précédent ? */
  informedOfPreviousError?: boolean;
}

/** Libellés français des familles, sous-types et étapes (BO). */
export const FAMILY_LABELS: Record<AiFailureFamily, string> = {
  INVALID_OUTPUT: 'Sortie invalide',
  TIMEOUT: 'Délai dépassé',
  PROVIDER_ERROR: 'Erreur du fournisseur',
  RATE_LIMIT: 'Limite de débit du fournisseur',
  AUTH_ERROR: 'Authentification refusée',
  CONTEXT_TOO_LARGE: 'Entrée trop volumineuse',
  INPUT_ERROR: 'Requête refusée par le fournisseur',
  SAFETY_BLOCK: 'Blocage de sécurité du fournisseur',
  NETWORK_ERROR: 'Erreur réseau',
  INTERNAL_ERROR: 'Erreur interne Verebona',
  UNKNOWN: 'Cause non classée',
};

export const SUBTYPE_LABELS: Record<InvalidOutputSubtype, string> = {
  EMPTY_RESPONSE: 'réponse vide',
  MALFORMED_JSON: 'JSON mal formé',
  SCHEMA_VALIDATION_FAILED: 'schéma non respecté',
  MISSING_REQUIRED_FIELD: 'champ obligatoire absent',
  INVALID_ENUM: 'valeur hors liste',
  INVALID_TYPE: 'type incorrect',
  OUTPUT_TRUNCATED: 'sortie tronquée',
  STRUCTURED_OUTPUT_REJECTED: 'structured output refusé',
  PARSER_ERROR: 'erreur du parseur',
  BUSINESS_VALIDATION_FAILED: 'règle métier non respectée',
  RUNTIME_CONTRACT_MISMATCH: 'contrat runtime incohérent (moteur)',
  PARAMETER_REJECTED: 'paramètre refusé par le modèle',
  PARAMETER_INCOMPATIBLE: 'combinaison modèle / paramètres incompatible (refusée avant appel)',
  UNKNOWN: 'non classé',
};

// ══════════════════════════════════════════════════════════════════════════
// LOT 52B — REQUÊTE FOURNISSEUR ET TENTATIVES INTERNES D'UN APPEL
//
// Métadonnées SANS CONTENU (ni prompt, ni document, ni schéma) : empreintes,
// compteurs, réglages effectifs. Figées dans `ai_usage_event.metadata`
// (`providerRequest`, `providerAttempts`) pour CHAQUE appel, réussi compris.
// ══════════════════════════════════════════════════════════════════════════

/** Requête réellement construite pour le fournisseur (première tentative de l'appel). */
export interface ProviderRequestTrace {
  /** `responseSchema` transmis au fournisseur (structured output). */
  responseSchemaSent: boolean;
  /** Empreinte (12) du schéma fournisseur DÉRIVÉ du contrat, transmis ou non. */
  providerSchemaHash: string | null;
  /** Nombre de nœuds du schéma dérivé (borne `MAX_PROVIDER_SCHEMA_NODES`). */
  schemaNodes: number | null;
  /** Mots-clés retirés à la réduction (contraintes vérifiées par Verebona). */
  droppedKeywords: string[];
  /**
   * Motif d'absence de `responseSchema` : `not_requested`,
   * `structured_output_off` (AI_STRUCTURED_OUTPUT=off), `too_complex`,
   * `unrepresentable`, `recent_rejection` (refus mémorisé) ; `null` si transmis.
   */
  schemaOmittedReason: string | null;
  /** `application/json` ou `null` (texte libre). */
  responseMimeType: string | null;
  maxOutputTokens: number | null;
  /** `aucun`, `low`, `high` ou `budget N`. */
  thinkingConfig: string;
  /** Pièces jointes : nombre, type MIME et transport (jamais de nom ni d'URL). */
  attachments: { count: number; items: Array<{ mimeType: string; transport: string }> };
}

/**
 * Tentative fournisseur INTERNE à un appel modèle : la tentative structurée,
 * puis l'éventuel nouvel essai du MÊME modèle sans `responseSchema`. Ce
 * n'est ni un fallback modèle, ni une tentative du job, ni une réparation.
 */
export interface ProviderAttemptTrace {
  /** 1 : tentative initiale ; 2 : nouvel essai sans schéma. */
  step: number;
  /**
   * `initial` (avec ou sans schéma), `schema_rejected_retry` (refus EXPLICITE
   * du schéma), `diagnostic_retry` (400 INVALID_ARGUMENT générique : essai
   * diagnostique sans schéma, lot 52B).
   */
  kind: 'initial' | 'schema_rejected_retry' | 'diagnostic_retry';
  responseSchemaSent: boolean;
  providerSchemaHash: string | null;
  responseMimeType: string | null;
  outcome: 'SUCCESS' | 'FAILED';
  httpStatus: number | null;
  providerErrorCode: string | null;
  family: AiFailureFamily | null;
  durationMs: number;
}

/** Nouvel essai du même modèle sans structured output (compteur `structuredOutputRetries`). */
export function isStructuredOutputRetry(a: Pick<ProviderAttemptTrace, 'kind'>): boolean {
  return a.kind === 'schema_rejected_retry' || a.kind === 'diagnostic_retry';
}

/**
 * Lot 52B — nature d'un échec AVANT sortie, pour le BO : un HTTP 400
 * INVALID_ARGUMENT n'est jamais une indisponibilité du fournisseur.
 */
export type ProviderFailureCategory = 'PROVIDER_UNAVAILABLE' | 'REQUEST_REJECTED' | 'STRUCTURED_OUTPUT_REJECTED' | 'PARAMETER_REJECTED' | 'PARAMETER_INCOMPATIBLE';

export const PROVIDER_FAILURE_CATEGORY_LABELS: Record<ProviderFailureCategory, string> = {
  PROVIDER_UNAVAILABLE: 'Fournisseur indisponible',
  REQUEST_REJECTED: 'Requête refusée par le fournisseur',
  STRUCTURED_OUTPUT_REJECTED: 'Structured output refusé',
  PARAMETER_REJECTED: 'Paramètre refusé par le modèle',
  PARAMETER_INCOMPATIBLE: 'Combinaison incompatible refusée avant appel',
};

export function providerFailureCategory(family: string | null | undefined, subtype: string | null | undefined): ProviderFailureCategory | null {
  if (subtype === 'STRUCTURED_OUTPUT_REJECTED') return 'STRUCTURED_OUTPUT_REJECTED';
  // Lot 82C (LOG-04, R02) : incompatibilité de paramètre, jamais une indisponibilité.
  if (subtype === 'PARAMETER_REJECTED') return 'PARAMETER_REJECTED';
  // Lot 85C : refus AVANT appel d'après les capacités du modèle.
  if (subtype === 'PARAMETER_INCOMPATIBLE') return 'PARAMETER_INCOMPATIBLE';
  switch (family) {
    case 'INPUT_ERROR': case 'CONTEXT_TOO_LARGE': case 'AUTH_ERROR': return 'REQUEST_REJECTED';
    case 'PROVIDER_ERROR': case 'NETWORK_ERROR': case 'TIMEOUT': case 'RATE_LIMIT': return 'PROVIDER_UNAVAILABLE';
    default: return null;
  }
}

/**
 * Code d'erreur AFFICHÉ au BO. Les traces antérieures au lot 52B portent
 * `PROVIDER_UNAVAILABLE` pour toute erreur brute du fournisseur, y compris un
 * 400 INVALID_ARGUMENT : la famille enregistrée corrige l'affichage (aucune
 * réécriture en base).
 */
export function displayErrorCode(errorCode: string | null, family: string | null | undefined, subtype?: string | null): string | null {
  if (errorCode !== 'PROVIDER_UNAVAILABLE') return errorCode;
  const cat = providerFailureCategory(family, subtype);
  return cat === 'REQUEST_REJECTED' || cat === 'STRUCTURED_OUTPUT_REJECTED' || cat === 'PARAMETER_REJECTED' ? 'PROVIDER_REQUEST_REJECTED' : errorCode;
}

/** Code affiché : `INVALID_OUTPUT / SCHEMA_VALIDATION_FAILED`, `TIMEOUT`… */
export function displayCause(family: AiFailureFamily | null, subtype: InvalidOutputSubtype | null): string | null {
  if (!family) return null;
  if (family === 'INVALID_OUTPUT') return `INVALID_OUTPUT / ${subtype ?? 'UNKNOWN'}`;
  // Lot 82C : le refus d'un paramètre se distingue d'un refus générique.
  return subtype === 'PARAMETER_REJECTED' || subtype === 'PARAMETER_INCOMPATIBLE' ? `${family} / ${subtype}` : family;
}
