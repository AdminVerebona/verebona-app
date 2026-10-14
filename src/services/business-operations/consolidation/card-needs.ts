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

/**
 * (d) Lot 53 (retour PO D11) : intervention rattachée à un sinistre par la
 * facture d'une action, facture retirée depuis, sans autre justification —
 * « Cette intervention fait-elle toujours suite au sinistre … ? ».
 */
export interface DetachCardNeed {
  operationId: number;
  claimId: number;
  fileId: number;
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
  parent: ParentCardNeed[];
  amount: AmountCardNeed[];
  /** Lot 53 (D11). */
  detach: DetachCardNeed[];
  /** Lot 53 (Q17). */
  exclusion: ExclusionCardNeed[];
  /** Lot 53D (D2). */
  currency: CurrencyCardNeed[];
  /** Opérations recalculées : leurs cartes (b) à (e) et devise non reconduites se ferment. */
  reviewedOperations: number[];
}

export function emptyCardNeeds(): OperationCardNeeds {
  return { match: [], reviewedFiles: [], parent: [], amount: [], detach: [], exclusion: [], currency: [], reviewedOperations: [] };
}
