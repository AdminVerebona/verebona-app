/**
 * Carte #819 — commande → facture : rattachement au bien par l'opération et date principale. Règles PURES (aucune base).
 *
 *   C819-U-01  appartenance → bien désigné : un seul bien, porté par une autre preuve ; plusieurs biens, désaccord, bien circulaire : rien
 *   C819-U-02  décision `OPERATION_ASSET` : garde-fous (autre bien désigné, multibiens, refus, bien disparu)
 *   C819-U-03  empreinte du contexte : inchangée sans bien désigné par l'opération, modifiée dès qu'il y en a un
 *   C819-U-04  justification du lien : relation structurelle, admise par la garde partagée (#739)
 *   C819-U-05  identité T3 : pièce de commande et date du document, pour un ACHAT seulement
 *   C819-U-06  date principale : date de la facture à l'arrivée de la facture concordante (commande payée ou non, date proposée par le modèle)
 *   C819-U-07  limites de la règle : commande seule, plusieurs factures, acompte, facture antérieure, événement réel, autres types
 *   C819-U-08  provenance et contradictions : source = la facture ; aucune contradiction commande / facture
 */
import { describe, expect, it } from 'vitest';
import {
  decideFromOperation, operationAttachmentOf, operationOfReason, NO_OPERATION_ATTACHMENT,
  type OperationAttachment, type OperationMembership,
} from '@/services/ai/reconciliation/document-asset/operation-inheritance';
import { documentAssetContextFingerprint } from '@/services/ai/reconciliation/document-asset/context';
import { documentAssetLinkJustification } from '@/services/ai/reconciliation/document-asset/link-justification';
import { admitDocumentAssetLink } from '@/services/documents/document-asset-links/admission';
import type { DocumentAssetCandidate } from '@/services/ai/reconciliation/document-asset/decision';
import {
  buildCandidateIdentity, computeProvenance, consolidateOperationState, invoiceAfterOrder, INVOICE_DOCUMENT_DATE_ORIGIN,
  type CandidateIdentity, type CandidateRecord, type SourceContribution,
} from '../consolidation/model';

const AUJ = '2026-11-20';
const COMMANDE = '2026-11-17';
const FACTURE = '2026-11-20';

// ── Rattachement par l'opération ─────────────────────────────────────────────

const membre = (operationId: number, assets: Array<[number, boolean?]>, via: OperationMembership['via'] = 'SOURCE'): OperationMembership =>
  ({ operationId, via, assets: assets.map(([assetId, ownSupport]) => ({ assetId, ownSupport: ownSupport === true })) });
const candidat = (o: Partial<DocumentAssetCandidate> & { assetId: number }): DocumentAssetCandidate => ({
  name: `Bien ${o.assetId}`, family: 'OBJET', subtype: null, identifiers: {}, serverSignals: [], t1: null, currentRole: null, ...o,
});
const cible = (assetId = 18, operationId = 116): OperationAttachment => operationAttachmentOf([membre(operationId, [[assetId]])]);
const opts = { multiAssetDeclared: false, identifiedAssetIds: [] as number[], isLiveAsset: () => true };

