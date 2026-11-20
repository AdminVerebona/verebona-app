/**
 * Lot 116C (carte Trello #806 §3) — Types de document qui établissent qu'un
 * contrat est un CONTRAT D'ASSURANCE : la police, l'attestation et l'avis
 * d'échéance de la rubrique « Assurances et sinistres » (Types V2, Annexe A).
 * Les pièces d'un SINISTRE (déclaration, constat, expertise, indemnisation,
 * courrier) n'en font pas partie : elles décrivent le sinistre, pas le contrat.
 *
 * Donnée de RÉFÉRENTIEL — jamais un libellé, un titre ni un fournisseur : la
 * nature du document est celle que T1 a classée (ou que l'utilisateur a
 * choisie). Un ancien code V1 est lu par sa correspondance certaine
 * (`resolveLegacyType`). Pure. Liste tenue ici (et non dans `DOCUMENT_TYPES`)
 * pour ne rien changer au référentiel transmis au prompt.
 */
import { resolveLegacyType } from './legacy-mapping';

export const INSURANCE_CONTRACT_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'INSURANCE_POLICY', // Contrat / police d'assurance
  'INSURANCE_CERTIFICATE', // Attestation d'assurance
  'INSURANCE_DUE_NOTICE', // Avis d'échéance d'assurance
]);

/** Le Type (V2, ou V1 à correspondance certaine) établit-il un contrat d'assurance ? */
export function isInsuranceContractDocumentType(code: string | null | undefined): boolean {
  if (!code) return false;
  if (INSURANCE_CONTRACT_DOCUMENT_TYPES.has(code)) return true;
  const r = resolveLegacyType({ typeCode: code, userSelected: false });
  return r.verdict === 'MAPPED' && !!r.typeCode && INSURANCE_CONTRACT_DOCUMENT_TYPES.has(r.typeCode);
}
