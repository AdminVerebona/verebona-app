/**
 * Carte #813 — bon de commande d'accessoire : règles PURES (aucune base).
 *
 *   C813-U-01  référentiel : une pièce de commande est reconnue par le catalogue documentaire existant
 *   C813-U-02  T1 (barrière) : achat lu sur un bon de commande jamais « réalisé » ; rôle et montants inchangés ; conversion ORDER / QUOTE protégée (C)
 *   C813-U-03  T3 (identité) : même règle sur un candidat déjà persisté ; date du bon jamais « date prévue » (C)
 *   C813-U-04  T3 (état) : commande seule ≠ réalisation ; aucune date de réalisation, de paiement ni de livraison
 *   C813-U-05  noms : « Bon de commande Polisport groovy coussin gris » exactement ; homonymes départagés (B)
 *   C813-U-06  noms : « Achat Polisport groovy coussin gris » ; replis ; plusieurs articles (A)
 *   C813-U-07  repère « Date de commande » : jamais une date de réalisation (C)
 *   C813-U-08  reprise d'un titre antérieur : seuls les discriminants ajoutés par défaut sont retirés (B)
 *
 * La projection (D) et la question « À traiter » (E) : `agenda-projection/__tests__/o7-projection.test.ts`,
 * `to-process/__tests__/l114v-qualification-situation.test.ts` (règles remplacées, carte #813).
 */
import { describe, expect, it } from 'vitest';
import { isOrderDocumentType, isOrderEvidenceWithoutRealization, orderDocumentTypeCodes } from '@/services/canonical/registry/order-evidence';
import { gateOperationCandidates, type AnchoredOperationCandidate, type CandidateGateContext } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { buildCandidateIdentity, consolidateOperationState, sourceLabelOf, type CandidateRecord } from '../consolidation/model';
import { planBusinessTitle } from '@/services/ai/source-analysis/document-title';
import { carriesOnlyDroppedDiscriminants } from '@/services/documents/document-title.service';
import { acquisitionDisplayLabel, acquisitionEventTitle, acquisitionLabelFromDesignation } from '@/lib/reference-events/operation-title';
import { referenceEventLabel } from '@/services/documents/business-period-surfaces';
import { presentationDateOf, PRESENTATION_BASIS_LABELS } from '@/lib/reference-events/presentation-date';

const DESIGNATION = 'Polisport groovy coussin gris';
const AUJ = '2026-11-17';

