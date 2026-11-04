/**
 * Lot 109D — ticket P1 « TCO — remises vs avoirs, 1 document → 1..N achats » :
 * recette §4 en tests PURS (aucune base). Le cas réel est rejoué sur
 * PostgreSQL 16 : `src/test/e2e/scenarios/l109d-tco-remises-avoirs.e2e.ts`.
 *
 *   L109D-U-ADJ    plan du document (remise intégrée, achat composé, commande payée, ventilation prudente)
 *   L109D-U-LINES  lignes économiques et TCO (une entrée par achat, aucun faux avoir, vrai avoir postérieur)
 *   L109D-U-T3     identité T3 normalisée (composantes attendues, candidat « remise seule »)
 *   L109D-U-GATE   barrière T1 (jamais de candidat avoir depuis une remise de commande / facture)
 *   L109D-U-VIEW   présentation (composantes masquées, détail consultable, clés de décision)
 */
import { describe, expect, it } from 'vitest';
import { planDocumentAdjustments, hintKey, type AdjustmentHint } from '../commercial-adjustments';
import { qualifyDocumentLines, type EconomicDocumentCandidate, type EconomicDocumentInput, type EconomicHint } from '../economic-lines';
import { computeTco, type TcoInput } from '../../tco/model';
import { toTcoDto, tcoUserView } from '../../tco/dto';
import { tcoLineKeys } from '../../tco/user-decisions';
import { buildCandidateIdentity, componentsFromIdentity, type CandidateRecord, type PersistedFinancialHint } from '../../consolidation/model';
import { buildReceiptProfile, linesOfTranscription } from '@/services/ai/source-analysis/projection/amount-roles';
import { gateOperationCandidates, type AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';

const TODAY = '2026-11-04';
const CHAISES = 7;
const TABLE = 8;
const NET = 27_735;
let seq = 5000;

const h = (role: string, amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: 'Fournisseur', references: [],
  targets: [{ type: 'ASSET', entityId: CHAISES }], hints, t3Outcome: null, ...o,
});
const doc = (fileId: number, candidates: EconomicDocumentCandidate[], o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: 'Bon de commande — 24 avril 2021', typeCode: 'ACQUISITION_ORDER', legacyType: null, date: '2021-04-24', supplier: 'Fournisseur',
  amountCents: NET, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [CHAISES], multiAsset: false, candidates, operations: [], ...o,
});
const entree = (documents: EconomicDocumentInput[], o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: CHAISES, today: TODAY, operations: [], assetAcquisitionDate: null, assetSaleDate: null, assetStatus: 'ACTIF', assetCategory: 'OBJET',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents, assetPrice: null, ...o,
} as TcoInput);
const retenues = (t: ReturnType<typeof computeTco>) => t.lines.filter((l) => l.status === 'RETAINED_DIRECT' || l.status === 'RETAINED_CONSOLIDATED');
const plan = (cands: Array<{ id: number; sourceRole: string | null; hints: AdjustmentHint[]; statusHint?: string }>, total: number | null = NET) =>
  planDocumentAdjustments(cands, { documentTotalMinor: total, today: TODAY });

/** Formes plausibles des indices T1 du bon de commande observé (4 × 69,50 − 20,00 + 19,35 = 277,35 € TTC). */
const PAIEMENT = h('PAYMENT', NET, { economicDate: '2021-04-24' });
const FORMES: Record<string, () => EconomicDocumentCandidate[]> = {
  'facture : total TTC + remise': () => [cand([h('REALIZED_COST', NET, { economicDate: '2021-04-24' }), h('REDUCTION', 2000, { amountScope: null }), PAIEMENT])],
  'commande payée : prévision + remise + paiement daté': () => [cand([h('FORECAST_COST', NET), h('REDUCTION', 2000, { amountScope: null }), PAIEMENT], { sourceRole: 'ORDER', statusHint: 'ENVISAGED' })],
  'remise isolée dans un second candidat': () => [cand([h('REALIZED_COST', NET, { economicDate: '2021-04-24' })]), cand([h('REDUCTION', 2000, { amountScope: null })], { sourceRole: null })],
  'lignes sans total : 278,00 + livraison 19,35 − 20,00': () => [cand([h('REALIZED_COST', 27_800, { amountScope: null, economicDate: '2021-04-24' }),
    h('REALIZED_COST', 1935, { amountScope: 'FEE', economicDate: '2021-04-24' }), h('REDUCTION', 2000, { amountScope: null })])],
};

