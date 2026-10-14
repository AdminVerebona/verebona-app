/**
 * Lot 54D — moteur financier partagé, TCO, concordance T2 / TCO / Sinistres
 * (ticket P1 Opérations V1 §3, §4, scénarios FIN-A à FIN-H ; écarts E03, E09).
 * Tests PURS (aucune base) ; la même chose sur base réelle :
 * `src/test/e2e/scenarios/l54d-operations-tco.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  attributeComponent, checkLedger, componentEurMinor, evaluateComponent, prorataUntil, summarizeLedger, type LedgerComponent,
} from '../engine';
import { annualEquivalent, computeTco, reliableValuation, validateUsageBudget, type TcoInput, type TcoOperation } from '../../tco/model';
import { claimCosts } from '../../claims/model';
import { consolidateComponentsDetailed, type DesiredComponent } from '../../consolidation/model';
import { operationCostLines, summarizeOperationCosts } from '@/services/verebona-assistant/canonical/operations';
import type { AssistantOperationRead } from '@/services/business-operations/read-service';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

const BIEN = 10;
let seq = 1;
const comp = (kind: FinancialComponentKind, eur: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: eur, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', parentOperationId: null, realizedDate: '2024-01-10', startDate: null, plannedDate: null,
  assetIds: [BIEN], label: typeCode, components: components.map((c) => ({ ...c, operationId: id })), documents: [{ fileId: id * 10, title: `doc ${id}`, role: 'INVOICE' }], ...o,
});
const entree = (operations: TcoOperation[], o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: BIEN, today: '2026-10-14', operations, assetAcquisitionDate: null, assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, ...o,
});

/** Socle du scénario B (possession) — euros en centimes. */
const scenarioB = (): TcoOperation[] => [
  op(1, 'ACQUISITION', [comp('REALIZED_COST', 2_000_000)], { realizedDate: '2022-03-01' }),
  op(2, 'INTERVENTION', [comp('REALIZED_COST', 120_000), comp('REDUCTION', 10_000)], { realizedDate: '2023-05-02' }),
  op(3, 'FINANCING', [comp('REALIZED_COST', 50_000)], { realizedDate: '2022-03-01' }),
  op(4, 'CLAIM', [comp('INDEMNITY', 30_000)], { realizedDate: '2024-02-01' }),
];

// ═══ Scénarios financiers obligatoires (ticket §5) ════════════════════════

