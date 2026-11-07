/**
 * Lot 113W2 (Trello #724, décision PO du 07/11/2026) — Types de document dont
 * les dates délimitent une PÉRIODE DE COUVERTURE (attestation, certificat de
 * garantie, extension de garantie, avis d'échéance) : leur fin n'est JAMAIS
 * une fin de contrat. Seule une fin contractuelle explicite (contrat à durée
 * déterminée, résiliation, avenant de fin) peut dater la fin d'un contrat.
 *
 * Donnée de RÉFÉRENTIEL (Types V2, Annexe A) — jamais un libellé, un titre ni
 * un fournisseur : la nature du document est celle que T1 a classée (ou que
 * l'utilisateur a choisie). Un ancien code V1 est lu par sa correspondance
 * certaine (`resolveLegacyType`). Pure. Liste tenue ici (et non dans
 * `DOCUMENT_TYPES`) pour ne rien changer au référentiel transmis au prompt.
 */
import { resolveLegacyType } from './legacy-mapping';

export const COVERAGE_PERIOD_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'INSURANCE_CERTIFICATE', // Attestation d'assurance
  'INSURANCE_DUE_NOTICE', // Avis d'échéance d'assurance (échéancier de couverture)
  'WARRANTY_CERTIFICATE', // Garantie
  'EXTENDED_WARRANTY', // Extension de garantie
]);

/** Le Type (V2, ou V1 à correspondance certaine) délimite-t-il une période de couverture ? */
export function isCoveragePeriodDocumentType(code: string | null | undefined): boolean {
  if (!code) return false;
  if (COVERAGE_PERIOD_DOCUMENT_TYPES.has(code)) return true;
  const r = resolveLegacyType({ typeCode: code, userSelected: false });
  return r.verdict === 'MAPPED' && !!r.typeCode && COVERAGE_PERIOD_DOCUMENT_TYPES.has(r.typeCode);
}
