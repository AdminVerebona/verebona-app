/**
 * Questions « À traiter » qu'une consolidation T3 des Opérations demande de
 * poser ou de fermer (lot 42, CDC Opérations V1 ch. 20, B19, C19). Pur
 * contrat de données entre le consolidateur (dans la transaction) et le
 * producteur des cartes (`to-process/operation-cards.ts`, APRÈS commit).
 *
 * Aucune carte n'est un écran de validation des Opérations : seules les
 * ambiguïtés à impact y arrivent (deux réalités plausibles pour un document,
 * parent Sinistre ambigu, montant contradictoire de même rôle).
 */

/** (a) Ce document concerne-t-il la même réalité que … ? */
export interface MatchCardNeed {
  fileId: number;
  candidateKey: string;
  /** CERTAIN : plusieurs rapprochements exacts incompatibles ; M3 : verdict sémantique ambigu. */
  basis: 'CERTAIN' | 'M3';
  /** Opérations proposées, par ordre de préférence. */
  operationIds: number[];
  /** Nature du candidat (libellé métier de la question). */
  typeHint: string | null;
}

/** (b) Cette intervention fait-elle suite à l'un de ces sinistres ? */
export interface ParentCardNeed {
  operationId: number;
  fileId: number;
  claimIds: number[];
}

/** (c) Deux documents indiquent des montants différents pour la même dépense. */
export interface AmountCardNeed {
  operationId: number;
  fileId: number;
  fingerprint: string;
  kind: string;
  options: Array<{ amountMinor: number; currency: string; fileIds: number[] }>;
  retained: { amountMinor: number; currency: string };
}

export interface OperationCardNeeds {
  match: MatchCardNeed[];
  /** Documents dont les candidats ont été évalués : leurs cartes (a) non reconduites se ferment. */
  reviewedFiles: number[];
  parent: ParentCardNeed[];
  amount: AmountCardNeed[];
  /** Opérations recalculées : leurs cartes (b) / (c) non reconduites se ferment. */
  reviewedOperations: number[];
}

export function emptyCardNeeds(): OperationCardNeeds {
  return { match: [], reviewedFiles: [], parent: [], amount: [], reviewedOperations: [] };
}