describe('FIN — scénarios chiffrés exacts', () => {
  it('FIN-A — sinistre : réparation 2 000 €, indemnité 1 500 € — brut 2 000, net 500 ; Sinistre / T2 / TCO concordent', () => {
    const sinistre = op(20, 'CLAIM', [comp('INDEMNITY', 150_000)]);
    const reparation = op(21, 'INTERVENTION', [comp('REALIZED_COST', 200_000)], { parentOperationId: 20 });
    const s = claimCosts([{ kind: 'REALIZED_COST', amountCents: 200_000 }, { kind: 'INDEMNITY', amountCents: 150_000 }]);
    expect([s.grossCents, s.netCents, s.complete]).toEqual([200_000, 50_000, true]);
    const tco = computeTco(entree([sinistre, reparation]));
    expect(tco.breakdown.find((b) => b.category === 'CLAIMS')?.costsCents).toBe(200_000);
    expect(tco.summary.cumulativeCostCents).toBe(50_000);
    // T2 : brut 2 000 € (dépenses) et reste à charge 500 € (net d'indemnité), mêmes composantes.
    const t2 = summarizeOperationCosts(operationCostLines([sinistre, reparation].map(asT2), { assetIds: [BIEN] }), null).part;
    expect(t2.sumCents).toBe(200_000);
    expect(t2.sumCents - t2.indemnity.sumCents).toBe(s.netCents);
    expect(t2.sumCents - t2.indemnity.sumCents).toBe(tco.summary.cumulativeCostCents);
  });

  it('FIN-B — possession : 20 000 + 1 200 + 500 − 100 − 300, valeur 18 000 → cumulé 21 300 €, net estimé 3 300 €', () => {
    const t = computeTco(entree(scenarioB(), { valuationHistory: [{ value: 18_000, date: '2026-09-01', mode: 'ESTIMATION_PERSONNELLE', source: 'USER' }] }));
    expect(t.summary.cumulativeCostCents).toBe(2_130_000);
    expect(t.summary.currentValue).toMatchObject({ cents: 1_800_000, date: '2026-09-01' });
    expect(t.summary.netEstimatedCents).toBe(330_000);
    expect(t.status).toBe('COMPLETE');
    expect(t.reductionsCents).toBe(10_000);
    expect(t.indemnitiesCents).toBe(30_000);
    expect(t.reliability.anomalies).toEqual([]);
  });

  it('FIN-C — cession : B + vente 17 000 € et frais 400 € → cumulé 21 700 €, net final 4 700 € (frais comptés une fois)', () => {
    const ops = [...scenarioB(), op(5, 'DISPOSAL', [comp('PROCEED', 1_700_000), comp('REALIZED_COST', 40_000)], { realizedDate: '2026-06-30' })];
    const t = computeTco(entree(ops, { assetStatus: 'VENDU', valuationHistory: [{ value: 18_000, date: '2026-01-01' }] }));
    expect(t.summary.cumulativeCostCents).toBe(2_170_000);
    expect(t.disposal).toMatchObject({ realizedPriceCents: 1_700_000, feesCents: 40_000, resultKind: 'FINAL' });
    expect(t.summary.netFinalCents).toBe(470_000);
    expect(t.summary.netEstimatedCents).toBeNull();
    expect(t.period).toMatchObject({ start: '2022-03-01', end: '2026-06-30', endSource: 'OPERATION' });
  });

  it('FIN-D — acompte 300 € + facture finale 1 200 € incluant l’acompte → coût 1 200 €, pas 1 500 €', () => {
    // Consolidation T3 : la facture TOTALE rend l'acompte non additionnel (F-092).
    const base = { currency: 'EUR', amountEurCents: null, economicDate: null, periodStart: null, periodEnd: null, label: null } as const;
    const { components } = consolidateComponentsDetailed([
      { sourceId: 1, components: [{ ...base, fingerprint: 'dep', kind: 'REALIZED_COST', amountMinor: 30_000, scope: 'DEPOSIT', sourceRole: 'DEPOSIT_INVOICE' } as DesiredComponent] },
      { sourceId: 2, components: [{ ...base, fingerprint: 'fin', kind: 'REALIZED_COST', amountMinor: 120_000, scope: 'TOTAL', sourceRole: 'INVOICE' } as DesiredComponent] },
    ]);
    const cout = components.reduce((n, c) => n + (c.kind === 'REALIZED_COST' ? c.amountMinor : 0), 0);
    expect(cout).toBe(120_000);
    const t = computeTco(entree([op(30, 'INTERVENTION', components.map((c) => comp(c.kind, c.amountMinor)))]));
    expect(t.summary.cumulativeCostCents).toBe(120_000);
  });

  it('FIN-E — financement : capital 20 000 € (information) + intérêts 500 € ; le capital ne double pas l’acquisition', () => {
    const t = computeTco(entree([
      op(40, 'ACQUISITION', [comp('REALIZED_COST', 2_000_000)]),
      op(41, 'FINANCING', [comp('REALIZED_COST', 50_000)]), // seul le coût de financement établi est une composante
    ]));
    expect(t.summary.cumulativeCostCents).toBe(2_050_000);
    expect(t.breakdown.find((b) => b.category === 'FINANCING')?.costsCents).toBe(50_000);
  });

  it('FIN-F — gain à la vente : achat 1 000 €, cession 1 500 € → net final −500 € (aucun plancher)', () => {
    const t = computeTco(entree([
      op(50, 'ACQUISITION', [comp('REALIZED_COST', 100_000)], { realizedDate: '2020-01-01' }),
      op(51, 'DISPOSAL', [comp('PROCEED', 150_000)], { realizedDate: '2025-01-01' }),
    ], { assetStatus: 'VENDU' }));
    expect(t.summary.netFinalCents).toBe(-50_000);
  });

  it('FIN-G — incertitudes : CHF non convertible, valorisation manquante, indemnité multi-biens non ventilée → rien d’inventé, couverture signalée', () => {
    const t = computeTco(entree([
      op(60, 'ACQUISITION', [comp('REALIZED_COST', 500_000)]),
      op(61, 'INTERVENTION', [comp('REALIZED_COST', 45_000, { currency: 'CHF' })]),
      op(62, 'CLAIM', [comp('INDEMNITY', 80_000)], { assetIds: [BIEN, 11] }),
    ]));
    expect(t.summary.cumulativeCostCents).toBe(500_000);
    expect(t.summary.netEstimatedCents).toBeNull();
    expect(t.summary.currentValue).toBeNull();
    expect(t.reliability.unconverted).toEqual([{ currency: 'CHF', amountMinor: 45_000, kind: 'REALIZED_COST' }]);
    expect(t.reliability.unallocated).toEqual({ count: 1, eurCents: -80_000 });
    expect(t.reliability.warnings).toEqual(expect.arrayContaining(['UNCONVERTED_AMOUNTS', 'UNALLOCATED_AMOUNTS', 'NO_RELIABLE_VALUATION']));
    expect(t.status).toBe('INCOMPLETE');
    expect(t.reliability.excluded.map((x) => x.reason).sort()).toEqual(['UNALLOCATED_MULTI_ASSET', 'UNCONVERTED_CURRENCY']);
  });

  it('FIN-H — volumétrie : 1 500 Opérations, fusion / invalidation hors lecture → total exact, aucune composante comptée deux fois', () => {
    const ops = Array.from({ length: 1_500 }, (_, i) => op(1_000 + i, 'INTERVENTION', [comp('REALIZED_COST', 1_234)]));
    const t = computeTco(entree(ops));
    expect(t.summary.cumulativeCostCents).toBe(1_500 * 1_234);
    expect(t.reliability.operationsCounted).toBe(1_500);
    // Une composante citée deux fois (deux justificatifs) n'est comptée qu'une fois.
    const c = comp('REALIZED_COST', 999);
    const e = evaluateComponent({ ...c, operationId: 1 }, { scope: new Set([BIEN]), operationAssetIds: [BIEN] });
    expect(summarizeLedger([e, e]).costsEurMinor).toBe(999);
    expect(checkLedger([e, e]).map((a) => a.code)).toContain('DUPLICATE_COMPONENT');
  });
});

