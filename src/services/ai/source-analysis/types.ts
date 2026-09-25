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
export type FactProvenance = 'TEXT_EXTRACTION' | 'VISUAL_ANALYSIS';

/** Preuve d'une observation visuelle : où regarder, et ce qui y est vu. */
export interface VisualEvidence {
  page?: number;
  imageIndex?: number;
  /** Zone relative (0 à 1). */
  region?: { x1: number; y1: number; x2: number; y2: number };
  description: string;
  /** Fichier observé (renseigné à la persistance). */
  fileId?: number;
}

export interface VisualObservation {
  description: string;
  subject?: string;
  confidence: EvidenceConfidence;
  page?: number;
  imageIndex?: number;
  region?: { x1: number; y1: number; x2: number; y2: number };
}

export interface ExtractedTableCell {
  row: number;
  column: number;
  rowHeader: string | null;
  columnHeader: string | null;
  columnPath: string[];
  /** Valeur brute ; `null` pour une cellule vide. */
  value: string | null;
  normalized: string | null;
  valueType: string | null;
  colspan: number;
  rowspan: number;
  page: number | null;
  confidence: EvidenceConfidence;
}

export interface ExtractedTable {
  index: number;
  title: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  columns: Array<{ header: string; path: string[] }>;
  rowCount: number;
  columnCount: number;
  cells: ExtractedTableCell[];
  confidence: EvidenceConfidence;
  uncertain: boolean;
  /** Incertitudes de structure (lecture, doublons, cellules hors grille). */
  issues: string[];
}

export interface ExtractedField {
  fieldKey: string;
  value: unknown;
  normalizedValue?: string;
  confidence: EvidenceConfidence;
  /**
   * Extrait littéral de la source. Présent pour TEXT_EXTRACTION ; ABSENT pour
   * VISUAL_ANALYSIS — une observation n'a pas de citation, et lui en fabriquer
   * une ferait passer une interprétation pour un texte.
   */
  excerpt?: string;
  /** Lu dans la source, ou observé sur l'image (défaut : lu). */
  provenance?: FactProvenance;
  visualEvidence?: VisualEvidence;
  /** Cellule de tableau d'où provient la valeur (index dans `document.tables`). */
  table?: { index: number; row: number; column: number };
  page?: number;
  selector?: string;
  /** Fait générique : sujet (« Chaudière »), attribut (« puissance »), unité (« kW »). */
  subject?: string;
  attribute?: string;
  label?: string;
  unit?: string;
  /** Période couverte (ISO), lorsque pertinent (contrat, relevé, garantie…). */
  periodStart?: string;
  periodEnd?: string;
  /** Zone de la source (en-tête, tableau, rubrique…). */
  section?: string;
  /**
   * Récurrence EXPLICITEMENT mentionnée par la source pour cette échéance
   * (jamais déduite de connaissances générales).
   */
  recurrence?: ExtractedRecurrence;
}

/** Récurrence telle que la source l'énonce (T1) — le calcul des dates relève de T4. */
export interface ExtractedRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  startDate?: string;
  endDate?: string;
  occurrenceCount?: number;
  /** Dates explicitement listées (échéancier). */
  dates?: string[];
  excerpt?: string;
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
  /** Récurrence démontrée par la source (EXPLICIT_SOURCE), le cas échéant. */
  recurrence?: import('../agenda/rules/recurrence').RecurrenceSpec;
}

export type AnalysisWarningCode =
  | 'NO_EXPLOITABLE_CONTENT'
  | 'PARTIAL_EXTRACTION'
  | 'UNVERIFIED_IDENTIFIER'
  | 'AMBIGUOUS_ASSET'
  | 'MULTI_ASSET_DOCUMENT'
  | 'LOW_CONFIDENCE_OVERALL'
  | 'SOURCE_UNREACHABLE'
  /** Information écartée : lue sans extrait, ou observée sans preuve visuelle. */
  | 'FIELD_WITHOUT_EVIDENCE'
  /** Tableau dont la structure (associations ligne/colonne) est douteuse. */
  | 'TABLE_STRUCTURE_UNCERTAIN';

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
    /**
     * Classement V2 (CDC V2 §3, §11.4).
     *
     * Structure distincte de `category` : la confiance y est NUMÉRIQUE, le
     * §11.2 raisonnant sur un seuil de 90 % que trois niveaux qualitatifs ne
     * permettent pas de situer.
     */
    rubric?: {
      rubricCode: string;
      documentTypeCode: string | null;
      confidence: number;
      excerpt: string;
      promptVersion: string | null;
    };
    description?: EvidenceValue<string>;
    transcription?: string;
    /** Observations visuelles — jamais mêlées à la transcription. */
    visual?: { summary?: string; observations: VisualObservation[] };
    /** Tableaux structurés (ligne/colonne), validés par `normalizeTables`. */
    tables?: ExtractedTable[];
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
