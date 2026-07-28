/**
 * Contrats du moteur de réconciliation — USAGE IA n°2, CDC §4.2.3.
 *
 * Ce moteur remplace à lui seul quatre traitements historiques :
 * suggestions à la demande, complétion des champs vides, enrichissement différé
 * et contrôle de cohérence. Critère d'acceptation n°8 : « un seul moteur
 * enrichit, contrôle et réconcilie les fiches ».
 */
import type { EvidenceConfidence, FieldOrigin } from '../evidence/evidence.types';

/** Décisions possibles pour un champ ou une liaison — CDC §4.2.3. */
export type ReconciliationAction =
  /** Champ vide : la valeur est écrite. */
  | 'apply'
  /** Champ déjà renseigné automatiquement : la valeur est remplacée. */
  | 'update'
  /** La valeur en place est conservée ; la preuve est rattachée. */
  | 'keep'
  /** Contradiction non résoluble : alimente « À arbitrer ». */
  | 'create_conflict'
  /** Cas ambigu : un appel modèle ciblé est justifié. */
  | 'request_ai_review'
  /** Rien à faire : aucune preuve exploitable. */
  | 'ignore';

export interface ReconciliationDecision {
  fieldKey: string;
  currentValue: unknown;
  proposedValue: unknown;
  action: ReconciliationAction;
  /** Code stable, testable et affichable — voir `reason-codes.ts`. */
  reasonCode: string;
  confidence: EvidenceConfidence;
  evidenceIds: number[];
  /** Score d'autorité de la preuve retenue, quand il y en a une. */
  sourcePriority?: number;
  /** true si la décision a été prise par règle, false si un modèle a tranché. */
  deterministic: boolean;
}

/** Valeur actuellement portée par la fiche. */
export interface CurrentValue {
  value: unknown;
  normalized: string | null;
  origin: FieldOrigin;
  updatedAt: Date | null;
  /**
   * Autorité de la preuve ayant produit la valeur, si elle est d'origine
   * automatique. Sans cette information, il est impossible de savoir si une
   * nouvelle preuve est meilleure : la décision se ferait à l'aveugle.
   */
  authorityScore?: number;
  /** Date du document ayant produit la valeur actuelle. */
  sourceDate?: Date | null;
}

/** Preuve candidate, déjà normalisée par le collecteur. */
export interface EvidenceCandidate {
  evidenceId: number;
  value: unknown;
  normalized: string | null;
  confidence: EvidenceConfidence;
  authorityScore: number;
  documentType: string | null;
  documentDate: Date | null;
  sourceId: number;
  excerpt: string;
}

/** Entrée du moteur de décision — aucune dépendance à la base. */
export interface DecisionInput {
  fieldKey: string;
  current: CurrentValue | null;
  candidates: EvidenceCandidate[];
  /** Champ soumis aux quatre conditions cumulatives du §4.2.6. */
  isCritical: boolean;
}

/** Synthèse d'une exécution du moteur sur un bien. */
export interface ReconciliationRun {
  runId: number;
  accountId: number;
  assetId: number;
  triggeredBy: string;
  decisions: ReconciliationDecision[];
  appliedCount: number;
  conflictCount: number;
  aiReviewCount: number;
  /** true si les décisions n'ont pas été écrites (§10.2). */
  shadow: boolean;
}