describe('L109D-U-ADJ — plan du document : remise intégrée, achat composé, prudence', () => {
  it('cas observé, quatre formes : un seul achat net de 277,35 €, la remise est une composante, jamais un avoir', () => {
    for (const [nom, f] of Object.entries(FORMES)) {
      const cands = f();
      const p = plan(cands.map((c) => ({ id: c.id, sourceRole: c.sourceRole, statusHint: c.statusHint ?? undefined, hints: c.hints })));
      expect(p.costBearing, nom).toBe(true);
      expect(p.purchases, nom).toHaveLength(1);
      expect(p.purchases[0], nom).toMatchObject({ netMinor: NET, kind: 'REALIZED_COST', discountsMinor: 2000 });
      const remise = cands.flatMap((c) => c.hints.map((x, i) => ({ c, x, i }))).find(({ x }) => x.role === 'REDUCTION')!;
      expect(p.treatments.get(hintKey(remise.c.id, remise.i)), nom).toEqual({ kind: 'COMPOSITION', purchase: p.purchases[0].candidateId, part: 'DISCOUNT' });
      expect(p.codes, nom).toContain('COMMERCIAL_ADJUSTMENT_INTEGRATED');
    }
  });

  it('lignes sans total : net recomposé et réconcilié avec le total du document ; total inconnu → non vérifié, signalé', () => {
    const c = FORMES['lignes sans total : 278,00 + livraison 19,35 − 20,00']()[0];
    const ok = plan([{ id: c.id, sourceRole: 'INVOICE', hints: c.hints }]).purchases[0];
    expect(ok).toMatchObject({ netMinor: NET, basis: 'LINES_NET', synthesized: true, reconciliation: 'RECONCILED', linesMinor: 27_800, feesMinor: 1935 });
    expect(plan([{ id: c.id, sourceRole: 'INVOICE', hints: c.hints }], null).purchases[0]).toMatchObject({ netMinor: NET, reconciliation: 'UNVERIFIED' });
    // Écart avec le total du document : jamais masqué.
    const ecart = plan([{ id: c.id, sourceRole: 'INVOICE', hints: c.hints }], 30_000);
    expect(ecart.purchases[0].reconciliation).toBe('MISMATCH');
    expect(ecart.codes).toContain('PURCHASE_NOT_RECONCILED');
  });

  it('montant unique déjà net (lot 48) : la remise lue à côté n’est pas déduite une seconde fois', () => {
    const p = plan([{ id: 1, sourceRole: 'INVOICE', hints: [h('REALIZED_COST', NET, { amountScope: null }), h('REDUCTION', 2000, { amountScope: null })] }]);
    expect(p.purchases[0]).toMatchObject({ netMinor: NET, basis: 'SINGLE_AMOUNT', synthesized: false, reconciliation: 'RECONCILED' });
    // Montant brut prouvé par le document (brut − remise = total du document) : remise déduite.
    const brut = plan([{ id: 1, sourceRole: 'INVOICE', hints: [h('REALIZED_COST', 29_735, { amountScope: null }), h('REDUCTION', 2000, { amountScope: null })] }]);
    expect(brut.purchases[0]).toMatchObject({ netMinor: NET, basis: 'LINES_NET', synthesized: true });
  });

  it('commande non payée, devis payé d’un acompte, paiement futur ou d’un autre montant : jamais réalisé', () => {
    const commande = plan([{ id: 1, sourceRole: 'ORDER', hints: [h('FORECAST_COST', NET), h('REDUCTION', 2000, { amountScope: null })] }]);
    expect(commande.purchases[0]).toMatchObject({ kind: 'FORECAST_COST', paidBy: null });
    const devis = plan([{ id: 1, sourceRole: 'QUOTE', hints: [h('FORECAST_COST', NET), PAIEMENT] }]);
    expect(devis.purchases).toEqual([]); // rien à composer, prévision inchangée
    const futur = plan([{ id: 1, sourceRole: 'ORDER', hints: [h('FORECAST_COST', NET), h('REDUCTION', 2000, { amountScope: null }), h('PAYMENT', NET, { economicDate: '2027-01-01' })] }]);
    expect(futur.purchases[0].paidBy).toBeNull();
    const partiel = plan([{ id: 1, sourceRole: 'ORDER', hints: [h('FORECAST_COST', NET), h('REDUCTION', 2000, { amountScope: null }), h('PAYMENT', 5000, { economicDate: '2021-04-24' })] }]);
    expect(partiel.purchases[0]).toMatchObject({ kind: 'FORECAST_COST', paidBy: null });
  });

  it('ticket de deux équipements distincts + remise globale : deux achats, remise NON ventilée (aucune règle explicite), jamais un avoir', () => {
    const p = plan([
      { id: 1, sourceRole: 'INVOICE', hints: [h('REALIZED_COST', 40_000)] },
      { id: 2, sourceRole: 'INVOICE', hints: [h('REALIZED_COST', 15_000)] },
      { id: 3, sourceRole: null, hints: [h('REDUCTION', 5000, { amountScope: null })] },
    ], 50_000);
    expect(p.treatments.get(hintKey(3, 0))).toEqual({ kind: 'DISCOUNT_UNALLOCATED' });
    expect(p.codes).toContain('GLOBAL_DISCOUNT_NOT_ALLOCATED');
    expect(p.adjustmentOnlyCandidates).toEqual([3]);
  });

  it('vrai avoir (document propre) : réduction conservée, jamais requalifiée ; acomptes, soldes et échéances jamais fusionnés', () => {
    const avoir = plan([{ id: 1, sourceRole: 'CREDIT_NOTE', hints: [h('REDUCTION', 5000)] }]);
    expect(avoir.costBearing).toBe(false);
    expect(avoir.treatments.get(hintKey(1, 0))).toEqual({ kind: 'KEEP' });
    const parts = plan([{ id: 1, sourceRole: 'DEPOSIT_INVOICE', hints: [h('REALIZED_COST', 10_000, { amountScope: 'DEPOSIT' }), h('REALIZED_COST', 2000, { amountScope: 'INSTALLMENT', periodStart: '2026-01-01' })] }]);
    expect(parts.purchases).toEqual([]);
  });

  it('plusieurs exemplaires identiques : la lecture des rôles (lot 107) garde une ligne × 4 ; le plan forme UN achat', () => {
    const p = buildReceiptProfile(linesOfTranscription([
      'Chaise en bois massif  4 x 69,50  278,00', 'Sous-total 278,00', 'Réduction -20,00', 'Frais de livraison 19,35', 'Total TTC 277,35', 'Paiement validé le 24/04/2021 CB 277,35',
    ].join('\n')), NET);
    expect(p.articles).toHaveLength(1);
    expect(p.articles[0]).toMatchObject({ quantity: 4, unitPriceCents: 6950, lineAmountCents: 27_800 });
    expect(p.globalAdjustments.map((s) => [s.role, s.cents])).toEqual([['GLOBAL_DISCOUNT', 2000], ['FEES', 1935]]);
    expect(p.reconciled).toBe(true);
    expect(p.multiArticle).toBe(true);
  });

  it('déterministe et idempotent : même entrée, même plan', () => {
    const cands = FORMES['remise isolée dans un second candidat']().map((c) => ({ id: c.id, sourceRole: c.sourceRole, hints: c.hints }));
    const a = plan(cands); const b = plan(cands);
    expect([...a.treatments]).toEqual([...b.treatments]);
    expect(a.purchases).toEqual(b.purchases);
  });
});

