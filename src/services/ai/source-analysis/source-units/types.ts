/**
 * Couche A de T1 — représentation exhaustive et durable de la source
 * (lot 34F, ticket « T1 — Garantir une extraction exhaustive, persistée et
 * réexploitable »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX COUCHES, DEUX GARANTIES
 *
 *   Couche A — `document_source_units` : ce que la source CONTIENT (texte
 *   intégral découpé en blocs, couples libellé / valeur, éléments de
 *   formulaire, tableaux ligne par ligne, observations visuelles,
 *   métadonnées). Chaque unité a un identifiant STABLE (`sourceUnitId`) et un
 *   état de couverture. Rien n'y est tronqué.
 *
 *   Couche B — `document_facts` (inchangée) : ce que T1 a COMPRIS. Chaque
 *   fait porte désormais `source_unit_ids` (provenance).
 *
 * Une information que T1 n'a pas su structurer reste en couche A (UNRESOLVED)
 * et, si un fait avait été produit puis rejeté, dans
 * `document_unresolved_facts` : « incompréhensible » ne signifie jamais
 * « supprimé ». T3 et les traitements futurs relisent ces tables
 * (`loadDocumentSourceUnits`) sans rouvrir le fichier.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * IDENTIFIANTS (`sourceUnitId`) — numérotation à partir de 1, stable pour un
 * même contenu :
 *   page:2:block:14                  bloc de texte (paragraphe, ≤ 8 lignes)
 *   page:2:field:3                   couple libellé / valeur (« Kilométrage : 78 000 km »)
 *   page:2:form:1                    élément de formulaire (case cochée / non cochée)
 *   page:5:table:2                   tableau (structure, en-têtes)
 *   page:5:table:2:row:4             ligne de tableau (ses cellules en charge utile)
 *   page:5:table:2:row:4:cell:3      cellule — adresse DÉRIVÉE de la ligne
 *                                    (la cellule elle-même est dans
 *                                    `document_table_cells`) ; utilisée par la
 *                                    provenance d'un fait lu dans une cellule
 *   page:7:visual:6                  observation visuelle
 *   doc:visual:summary               vue d'ensemble visuelle
 *   doc:meta:title | description | documentDate | supplier | amount | classification
 *   page:9:gap:12                    pages 9 à 12 non analysées (découpage en
 *                                    échec) — toujours FAILED, jamais silencieux
 * Pagination inconnue (transcription sans marque de page) : page 1.
 */

export const SOURCE_UNIT_KINDS = [
  'DOCUMENT_METADATA', 'TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD', 'TABLE', 'TABLE_ROW',
  'VISUAL_OBSERVATION', 'VISUAL_SUMMARY', 'PAGE_GAP',
] as const;
export type SourceUnitKind = (typeof SOURCE_UNIT_KINDS)[number];

