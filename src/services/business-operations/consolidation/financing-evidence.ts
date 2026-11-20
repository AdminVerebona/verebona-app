/**
 * Carte Trello #806, volet B §11 (partie T3) — PREUVE D'UN FINANCEMENT (pure).
 *
 * T1 propose un type pour chaque réalité lue sur un document (`typeHint`).
 * « Financement » (FINANCING) était repris tel quel : un document qui porte
 * une simple « échéance » — avis d'échéance d'assurance, facture à payer,
 * appel de charges — pouvait donc devenir un PRÊT, entrer dans la catégorie
 * « Financement » du coût de possession et y être présumé honoré comme une
 * échéance contractuelle.
 *
 * Règle : le type « Financement » n'est retenu que s'il est PROUVÉ par un
 * référentiel EXISTANT — aucune liste de mots, aucun libellé, aucun nom de
 * banque, rien de codé en dur ici :
 *   · `DOCUMENT_TYPE`  — le Type du document est une pièce de financement
 *                        (`lib/referential/v2/financing-document-types.ts` :
 *                        prêt, crédit, échéancier de financement, sûreté,
 *                        leasing / LOA / LLD) ;
 *   · `LOAN_REFERENCE` — la réalité cite une référence de PRÊT (nature `LOAN`
 *                        du référentiel des références métier, `REFERENCE_KINDS`) ;
 *   · `LOAN_PRINCIPAL` — elle porte un CAPITAL EMPRUNTÉ (rôle `LOAN_PRINCIPAL`
 *                        du référentiel des rôles de montant, établi par T1
 *                        et par la règle du lot 53D).
 * Sans aucune de ces preuves : le type n'est PAS « Financement ». Il devient
 * « non qualifié » (jamais « Autre » par défaut, jamais un autre type deviné) :
 * la réalité reste créée, rattachée et comptée selon les règles existantes des
 * types non qualifiés — notamment l'échéance d'un contrat (lot 55B), qui
 * rejoint son contrat par ses références.
 *
 * Ne touche ni au stock (une opération déjà typée « Financement » n'est jamais
 * requalifiée d'office : l'utilisateur corrige le type depuis la fiche), ni
 * aux prompts : la règle vaut que le bloc facultatif du PO soit appliqué ou non.
 */
import { isFinancingDocumentType } from '@/lib/referential/v2/financing-document-types';

export type FinancingEvidence = 'DOCUMENT_TYPE' | 'LOAN_REFERENCE' | 'LOAN_PRINCIPAL';

/** Nature de référence et rôle de montant qui prouvent un prêt (valeurs des référentiels existants). */
export const LOAN_REFERENCE_KIND = 'LOAN';
export const LOAN_PRINCIPAL_ROLE = 'LOAN_PRINCIPAL';

export interface FinancingEvidenceInput {
  /** Type du document (V2, ou V1 à correspondance certaine) ; null : inconnu. */
  documentTypeCode: string | null | undefined;
  /** Natures des références métier citées par la réalité. */
  referenceKinds: ReadonlyArray<string | null | undefined>;
  /** Rôles des montants portés par la réalité. */
  hintRoles: ReadonlyArray<string | null | undefined>;
}

/** Première preuve de financement trouvée, dans l'ordre document → référence → capital ; null : aucune. */
export function financingEvidenceOf(i: FinancingEvidenceInput): FinancingEvidence | null {
  if (isFinancingDocumentType(i.documentTypeCode)) return 'DOCUMENT_TYPE';
  if (i.referenceKinds.some((k) => k === LOAN_REFERENCE_KIND)) return 'LOAN_REFERENCE';
  if (i.hintRoles.some((r) => r === LOAN_PRINCIPAL_ROLE)) return 'LOAN_PRINCIPAL';
  return null;
}

/**
 * Indice de type RETENU (pur) : `FINANCING` sans preuve → null (« non
 * qualifié ») ; tout autre indice est rendu tel quel. La casse et les espaces
 * de l'indice sont ceux que T1 a écrits (comparaison normalisée).
 */
export function provenTypeHint<T extends string | null | undefined>(typeHint: T, i: FinancingEvidenceInput): T | null {
  if (typeof typeHint !== 'string' || typeHint.trim().toUpperCase() !== 'FINANCING') return typeHint;
  return financingEvidenceOf(i) === null ? null : typeHint;
}