describe('L109D-U-LINES — lignes économiques et TCO', () => {
  it('cas observé, quatre formes : TCO = 277,35 €, une seule dépense retenue, aucun avoir, aucune rubrique « avoirs »', () => {
    for (const [nom, f] of Object.entries(FORMES)) {
      const t = computeTco(entree([doc(900, f())]));
      expect(t.summary.cumulativeCostCents, nom).toBe(NET);
      expect(t.reductionsCents + t.refundsCents, nom).toBe(0);
      expect(retenues(t), nom).toHaveLength(1);
      expect(retenues(t)[0], nom).toMatchObject({ kind: 'REALIZED_COST', includedCents: NET, fileId: 900, label: 'Bon de commande — 24 avril 2021' });
      expect(retenues(t)[0].composition, nom).toMatchObject({ netMinor: NET, discountsMinor: 2000 });
      const dto = toTcoDto(t);
      expect(dto.lines.filter((l) => l.kind === 'REDUCTION'), nom).toEqual([]);
      expect(dto.lines.filter((l) => l.status !== 'PAYMENT'), nom).toHaveLength(1);
    }
  });

  it('commande payée : datée du paiement (24/04/2021), justificatif ouvrable', () => {
    const t = computeTco(entree([doc(901, FORMES['commande payée : prévision + remise + paiement daté']())]));
    expect(retenues(t)[0]).toMatchObject({ date: '2021-04-24', fileId: 901, annualYear: 2021 });
  });

  it('avoir postérieur réel : coût de l’achat ajusté UNE fois, preuve conservée, distinct de la remise initiale', () => {
    const avoir = doc(902, [cand([h('REDUCTION', 5000, { economicDate: '2021-06-01' })], { sourceRole: 'CREDIT_NOTE' })], { title: 'Avoir n° 12 — retour d’une chaise', typeCode: null, amountCents: 5000, date: '2021-06-01' });
    const t = computeTco(entree([doc(900, FORMES['facture : total TTC + remise']()), avoir]));
    expect(t.summary.cumulativeCostCents).toBe(NET - 5000);
    expect(t.reductionsCents).toBe(5000);
    expect(retenues(t).filter((l) => l.kind === 'REDUCTION')).toEqual([expect.objectContaining({ fileId: 902, includedCents: 5000 })]);
  });

  it('commande + facture + reçu de paiement + acompte du même achat : aucune multiplication du coût', () => {
    const ref = [{ kind: 'ORDER', value: 'CMD-77' }];
    const commande = doc(910, [cand([h('FORECAST_COST', NET), h('REDUCTION', 2000, { amountScope: null })], { sourceRole: 'ORDER', references: ref })]);
    const facture = doc(911, [cand([h('REALIZED_COST', NET, { economicDate: '2021-05-02' }), h('REDUCTION', 2000, { amountScope: null })], { references: [...ref, { kind: 'INVOICE', value: 'F-77' }] })],
      { title: 'Facture F-77', typeCode: 'ACQUISITION_INVOICE', date: '2021-05-02' });
    const recu = doc(912, [cand([h('PAYMENT', NET, { economicDate: '2021-05-02' })], { sourceRole: 'PAYMENT_PROOF', references: ref })], { title: 'Reçu CB', typeCode: 'ACQUISITION_PAYMENT' });
    const acompte = doc(913, [cand([h('REALIZED_COST', 10_000, { amountScope: 'DEPOSIT' })], { sourceRole: 'DEPOSIT_INVOICE', references: ref })], { title: 'Facture d’acompte', typeCode: 'ACQUISITION_INVOICE', amountCents: 10_000 });
    const t = computeTco(entree([commande, facture, recu, acompte]));
    expect(t.summary.cumulativeCostCents).toBe(NET);
    expect(retenues(t)).toEqual([expect.objectContaining({ fileId: 911, includedCents: NET })]);
  });

  it('devis non réalisé : aucun coût réel', () => {
    const devis = doc(920, [cand([h('FORECAST_COST', NET), h('REDUCTION', 2000, { amountScope: null })], { sourceRole: 'QUOTE', statusHint: 'ENVISAGED' })], { typeCode: 'ACQUISITION_QUOTE' });
    const t = computeTco(entree([devis]));
    expect(t.summary.cumulativeCostCents).toBe(0);
    expect(t.reductionsCents).toBe(0);
  });

  it('deux achats indépendants de même montant, même date, même fournisseur (deux factures) : jamais fusionnés', () => {
    const a = doc(930, [cand([h('REALIZED_COST', 12_000, { economicDate: '2026-03-01' })], { references: [{ kind: 'INVOICE', value: 'A-1' }] })], { title: 'Facture A-1', typeCode: 'ACQUISITION_INVOICE', amountCents: 12_000, date: '2026-03-01' });
    const b = doc(931, [cand([h('REALIZED_COST', 12_000, { economicDate: '2026-03-01' })], { references: [{ kind: 'INVOICE', value: 'A-2' }] })], { title: 'Facture A-2', typeCode: 'ACQUISITION_INVOICE', amountCents: 12_000, date: '2026-03-01', hash: 'autre' });
    expect(computeTco(entree([a, b])).summary.cumulativeCostCents).toBe(24_000);
  });

  it('ticket de deux équipements distincts : deux achats ciblés ; facture de travaux fournitures + main-d’œuvre : une seule dépense', () => {
    const ticket = doc(940, [
      cand([h('REALIZED_COST', 40_000)], { targets: [{ type: 'ASSET', entityId: CHAISES }] }),
      cand([h('REALIZED_COST', 15_000)], { targets: [{ type: 'ASSET', entityId: TABLE }] }),
    ], { linkedAssetIds: [CHAISES, TABLE], multiAsset: true, amountCents: 55_000, typeCode: 'ACQUISITION_INVOICE' });
    const t = computeTco(entree([ticket]));
    expect(t.summary.cumulativeCostCents).toBe(40_000);
    expect(computeTco(entree([ticket], { assetId: TABLE })).summary.cumulativeCostCents).toBe(15_000);
    const travaux = doc(941, [cand([h('REALIZED_COST', 32_000, { amountScope: null, economicDate: '2026-02-10' }), h('REALIZED_COST', 48_000, { amountScope: null, economicDate: '2026-02-10' })], { typeHint: 'INTERVENTION' })],
      { title: 'Facture travaux', typeCode: 'WORKS_INVOICE', amountCents: 80_000, date: '2026-02-10' });
    const u = computeTco(entree([travaux]));
    expect(u.summary.cumulativeCostCents).toBe(80_000);
    expect(retenues(u)).toEqual([expect.objectContaining({ id: 'doc:941:' + travaux.candidates[0].id + ':net', includedCents: 80_000, composition: expect.objectContaining({ linesMinor: 80_000 }) })]);
  });

  it('document multibiens + remise globale : chaque bien ne reçoit que sa part démontrable, la remise reste non répartie (jamais un avoir)', () => {
    const ticket = doc(950, [
      cand([h('REALIZED_COST', 40_000)], { targets: [{ type: 'ASSET', entityId: CHAISES }] }),
      cand([h('REALIZED_COST', 15_000)], { targets: [{ type: 'ASSET', entityId: TABLE }] }),
      cand([h('REDUCTION', 5000, { amountScope: null })], { sourceRole: null, targets: [] }),
    ], { linkedAssetIds: [CHAISES, TABLE], multiAsset: true, amountCents: 50_000, typeCode: 'ACQUISITION_INVOICE' });
    const t = computeTco(entree([ticket]));
    expect(t.summary.cumulativeCostCents).toBe(40_000);
    expect(t.reductionsCents).toBe(0);
    expect(t.lines.find((l) => l.kind === 'REDUCTION')).toMatchObject({ status: 'UNALLOCATED', reason: 'GLOBAL_DISCOUNT_NOT_ALLOCATED', includedCents: 0 });
  });

  it('remise de ligne + coupon + livraison sur un achat (TVA comprise dans le TTC) : net exact', () => {
    const d = doc(960, [cand([h('REALIZED_COST', 10_000, { amountScope: null }), h('REDUCTION', 1000, { amountScope: null }), h('REDUCTION', 500, { amountScope: null }), h('REALIZED_COST', 690, { amountScope: 'FEE' })])],
      { amountCents: 9190, typeCode: 'ACQUISITION_INVOICE' });
    const t = computeTco(entree([d]));
    expect(t.summary.cumulativeCostCents).toBe(9190);
    expect(retenues(t)).toHaveLength(1);
  });

  it('réanalyse / requalification : qualification stable, mêmes identifiants de lignes', () => {
    const cands = FORMES['lignes sans total : 278,00 + livraison 19,35 − 20,00']();
    const a = qualifyDocumentLines([doc(970, cands)], { today: TODAY });
    const b = qualifyDocumentLines([doc(970, cands)], { today: TODAY });
    expect(a.map((l) => [l.lineId, l.status, l.amountMinor])).toEqual(b.map((l) => [l.lineId, l.status, l.amountMinor]));
  });
});

