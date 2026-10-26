/**
 * Prix d'achat lu dans un candidat Opération T1 (lot 76J, T3-COH-02 / 03 /
 * 06) — règle PURE.
 *
 * T1 produit, pour un document, des preuves de champ (`field_evidence`) ET
 * des candidats Opération structurés (`document_operation_candidates` :
 * nature, cibles vérifiées, montants ancrés sur un fait cité). Un acte de
 * vente peut porter le prix de l'acquisition dans son candidat sans preuve
 * `acquisitionPrice` projetée : la fiche restait vide alors que Verebona
 * possédait l'information.
 *
 * Un montant n'est retenu comme prix d'achat que s'il est EXPLICITEMENT
 * attribuable à l'acquisition de la cible :
 *   · candidat ÉTABLI, CERTAIN, actif, de nature ACQUISITION réalisée (une
 *     facture de travaux est une INTERVENTION : jamais un prix d'achat) ;
 *   · cible unique VÉRIFIÉE : l'équipement (un seul, du bien) quand le
 *     candidat en vise un — jamais alors le bien parent —, sinon le bien
 *     lui-même ; aucune pièce ;
 *   · un seul montant de coût réalisé TOTAL en euros, ancré sur un fait
 *     persisté (extrait littéral exigé par la barrière des champs
 *     critiques) ;
 *   · document capable d'établir un achat (catalogue documentaire :
 *     `purchase`) ; pour un BIEN IMMOBILIER, seulement un document faisant
 *     autorité (acte, compromis) — une facture ne fait jamais le prix d'une
 *     maison.
 * Le prix retenu devient une preuve ordinaire du champ, décidée par le
 * moteur commun (autorité, champ critique, préséance USER/ADMIN).
 */
import { resolveDocumentType, toAssetFamily } from '@/services/canonical/registry';

export const T3_OPERATION_PRICE_RULE = 'T3_ACQUISITION_OPERATION_PRICE';

export interface OperationCandidateRow {
  id: number;
  fileId: number;
  analysisRunId: number | null;
  typeHint: string | null;
  statusHint: string | null;
  established: boolean;
  confidence: string;
  documentType: string | null;
  payload: Record<string, unknown>;
}

export type PriceTarget = { type: 'ASSET'; id: number } | { type: 'EQUIPMENT'; id: number };

type PriceSelection =
  | { ok: true; target: PriceTarget; amountMinor: number; factId: number }
  | { ok: false; reason: string };

interface Hint { type?: unknown; entityId?: unknown; confidence?: unknown }
interface Fin { role?: unknown; amountMinor?: unknown; currency?: unknown; amountScope?: unknown; evidence?: { factId?: unknown } | null }

export function selectAcquisitionPrice(
  c: OperationCandidateRow,
  ctx: { assetId: number; category: string | null; equipmentIds: readonly number[] },
): PriceSelection {
  if (!c.established || c.confidence !== 'certain') return { ok: false, reason: 'NOT_ESTABLISHED_CERTAIN' };
  if (c.typeHint !== 'ACQUISITION') return { ok: false, reason: 'NOT_ACQUISITION' };
  if (c.statusHint && c.statusHint !== 'REALIZED') return { ok: false, reason: 'NOT_REALIZED' };

  const hints = (Array.isArray(c.payload.targetHints) ? c.payload.targetHints : []) as Hint[];
  if (hints.some((h) => h.type === 'ROOM')) return { ok: false, reason: 'ROOM_TARGET' };
  const equipements = hints.filter((h) => h.type === 'EQUIPMENT');
  let target: PriceTarget;
  if (equipements.length > 0) {
    const ids = [...new Set(equipements.map((h) => Number(h.entityId)).filter((n) => Number.isInteger(n) && n > 0))];
    if (equipements.length !== 1 || ids.length !== 1) return { ok: false, reason: 'EQUIPMENT_TARGET_AMBIGUOUS' };
    if (!ctx.equipmentIds.includes(ids[0])) return { ok: false, reason: 'EQUIPMENT_NOT_OF_ASSET' };
    if (equipements[0].confidence !== 'certain') return { ok: false, reason: 'TARGET_NOT_CERTAIN' };
    target = { type: 'EQUIPMENT', id: ids[0] };
  } else {
    const biens = hints.filter((h) => h.type === 'ASSET');
    if (biens.length !== 1 || Number(biens[0].entityId) !== ctx.assetId) return { ok: false, reason: 'ASSET_TARGET_NOT_VERIFIED' };
    if (biens[0].confidence !== 'certain') return { ok: false, reason: 'TARGET_NOT_CERTAIN' };
    target = { type: 'ASSET', id: ctx.assetId };
  }

  const entree = resolveDocumentType(c.documentType ?? '');
  if (!entree || !(entree.businessTypes as readonly string[]).includes('purchase')) return { ok: false, reason: 'DOCUMENT_NOT_PURCHASE' };
  if (target.type === 'ASSET' && toAssetFamily(ctx.category) === 'IMMOBILIER' && entree.authority !== 'AUTHORITATIVE') {
    return { ok: false, reason: 'REAL_ESTATE_NEEDS_AUTHORITATIVE_DOCUMENT' };
  }

  const fins = ((Array.isArray(c.payload.financialHints) ? c.payload.financialHints : []) as Fin[])
    .filter((f) => f.role === 'REALIZED_COST');
  const retenus = fins.filter((f) => f.currency === 'EUR' && (f.amountScope === 'TOTAL' || f.amountScope == null)
    && Number.isInteger(f.amountMinor) && Number(f.amountMinor) > 0);
  const montants = [...new Set(retenus.map((f) => Number(f.amountMinor)))];
  if (montants.length !== 1 || retenus.length !== fins.length) return { ok: false, reason: 'AMOUNT_NOT_UNIQUE_EUR_TOTAL' };
  const factId = Number(retenus[0].evidence?.factId);
  if (!Number.isInteger(factId) || factId <= 0) return { ok: false, reason: 'AMOUNT_NOT_ANCHORED' };
  return { ok: true, target, amountMinor: montants[0], factId };
}