/** Opération TCO → forme T2 (même composantes consolidées). */
function asT2(o: TcoOperation): AssistantOperationRead {
  return {
    id: o.id, accountId: 1, typeCode: o.typeCode, status: o.status as never, parentOperationId: o.parentOperationId, provider: null,
    plannedDate: o.plannedDate, startDate: o.startDate, realizedDate: o.realizedDate, endDate: null, technicalLabel: null, closedAt: null,
    invalidatedAt: null, mergedIntoOperationId: null, version: 1, active: true,
    contractReference: null, effectiveFrom: null, effectiveTo: null, claimStatus: null, claimType: null, insurerClaimRef: null, declaredOn: null,
    assetIds: o.assetIds, documents: [], sourceKinds: [],
    components: o.components.map((c) => ({ id: c.id, kind: c.kind, amountMinor: c.amountMinor, currency: c.currency, amountEurCents: c.amountEurCents, economicDate: c.economicDate, targetAssetId: c.targetAssetId, label: null })),
  } as unknown as AssistantOperationRead;
}

// ═══ Règles TCO (§3) ═════════════════════════════════════════════════════

describe('TCO — périodes, attribution, valorisation, forfaits', () => {
  it('TCO-01 — début = date réelle d’acquisition (Opération, sinon fiche), jamais la date d’ajout ; absente → signalée', () => {
    expect(computeTco(entree([], { assetAcquisitionDate: '2019-05-04' })).period).toMatchObject({ start: '2019-05-04', startSource: 'ASSET_DATA', endSource: 'TODAY' });
    const sans = computeTco(entree([]));
    expect(sans.period.start).toBeNull();
    expect(sans.reliability.warnings).toContain('ACQUISITION_DATE_MISSING');
    expect(sans.status).toBe('INCOMPLETE');
  });

  it('TCO-02 / F-112 — période payée qui dépasse la cession : prorata EXACT au jour', () => {
    const assurance = op(70, 'CONTRACT', [comp('REALIZED_COST', 36_500, { periodStart: '2026-01-01', periodEnd: '2026-12-31' })]);
    const t = computeTco(entree([assurance, op(71, 'DISPOSAL', [comp('PROCEED', 0)], { realizedDate: '2026-03-31' })], { assetStatus: 'VENDU' }));
    // 1er janvier → 31 mars inclus = 90 jours sur 365.
    expect(t.breakdown.find((b) => b.category === 'CONTRACTS')?.costsCents).toBe(9_000);
    expect(t.reliability.warnings).toContain('PRORATA_APPLIED');
    expect(prorataUntil(36_500, '2026-01-01', '2026-12-31', '2026-03-31')).toEqual({ amountMinor: 9_000, days: 90, totalDays: 365 });
    expect(prorataUntil(36_500, '2026-01-01', '2026-12-31', '2027-01-01')).toBeNull();
  });

  it('TCO-03 / F-113 — remboursement réel après résiliation : il REMPLACE l’ajustement théorique', () => {
    const assurance = op(72, 'CONTRACT', [
      comp('REALIZED_COST', 36_500, { periodStart: '2026-01-01', periodEnd: '2026-12-31' }),
      comp('REFUND', 20_000, { economicDate: '2026-03-15' }),
    ]);
    const t = computeTco(entree([assurance, op(73, 'DISPOSAL', [comp('PROCEED', 0)], { realizedDate: '2026-03-31' })], { assetStatus: 'VENDU' }));
    expect(t.summary.cumulativeCostCents).toBe(16_500);
    expect(t.reliability.warnings).not.toContain('PRORATA_APPLIED');
  });

  it('TCO-04 — attribution : ciblée = ce bien seul ; mono-bien implicite ; multi-biens non ventilé hors TCO ; équipement une fois au parent', () => {
    expect(attributeComponent({ targetAssetId: 11 }, [BIEN, 11], new Set([BIEN]))).toBe('OUT');
    expect(attributeComponent({ targetAssetId: BIEN }, [BIEN, 11], new Set([BIEN]))).toBe('IN');
    expect(attributeComponent({ targetAssetId: null }, [BIEN], new Set([BIEN]))).toBe('IN');
    expect(attributeComponent({ targetAssetId: null }, [BIEN, 11], new Set([BIEN]))).toBe('UNALLOCATED');
    expect(attributeComponent({ targetAssetId: null, targetEquipmentId: 7 }, [BIEN, 11], new Set([BIEN]), new Map([[7, BIEN]]))).toBe('IN');
    const chaudiere = op(80, 'INTERVENTION', [comp('REALIZED_COST', 25_000, { targetEquipmentId: 7 })], { assetIds: [BIEN] });
    const t = computeTco(entree([chaudiere], { equipmentAssets: new Map([[7, BIEN]]) }));
    expect(t.summary.cumulativeCostCents).toBe(25_000);
  });

  it('TCO-05 — sous-opérations : intervention enfant d’un sinistre comptée une fois (poste Sinistres), jamais avec le parent', () => {
    const t = computeTco(entree([op(90, 'CLAIM', []), op(91, 'INTERVENTION', [comp('REALIZED_COST', 70_000)], { parentOperationId: 90 })]));
    expect(t.breakdown).toEqual([{ category: 'CLAIMS', label: 'Sinistres', costsCents: 70_000, count: 1 }]);
  });

  it('TCO-06 — exclusions : devis, Opération annulée, coût après cession ; aucune dépréciation inventée', () => {
    const t = computeTco(entree([
      op(100, 'INTERVENTION', [comp('FORECAST_COST', 99_000)], { status: 'ENVISAGED' }),
      op(101, 'INTERVENTION', [comp('REALIZED_COST', 5_000)], { status: 'CANCELLED' }),
      op(102, 'INTERVENTION', [comp('REALIZED_COST', 7_000, { economicDate: '2026-08-01' })]),
      op(103, 'DISPOSAL', [comp('PROCEED', 10_000)], { realizedDate: '2026-07-01' }),
    ], { assetStatus: 'VENDU' }));
    expect(t.summary.cumulativeCostCents).toBe(0);
    expect(t.reliability.excluded.map((x) => x.reason).sort()).toEqual(['AFTER_DISPOSAL', 'FORECAST', 'OPERATION_CANCELLED']);
  });

  it('TCO-07 — valorisation fiable : datée, en euros, non postérieure ; sinon aucune', () => {
    expect(reliableValuation([{ value: 1000, date: null }], '2026-01-01')).toBeNull();
    expect(reliableValuation([{ value: 1000, date: '2026-02-01' }], '2026-01-01')).toBeNull();
    expect(reliableValuation([{ value: 1000, date: '2025-02-01', currency: 'CHF' }], '2026-01-01')).toBeNull();
    expect(reliableValuation([{ value: 900, date: '2024-01-01' }, { value: 1000.5, date: '2025-02-01', mode: 'AVIS_VALEUR' }], '2026-01-01'))
      .toEqual({ cents: 100_050, date: '2025-02-01', mode: 'AVIS_VALEUR', source: null });
  });

  it('TCO-08 — cession sans prix réalisé : simulation PROVISOIRE au prix souhaité, jamais un résultat définitif', () => {
    const t = computeTco(entree([op(110, 'ACQUISITION', [comp('REALIZED_COST', 300_000)])], { assetStatus: 'VENDU', assetSaleDate: '2026-05-01', desiredSalePriceCents: 250_000 }));
    expect(t.disposal).toMatchObject({ resultKind: 'PROVISIONAL', realizedPriceCents: null, provisionalNetCents: 50_000 });
    expect(t.summary.netFinalCents).toBeNull();
    expect(t.reliability.warnings).toContain('DISPOSAL_PRICE_MISSING');
  });

  it('TCO-09 — forfaits d’usage séparés du réel : jamais dans le coût cumulé ; devise étrangère jamais additionnée', () => {
    const t = computeTco(entree([op(120, 'ACQUISITION', [comp('REALIZED_COST', 100_000)])], {
      budgets: [
        { id: 1, assetId: BIEN, category: 'FUEL', label: null, amountMinor: 12_000, currency: 'EUR', periodicity: 'MONTHLY', validFrom: '2026-01-01', validTo: null },
        { id: 2, assetId: BIEN, category: 'TOLLS', label: null, amountMinor: 30_000, currency: 'EUR', periodicity: 'YEARLY', validFrom: null, validTo: '2025-12-31' },
        { id: 3, assetId: BIEN, category: 'OTHER', label: 'Vignette CH', amountMinor: 4_000, currency: 'CHF', periodicity: 'YEARLY', validFrom: null, validTo: null },
      ],
    }));
    expect(t.summary.cumulativeCostCents).toBe(100_000);
    expect(t.usage.annualEstimateCents).toBe(144_000);
    expect(t.usage.otherCurrencies).toEqual([{ currency: 'CHF', annualEquivalentMinor: 4_000 }]);
    expect(annualEquivalent({ amountMinor: 100, periodicity: 'QUARTERLY' })).toBe(400);
    expect(validateUsageBudget({ category: 'FUEL', amountMinor: 1.5, currency: 'EUR', periodicity: 'MONTHLY' })).toMatch(/Montant/);
    expect(validateUsageBudget({ category: 'FUEL', amountMinor: 100, currency: 'XXX', periodicity: 'MONTHLY' })).toMatch(/Devise/);
    expect(validateUsageBudget({ category: 'FUEL', amountMinor: 100, currency: 'EUR', periodicity: 'MONTHLY', validFrom: '2026-02-01', validTo: '2026-01-01' })).toMatch(/fin de validité/);
  });

  it('TCO-15 — cas C29 du TCO : F-002 / F-116 équipement une fois ; F-091 devis + facture ; F-092 / F-093 acompte ; F-094 factures partielles ; F-103 principal hors TCO ; F-105 CHF hors agrégat ; F-115 composante ciblée ; F-124 net provisoire ; F-159 / F-160 indemnité attribuée / non allouée', () => {
    const tco = (ops: TcoOperation[], o: Partial<TcoInput> = {}) => computeTco(entree(ops, o));
    // F-002 / F-116 : composante d'un équipement du bien, Opération liée au bien ET à l'équipement → une fois.
    expect(tco([op(140, 'INTERVENTION', [comp('REALIZED_COST', 30_000, { targetEquipmentId: 3 })])], { equipmentAssets: new Map([[3, BIEN]]) }).summary.cumulativeCostCents).toBe(30_000);
    // F-091 : devis 1 200 + facture 1 350 → 1 350.
    expect(tco([op(141, 'INTERVENTION', [comp('FORECAST_COST', 120_000), comp('REALIZED_COST', 135_000)])]).summary.cumulativeCostCents).toBe(135_000);
    // F-092 / F-093 : acompte + solde (portions distinctes consolidées par T3) = 1 200.
    expect(tco([op(142, 'INTERVENTION', [comp('REALIZED_COST', 30_000), comp('REALIZED_COST', 90_000)])]).summary.cumulativeCostCents).toBe(120_000);
    // F-094 : deux factures partielles 500 + 700 → 1 200.
    expect(tco([op(143, 'INTERVENTION', [comp('REALIZED_COST', 50_000), comp('REALIZED_COST', 70_000)])]).summary.cumulativeCostCents).toBe(120_000);
    // F-103 : principal = détail du financement, jamais une composante → hors TCO.
    expect(tco([op(144, 'FINANCING', [])]).summary.cumulativeCostCents).toBe(0);
    // F-105 : CHF sans EUR → hors agrégat EUR, montant d'origine visible.
    expect(tco([op(145, 'INTERVENTION', [comp('REALIZED_COST', 45_000, { currency: 'CHF' })])]).reliability.unconverted).toEqual([{ currency: 'CHF', amountMinor: 45_000, kind: 'REALIZED_COST' }]);
    // F-115 : multi-biens, composante ciblée bien A → TCO de A seulement.
    const multi = op(146, 'INTERVENTION', [comp('REALIZED_COST', 10_000, { targetAssetId: BIEN }), comp('REALIZED_COST', 20_000, { targetAssetId: 11 })], { assetIds: [BIEN, 11] });
    expect(tco([multi]).summary.cumulativeCostCents).toBe(10_000);
    // F-124 : VENDU sans prix réalisé → net provisoire seulement.
    expect(tco([op(147, 'ACQUISITION', [comp('REALIZED_COST', 10_000)])], { assetStatus: 'VENDU', assetSaleDate: '2026-01-01', desiredSalePriceCents: 8_000 }).disposal.resultKind).toBe('PROVISIONAL');
    // F-159 : indemnité attribuée au bien → TCO réduit ; F-160 : non allouée → aucune réduction individuelle.
    expect(tco([op(148, 'CLAIM', [comp('REALIZED_COST', 50_000), comp('INDEMNITY', 20_000, { targetAssetId: BIEN })], { assetIds: [BIEN, 11] })]).summary.cumulativeCostCents).toBe(-20_000 + 0);
    expect(tco([op(149, 'CLAIM', [comp('INDEMNITY', 20_000)], { assetIds: [BIEN, 11] })]).summary.cumulativeCostCents).toBe(0);
  });

  it('TCO-10 — lecture partielle (garde-fou de volume) : statut PARTIEL, jamais COMPLET', () => {
    const t = computeTco(entree([op(130, 'ACQUISITION', [comp('REALIZED_COST', 1)])], { readComplete: false, assetAcquisitionDate: '2020-01-01' }));
    expect(t.status).toBe('PARTIAL');
    expect(t.reliability.warnings).toContain('PARTIAL_READ');
  });
});

