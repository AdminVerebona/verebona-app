/**
 * Lot 113AL — effet d'un montant arbitré, tel que le moteur existant le traite
 * (évaluateur du corpus maître et tests) : la ligne produite par
 * `semanticDraft` à partir de l'effet validé. Pur.
 *   · status : statut de la ligne (`ENGINE` : coût évalué par le moteur —
 *     retenu, non attribué, prévision… selon ses règles habituelles) ;
 *   · reason : motif de la ligne (null pour une ligne évaluée par le moteur).
 */
import { semanticDraft, type SemanticQualification } from '../../finance/semantic-qualification';
import type { DocumentLineDraft, EconomicDocumentInput } from '../../finance/economic-lines';
import type { QualificationEffect, RawQualificationContext } from './contract';

export function qualificationEffectStatus(raw: RawQualificationContext, e: QualificationEffect): { status: string; reason: string | null } {
  const cible = raw.documents.find((d) => d.id === raw.targetFileId);
  const doc: EconomicDocumentInput = {
    fileId: raw.targetFileId, title: cible?.title ?? 'Document', typeCode: cible?.type ?? null, legacyType: null, date: cible?.date ?? null,
    supplier: cible?.provider ?? null, amountCents: e.amountMinor, currency: e.currency, userEditedAmount: false, hash: null, state: null,
    ignoredWith: null, linkedAssetIds: [raw.asset.id], multiAsset: cible?.multiAsset === true, candidates: [], operations: [],
  };
  const base: DocumentLineDraft = {
    lineId: `doc:${raw.targetFileId}`, fileId: raw.targetFileId, candidateId: null, title: doc.title, kind: null, role: 'REALIZED_COST',
    amountMinor: e.amountMinor, currency: e.currency, amountEurCents: null, date: doc.date, periodStart: null, periodEnd: null,
    targetAssetId: null, targetEquipmentId: null, assetIds: [raw.asset.id], typeHint: null, theme: null, scope: null, provenance: 'DOCUMENT',
    operationId: null, operationLabel: null, status: null, reason: null, relatedFileId: null, note: null, supplierKey: null, invoiceRefs: [],
  };
  const q: SemanticQualification = { ...e, reviewId: 0, decidedAt: '', contractVersion: '', promptVersion: null, model: null };
  const d = semanticDraft(doc, base, q);
  if (!d) return { status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN' };
  if (d.status === null) return { status: d.assetIds.includes(-1) ? 'UNALLOCATED' : 'ENGINE', reason: null };
  return { status: d.status, reason: d.reason };
}