describe('C819-U-01 — bien désigné au document par ses opérations', () => {
  it('aucune appartenance : rien, et aucune part d’empreinte', () => {
    expect(operationAttachmentOf([])).toEqual(NO_OPERATION_ATTACHMENT);
  });
  it('une opération, UN bien porté par une autre preuve : ce bien (cas réel : facture 395 → opération 116 → bien 18)', () => {
    const a = operationAttachmentOf([membre(116, [[18]])]);
    expect(a).toMatchObject({ status: 'TARGET', targetAssetId: 18, operationId: 116, operationIds: [116] });
    expect(a.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });
  it('rattachement explicite de l’utilisateur à l’opération : même règle', () => {
    expect(operationAttachmentOf([membre(116, [[18]], 'USER_MEMBER')])).toMatchObject({ status: 'TARGET', targetAssetId: 18 });
  });
  it('opération à PLUSIEURS biens : aucun n’est désigné', () => {
    expect(operationAttachmentOf([membre(116, [[18], [19]])])).toMatchObject({ status: 'SEVERAL_ASSETS', targetAssetId: null, fingerprint: null });
  });
  it('opération sans bien, ou bien que l’opération ne tient QUE de ce document (jamais circulaire) : rien', () => {
    expect(operationAttachmentOf([membre(116, [])])).toMatchObject({ status: 'NO_ASSET', fingerprint: null });
    expect(operationAttachmentOf([membre(116, [[18, true]])])).toMatchObject({ status: 'NO_ASSET', targetAssetId: null, fingerprint: null });
  });
  it('plusieurs opérations : même bien → ce bien (la plus ancienne fonde l’héritage) ; biens différents → désaccord', () => {
    expect(operationAttachmentOf([membre(120, [[18]]), membre(116, [[18]])])).toMatchObject({ status: 'TARGET', targetAssetId: 18, operationId: 116, operationIds: [116, 120] });
    expect(operationAttachmentOf([membre(116, [[18]]), membre(120, [[19]])])).toMatchObject({ status: 'OPERATIONS_DISAGREE', targetAssetId: null });
    // Une opération sans bien n'empêche pas l'autre de désigner le sien ; un bien que le document porte lui-même ailleurs, si.
    expect(operationAttachmentOf([membre(116, [[18]]), membre(120, [])])).toMatchObject({ status: 'TARGET', targetAssetId: 18 });
    expect(operationAttachmentOf([membre(116, [[18]]), membre(120, [[19, true]])])).toMatchObject({ status: 'OPERATIONS_DISAGREE' });
  });
  it('déterministe : l’ordre des appartenances est indifférent', () => {
    const a = [membre(120, [[18]]), membre(116, [[18]])];
    expect(operationAttachmentOf(a)).toEqual(operationAttachmentOf([...a].reverse()));
  });
});

describe('C819-U-02 — décision OPERATION_ASSET et garde-fous', () => {
  it('bien désigné, aucun autre indice : rattachement déterministe, motif `OPERATION_ASSET:<opération>`', () => {
    const d = decideFromOperation(cible(), [], opts);
    expect(d).toEqual({ kind: 'APPLY', assetId: 18, score: 1, method: 'DETERMINISTIC', reason: 'OPERATION_ASSET:116' });
    expect(operationOfReason(d && d.kind === 'APPLY' ? d.reason : null)).toBe(116);
  });
  it('sans appartenance, sans bien désigné, contexte sans lecture de l’opération : aucune décision', () => {
    expect(decideFromOperation(NO_OPERATION_ATTACHMENT, [], opts)).toBeNull();
    expect(decideFromOperation(operationAttachmentOf([membre(116, [[18], [19]])]), [], opts)).toBeNull();
    expect(decideFromOperation(null, [], opts)).toBeNull();
    expect(decideFromOperation(undefined, [], opts)).toBeNull();
  });
  it('le document désigne lui-même un AUTRE bien (identifiant, fait ciblé, référence partagée, T1 certain) : jamais tranché ici', () => {
    expect(decideFromOperation(cible(), [], { ...opts, identifiedAssetIds: [19] })).toBeNull();
    for (const sources of [['FACT_TARGET'], ['STRONG_IDENTIFIER'], ['SHARED_REFERENCE']] as const) {
      expect(decideFromOperation(cible(), [candidat({ assetId: 19, sources: [...sources] })], opts), sources[0]).toBeNull();
    }
    const t1 = (confidence: string) => candidat({ assetId: 19, sources: ['T1_CANDIDATE'], t1: { confidence, score: 0.9, reason: 'r', signals: 's' } });
    expect(decideFromOperation(cible(), [t1('certain')], opts)).toBeNull();
    // Un autre bien seulement cité (nom, contexte, T1 probable) n'empêche pas l'opération de répondre.
    expect(decideFromOperation(cible(), [t1('probable'), candidat({ assetId: 20, sources: ['CONTEXTUAL_MATCH'] })], opts)).toMatchObject({ kind: 'APPLY', assetId: 18 });
    // Le même bien désigné aussi par le document : rien ne s'oppose.
    expect(decideFromOperation(cible(), [candidat({ assetId: 18, sources: ['FACT_TARGET'] })], { ...opts, identifiedAssetIds: [18] })).toMatchObject({ kind: 'APPLY', assetId: 18 });
  });
  it('document multibiens, bien refusé par l’utilisateur, bien disparu : aucune décision', () => {
    expect(decideFromOperation(cible(), [], { ...opts, multiAssetDeclared: true })).toBeNull();
    expect(decideFromOperation(cible(), [], { ...opts, refusedAssetIds: [18] })).toBeNull();
    expect(decideFromOperation(cible(), [], { ...opts, isLiveAsset: () => false })).toBeNull();
  });
  it('seul un motif exact est reconnu comme rattachement par l’opération', () => {
    for (const r of ['OPERATION_ASSET:', 'OPERATION_ASSET:x', 'GROUP_IDENTITY_ATTESTED:OPERATION', 'facture OPERATION_ASSET:116', null, undefined]) expect(operationOfReason(r), String(r)).toBeNull();
  });
});

describe('C819-U-03 — empreinte du contexte', () => {
  const base = { documentDigest: 'd', candidates: [], candidateIdentifiers: {}, matches: [] };
  it('sans bien désigné par l’opération : empreinte IDENTIQUE à celle d’avant la carte (aucune réévaluation, aucune mémoire invalidée)', () => {
    const avant = documentAssetContextFingerprint(base);
    expect(documentAssetContextFingerprint({ ...base, operation: null })).toBe(avant);
    expect(documentAssetContextFingerprint({ ...base, operation: NO_OPERATION_ATTACHMENT.fingerprint })).toBe(avant);
    expect(documentAssetContextFingerprint({ ...base, operation: operationAttachmentOf([membre(116, [[18], [19]])]).fingerprint })).toBe(avant);
  });
  it('bien désigné : empreinte modifiée (l’abstention mémorisée n’est plus réutilisée) ; autre bien ou autre opération : autre empreinte', () => {
    const avant = documentAssetContextFingerprint(base);
    const a = documentAssetContextFingerprint({ ...base, operation: cible(18, 116).fingerprint });
    expect(a).not.toBe(avant);
    expect(documentAssetContextFingerprint({ ...base, operation: cible(19, 116).fingerprint })).not.toBe(a);
    expect(documentAssetContextFingerprint({ ...base, operation: cible(18, 117).fingerprint })).not.toBe(a);
    expect(documentAssetContextFingerprint({ ...base, operation: cible(18, 116).fingerprint })).toBe(a);
  });
});

describe('C819-U-04 — justification du lien hérité', () => {
  it('relation structurelle par l’opération : admise par la garde partagée, preuve décisive tracée', () => {
    const j = documentAssetLinkJustification({
      assetId: 18, decision: { kind: 'APPLY', assetId: 18, score: 1, method: 'DETERMINISTIC', reason: 'OPERATION_ASSET:116' }, branch: 'OPERATION',
      candidates: [], identification: { matches: [] }, qualifications: [], identity: null, facts: [], texts: [],
    });
    expect(j).toEqual({ step: 'T3_DOCUMENT_ASSET', rule: 'OPERATION:OPERATION_ASSET:116', proofs: [{ kind: 'STRUCTURAL', detail: 'OPERATION_MEMBERSHIP:116' }] });
    expect(admitDocumentAssetLink('AI', j)).toMatchObject({ admitted: true, reasonCode: 'PROOF', decisiveProof: { kind: 'STRUCTURAL', detail: 'OPERATION_MEMBERSHIP:116' } });
  });
  it('une décision du MODÈLE dont le texte commence par le motif n’est jamais lue comme un rattachement par l’opération', () => {
    const j = documentAssetLinkJustification({
      assetId: 18, decision: { kind: 'APPLY', assetId: 18, score: 0.9, method: 'AI', reason: 'OPERATION_ASSET:116' }, branch: 'SEMANTIC',
      candidates: [], identification: { matches: [] }, qualifications: [], identity: null, facts: [], texts: [],
    });
    expect(j.proofs.some((p) => p.kind === 'STRUCTURAL')).toBe(false);
    expect(admitDocumentAssetLink('AI', j).admitted).toBe(false);
  });
});

// ── Date principale ──────────────────────────────────────────────────────────

const persiste = (over: Partial<CandidateRecord> & { payload?: CandidateRecord['payload'] } = {}): CandidateRecord => ({
  id: 1, accountId: 1, fileId: 50, candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: 'REALIZED',
  summary: 'Coussin pour siège enfant',
  payload: { sourceRoleHint: 'INVOICE', financialHints: [{ role: 'REALIZED_COST', amountMinor: 999, currency: 'EUR', amountScope: 'TOTAL' }] as never },
  ...over,
});
const ctx = (type: string | null, date: string | null) =>
  ({ fileAssetId: 18, liveAssetIds: new Set([18]), equipmentAssets: new Map<number, number>(), fileDocumentTypeCode: type, fileDocumentDate: date, today: AUJ });
/** Bon de commande (document classé pièce de commande ; rôle proposé « facture », comme dans le cas réel). `paye` : paiement daté lu sur le bon. */
const bon = (o: { paye?: boolean; date?: string | null; realizedDate?: string; fileId?: number } = {}): CandidateIdentity => buildCandidateIdentity(persiste({
  fileId: o.fileId ?? 50,
  payload: {
    sourceRoleHint: 'INVOICE', ...(o.realizedDate ? { temporalHints: { realizedDate: o.realizedDate } } : {}),
    financialHints: [
      { role: 'REALIZED_COST', amountMinor: 999, currency: 'EUR', amountScope: 'TOTAL', ...(o.paye ? { economicDate: COMMANDE } : {}) },
      ...(o.paye ? [{ role: 'PAYMENT', amountMinor: 999, currency: 'EUR', amountScope: 'TOTAL', economicDate: COMMANDE }] : []),
    ] as never,
  },
}), ctx('ACQUISITION_ORDER', o.date === undefined ? COMMANDE : o.date));
/** Facture. `dateAchat` : date de réalisation proposée par le modèle (souvent la date de commande). */
const facture = (o: { dateAchat?: string | null; date?: string | null; fileId?: number; role?: string; scope?: string; id?: number } = {}): CandidateIdentity => buildCandidateIdentity(persiste({
  id: o.id ?? 2, fileId: o.fileId ?? 51,
  payload: {
    sourceRoleHint: o.role ?? 'INVOICE', ...(o.dateAchat === null ? {} : { temporalHints: { realizedDate: o.dateAchat ?? COMMANDE } }),
    financialHints: [{ role: 'REALIZED_COST', amountMinor: 999, currency: 'EUR', amountScope: o.scope ?? 'TOTAL', economicDate: o.dateAchat === null ? null : o.dateAchat ?? COMMANDE }] as never,
  },
}), ctx('ACQUISITION_INVOICE', o.date === undefined ? FACTURE : o.date));
const sources = (...ids: CandidateIdentity[]): SourceContribution[] => ids.map((identity, i) => ({ sourceId: i + 1, identity }));
const etat = (...ids: CandidateIdentity[]) => consolidateOperationState('ACQUISITION', sources(...ids), AUJ);

describe('C819-U-05 — identité T3 : pièces de la succession commande → facture', () => {
  it('bon de commande d’un achat : pièce de commande, date du document conservée ; facture : date du document conservée', () => {
    expect(bon()).toMatchObject({ orderEvidence: true, documentDate: COMMANDE, status: 'ENVISAGED' });
    expect(bon({ paye: true })).toMatchObject({ orderEvidence: true, documentDate: COMMANDE, status: 'REALIZED' });
    const f = facture();
    expect(f).toMatchObject({ documentDate: FACTURE, status: 'REALIZED', role: 'INVOICE' });
    expect(f.orderEvidence).toBeUndefined();
  });
  it('rôle « commande » déclaré sur un document non classé : pièce de commande aussi', () => {
    const c = buildCandidateIdentity(persiste({ payload: { sourceRoleHint: 'ORDER' } }), ctx(null, COMMANDE));
    expect(c).toMatchObject({ orderEvidence: true, documentDate: COMMANDE });
  });
  it('aucune autre source ne porte ces marques : intervention, contrat, autre rôle d’un achat, document sans date', () => {
    for (const typeHint of ['INTERVENTION', 'CONTRACT', 'CLAIM', null]) {
      const c = buildCandidateIdentity(persiste({ typeHint }), ctx('MAINTENANCE_INVOICE', FACTURE));
      expect([c.orderEvidence, c.documentDate], String(typeHint)).toEqual([undefined, undefined]);
    }
    const preuve = buildCandidateIdentity(persiste({ payload: { sourceRoleHint: 'PAYMENT_PROOF' } }), ctx('ACQUISITION_INVOICE', FACTURE));
    expect([preuve.orderEvidence, preuve.documentDate]).toEqual([undefined, undefined]);
    expect(facture({ date: null }).documentDate).toBeUndefined();
  });
});

describe('C819-U-06 — date principale = date de la facture concordante de la commande', () => {
  it('cas réel : commande payée le 17/11 (réalisée au 17/11), facture du 20/11 dont le modèle date l’achat du 17/11 → 20/11', () => {
    const seule = etat(bon({ paye: true }));
    expect(seule).toMatchObject({ status: 'REALIZED', realizedDate: COMMANDE });
    expect(seule.invoiceAfterOrder).toBeUndefined();
    const s = etat(bon({ paye: true }), facture());
    expect(s).toMatchObject({ status: 'REALIZED', realizedDate: FACTURE, invoiceAfterOrder: { sourceId: 2, date: FACTURE, orderDates: [COMMANDE] } });
  });
  it('commande non payée : envisagée, sans date ; à la facture → date de la facture, quelle que soit la date proposée par le modèle', () => {
    expect(etat(bon())).toMatchObject({ status: 'ENVISAGED', realizedDate: null });
    for (const dateAchat of [COMMANDE, FACTURE, '2026-11-19', null]) {
      expect(etat(bon(), facture({ dateAchat })), String(dateAchat)).toMatchObject({ status: 'REALIZED', realizedDate: FACTURE });
    }
  });
  it('l’ordre d’arrivée des pièces est indifférent ; un bon sans date ne gêne pas', () => {
    expect(etat(facture({ id: 1 }), bon())).toMatchObject({ realizedDate: FACTURE, invoiceAfterOrder: { sourceId: 1 } });
    expect(etat(bon({ date: null }), facture())).toMatchObject({ realizedDate: FACTURE, invoiceAfterOrder: { orderDates: [] } });
  });
  it('la date prévue (livraison annoncée) et les composantes (montants, date de paiement) ne sont pas touchées', () => {
    const livraison = buildCandidateIdentity(persiste({ payload: { sourceRoleHint: 'INVOICE', temporalHints: { plannedDate: '2026-11-25' }, financialHints: [{ role: 'REALIZED_COST', amountMinor: 999, currency: 'EUR', amountScope: 'TOTAL' }] as never } }), ctx('ACQUISITION_ORDER', COMMANDE));
    const s = etat(livraison, facture());
    expect(s).toMatchObject({ realizedDate: FACTURE, plannedDate: '2026-11-25' });
    expect(s.components.map((c) => [c.kind, c.amountMinor, c.economicDate ?? null]).sort()).toEqual([['FORECAST_COST', 999, null], ['REALIZED_COST', 999, COMMANDE]]);
  });
});

describe('C819-U-07 — limites : la règle ne vaut que pour la succession commande → facture du même achat', () => {
  it('facture seule (aucune commande) : règle existante (date de réalisation portée par la facture)', () => {
    const s = etat(facture({ dateAchat: '2026-11-19' }));
    expect(s.realizedDate).toBe('2026-11-19');
    expect(s.invoiceAfterOrder).toBeUndefined();
  });
  it('PLUSIEURS factures : la règle ne s’applique pas — règle existante (plus ancienne date de réalisation portée par les preuves)', () => {
    const s = etat(bon({ paye: true }), facture({ dateAchat: FACTURE }), facture({ id: 3, fileId: 52, dateAchat: '2026-11-25', date: '2026-11-25' }));
    expect(s.invoiceAfterOrder).toBeUndefined();
    expect(s.realizedDate).toBe(FACTURE);
    expect(invoiceAfterOrder(sources(bon(), facture(), facture({ id: 3, fileId: 52 })), sources(bon(), facture(), facture({ id: 3, fileId: 52 })).slice(1))).toBeNull();
  });
  it('facture d’ACOMPTE, montant d’acompte, de solde ou d’échéance : la règle ne s’applique pas', () => {
    expect(etat(bon({ paye: true }), facture({ role: 'DEPOSIT_INVOICE' })).invoiceAfterOrder).toBeUndefined();
    for (const scope of ['DEPOSIT', 'BALANCE', 'INSTALLMENT']) expect(etat(bon({ paye: true }), facture({ scope })).invoiceAfterOrder, scope).toBeUndefined();
  });
  it('facture datée AVANT la commande, ou facture sans date de document : rien n’est présumé', () => {
    expect(etat(bon({ paye: true }), facture({ date: '2026-11-10' })).invoiceAfterOrder).toBeUndefined();
    expect(etat(bon({ paye: true }), facture({ date: null })).invoiceAfterOrder).toBeUndefined();
  });
  it('facture qui ne prouve pas la réalisation (incertaine) : la règle ne s’applique pas', () => {
    const probable = buildCandidateIdentity(persiste({ id: 2, fileId: 51, confidence: 'probable' }), ctx('ACQUISITION_INVOICE', FACTURE));
    expect(etat(bon({ paye: true }), probable).invoiceAfterOrder).toBeUndefined();
  });
  it('date de réalisation portée par un événement RÉEL de l’utilisateur ou par la fiche du bien : leurs règles restent seules', () => {
    const f = facture();
    const agenda: CandidateIdentity = { ...f, candidateId: 9, fileId: 0, role: null, dates: { ...f.dates, realizedDate: '2026-11-18' }, agenda: { itemId: 5, realizedDate: '2026-11-18', realizationRecord: true } };
    const fiche: CandidateIdentity = { ...f, candidateId: 10, fileId: 0, role: null, dates: { ...f.dates, realizedDate: '2026-11-18' }, structured: { nature: 'ACQUISITION', dateBasis: 'FIELD' } };
    for (const autre of [agenda, fiche]) {
      const srcs = sources(bon(), f, autre);
      expect(invoiceAfterOrder(srcs, srcs.slice(1))).toBeNull();
    }
  });
  it('autres types (intervention, contrat, sinistre) : jamais concernés, même avec un devis ou une commande de travaux', () => {
    const devis = buildCandidateIdentity(persiste({ typeHint: 'INTERVENTION', statusHint: 'ENVISAGED', payload: { sourceRoleHint: 'ORDER' } }), ctx('WORKS_PURCHASE_ORDER', COMMANDE));
    const fact = buildCandidateIdentity(persiste({ id: 2, fileId: 51, typeHint: 'INTERVENTION', payload: { sourceRoleHint: 'INVOICE', temporalHints: { realizedDate: '2026-11-18' } } }), ctx('MAINTENANCE_INVOICE', FACTURE));
    const s = consolidateOperationState('INTERVENTION', sources(devis, fact), AUJ);
    expect(s.realizedDate).toBe('2026-11-18');
    expect(s.invoiceAfterOrder).toBeUndefined();
  });
});

describe('C819-U-08 — provenance et contradictions', () => {
  it('provenance de la date principale : la source est la FACTURE, origine « date du document de la facture »', () => {
    const s = etat(bon({ paye: true }), facture());
    expect(s.provenance.realizedDate).toEqual({ sourceId: 2, value: FACTURE, origin: INVOICE_DOCUMENT_DATE_ORIGIN });
    // Recalculée après les autorités (fiche, Agenda) : même résultat avec la règle, provenance habituelle sans elle.
    expect(computeProvenance(s, sources(bon({ paye: true }), facture()), { invoiceAfterOrder: s.invoiceAfterOrder }).realizedDate).toEqual({ sourceId: 2, value: FACTURE, origin: INVOICE_DOCUMENT_DATE_ORIGIN });
    expect(computeProvenance({ ...s, realizedDate: COMMANDE }, sources(bon({ paye: true }), facture()), { invoiceAfterOrder: s.invoiceAfterOrder }).realizedDate).toEqual({ sourceId: 2, value: COMMANDE });
  });
  it('aucune contradiction de date entre la commande et sa facture, même au-delà de 7 jours et de la fenêtre de la transaction', () => {
    const loin = etat(bon({ paye: true, date: '2026-01-05', realizedDate: '2026-01-05' }), facture({ dateAchat: '2026-01-05' }));
    expect(loin.realizedDate).toBe(FACTURE);
    expect(loin.attributeConflicts.filter((c) => c.field === 'realizedDate')).toEqual([]);
  });
  it('une AUTRE preuve datée différemment reste relevée (la règle n’efface que la concurrence commande / facture)', () => {
    const preuve = buildCandidateIdentity(persiste({ id: 3, fileId: 52, payload: { sourceRoleHint: 'OTHER_EVIDENCE', temporalHints: { realizedDate: '2026-11-22' } } }), ctx('WARRANTY_CERTIFICATE', '2026-11-22'));
    const s = etat(bon({ paye: true }), facture(), preuve);
    expect(s.realizedDate).toBe(FACTURE);
    expect(s.attributeConflicts.filter((c) => c.field === 'realizedDate').map((c) => c.values.map((v) => v.value).sort())).toEqual([[FACTURE, '2026-11-22']]);
  });
});