// ═══ Écarts E03 / E09 (règles pures) ═════════════════════════════════════

describe('OPS-E09 / OPS-E03 — zéro ≠ inconnu, aucune conversion inventée', () => {
  it('OPS-E09 — devise sans contre-valeur : null (jamais 0) ; Sinistre : frais CHF exclus, indemnité EUR comptée, couverture incomplète', () => {
    expect(componentEurMinor({ amountMinor: 0, currency: 'EUR', amountEurCents: null })).toBe(0);
    expect(componentEurMinor({ amountMinor: 45_000, currency: 'CHF', amountEurCents: null })).toBeNull();
    expect(componentEurMinor({ amountMinor: 45_000, currency: 'XXX', amountEurCents: 46_000 })).toBeNull();
    expect(componentEurMinor({ amountMinor: 60_000, currency: 'CHF', amountEurCents: 62_500 })).toBe(62_500);
    const s = claimCosts([
      { kind: 'REALIZED_COST', amountCents: null, amountMinor: 120_000, currency: 'CHF' },
      { kind: 'INDEMNITY', amountCents: 50_000, amountMinor: 50_000, currency: 'EUR' },
    ]);
    expect(s).toMatchObject({ grossCents: 0, indemnityCents: 50_000, complete: false, unconverted: [{ kind: 'REALIZED_COST', amountMinor: 120_000, currency: 'CHF' }] });
    const e = evaluateComponent(comp('REALIZED_COST', 120_000, { currency: 'CHF', operationId: 1 }), { scope: null, operationAssetIds: [] });
    expect(e).toMatchObject({ included: false, exclusion: 'UNCONVERTED_CURRENCY', includedEurMinor: 0, eurMinor: null });
  });

  it('OPS-E03 — F-106 contre-valeur EUR explicite retenue ; contradictoire entre deux justificatifs → aucune retenue', () => {
    const c = (eur: number | null): DesiredComponent => ({
      fingerprint: 'f', kind: 'REALIZED_COST', amountMinor: 60_000, currency: 'CHF', amountEurCents: eur, economicDate: null, periodStart: null, periodEnd: null,
      scope: 'TOTAL', sourceRole: 'INVOICE', label: null,
    });
    expect(consolidateComponentsDetailed([{ sourceId: 1, components: [c(null)] }, { sourceId: 2, components: [c(62_500)] }]).components[0].amountEurCents).toBe(62_500);
    expect(consolidateComponentsDetailed([{ sourceId: 1, components: [c(62_500)] }, { sourceId: 2, components: [c(62_500)] }]).components[0].amountEurCents).toBe(62_500);
    expect(consolidateComponentsDetailed([{ sourceId: 1, components: [c(62_500)] }, { sourceId: 2, components: [c(61_900)] }]).components[0].amountEurCents).toBeNull();
    expect(consolidateComponentsDetailed([{ sourceId: 1, components: [c(62_500)] }, { sourceId: 2, components: [c(61_900)] }, { sourceId: 3, components: [c(62_500)] }]).components[0].amountEurCents).toBeNull();
  });
});