describe('L109D-U-T3 — identité T3 normalisée (même règle que le TCO)', () => {
  const rec = (id: number, key: string, role: string | null, hints: PersistedFinancialHint[], o: Partial<CandidateRecord> = {}): CandidateRecord => ({
    id, accountId: 1, fileId: 77, candidateKey: key, established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: role === 'ORDER' ? 'ENVISAGED' : 'REALIZED',
    summary: 'Commande', payload: { sourceRoleHint: role, provider: 'Fournisseur', targetHints: [], businessReferences: [{ kind: 'ORDER', value: 'TK-1' }], financialHints: hints }, ...o,
  });
  const ph = (role: string, amountMinor: number, o: Partial<PersistedFinancialHint> = {}): PersistedFinancialHint =>
    ({ role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o });
  const ident = (c: CandidateRecord, all: CandidateRecord[], total: number | null = NET) => buildCandidateIdentity(c, {
    fileAssetId: null, liveAssetIds: new Set(), equipmentAssets: new Map(), documentCandidates: all, documentTotalMinor: total, today: TODAY,
  });
  const comps = (c: CandidateRecord, all: CandidateRecord[], total: number | null = NET) => componentsFromIdentity(ident(c, all, total)).map((x) => [x.kind, x.amountMinor]);

  it('remise isolée dans un second candidat : aucune composante REDUCTION ; le candidat « remise seule » n’est pas établi', () => {
    const achat = rec(1, 'op1', 'INVOICE', [ph('REALIZED_COST', NET)]);
    const remise = rec(2, 'op2', null, [ph('REDUCTION', 2000, { amountScope: null })]);
    expect(comps(achat, [achat, remise])).toEqual([['REALIZED_COST', NET]]);
    expect(ident(remise, [achat, remise]).established).toBe(false);
    expect(comps(remise, [achat, remise])).toEqual([]);
  });

  it('lignes sans total : UNE composante nette (277,35 €), plus 278,00 € ; commande payée : coût réalisé, statut réalisé', () => {
    const lignes = rec(3, 'op1', 'INVOICE', [ph('REALIZED_COST', 27_800, { amountScope: null }), ph('REALIZED_COST', 1935, { amountScope: 'FEE' }), ph('REDUCTION', 2000, { amountScope: null })]);
    expect(comps(lignes, [lignes])).toEqual([['REALIZED_COST', NET]]);
    const commande = rec(4, 'op1', 'ORDER', [ph('FORECAST_COST', NET), ph('REDUCTION', 2000, { amountScope: null }), ph('PAYMENT', NET, { economicDate: '2021-04-24' })]);
    const id = ident(commande, [commande]);
    expect(id.status).toBe('REALIZED');
    expect(componentsFromIdentity(id).map((x) => [x.kind, x.amountMinor, x.economicDate])).toEqual([['REALIZED_COST', NET, '2021-04-24']]);
    // Sans paiement : prévision (statuts existants respectés).
    const nonPayee = rec(5, 'op1', 'ORDER', [ph('FORECAST_COST', NET)]);
    expect(ident(nonPayee, [nonPayee]).status).toBe('ENVISAGED');
    expect(comps(nonPayee, [nonPayee])).toEqual([['FORECAST_COST', NET]]);
  });

  it('vrai avoir : composante REDUCTION conservée ; idempotent (deux constructions identiques)', () => {
    const avoir = rec(6, 'op1', 'CREDIT_NOTE', [ph('REDUCTION', 5000)]);
    expect(comps(avoir, [avoir])).toEqual([['REDUCTION', 5000]]);
    const lignes = rec(7, 'op1', 'INVOICE', [ph('REALIZED_COST', 27_800, { amountScope: null }), ph('REALIZED_COST', 1935, { amountScope: 'FEE' }), ph('REDUCTION', 2000, { amountScope: null })]);
    expect(componentsFromIdentity(ident(lignes, [lignes]))).toEqual(componentsFromIdentity(ident(lignes, [lignes])));
  });
});

