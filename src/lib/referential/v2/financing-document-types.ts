/**
 * Carte Trello #806, volet B §11 (partie T3) — Types de document qui
 * établissent un FINANCEMENT : contrat de prêt ou de crédit, échéancier de
 * financement, sûreté attachée au financement, contrat de financement / leasing
 * (LOA, LLD ou financement assimilé) — Types V2, rubrique « Gestion du bien ».
 *
 * Donnée de RÉFÉRENTIEL — jamais un libellé, un titre, un mot du document ni
 * un fournisseur : la nature du document est celle que T1 a classée (ou que
 * l'utilisateur a choisie). Un ancien code V1 est lu par sa correspondance
 * certaine (`resolveLegacyType`). Pure. Liste tenue ici (et non dans
 * `DOCUMENT_TYPES`) pour ne rien changer au référentiel transmis au prompt —
 * même choix que `insurance-contract-document-types.ts` (lot 116C).
 *
 * Un avis d'échéance d'assurance, une facture, un appel de charges, un rappel
 * de paiement portent eux aussi une « échéance » : ce ne sont PAS des pièces
 * de financement, et ils n'en font pas partie.
 */
import { resolveLegacyType } from './legacy-mapping';

export const FINANCING_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'FINANCING_CONTRACT', // Contrat de prêt / crédit lié au bien
  'FINANCING_SCHEDULE', // Échéancier de financement
  'FINANCING_GUARANTEE', // Hypothèque / garantie de financement
  'LEASING_FINANCING_CONTRACT', // Contrat de financement / leasing du bien (LOA, LLD)
]);

/** Le Type (V2, ou V1 à correspondance certaine) établit-il un financement ? */
export function isFinancingDocumentType(code: string | null | undefined): boolean {
  if (!code) return false;
  if (FINANCING_DOCUMENT_TYPES.has(code)) return true;
  const r = resolveLegacyType({ typeCode: code, userSelected: false });
  return r.verdict === 'MAPPED' && !!r.typeCode && FINANCING_DOCUMENT_TYPES.has(r.typeCode);
}
