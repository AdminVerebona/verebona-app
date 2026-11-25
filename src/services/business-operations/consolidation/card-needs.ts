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
interface MatchCardNeed {
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
interface AmountCardNeed {
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
interface ExclusionCardNeed {
  operationId: number;
  assetId: number;
  /** Documents (non encore arbitrés) qui citent le bien ; le premier porte la carte. */
  fileIds: number[];
}

/** (d) Lot 53D (D2) : la devise de ce montant n'est pas écrite clairement sur le document. */
interface CurrencyCardNeed {
  operationId: number;
  fileId: number;
  fingerprint: string;
  kind: string;
  amountMinor: number;
  /** Devises plausibles (au plus 3), à confirmer. */
  candidates: string[];
}

/**
 * (f) Lot 114 (Trello #750, issue C) : contradiction RÉELLE d'un attribut (prestataire, date) entre sources du
 * même fait, que ni les preuves ni l'arbitrage T3 ne départagent — « laquelle est la bonne ? ».
 */
export interface AttributeCardNeed {
  operationId: number;
  /**
   * Document le plus récent parmi ceux qui portent une des valeurs : il porte
   * la carte. Lot 115 (#791, E06) : `null` quand AUCUN document n'est
   * associable (sources structurées, imports, pièce supprimée) — la carte est
   * alors portée par un ÉVÉNEMENT RÉEL de l'Agenda de cet événement de
   * référence ; aucun document n'est inventé, et sans objet réel il n'y a pas
   * de carte (jamais un faux succès).
   */
  fileId: number | null;
  field: 'plannedDate' | 'startDate' | 'realizedDate' | 'endDate' | 'provider';
  /** Rôle sémantique comparé (même fait). */
  role: string;
  reasonCode: string;
  /**
   * TOUTES les valeurs réellement différentes (y compris au-delà de la
   * troisième), avec leurs documents. Carte #836 (écart E06) : aucune n'est
   * retirée ici, et aucune n'est retirée à la construction des propositions —
   * seul l'AFFICHAGE est paginé (identifiants stables), si bien que toute
   * valeur réelle reste sélectionnable.
   */
  options: Array<{ value: string; normalized: string; fileIds: number[] }>;
  /** Valeur actuellement portée par l'événement de référence (jamais écrasée avant la réponse). */
  retained: string | null;
  /**
   * Carte #836 (écarts E06 et E07) : périmètre MATÉRIEL des preuves présenté à
   * la question (`evidenceScopeKeyOf`) — enregistré avec la réponse de
   * l'utilisateur. Une preuve matériellement nouvelle lui vaudra une question
   * ciblée au lieu d'un écrasement silencieux de son choix.
   */
  evidenceKey?: string;
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
  /** Lot 114 (#750). */
  attribute: AttributeCardNeed[];
  /** Opérations recalculées : leurs cartes (montant, exclusion, devise) non reconduites se ferment. */
  reviewedOperations: number[];
}

export function emptyCardNeeds(): OperationCardNeeds {
  return { match: [], reviewedFiles: [], amount: [], exclusion: [], currency: [], attribute: [], reviewedOperations: [] };
}