export const COVERAGE_STATUSES = ['COVERED', 'NON_INFORMATIONAL', 'UNRESOLVED', 'UNCERTAIN', 'FAILED'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const T1_QUALITY_STATES = ['COMPLETE', 'COMPLETE_WITH_UNRESOLVED', 'INCOMPLETE_RETRYABLE', 'INCOMPLETE_FINAL'] as const;
export type T1QualityState = (typeof T1_QUALITY_STATES)[number];

/** Origine d'une unité : passe principale, lot de débordement, découpage par pages, réparation, reprise historique. */
export type SourceUnitOrigin = 'PASS_1' | 'OVERFLOW' | 'CHUNK' | 'REPAIR' | 'BACKFILL';

export interface SourceUnit {
  sourceUnitId: string;
  kind: SourceUnitKind;
  /** Page (1…n) ; null pour une unité de niveau document. */
  page: number | null;
  /** Ordre de lecture dans le document (0…n). */
  ordinal: number;
  /** Unité parente (ligne → tableau). */
  parentUnitId: string | null;
  /** Contenu INTÉGRAL (jamais tronqué) ; null pour une lacune de pages. */
  text: string | null;
  /** Couple libellé / valeur, élément de formulaire. */
  label?: string | null;
  value?: string | null;
  /** Charge utile structurée (cellules d'une ligne, région d'une observation…). */
  payload: Record<string, unknown>;
  /** Localisation dans la source (page, tableau, ligne, région, segment). */
  location: Record<string, unknown>;
  origin: SourceUnitOrigin;
  /** Contient une valeur structurable (date, montant, identifiant, libellé : valeur…). */
  salient: boolean;
}

export interface UnitCoverage {
  status: CoverageStatus;
  /** Motif lisible (`fact`, `metadata`, `entity`, `table`, `pagination`, `repair_failed`…). */
  reason: string | null;
  /** Nombre de faits rattachés. */
  factCount: number;
}

export interface CoveredSourceUnit extends SourceUnit, UnitCoverage {
  /** Tentatives de réparation ciblée sur cette unité. */
  repairAttempts: number;
}

/** Motifs de conservation d'un fait non intégré tel quel (`document_unresolved_facts`). */
export const UNRESOLVED_REASONS = [
  'INVALID_SCHEMA', 'VALUE_TOO_LONG', 'NO_EVIDENCE', 'UNKNOWN_TARGET', 'UNKNOWN_CANONICAL_KEY',
  'VALUE_NOT_NORMALIZABLE', 'KEY_NOT_APPLICABLE', 'FIELD_PRUNED', 'OBSERVATION_WITHOUT_DESCRIPTION', 'EMPTY_TABLE',
] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

/**
 * UNRESOLVED : absent des faits, conservé ici seulement ;
 * RETAINED : présent dans les faits, mais pas tel que le modèle l'avait
 *   annoncé (générique, cible neutralisée) — trace de la requalification ;
 * RECOVERED : écarté à la 1re passe, retrouvé par la réparation ciblée.
 */
export type UnresolvedStatus = 'UNRESOLVED' | 'RETAINED' | 'RECOVERED';

export interface UnresolvedFactRecord {
  reason: UnresolvedReason;
  status: UnresolvedStatus;
  sourceUnitIds: string[];
  rawKey: string | null;
  canonicalKey: string | null;
  rawValue: string | null;
  /** Élément tel que rendu par le modèle (valeur complète, jamais tronquée). */
  originalPayload: unknown;
  pass: SourceUnitOrigin;
  detail?: string | null;
}

/** Rapport de complétude T1 (ticket §« Ajouter un état de complétude T1 »). */
export interface T1CompletenessReport {
  totalSourceUnits: number;
  coveredUnits: number;
  nonInformationalUnits: number;
  unresolvedUnits: number;
  uncertainUnits: number;
  failedUnits: number;
  /** Faits retenus (après fusion des lots, découpages et réparations). */
  factsCount: number;
  /** Faits écartés et NON retrouvés (conservés dans `document_unresolved_facts`). */
  droppedFactsCount: number;
  /** Sections DÉFINITIVEMENT non lues (limite atteinte sans poursuite possible) — 0 attendu. */
  truncatedSectionsCount: number;
  /** Sections traitées par lot supplémentaire (débordement, pages découpées) — aucune perte. */
  batchedSectionsCount: number;
  /** (couvertes + non informatives) / total ; 1 pour un document sans unité. */
  coverageRatio: number;
  repairPassCount: number;
  chunkCount: number;
  qualityState: T1QualityState;
  /** Anomalies fonctionnelles (FACTS_TRUNCATED, PARTIAL_EXTRACTION, FACT_INVALID_DROPPED, SOURCE_UNIT_FAILED, COVERAGE_INCOMPLETE). */
  anomalies: string[];
}

export const T1_COMPLETENESS_ANOMALIES = [
  'FACTS_TRUNCATED', 'PARTIAL_EXTRACTION', 'FACT_INVALID_DROPPED', 'SOURCE_UNIT_FAILED', 'COVERAGE_INCOMPLETE',
] as const;

/** Segment de texte lu : passe principale ou lot de pages (décalage de page). */
export interface TextSegment {
  text: string;
  /** Pages du segment = décalage + page lue (1…n). */
  pageOffset: number;
  origin: SourceUnitOrigin;
}

/** Lot de pages non analysé (découpage en échec). */
export interface PageGap {
  pageStart: number;
  pageEnd: number;
  retryable: boolean;
  message: string;
}

/** Couche A complète d'une analyse, prête à persister. */
export interface SourceLayer {
  /** Version de l'algorithme de découpage / couverture. */
  layerVersion: number;
  units: CoveredSourceUnit[];
  unresolvedFacts: UnresolvedFactRecord[];
  report: T1CompletenessReport;
  /** Unités en échec réessayables (file de reprise). */
  retryable: boolean;
}

export const SOURCE_LAYER_VERSION = 1;
