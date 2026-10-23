/**
 * Questions « À traiter » qu'une consolidation T3 des Opérations demande de
 * poser ou de fermer (lot 42, CDC Opérations V1 ch. 20, B19, C19). Pur
 * contrat de données entre le consolidateur (dans la transaction) et le
 * producteur des cartes (`to-process/operation-cards.ts`, APRÈS commit).
 *
 * Aucune carte n'est un écran de validation des Opérations : seules les
 * ambiguïtés à impact y arrivent (deux réalités plausibles pour un document,
 * montant contradictoire de même rôle, devise, bien retiré d'un sinistre).
 * Lot 83D (CDC v5 §18.4, AC39) : plus de parent Sinistre ni de dissociation.
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

/** (c) Deux documents indiquent des montants différents pour la même dépense. */
export interface AmountCardNeed {
  operationId: number;
  fileId: number;
  fingerprint: string;
  kind: string;
  options: Array<{ amountMinor: number; currency: string; fileIds: number[] }>;
  retained: { amountMinor: number; currency: string };
}

/**
 * (e) Lot 53 (retour PO Q17) : bien retiré du sinistre par l'utilisateur,
 * cité par un nouveau document — « Faut-il le rattacher à nouveau ? ».
 */
export interface ExclusionCardNeed {
  operationId: number;
  assetId: number;
  /** Documents (non encore arbitrés) qui citent le bien ; le premier porte la carte. */
  fileIds: number[];
}

/** (d) Lot 53D (D2) : la devise de ce montant n'est pas écrite clairement sur le document. */
export interface CurrencyCardNeed {
  operationId: number;
  fileId: number;
  fingerprint: string;
  kind: string;
  amountMinor: number;
  /** Devises plausibles (au plus 3), à confirmer. */
  candidates: string[];
}

export interface OperationCardNeeds {
  match: MatchCardNeed[];
  /** Documents dont les candidats ont été évalués : leurs cartes (a) non reconduites se ferment. */
  reviewedFiles: number[];
  amount: AmountCardNeed[];
  /** Lot 53 (Q17). */
  exclusion: ExclusionCardNeed[];
  /** Lot 53D (D2). */
  currency: CurrencyCardNeed[];
  /** Opérations recalculées : leurs cartes (montant, exclusion, devise) non reconduites se ferment. */
  reviewedOperations: number[];
}

export function emptyCardNeeds(): OperationCardNeeds {
  return { match: [], reviewedFiles: [], amount: [], exclusion: [], currency: [], reviewedOperations: [] };
}
