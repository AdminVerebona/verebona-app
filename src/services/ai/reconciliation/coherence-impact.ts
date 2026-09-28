/**
 * Événements à impact de cohérence — CDC BO IA T3-004.
 *
 * « Ne pas déclencher T3 après chaque modification utilisateur » ;
 * « uniquement événements à impact de cohérence identifiés dans le code » ;
 * « édition sans impact ne déclenche pas ».
 *
 * Une modification de bien n'est un événement T3 que si elle touche :
 *   · un champ STRUCTURANT (liste ci-dessous : identité, localisation,
 *     acquisition, contrats, garanties, statut) ;
 *   · ou un champ pour lequel des preuves documentaires actives existent
 *     (`field_evidence`) : c'est précisément ce que T3 rapproche.
 * Notes, description, valorisation, préférences d'affichage, acquittement
 * d'alertes… ne déclenchent rien.
 */
import { CRITICAL_FIELDS } from './decision/critical-fields';

export const STRUCTURAL_ASSET_FIELDS: ReadonlySet<string> = new Set<string>([
  ...CRITICAL_FIELDS,
  'address', 'status', 'subCategory',
  // Identifiants d'objet et de contrat.
  'vin', 'serialNumber', 'chassisNumber', 'iban', 'contractNumber', 'policyNumber',
  // Acquisition, garanties, contrats, assurance.
  'acquisitionDate', 'purchaseDate', 'warrantyEndDate', 'warrantyStartDate',
  'contractStartDate', 'contractEndDate', 'insurer', 'insurancePremium',
  // Caractéristiques qui conditionnent les échéances et les rapprochements.
  'brand', 'model', 'constructionYear', 'firstRegistrationDate', 'energyClass',
  'occupancyStatus', 'ownershipStatus', 'surface', 'livingArea',
]);

/** Clés techniques ou d'affichage : jamais un impact de cohérence. */
const IGNORED = /(__?origin|^dismissedCoherenceAlerts$|^coherenceAlerts$|^valuationHistory$)/;

/** Pur : champs structurants parmi les champs modifiés. */
export function structuralFieldsIn(fields: string[]): string[] {
  return fields.filter((f) => !IGNORED.test(f) && STRUCTURAL_ASSET_FIELDS.has(f));
}

async function evidenceFields(accountId: number, assetId: number): Promise<string[]> {
  const { pgClient } = await import('@/db');
  const rows = await pgClient.unsafe(
    `SELECT DISTINCT field_key FROM field_evidence
      WHERE account_id = $1 AND asset_id = $2 AND status = 'active'`,
    [accountId, assetId] as never[],
  );
  return (rows as unknown as Array<{ field_key: string }>).map((r) => r.field_key);
}

/**
 * La modification a-t-elle un impact de cohérence ? En cas de doute (base
 * illisible), OUI : mieux vaut un contrôle de trop qu'une incohérence
 * manquée — T3 fusionne de toute façon les événements rapprochés.
 */
export async function hasCoherenceImpact(
  accountId: number, assetId: number, fields: string[],
  loadEvidenceFields: (accountId: number, assetId: number) => Promise<string[]> = evidenceFields,
): Promise<boolean> {
  const candidats = fields.filter((f) => !IGNORED.test(f));
  if (candidats.length === 0) return false;
  if (structuralFieldsIn(candidats).length > 0) return true;
  try {
    const prouves = new Set(await loadEvidenceFields(accountId, assetId));
    return candidats.some((f) => prouves.has(f));
  } catch {
    return true;
  }
}
