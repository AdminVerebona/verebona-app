/**
 * Provenance et preuves — CDC §5.4.
 *
 * Constat d'audit : `ai_field_updates` conserve une ancienne et une nouvelle
 * valeur, mais aucune chaîne de preuve. `field_evidence` comble ce manque.
 */
export type EvidenceConfidence = 'certain' | 'probable' | 'conflictual';

export type EvidenceStatus = 'active' | 'superseded' | 'rejected' | 'conflict';

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
  excerpt: string;
  documentType?: string;
  documentDate?: Date | null;
  provider?: string;
  model?: string;
  promptVersion?: string;
  confidence: EvidenceConfidence;
  authorityScore: number;
  operationTraceId?: string;
}

export interface FieldEvidence extends FieldEvidenceInput {
  id: number;
  status: EvidenceStatus;
  extractedAt: Date;
}