const ancre = (over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate => ({
  candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: 'REALIZED',
  summary: 'Commande d’un coussin pour siège enfant', sourceRoleHint: 'INVOICE', provider: 'Cycles Exemple',
  targetHints: [], businessReferences: [], temporalHints: {},
  financialHints: [{ role: 'REALIZED_COST', amountMinor: 2490, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2026-11-12', periodStart: null, periodEnd: null, factRef: 'f1' }],
  evidenceFactRefs: ['f1'], visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
});
const ctxT1 = (over: Partial<CandidateGateContext> = {}): CandidateGateContext => ({
  hasExploitableContent: true, documentTypeCode: 'ACQUISITION_ORDER',
  verifiedIds: { ASSET: new Set([7]), EQUIPMENT: new Set(), ROOM: new Set() },
  capabilities: { rooms: false, equipments: false }, keptFactRefs: new Set(['f1']), ...over,
});
const persiste = (over: Partial<CandidateRecord> & { payload?: CandidateRecord['payload'] } = {}): CandidateRecord => ({
  id: 1, accountId: 1, fileId: 50, candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: 'REALIZED',
  summary: 'Commande d’un coussin pour siège enfant',
  payload: { sourceRoleHint: 'INVOICE', financialHints: [{ role: 'REALIZED_COST', amountMinor: 2490, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2026-11-12' }] as never },
  ...over,
});
const ctxT3 = { fileAssetId: 7, liveAssetIds: new Set([7]), equipmentAssets: new Map<number, number>() };

describe('C813-U-01 — référentiel : pièce de commande reconnue par le catalogue documentaire', () => {
  it('bon de commande (code canonique et alias V2) : oui ; facture, devis, type inconnu ou absent : non', () => {
    for (const c of ['BON_COMMANDE', 'ACQUISITION_ORDER', 'WORKS_PURCHASE_ORDER', 'acquisition_order']) expect(isOrderDocumentType(c), c).toBe(true);
    for (const c of ['FACTURE', 'ACQUISITION_INVOICE', 'DEVIS', 'ACQUISITION_QUOTE', 'COMPROMIS_VENTE', 'AVIS_ECHEANCE', 'INCONNU', '', null, undefined]) expect(isOrderDocumentType(c), String(c)).toBe(false);
    expect(orderDocumentTypeCodes()).toEqual(expect.arrayContaining(['ACQUISITION_ORDER', 'BON_COMMANDE', 'WORKS_PURCHASE_ORDER']));
    for (const c of orderDocumentTypeCodes()) expect(c).toMatch(/^[A-Z0-9_]+$/);
  });
  it('commande sans preuve de réalisation : rôle absent, « facture » ou « autre preuve », sans paiement lu ; les autres rôles gardent leurs règles', () => {
    for (const r of [null, 'INVOICE', 'OTHER_EVIDENCE']) expect(isOrderEvidenceWithoutRealization(r, 'ACQUISITION_ORDER', false), String(r)).toBe(true);
    for (const r of ['QUOTE', 'ORDER', 'PAYMENT_PROOF', 'DEPOSIT_INVOICE', 'CREDIT_NOTE', 'REFUND_PROOF', 'CONTRACT_DOCUMENT']) expect(isOrderEvidenceWithoutRealization(r, 'ACQUISITION_ORDER', false), r).toBe(false);
    expect(isOrderEvidenceWithoutRealization('INVOICE', 'ACQUISITION_ORDER', true)).toBe(false); // commande payée : règle existante (lot 109D)
    expect(isOrderEvidenceWithoutRealization('INVOICE', 'ACQUISITION_INVOICE', false)).toBe(false);
    expect(isOrderEvidenceWithoutRealization(null, null, false)).toBe(false);
  });
});

describe('C813-U-02 — T1 : la barrière serveur ne laisse pas « réalisé » un achat lu sur un bon de commande (sans bloc de prompt)', () => {
  it('document classé bon de commande, rôle « facture » réalisé : envisagé ; rôle et montants proposés INCHANGÉS', () => {
    const [c] = gateOperationCandidates([ancre()], ctxT1()).candidates;
    expect(c).toMatchObject({ sourceRoleHint: 'INVOICE', statusHint: 'ENVISAGED', established: true });
    expect(c.financialHints.map((h) => h.role)).toEqual(['REALIZED_COST']);
    expect(c.adjustments).toContain('ORDER_DOCUMENT_NOT_REALIZED');
  });
  it('rôle absent, et type V2 absent mais type canonique « BON_COMMANDE » : même résultat ; paiement lu : statut du modèle gardé', () => {
    expect(gateOperationCandidates([ancre({ sourceRoleHint: null })], ctxT1()).candidates[0]).toMatchObject({ sourceRoleHint: null, statusHint: 'ENVISAGED' });
    expect(gateOperationCandidates([ancre()], ctxT1({ documentTypeCode: null, canonicalType: 'BON_COMMANDE' })).candidates[0]).toMatchObject({ statusHint: 'ENVISAGED' });
    const paye = ancre({ financialHints: [...ancre().financialHints, { ...ancre().financialHints[0], role: 'PAYMENT' }] });
    expect(gateOperationCandidates([paye], ctxT1()).candidates[0]).toMatchObject({ statusHint: 'REALIZED' });
    // Autre type d'opération sur le même document : inchangé.
    expect(gateOperationCandidates([ancre({ typeHint: 'INTERVENTION' })], ctxT1()).candidates[0]).toMatchObject({ statusHint: 'REALIZED' });
  });
  it('comportement à protéger : ORDER / QUOTE proposés par le modèle convertissent coût réalisé → prévisionnel et réalisé → envisagé ; une facture reste une facture', () => {
    for (const role of ['ORDER', 'QUOTE'] as const) {
      const [c] = gateOperationCandidates([ancre({ sourceRoleHint: role })], ctxT1({ documentTypeCode: null })).candidates;
      expect(c.financialHints[0].role).toBe('FORECAST_COST');
      expect(c.statusHint).toBe('ENVISAGED');
      expect(c.adjustments).toEqual(expect.arrayContaining(['QUOTE_FORECAST_ONLY', 'QUOTE_NOT_REALIZED']));
      expect(c.adjustments).not.toContain('ORDER_DOCUMENT_NOT_REALIZED');
    }
    const [f] = gateOperationCandidates([ancre()], ctxT1({ documentTypeCode: 'ACQUISITION_INVOICE' })).candidates;
    expect(f).toMatchObject({ sourceRoleHint: 'INVOICE', statusHint: 'REALIZED' });
    expect(f.financialHints[0].role).toBe('REALIZED_COST');
  });
});

describe('C813-U-03 — T3 : identité d’un candidat déjà persisté (stock), date du bon', () => {
  it('rôle persisté « facture » ou absent sur un document classé bon de commande : envisagé — une facture reste réalisée', () => {
    expect(buildCandidateIdentity(persiste(), { ...ctxT3, fileDocumentTypeCode: 'ACQUISITION_ORDER' })).toMatchObject({ role: 'INVOICE', status: 'ENVISAGED', type: 'ACQUISITION' });
    expect(buildCandidateIdentity(persiste({ statusHint: null, payload: {} }), { ...ctxT3, fileDocumentTypeCode: 'ACQUISITION_ORDER' })).toMatchObject({ role: null, status: 'ENVISAGED' });
    expect(buildCandidateIdentity(persiste(), { ...ctxT3, fileDocumentTypeCode: 'ACQUISITION_INVOICE' })).toMatchObject({ role: 'INVOICE', status: 'REALIZED' });
    expect(buildCandidateIdentity(persiste(), ctxT3)).toMatchObject({ role: 'INVOICE', status: 'REALIZED' });
    // Commande déclarée par T1 : règle existante, inchangée.
    expect(buildCandidateIdentity(persiste({ payload: { sourceRoleHint: 'ORDER' } }), { ...ctxT3, fileDocumentTypeCode: 'ACQUISITION_ORDER' })).toMatchObject({ role: 'ORDER', status: 'ENVISAGED' });
    // Paiement lu sur le document : la preuve existante de la commande payée n'est pas retirée.
    const paye = persiste({ payload: { sourceRoleHint: 'INVOICE', financialHints: [
      { role: 'REALIZED_COST', amountMinor: 2490, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2026-11-12' },
      { role: 'PAYMENT', amountMinor: 2490, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2026-11-12' }] as never } });
    expect(buildCandidateIdentity(paye, { ...ctxT3, fileDocumentTypeCode: 'ACQUISITION_ORDER' }).status).toBe('REALIZED');
  });
  it('« date prévue » égale à la date du bon : date de commande recopiée, jamais une date prévue ; une date distincte (livraison) est gardée', () => {
    const c = (plannedDate: string, role: string | null = 'ORDER') => persiste({ payload: { sourceRoleHint: role, temporalHints: { plannedDate } } });
    const ctx = { ...ctxT3, fileDocumentTypeCode: 'ACQUISITION_ORDER', fileDocumentDate: '2026-11-12' };
    expect(buildCandidateIdentity(c('2026-11-12'), ctx).dates.plannedDate).toBeNull();
    expect(buildCandidateIdentity(c('2026-11-12', 'INVOICE'), ctx).dates.plannedDate).toBeNull();
    expect(buildCandidateIdentity(c('2026-11-20'), ctx).dates.plannedDate).toBe('2026-11-20');
    // Hors achat (bon de commande de travaux), la règle existante est inchangée.
    expect(buildCandidateIdentity({ ...c('2026-11-12'), typeHint: 'INTERVENTION' }, ctx).dates.plannedDate).toBe('2026-11-12');
  });
});

describe('C813-U-04 — T3 : une commande seule n’est pas une réalisation', () => {
  const commande = buildCandidateIdentity(persiste({ payload: { sourceRoleHint: 'INVOICE', temporalHints: { realizedDate: '2026-11-12', plannedDate: '2026-11-12' },
    financialHints: [{ role: 'REALIZED_COST', amountMinor: 2490, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2026-11-12' }] as never } }),
  { ...ctxT3, fileDocumentTypeCode: 'ACQUISITION_ORDER', fileDocumentDate: '2026-11-12' });
  it('bon daté : envisagé, aucune date de réalisation, de début ni de fin, aucune date prévue ; le montant lu reste tel que T1 l’a qualifié', () => {
    const s = consolidateOperationState('ACQUISITION', [{ sourceId: 1, identity: commande }], AUJ);
    expect(s).toMatchObject({ status: 'ENVISAGED', realizationProven: false, realizedDate: null, plannedDate: null, startDate: null, endDate: null });
    expect(s.components.map((x) => [x.kind, x.amountMinor])).toEqual([['REALIZED_COST', 2490]]);
  });
  it('bon puis facture concordante : réalisé à la date de la FACTURE, un seul coût (même montant, jamais additionné)', () => {
    const facture = buildCandidateIdentity(persiste({ id: 2, fileId: 51, payload: { sourceRoleHint: 'INVOICE', temporalHints: { realizedDate: '2026-11-18' },
      financialHints: [{ role: 'REALIZED_COST', amountMinor: 2490, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2026-11-18' }] as never } }),
    { ...ctxT3, fileDocumentTypeCode: 'ACQUISITION_INVOICE' });
    const s = consolidateOperationState('ACQUISITION', [{ sourceId: 1, identity: commande }, { sourceId: 2, identity: facture }], AUJ);
    expect(s).toMatchObject({ status: 'REALIZED', realizedDate: '2026-11-18' });
    expect(s.components.filter((x) => x.kind === 'REALIZED_COST').map((x) => x.amountMinor)).toEqual([2490]);
  });
});

describe('C813-U-05 — nom du DOCUMENT : type documentaire réel + désignation', () => {
  const ctx = { typeCode: 'ACQUISITION_ORDER', supplier: 'Cycles Exemple', documentDate: '2026-11-12', asset: { id: 7, name: 'Jean Fourche' }, accountAssetCount: 3 };
  it('« Bon de commande Polisport groovy coussin gris » exactement : ni date, ni fournisseur, ni bien', () => {
    const p = planBusinessTitle(`Bon de commande ${DESIGNATION}`, ctx);
    expect(p.title).toBe(`Bon de commande ${DESIGNATION}`);
    expect(p).toMatchObject({ nature: 'Bon de commande', subject: DESIGNATION, period: null, supplier: null, target: null, designationOnly: true, subjectSource: 'TITLE' });
    // Même résultat sans fournisseur connu (le bien ne devient pas le titre), et quand la désignation vient d'un fait.
    expect(planBusinessTitle(`Bon de commande ${DESIGNATION}`, { ...ctx, supplier: null }).title).toBe(`Bon de commande ${DESIGNATION}`);
    expect(planBusinessTitle(null, { ...ctx, subjects: [DESIGNATION] })).toMatchObject({ title: `Bon de commande ${DESIGNATION}`, subjectSource: 'FACT', otherSubjects: false });
    // Une borne unique copiée de la date du bon n'est pas une période (périmètre de la carte #812 : ici, seulement le titre).
    expect(planBusinessTitle(`Bon de commande ${DESIGNATION}`, { ...ctx, period: { start: '2026-11-12', end: '2026-11-12' } }).title).toBe(`Bon de commande ${DESIGNATION}`);
    expect(planBusinessTitle(`Bon de commande ${DESIGNATION}`, { ...ctx, period: { start: '2026-11-12', end: null } }).title).toBe(`Bon de commande ${DESIGNATION}`);
  });
  it('jamais transformé en « Facture » ; une facture garde ses règles (date au jour)', () => {
    expect(planBusinessTitle(`Bon de commande ${DESIGNATION}`, ctx).title).not.toMatch(/facture/i);
    expect(planBusinessTitle(`Facture ${DESIGNATION}`, { ...ctx, typeCode: 'ACQUISITION_INVOICE' }).title).toBe(`Facture ${DESIGNATION} Cycles Exemple — 12 novembre 2026`);
  });
  it('de vrais homonymes sont départagés par la date, puis par la référence ; sans désignation, la règle générale reste', () => {
    const homonyme = planBusinessTitle(`Bon de commande ${DESIGNATION}`, { ...ctx, similarTitles: [`Bon de commande ${DESIGNATION}`], reference: 'CMD-42' });
    expect(homonyme).toMatchObject({ title: `Bon de commande ${DESIGNATION} — 12 novembre 2026`, duplicateResolved: true });
    const deux = planBusinessTitle(`Bon de commande ${DESIGNATION}`, { ...ctx, reference: 'CMD-42', similarTitles: [`Bon de commande ${DESIGNATION}`, `Bon de commande ${DESIGNATION} — 12 novembre 2026`] });
    expect(deux.title).toBe(`Bon de commande ${DESIGNATION} — CMD-42`);
    // Produit non identifié : fournisseur et date du document distinguent encore (règle antérieure inchangée).
    expect(planBusinessTitle('Bon de commande', { typeCode: 'ACQUISITION_ORDER', supplier: 'Tikamoon', documentDate: '2021-04-24' }).title).toBe('Bon de commande Tikamoon — 24 avril 2021');
  });
});

describe('C813-U-06 — nom de l’OPÉRATION : « Achat » + désignation', () => {
  it('« Achat Polisport groovy coussin gris » ; plusieurs articles : formulation explicite ; rien d’inventé sans désignation', () => {
    expect(acquisitionLabelFromDesignation(DESIGNATION)).toBe(`Achat ${DESIGNATION}`);
    expect(acquisitionLabelFromDesignation(DESIGNATION, { otherArticles: true })).toBe(`Achat ${DESIGNATION} et autres articles`);
    expect(acquisitionLabelFromDesignation('achat accessoires vélo')).toBe('Achat accessoires vélo');
    for (const v of [null, undefined, '', '   ', '12345']) expect(acquisitionLabelFromDesignation(v)).toBeNull();
    expect(acquisitionLabelFromDesignation('x'.repeat(200))!.length).toBeLessThanOrEqual(80);
  });
  it('T3 : le libellé d’une source est ce nom quand le document porte UN candidat établi ; sinon le résumé (règle antérieure)', () => {
    const ctx = { ...ctxT3, fileDocumentTypeCode: 'ACQUISITION_ORDER', fileDesignation: { subject: DESIGNATION, otherArticles: false } };
    const id = buildCandidateIdentity(persiste(), ctx);
    expect(id.designationLabel).toBe(`Achat ${DESIGNATION}`);
    expect(sourceLabelOf(id)).toBe(`Achat ${DESIGNATION}`);
    // Deux réalités dans le même document : la désignation du document n'en nomme aucune en particulier.
    const deux = buildCandidateIdentity(persiste(), { ...ctx, documentCandidates: [persiste(), persiste({ id: 2, candidateKey: 'op2' })] });
    expect(deux.designationLabel).toBeUndefined();
    expect(sourceLabelOf(deux)).toBe('Commande d’un coussin pour siège enfant');
    // Autre type que l'achat, ou aucune désignation : résumé.
    expect(buildCandidateIdentity(persiste({ typeHint: 'INTERVENTION' }), ctx).designationLabel).toBeUndefined();
    expect(sourceLabelOf(buildCandidateIdentity(persiste(), ctxT3))).toBe('Commande d’un coussin pour siège enfant');
  });
  it('lecture (fiche, Timeline, recherche) : « Achat Polisport groovy coussin gris », jamais « Achat — Achat … » ni le bien à la place du produit', () => {
    expect(referenceEventLabel({ typeCode: 'ACQUISITION', technicalLabel: `Achat ${DESIGNATION}`, provider: 'Cycles Exemple', firstDocumentTitle: `Bon de commande ${DESIGNATION}` })).toBe(`Achat ${DESIGNATION}`);
    // Replis existants inchangés quand le produit n'est pas identifié.
    expect(referenceEventLabel({ typeCode: 'ACQUISITION', technicalLabel: 'Coussin pour siège enfant' })).toBe('Achat — Coussin pour siège enfant');
    expect(referenceEventLabel({ typeCode: 'ACQUISITION', technicalLabel: null, firstDocumentTitle: 'Bon de commande Tikamoon — 24 avril 2021' })).toBe('Achat — Bon de commande Tikamoon — 24 avril 2021');
    expect(referenceEventLabel({ typeCode: 'ACQUISITION', technicalLabel: null })).toBe('Achat');
    // Les autres types gardent leur forme.
    expect(referenceEventLabel({ typeCode: 'CONTRACT', technicalLabel: 'Contrat d’assurance habitation' })).toBe('Contrat — Contrat d’assurance habitation');
    expect(acquisitionDisplayLabel('Acquisition du vélo')).toBe('Acquisition du vélo');
  });
  it('événement d’achat légitime : intitulé, sinon prestataire, sinon bien — « Achat » nu seulement sans aucun élément', () => {
    expect(acquisitionEventTitle({ label: `Achat ${DESIGNATION}`, provider: 'Cycles Exemple', assetNames: ['Jean Fourche'] })).toBe(`Achat ${DESIGNATION}`);
    expect(acquisitionEventTitle({ label: null, provider: 'Cycles Exemple', assetNames: ['Jean Fourche'] })).toBe('Achat — Cycles Exemple');
    expect(acquisitionEventTitle({ label: null, provider: null, assetNames: ['', 'Jean Fourche'] })).toBe('Achat — Jean Fourche');
    expect(acquisitionEventTitle({ label: null, provider: null })).toBe('Achat');
  });
});

describe('C813-U-07 — repère « Date de commande »', () => {
  const faits = { typeCode: 'ACQUISITION', realizedDate: null, firstQuoteDate: null, startDate: null, firstCoverageStart: null, plannedDate: null };
  it('achat sans réalisation : la date du bon est le repère, nommé « Date de commande » ; réalisé : la date réelle prime', () => {
    expect(presentationDateOf({ ...faits, firstOrderDate: '2026-11-12' })).toEqual({ date: '2026-11-12', basis: 'FIRST_ORDER' });
    expect(PRESENTATION_BASIS_LABELS.FIRST_ORDER).toBe('Date de commande');
    expect(presentationDateOf({ ...faits, realizedDate: '2026-11-18', firstOrderDate: '2026-11-12' })).toEqual({ date: '2026-11-18', basis: 'REALIZED' });
  });
  it('bon sans date : « sans date », rien n’est inventé ; les autres types ne lisent pas ce fait', () => {
    expect(presentationDateOf({ ...faits, firstOrderDate: null })).toEqual({ date: null, basis: null });
    expect(presentationDateOf(faits)).toEqual({ date: null, basis: null });
    expect(presentationDateOf({ ...faits, typeCode: 'INTERVENTION', firstOrderDate: '2026-11-12' })).toEqual({ date: null, basis: null });
  });
});

describe('C813-U-08 — reprise d’un titre SYSTÈME antérieur', () => {
  const titre = `Bon de commande ${DESIGNATION}`;
  it('date du bon, fournisseur et bien ajoutés par défaut : retirés ; toute autre précision : le titre n’est pas touché', () => {
    expect(carriesOnlyDroppedDiscriminants(`${titre} Cycles Exemple — 12 novembre 2026`, titre, ['Cycles Exemple', 'Jean Fourche'])).toBe(true);
    expect(carriesOnlyDroppedDiscriminants(`${titre} — 12 novembre 2026`, titre, [])).toBe(true);
    expect(carriesOnlyDroppedDiscriminants(`${titre} Jean Fourche`, titre, ['Jean Fourche'])).toBe(true);
    expect(carriesOnlyDroppedDiscriminants(`${titre} — 1er mars 2026`, titre, [])).toBe(true);
    expect(carriesOnlyDroppedDiscriminants(`${titre} taille M`, titre, ['Cycles Exemple'])).toBe(false);
    expect(carriesOnlyDroppedDiscriminants(titre, titre, [])).toBe(false);
    expect(carriesOnlyDroppedDiscriminants('Commande coussin du vélo', titre, [])).toBe(false);
    expect(carriesOnlyDroppedDiscriminants(null, titre, [])).toBe(false);
  });
});