describe('L109D-U-GATE — barrière T1', () => {
  const ac = (key: string, role: AnchoredOperationCandidate['sourceRoleHint'], hints: Array<[string, number, string | null]>): AnchoredOperationCandidate => ({
    candidateKey: key, established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: 'REALIZED', summary: key, sourceRoleHint: role, provider: 'Fournisseur',
    targetHints: [], businessReferences: [], temporalHints: {}, evidenceFactRefs: [`f-${key}`], visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [],
    financialHints: hints.map(([r, a, s], i) => ({ role: r as never, amountMinor: a, currency: 'EUR', amountScope: s as never, economicDate: null, periodStart: null, periodEnd: null, factRef: `f-${key}-${i}` })),
  });
  const ctx = (refs: string[]) => ({
    hasExploitableContent: true, documentTypeCode: 'ACQUISITION_ORDER', capabilities: { rooms: true, equipments: true }, keptFactRefs: new Set(refs),
    verifiedIds: { ASSET: new Set<number>(), EQUIPMENT: new Set<number>(), ROOM: new Set<number>() },
  });

  it('jamais de candidat avoir établi depuis la remise d’une commande : rattachée à l’unique achat, candidat non établi (tracé)', () => {
    const achat = ac('op1', 'INVOICE', [['REALIZED_COST', NET, 'TOTAL']]);
    const remise = ac('op2', null, [['REDUCTION', 2000, null]]);
    const r = gateOperationCandidates([achat, remise], ctx(['f-op1', 'f-op2', 'f-op1-0', 'f-op2-0']));
    const [a, b] = r.candidates;
    expect(b).toMatchObject({ established: false, exclusionReason: 'UNQUALIFIED_AMOUNT' });
    expect(b.adjustments).toContain('COMMERCIAL_ADJUSTMENT_NOT_A_CREDIT');
    expect(a.financialHints.map((x) => [x.role, x.amountMinor])).toEqual([['REALIZED_COST', NET], ['REDUCTION', 2000]]);
    expect(a.adjustments).toEqual(expect.arrayContaining(['COMMERCIAL_ADJUSTMENT_MERGED', 'COMMERCIAL_ADJUSTMENT_INTEGRATED']));
    // Vrai avoir : inchangé.
    const avoir = gateOperationCandidates([ac('op1', 'CREDIT_NOTE', [['REDUCTION', 5000, 'TOTAL']])], ctx(['f-op1', 'f-op1-0'])).candidates[0];
    expect(avoir).toMatchObject({ established: true });
    expect(avoir.financialHints[0].role).toBe('REDUCTION');
  });
});

