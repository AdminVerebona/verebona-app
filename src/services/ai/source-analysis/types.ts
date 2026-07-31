/**
 * Contrats de l'analyse unifiée des sources — CDC §4.1.5 et §4.1.6.
 *
 * EXIGENCE CENTRALE (§4.1.7) : « Un lien web produit exactement le même schéma
 * de sortie qu'un fichier. » C'est le critère d'acceptation n°6. Toute source,
 * présente ou future, entre par `SourceInput` et ressort par
 * `SourceAnalysisResult` — sans exception et sans variante.
 */
import type { EvidenceValue, EvidenceConfidence } from '../evidence/evidence.types';

/**
 * Types de source pris en charge. L'ajout d'une source (email, import externe)
 * consiste à écrire un adaptateur, jamais à modifier le pipeline (§4.1.2).
 */
export type SourceType = 'file' | 'web_link' | 'future_source';

/** Entrée normalisée du pipeline commun — CDC §4.1.5. */
export interface SourceInput {
  sourceType: SourceType;
  /** Identifiants `asset_files.id` — plusieurs si les fichiers forment un même document. */
  sourceIds: number[];
  accountId: number;
  userId: number;
  mimeTypes: string[];
  displayNames: string[];
  /** URLs exploitables par le fournisseur (S3 signées, durée limitée). */
  contentUrls?: string[];
  /** Contenu déjà extrait par l'adaptateur (cas d'une page web nettoyée). */
  extractedContent?: string;
  linkedAssetId?: number | null;
  /** Version de la source — clé d'idempotence et évitement de réanalyse (§6.3). */
  sourceVersion?: number;
}

/** Candidat de rattachement à une entité du compte. */
export interface LinkCandidate {
  /** Identifiant renvoyé par le modèle — TOUJOURS revérifié en base (§4.1.7). */
  entityId: number | null;
  /** Libellé brut lorsque l'entité n'existe pas encore. */
  rawLabel?: string;
  confidence: EvidenceConfidence;
  score: number;
  reason: string;
  excerpt: string;
  /** false tant que `identifier-verifier` n'a pas confirmé l'existence. */
  verified: boolean;
}

/** Champ extrait, destiné au moteur de réconciliation (usage 2). */
export interface ExtractedField {
  fieldKey: string;
  value: unknown;
  normalizedValue?: string;
  confidence: EvidenceConfidence;
  excerpt: string;
  page?: number;
  selector?: string;
}

/** Candidat d'événement, destiné au moteur agenda (usage 4). */
export interface AgendaCandidate {
  title: string;
  date: string;
  /** Classification laissée à l'usage 4 lorsqu'elle n'est pas déterministe. */
  suggestedCategory?: 'action' | 'information';
  confidence: EvidenceConfidence;
  excerpt: string;
  originFieldKey?: string;
}

export type AnalysisWarningCode =
  | 'NO_EXPLOITABLE_CONTENT'
  | 'PARTIAL_EXTRACTION'
  | 'UNVERIFIED_IDENTIFIER'
  | 'AMBIGUOUS_ASSET'
  | 'MULTI_ASSET_DOCUMENT'
  | 'LOW_CONFIDENCE_OVERALL'
  | 'SOURCE_UNREACHABLE';

export interface AnalysisWarning {
  code: AnalysisWarningCode;
  message: string;
  /** Champ ou entité concerné, si applicable. */
  target?: string;
}

export interface SupplierCandidate {
  name: string;
  siret?: string;
  /** Identifiant `suppliers.id` si le fournisseur existe déjà, après vérification. */
  supplierId?: number | null;
}

/** Trace technique de l'analyse — rattachement usage / opérations (§5.5). */
export interface AiOperationTrace {
  traceIds: string[];
  operationCodes: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostMicros: number;
  totalDurationMs: number;
  usedFallback: boolean;
  models: string[];
}

/**
 * Sortie unifiée du pipeline — CDC §4.1.6.
 * Identique pour un fichier, un lien web et toute source future.
 */
export interface SourceAnalysisResult {
  sourceGroup: {
    sourceIds: number[];
    leadSourceId: number;
  };
  document: {
    title?: EvidenceValue<string>;
    type?: EvidenceValue<string>;
    /** Catégorie documentaire proposée (CDC 5 §7.1). */
    category?: EvidenceValue<string>;
    description?: EvidenceValue<string>;
    transcription?: string;
    date?: EvidenceValue<string>;
    supplier?: EvidenceValue<SupplierCandidate>;
    amountCents?: EvidenceValue<number>;
  };
  assetCandidates: LinkCandidate[];
  roomCandidates: LinkCandidate[];
  equipmentCandidates: LinkCandidate[];
  extractedFields: ExtractedField[];
  agendaCandidates: AgendaCandidate[];
  warnings: AnalysisWarning[];
  operationTrace: AiOperationTrace;
}

/** Contexte du compte transmis aux étapes — borné et minimisé (§5.6). */
export interface AnalysisContext {
  accountId: number;
  userId: number;
  assets: Array<{ id: number; name: string; category: string | null; subtype: string | null }>;
  rooms: Array<{ id: number; name: string; assetId: number }>;
  equipments: Array<{ id: number; name: string; type: string | null; assetId: number }>;
  existingTitles: string[];
  linkedAssetId: number | null;
}
