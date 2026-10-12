/**
 * Lot 41 (O3a) — composantes financières C12 et état consolidé C8 / C10 /
 * C11 (règles pures). C12-xx par rôle financier, C8-xx, C10-xx, C11-xx.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCandidateIdentity, componentKindOf, componentsFromIdentity, consolidateComponents, consolidateOperationState, normalizeProvider, statusOfSource,
  type CandidateIdentity, type CandidateRecord, type PersistedFinancialHint,
} from '../model';

const hint = (role: string, amountMinor: number, over: Partial<PersistedFinancialHint> = {}): PersistedFinancialHint => ({ role, amountMinor, currency: 'EUR', ...over });

function ident(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: 10, established: true, confidence: 'certain', type: 'INTERVENTION', status: 'REALIZED',
    role: 'INVOICE', summary: 's', provider: 'Garage', providerKey: 'garage', assetIds: [1], targetAuthority: 'DOCUMENT', equipmentIds: [],
    refs: [], dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: null }, hints: [], ...over,
  };
}
const ref = (kind: CandidateIdentity['refs'][number]['kind'], v: string) => ({ kind, value: v, normalized: v.replace(/[^A-Z0-9]/gi, '').toUpperCase() });
const net = (cs: ReturnType<typeof consolidateComponents>) =>
  cs.reduce((t, c) => t + (c.kind === 'FORECAST_COST' ? 0 : c.kind === 'REALIZED_COST' ? c.amountMinor : -c.amountMinor), 0);

describe('C12 — composantes financières par rôle', () => {
  it('C12-01 / INV-013 QUOTE : coût PRÉVU seulement (jamais réalisé)', () => {
    expect(componentsFromIdentity(ident({ role: 'QUOTE', hints: [hint('REALIZED_COST', 120000)] })).map((c) => c.kind)).toEqual(['FORECAST_COST']);
  });

  it('C12-02 / F-001 INVOICE : coût RÉALISÉ', () => {
    expect(componentsFromIdentity(ident({ hints: [hint('REALIZED_COST', 74900, { amountScope: 'TOTAL' })] }))).toEqual([
      expect.objectContaining({ kind: 'REALIZED_COST', amountMinor: 74900, currency: 'EUR' }),
    ]);
  });

  it('C12-03 / F-092 / INV-014 DEPOSIT + facture finale TOTALE incluant l\'acompte : 1 200, jamais 1 500', () => {
    const acompte = componentsFromIdentity(ident({ role: 'DEPOSIT_INVOICE', refs: [ref('INVOICE', 'AC-1')], hints: [hint('REALIZED_COST', 30000, { amountScope: 'DEPOSIT' })] }));
    const finale = componentsFromIdentity(ident({ refs: [ref('INVOICE', 'SO-1')], hints: [hint('REALIZED_COST', 120000, { amountScope: 'TOTAL' }), hint('REALIZED_COST', 30000, { amountScope: 'DEPOSIT' }), hint('REALIZED_COST', 90000, { amountScope: 'BALANCE' })] }));
    const cs = consolidateComponents([{ sourceId: 1, components: acompte }, { sourceId: 2, components: finale }]);
    expect(cs.map((c) => [c.kind, c.amountMinor, c.scope])).toEqual([['REALIZED_COST', 120000, 'TOTAL']]);
    expect(net(cs)).toBe(120000);
  });

  it('C12-04 / F-093 DEPOSIT + facture de SOLDE explicitement distincte : 300 + 900 = 1 200 ; l\'acompte cité deux fois n\'est compté qu\'une', () => {
    const acompte = componentsFromIdentity(ident({ role: 'DEPOSIT_INVOICE', refs: [ref('INVOICE', 'AC-1')], hints: [hint('REALIZED_COST', 30000, { amountScope: 'DEPOSIT' })] }));
    const solde = componentsFromIdentity(ident({ role: 'INVOICE', refs: [ref('INVOICE', 'SO-1')], hints: [hint('REALIZED_COST', 30000, { amountScope: 'DEPOSIT' }), hint('REALIZED_COST', 90000, { amountScope: 'BALANCE' })] }));
    const cs = consolidateComponents([{ sourceId: 1, components: acompte }, { sourceId: 2, components: solde }]);
    expect(net(cs)).toBe(120000);
    expect(cs.find((c) => c.scope === 'DEPOSIT')?.sourceIds).toEqual([1, 2]);
  });

  it('C12-05 / F-095 / F-120 CREDIT_NOTE : réduction, montant ≥ 0 et signe porté par le rôle', () => {
    const [c] = componentsFromIdentity(ident({ role: 'CREDIT_NOTE', hints: [hint('REALIZED_COST', 10000)] }));
    expect(c).toMatchObject({ kind: 'REDUCTION', amountMinor: 10000 });
    expect(net(consolidateComponents([{ sourceId: 1, components: componentsFromIdentity(ident({ hints: [hint('REALIZED_COST', 135000)], refs: [ref('INVOICE', 'F1')] })) }, { sourceId: 2, components: [c] }]))).toBe(125000);
  });

  it('C12-06 / F-097 / INV-FINAL-015 PAYMENT_PROOF : jamais un coût, même si T1 a qualifié le montant de coût', () => {
    expect(componentsFromIdentity(ident({ role: 'PAYMENT_PROOF', hints: [hint('REALIZED_COST', 90000), hint('PAYMENT', 90000)] }))).toEqual([]);
    expect(componentKindOf('PAYMENT', 'INVOICE')).toBeNull();
  });

  it('C12-07 / F-099 / Q4 INDEMNITY : composante qui réduit seulement le coût net ; F-098 REFUND ; F-101 PROCEED', () => {
    expect(componentsFromIdentity(ident({ role: 'CLAIM_DOCUMENT', hints: [hint('INDEMNITY', 80000)] }))[0]).toMatchObject({ kind: 'INDEMNITY', amountMinor: 80000 });
    expect(componentKindOf('REFUND', 'REFUND_PROOF')).toBe('REFUND');
    expect(componentKindOf('PROCEED', 'SALE_DOCUMENT')).toBe('PROCEED');
  });

  it('C12-08 / C12.2 / F-110 / F-111 Contrat : le tarif du contrat est un coût prévu ; la cotisation facturée un coût réalisé de période', () => {
    expect(componentsFromIdentity(ident({ type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', hints: [hint('REALIZED_COST', 4000, { amountScope: 'INSTALLMENT', periodStart: '2026-01-01', periodEnd: '2026-01-31' })] }))
      .map((c) => [c.kind, c.amountMinor])).toEqual([['FORECAST_COST', 4000]]);
    const [f] = componentsFromIdentity(ident({ type: 'CONTRACT', role: 'INVOICE', hints: [hint('REALIZED_COST', 48000, { amountScope: 'INSTALLMENT', periodStart: '2026-01-01', periodEnd: '2026-12-31' })] }));
    expect(f).toMatchObject({ kind: 'REALIZED_COST', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
  });

  it('C12-09 / F-105 / C12.3 devise CHF conservée, aucune conversion inventée', () => {
    expect(componentsFromIdentity(ident({ hints: [hint('REALIZED_COST', 449000, { currency: 'CHF' })] }))[0]).toMatchObject({ amountMinor: 449000, currency: 'CHF' });
  });

  it('C12-10 / F-108 / F-109 identité C12.1 : deux copies d\'une facture = une empreinte ; réanalyse qui corrige le montant = même empreinte', () => {
    const a = componentsFromIdentity(ident({ refs: [ref('INVOICE', 'FA-1')], hints: [hint('REALIZED_COST', 100000)] }));
    const b = componentsFromIdentity(ident({ refs: [ref('INVOICE', 'fa 1')], hints: [hint('REALIZED_COST', 120000)] }));
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
    const cs = consolidateComponents([{ sourceId: 1, components: a }, { sourceId: 2, components: a }]);
    expect(cs).toHaveLength(1);
    expect(cs[0].sourceIds).toEqual([1, 2]);
  });

  it('C12-11 / F-094 deux factures partielles distinctes 500 + 700 : deux composantes additives', () => {
    const a = componentsFromIdentity(ident({ refs: [ref('INVOICE', 'P1')], hints: [hint('REALIZED_COST', 50000, { amountScope: 'TOTAL' })] }));
    const b = componentsFromIdentity(ident({ refs: [ref('INVOICE', 'P2')], hints: [hint('REALIZED_COST', 70000, { amountScope: 'TOTAL' })] }));
    expect(net(consolidateComponents([{ sourceId: 1, components: a }, { sourceId: 2, components: b }]))).toBe(120000);
  });

  it('C12-12 / F-119 / T1-OP-004 rôle inconnu ou preuve « autre » : aucune composante', () => {
    expect(componentsFromIdentity(ident({ hints: [hint('MYSTERE', 100)] }))).toEqual([]);
    expect(componentsFromIdentity(ident({ role: 'OTHER_EVIDENCE', hints: [hint('REALIZED_COST', 100)] }))).toEqual([]);
  });
});

describe('C8 / C11 / C10 — état consolidé', () => {
  const src = (sourceId: number, over: Partial<CandidateIdentity>) => ({ sourceId, identity: ident(over) });

  it('C8-01 / F-069 / F-070 devis puis facture → REALIZED ; facture retirée, devis restant → ENVISAGED', () => {
    const devis = src(1, { role: 'QUOTE', status: statusOfSource('REALIZED', 'QUOTE'), dates: { plannedDate: '2026-11-20', startDate: null, realizedDate: null, endDate: null } });
    const facture = src(2, { role: 'INVOICE', status: 'REALIZED', dates: { plannedDate: null, startDate: null, realizedDate: '2026-11-22', endDate: null } });
    expect(devis.identity.status).toBe('ENVISAGED');
    expect(consolidateOperationState('INTERVENTION', [devis, facture], '2026-12-01')).toMatchObject({ status: 'REALIZED', plannedDate: '2026-11-20', realizedDate: '2026-11-22' });
    expect(consolidateOperationState('INTERVENTION', [devis], '2026-12-01')).toMatchObject({ status: 'ENVISAGED', realizedDate: null });
  });

  it('C8-02 / F-068 preuve d\'annulation certaine → CANCELLED ; une source probable n\'établit pas la réalisation', () => {
    expect(consolidateOperationState('INTERVENTION', [src(1, { status: 'CANCELLED' })], '2026-01-01').status).toBe('CANCELLED');
    expect(consolidateOperationState('INTERVENTION', [src(1, { status: 'REALIZED', confidence: 'probable' })], '2026-01-01').status).toBe('ENVISAGED');
  });

  it('C11-01 INTERVENTION : date de prestation, sinon date de facture (repli C11.1)', () => {
    expect(consolidateOperationState('INTERVENTION', [src(1, { dates: { plannedDate: null, startDate: null, realizedDate: '2026-06-02', endDate: null }, hints: [hint('REALIZED_COST', 1, { economicDate: '2026-06-10' })] })], '2026-12-01').realizedDate).toBe('2026-06-02');
    expect(consolidateOperationState('INTERVENTION', [src(1, { hints: [hint('REALIZED_COST', 1, { economicDate: '2026-06-10' })] })], '2026-12-01').realizedDate).toBe('2026-06-10');
  });

  it('C11-02 / Q13 CONTRACT : start_date = date d\'effet ; signé à effet futur = ENVISAGED jusqu\'à l\'entrée en vigueur', () => {
    const c = src(1, { type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', refs: [ref('POLICY', 'HAB-1')], dates: { plannedDate: null, startDate: '2027-01-01', realizedDate: null, endDate: '2027-12-31' } });
    expect(consolidateOperationState('CONTRACT', [c], '2026-10-12')).toMatchObject({ status: 'ENVISAGED', startDate: '2027-01-01', realizedDate: null, contract: { contractReference: 'HAB-1', effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31' } });
    expect(consolidateOperationState('CONTRACT', [c], '2027-01-01').status).toBe('REALIZED');
  });

  it('C11-03 CLAIM : date de survenue seulement, aucun repli ; C11-04 DISPOSAL : repli sur la date du produit de cession', () => {
    expect(consolidateOperationState('CLAIM', [src(1, { type: 'CLAIM', hints: [hint('INDEMNITY', 1, { economicDate: '2026-05-05' })] })], '2026-12-01').realizedDate).toBeNull();
    expect(consolidateOperationState('DISPOSAL', [src(1, { type: 'DISPOSAL', role: 'SALE_DOCUMENT', hints: [hint('PROCEED', 1000000, { economicDate: '2026-04-04' })] })], '2026-12-01').realizedDate).toBe('2026-04-04');
  });

  it('C11-05 / F-054 type nul de l\'Opération qualifié par le type commun des candidats', () => {
    expect(consolidateOperationState(null, [src(1, { type: 'INTERVENTION' })], '2026-01-01').type).toBe('INTERVENTION');
    expect(consolidateOperationState(null, [src(1, { type: 'INTERVENTION' }), src(2, { type: 'CLAIM' })], '2026-01-01').type).toBeNull();
  });

  it('C10-01 cible : T1 certain prime ; probable seule → bien du document (INFERENCE) ; équipement → bien parent ; sinon sans bien (P08)', () => {
    const rec = (targetHints: NonNullable<CandidateRecord['payload']['targetHints']>): CandidateRecord => ({
      id: 1, accountId: 1, fileId: 1, candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED', summary: 's',
      payload: { targetHints },
    });
    const ctx = { fileAssetId: 5, liveAssetIds: new Set([5, 6, 7]), equipmentAssets: new Map([[30, 7]]) };
    expect(buildCandidateIdentity(rec([{ type: 'ASSET', entityId: 6, confidence: 'certain' }]), ctx)).toMatchObject({ assetIds: [6], targetAuthority: 'DOCUMENT' });
    expect(buildCandidateIdentity(rec([{ type: 'ASSET', entityId: 6, confidence: 'probable' }]), ctx)).toMatchObject({ assetIds: [5], targetAuthority: 'INFERENCE' });
    expect(buildCandidateIdentity(rec([{ type: 'EQUIPMENT', entityId: 30, confidence: 'certain' }]), ctx)).toMatchObject({ assetIds: [7], equipmentIds: [30] });
    expect(buildCandidateIdentity(rec([]), { ...ctx, fileAssetId: null })).toMatchObject({ assetIds: [], targetAuthority: null });
  });

  it('C10-02 / F-114 multi-biens : plusieurs liens, composante globale (aucune ventilation inventée)', () => {
    const s = consolidateOperationState('INTERVENTION', [src(1, { assetIds: [1, 2], hints: [hint('REALIZED_COST', 116000, { amountScope: 'TOTAL' })] })], '2026-01-01');
    expect(s.assets.map((a) => a.assetId)).toEqual([1, 2]);
    expect(s.components).toHaveLength(1);
  });

  it('normalisation du prestataire (comparaison seulement)', () => {
    expect(normalizeProvider('Garage Exemple SARL')).toBe(normalizeProvider('garage exemple'));
    expect(normalizeProvider('  ')).toBeNull();
  });
});
