/**
 * Provenance et preuves — CDC §5.4.
 *
 * Constat d'audit : `ai_field_updates` conserve une ancienne et une nouvelle
 * valeur, mais aucune chaîne de preuve. `field_evidence` comble ce manque.
 */
export type EvidenceConfidence = 'certain' | 'probable' | 'conflictual';

export type EvidenceStatus = 'active' | 'superseded' | 'rejected' | 'conflict';

/**
 * Cycle de vie d'une preuve (migration 0219, CDC 15 §14.4, T3-03), DISTINCT
 * de `EvidenceStatus` (décision de réconciliation) :
 *  - ACTIVE     : appartient à l'analyse courante de sa source ;
 *  - SUPERSEDED : remplacée par une nouvelle analyse de la même source
 *                 (trace conservée, jamais supprimée) ;
 *  - WITHDRAWN  : retirée (source détachée ou supprimée — lot 13).
 */
export type EvidenceLifecycleStatus = 'ACTIVE' | 'SUPERSEDED' | 'WITHDRAWN';
export const EVIDENCE_LIFECYCLE_STATUSES: readonly EvidenceLifecycleStatus[] = ['ACTIVE', 'SUPERSEDED', 'WITHDRAWN'];

/** Types de cible d'une preuve (CDC 15 T1-04) — mêmes codes que le contrat T1. */
export type EvidenceTargetType = 'ASSET' | 'EQUIPMENT' | 'ROOM' | 'DOCUMENT' | 'SUPPLIER' | 'GENERIC';

export type FieldOrigin =
  | 'USER'
  | 'DOCUMENT_EXTRACTION'
  | 'RECONCILIATION'
  | 'IMPORT'
  | 'SYSTEM_RULE'
  | 'ADMIN';

export type EvidenceSourceType = 'document' | 'web_link' | 'agenda' | 'equipment' | 'supplier' | 'user_input';

/** Localisation exacte de la preuve dans la source (page, section, sélecteur). */
export interface EvidenceLocation {
  page?: number;
  section?: string;
  /** Sélecteur CSS pour une source web. */
  selector?: string;
  /** Décalages caractères dans le texte extrait. */
  charStart?: number;
  charEnd?: number;
  /** Cellule de tableau d'où provient la valeur (T1-08). */
  table?: { index: number; row: number; column: number };
}

/** Valeur extraite accompagnée de sa preuve — utilisée dans SourceAnalysisResult. */
export interface EvidenceValue<T> {
  value: T;
  normalizedValue?: string;
  confidence: EvidenceConfidence;
  /** Extrait littéral justifiant la valeur. */
  excerpt: string;
  location: EvidenceLocation;
}

export interface FieldEvidenceInput {
  accountId: number;
  assetId: number;
  fieldKey: string;
  value: unknown;
  normalizedValue?: string;
  sourceType: EvidenceSourceType;
  sourceId: number;
  sourceVersion?: number;
  location: EvidenceLocation;
  /** Extrait littéral ; `null` pour une observation visuelle (aucune citation). */
  excerpt: string | null;
  /** TEXT_EXTRACTION (lu) | VISUAL_ANALYSIS (observé) — migration 0161. */
  evidenceOrigin?: 'TEXT_EXTRACTION' | 'VISUAL_ANALYSIS';
  visualEvidence?: Record<string, unknown> | null;
  documentType?: string;
  documentDate?: Date | null;
  provider?: string;
  model?: string;
  promptVersion?: string;
  confidence: EvidenceConfidence;
  authorityScore: number;
  operationTraceId?: string;

  // ── Migration 0219 — contrat T1 enrichi (CDC 15 T1-01, T1-03, T1-04) ─────
  // Optionnels : le chemin historique ne les renseigne pas, et leur absence
  // laisse l'empreinte et l'écriture strictement inchangées.

  /** Clé du registre canonique (égale à `fieldKey` dans le nouveau chemin). */
  canonicalKey?: string | null;
  canonicalUnit?: string | null;
  /** Valeur telle que lue, avant normalisation (texte). */
  rawValue?: string | null;
  /**
   * Cible réelle du fait. `assetId` reste le bien PORTEUR (parent d'un
   * équipement ou d'une pièce) ; absent = preuve du bien lui-même.
   */
  target?: {
    type: EvidenceTargetType;
    entityId: number | null;
    label: string | null;
    confidence: EvidenceConfidence;
  } | null;
  semanticEvent?: { type: string; nature: string } | null;
  recurrence?: Record<string, unknown> | null;
  projectionOrigin?: string | null;
  projectionRule?: string | null;
  /** Analyse (document_analysis_runs.id) ayant produit la preuve — cycle de vie. */
  analysisRunId?: number | null;
}

export interface FieldEvidence extends FieldEvidenceInput {
  id: number;
  status: EvidenceStatus;
  extractedAt: Date;
  /** NULL en base (avant 0219 ou ligne historique) = ACTIVE. */
  lifecycleStatus?: EvidenceLifecycleStatus;
}