describe('L109D-U-VIEW — présentation et décisions', () => {
  it('composantes de calcul masquées de la fiche, détail consultable ; contexte de rattachement hors ligne principale', () => {
    const t = computeTco(entree([doc(900, FORMES['lignes sans total : 278,00 + livraison 19,35 − 20,00']())]));
    const v = tcoUserView(t.lines);
    expect(v.lines).toHaveLength(1);
    expect(Object.values(v.hidden).filter((x) => x === 'COMPOSITION_SHOWN')).toHaveLength(3);
    expect(v.lines[0].composition).toMatchObject({ netMinor: NET, linesMinor: 27_800, feesMinor: 1935, discountsMinor: 2000, reconciliation: 'RECONCILED' });
  });

  it('décision « Retirer du TCO » prise sur une ancienne ligne de coût : suit le net recomposé (clé secondaire)', () => {
    const t = computeTco(entree([doc(900, FORMES['lignes sans total : 278,00 + livraison 19,35 − 20,00']())]));
    const net = retenues(t)[0];
    const k = tcoLineKeys(net);
    expect(k.primary).toBe(`f:900:REALIZED_COST:${NET}:EUR`);
    expect(k.secondary).toEqual(expect.arrayContaining(['f:900:REALIZED_COST:27800:EUR', 'f:900:REALIZED_COST:1935:EUR']));
    expect(k.secondary.some((x) => x.includes('REDUCTION'))).toBe(false);
  });
});
