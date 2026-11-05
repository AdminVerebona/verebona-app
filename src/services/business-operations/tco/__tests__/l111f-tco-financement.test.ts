/**
 * Lot 111F — ticket P1 « TCO — coût de possession, financement et
 * valorisation ». Tests PURS sur le moteur TCO RÉEL (`computeTco`) : coût
 * annuel moyen hors prix d'achat (`./annual`), valorisation admissible
 * (`./ownership-indicators`), prêts (`./financing`), indicateurs de la fiche.
 * Lecture SQL, routes et écran : `src/test/e2e/scenarios/l111f-tco-financement.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, reliableValuation, type TcoAssetPrice, type TcoInput, type TcoOperation } from '../model';
import { annualizeCents, ownershipDuration } from '../annual';
import { assessValuations, assetAcquisitionPrice, valuationAgeLabel } from '../ownership-indicators';
import { planFinancingComponents, TCO_FINANCING_BASIS_LABEL, type TcoFinancingDetails } from '../financing';
import { toTcoDto } from '../dto';
import type { ComponentProvenance } from '../fact-identity';
import type { EconomicDocumentCandidate, EconomicDocumentInput, EconomicHint } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';
import { ownershipCostAnswer } from '@/services/verebona-assistant/canonical/structured-answers';

const MAISON = 11;
const TODAY = '2026-11-05';
const ACHAT = '2021-11-05';
let seq = 111_000;

const hint = (role: string, amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'INTERVENTION', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [],
  targets: [{ type: 'ASSET', entityId: MAISON }], hints, t3Outcome: null, ...o,
});
const doc = (fileId: number, o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: `Facture ${fileId}`, typeCode: 'REPAIR_INVOICE', legacyType: null, date: '2024-06-01', supplier: null,
  amountCents: null, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [MAISON], multiAsset: false, candidates: [], operations: [], ...o,
});
const travaux = (fileId: number, cents: number, date: string) => doc(fileId, { amountCents: cents, date, candidates: [cand([hint('REALIZED_COST', cents)])] });
const comp = (kind: FinancialComponentKind, cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: ACHAT, startDate: null, plannedDate: null,
  assetIds: [MAISON], label: typeCode, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const provenance = (entries: Array<[number, number[]]>) => new Map<number, ComponentProvenance>(entries.map(([id, files]) => [id, {
  documentFileIds: files, withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: true,
}]));
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: MAISON, today: TODAY, operations: [], assetAcquisitionDate: ACHAT, assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: prix(40_000_000),
  assetCategory: 'IMMOBILIER', ...o,
});

/**
 * Prêt immobilier : capital 300 000 € (jamais un coût), 20 échéances passées
 * d'intérêts + assurance (1 000 € chacune = 20 000 €) selon le tableau
 * d'amortissement, 10 échéances futures (prévisionnel).
 */
function pretMaison(id = 900, fileId = 9001, o: { passees?: number; futures?: number; montant?: number; debut?: string } = {}) {
  const montant = o.montant ?? 100_000;
  const comps: LedgerComponent[] = [comp('FORECAST_COST', 30_000_000, { label: 'Capital emprunté' })];
  const debut = new Date(`${o.debut ?? '2022-01-05'}T00:00:00Z`);
  const n = (o.passees ?? 20) + (o.futures ?? 10);
  for (let i = 0; i < n; i++) {
    const d = new Date(debut); d.setUTCMonth(debut.getUTCMonth() + (i < (o.passees ?? 20) ? i * 2 : 0) + (i >= (o.passees ?? 20) ? 60 + (i - (o.passees ?? 20)) : 0));
    comps.push(comp('FORECAST_COST', montant, { economicDate: d.toISOString().slice(0, 10), label: 'Intérêts et assurance' }));
  }
  const operation = op(id, 'FINANCING', comps, { status: 'IN_PROGRESS', realizedDate: null, startDate: '2021-11-05', label: 'Financement — Prêt immobilier', documents: [{ fileId, title: 'Tableau d’amortissement', role: 'CONTRACT_DOCUMENT', date: '2021-10-20' }] });
  const details: TcoFinancingDetails = { reference: 'PRET-1', lender: 'Banque', principalAmountMinor: 30_000_000, principalCurrency: 'EUR', effectiveFrom: '2021-11-05', effectiveTo: '2041-11-05' };
  const prov = provenance(operation.components.map((c) => [c.id, [fileId]]));
  return { operation, details, prov };
}

describe('L111F — coût annuel moyen de possession (prix d’achat jamais annualisé)', () => {
  it('L111F-01 — maison 400 000 / 50 000 / 20 000 / 5 ans : total 470 000 €, annuel ≈ 14 000 €/an, capital jamais compté', () => {
    const p = pretMaison();
    const t = computeTco(entree({
      operations: [p.operation], componentProvenance: p.prov, financingDetails: new Map([[900, p.details]]),
      documents: [travaux(101, 3_800_000, '2023-03-01'), travaux(102, 1_200_000, '2025-01-15')], // dont remplacement de chaudière 12 000 €
    }));
    expect(t.summary.cumulativeCostCents).toBe(47_000_000);
    expect(t.annual.average.acquisitionPriceCents).toBe(40_000_000);
    expect(t.annual.average.ownershipCostsCents).toBe(7_000_000);
    // Décision PO du 05/11 : années anniversaires — 05/11/2021 → 05/11/2026 = exactement 5 ans.
    expect(t.annual.average.duration).toEqual({ fullYears: 5, remainderDays: 0, yearDays: 365 });
    expect(t.annual.average.years).toBe(5);
    expect(t.annual.average.cents).toBe(1_400_000); // 14 000,00 €/an exactement
    // Jamais l'ancienne formule (achat annualisé ≈ 94 000 €/an).
    expect(t.annual.average.cents!).toBeLessThan(47_000_000 / 5 / 5);
    // Capital : ligne conservée, jamais un coût.
    expect(t.lines.find((l) => l.reason === 'LOAN_PRINCIPAL')).toMatchObject({ includedCents: 0, status: 'EXCLUDED' });
    // Financement à date (compris dans le total) et prévisionnel séparé.
    expect(t.indicators.financing).toMatchObject({ costToDateCents: 2_000_000, remainingCents: 1_000_000, contractualTotalCents: 3_000_000, basisLabel: TCO_FINANCING_BASIS_LABEL });
    expect(t.indicators.financing.loans).toHaveLength(1);
    expect(t.lines.filter((l) => l.financingBasis === 'SCHEDULE')).toHaveLength(20);
    expect(t.lines.filter((l) => l.financingBasis === 'SCHEDULE').every((l) => /présumée honorée/.test(l.note ?? '') && !/réellement payé|paiements vérifiés/.test(l.note ?? ''))).toBe(true);
    // Mêmes lignes : Σ années = total ; indicateurs de la fiche.
    expect(t.annual.reconciled).toBe(true);
    expect(t.indicators.total).toMatchObject({ cents: 47_000_000, financingToDateCents: 2_000_000 });
    expect(t.indicators.annualAverage).toMatchObject({ cents: t.annual.average.cents, unavailableReason: null });
    expect(t.indicators.annualAverage.info).toMatch(/prix d’achat du bien 400\s000,00\s€/);
    // Sans estimation : coût net « – » avec motif, jamais le prix d'achat comme valeur.
    expect(t.summary.netEstimatedCents).toBeNull();
    expect(t.indicators.net).toMatchObject({ cents: null, valuation: null });
    expect(t.indicators.net.unavailableReason).toMatch(/Aucune estimation de valeur postérieure à l’achat/);
  });

  it('L111F-02 — avec estimation post-achat de 430 000 € : coût net 40 000 € ; estimation la plus récente PAR DATE, pas par ordre d’ajout', () => {
    const p = pretMaison();
    const base = { operations: [p.operation], componentProvenance: p.prov, financingDetails: new Map([[900, p.details]]), documents: [travaux(101, 5_000_000, '2023-03-01')] };
    const t = computeTco(entree({ ...base, valuationHistory: [
      { id: 'b', value: 430_000, date: '2026-09-01', mode: 'ESTIMATION_AGENCE', source: 'USER', addedAt: '2026-09-02T10:00:00Z' },
      { id: 'a', value: 410_000, date: '2024-05-01', mode: 'AVIS_VALEUR', source: 'USER', addedAt: '2026-10-01T10:00:00Z' }, // ajoutée APRÈS, mais plus ancienne
    ] }));
    expect(t.summary.currentValue).toMatchObject({ cents: 43_000_000, date: '2026-09-01' });
    expect(t.summary.netEstimatedCents).toBe(4_000_000);
    expect(t.indicators.net).toMatchObject({ kind: 'ESTIMATED', cents: 4_000_000, valuation: { cents: 43_000_000, date: '2026-09-01', ageLabel: 'il y a 2 mois' } });
    expect(t.indicators.net.info).toMatch(/Aucun frais de revente hypothétique/);
  });

  it('L111F-03 — valorisations non admissibles : future, antérieure / égale à l’achat, non datée, autre devise, date d’achat inconnue', () => {
    const h = [
      { value: 500_000, date: '2027-01-01' },
      { value: 390_000, date: ACHAT },
      { value: 380_000, date: '2020-01-01' },
      { value: 420_000, date: null },
      { value: 420_000, date: '2026-01-01', currency: 'CHF' },
    ];
    const r = assessValuations(h, { asOf: TODAY, acquisitionDate: ACHAT });
    expect(r.retainedIndex).toBeNull();
    expect(r.items.map((x) => x.rejection)).toEqual(['FUTURE', 'NOT_AFTER_ACQUISITION', 'NOT_AFTER_ACQUISITION', 'UNDATED', 'CURRENCY']);
    expect(reliableValuation(h, TODAY, ACHAT)).toBeNull();
    expect(reliableValuation([{ value: 420_000, date: '2026-01-01' }], TODAY, null)).toBeNull();
    expect(reliableValuation([{ value: 420_000, date: '2026-01-01' }], TODAY, ACHAT)).toMatchObject({ cents: 42_000_000 });
    const t = computeTco(entree({ valuationHistory: [{ value: 390_000, date: ACHAT }] }));
    expect(t.summary.netEstimatedCents).toBeNull();
    expect(t.indicators.net.unavailableReason).toMatch(/antérieure ou égale à la date d’achat/);
    const sansDate = computeTco(entree({ assetAcquisitionDate: null, valuationHistory: [{ value: 420_000, date: '2026-01-01' }] }));
    expect(sansDate.summary.netEstimatedCents).toBeNull();
    expect(sansDate.indicators.net.unavailableReason).toMatch(/Date d’achat du bien inconnue/);
    // À date égale : la dernière enregistrée.
    const egal = assessValuations([{ value: 1, date: '2026-01-01', addedAt: '2026-02-01' }, { value: 2, date: '2026-01-01', addedAt: '2026-01-15' }], { asOf: TODAY, acquisitionDate: ACHAT });
    expect(egal.retainedIndex).toBe(0);
    expect(valuationAgeLabel('2024-11-05', TODAY)).toBe('il y a 2 ans');
  });

  it('L111F-04 — maison ~497 k€ détenue ~5,5 ans : plus de « ~90 k€/an » ; moyenne reconstruite depuis dépenses et financement', () => {
    const t = computeTco(entree({
      assetAcquisitionDate: '2021-05-01', assetPrice: prix(45_000_000),
      documents: [travaux(201, 3_709_283, '2022-03-01'), travaux(202, 1_000_000, '2025-02-01')],
    }));
    expect(t.summary.cumulativeCostCents).toBe(49_709_283);
    const ancienne = annualizeCents(49_709_283, t.annual.average.duration!);
    expect(ancienne).toBeGreaterThan(9_000_000);
    expect(t.annual.average.cents).toBe(annualizeCents(4_709_283, t.annual.average.duration!));
    expect(t.annual.average.duration).toEqual({ fullYears: 5, remainderDays: 188, yearDays: 365 }); // 01/05/2021 → 05/11/2026
    expect(t.annual.average.cents!).toBeLessThan(1_000_000);
  });

  it('L111F-05 — prix d’achat inconnu : moyenne « – » (jamais un prix fictif) ; location / don : rien à soustraire', () => {
    const inconnu = computeTco(entree({ assetPrice: null, documents: [travaux(301, 100_000, '2024-01-01')] }));
    expect(inconnu.annual.average).toMatchObject({ status: 'ACQUISITION_PRICE_UNKNOWN', cents: null });
    expect(inconnu.indicators.annualAverage.unavailableReason).toMatch(/Prix d’achat du bien inconnu/);
    const location = computeTco(entree({ assetPrice: null, acquisitionExpected: false, documents: [travaux(302, 100_000, '2024-01-01')] }));
    expect(location.annual.average.status).toBe('COMPUTED');
    expect(location.annual.average.acquisitionPriceCents).toBe(0);
    expect(location.annual.average.cents).toBe(20_000); // 100 000 c ÷ 5 ans pleins
  });

  it('L111F-06 — gros travaux et remplacement de chaudière : inclus intégralement, aucune revalorisation automatique', () => {
    const sans = computeTco(entree({ documents: [travaux(401, 500_000, '2024-01-01')] }));
    const avec = computeTco(entree({ documents: [travaux(401, 500_000, '2024-01-01'), travaux(402, 1_500_000, '2025-10-01')] }));
    expect(avec.annual.average.ownershipCostsCents! - sans.annual.average.ownershipCostsCents!).toBe(1_500_000);
    expect(avec.summary.currentValue).toBeNull();
    expect(avec.summary.netEstimatedCents).toBeNull();
  });

  it('L111F-07 — prix immobilier ventilé : prix du bien seul retiré ; frais compris dans le net d’un achat restent au numérateur', () => {
    expect(assetAcquisitionPrice({
      acquisitionStatus: 'DOCUMENTED', assetPriceEurCents: null,
      lines: [{ status: 'RETAINED_DIRECT', kind: 'REALIZED_COST', category: 'ACQUISITION', includedCents: 43_000_000, composition: { feesMinor: 3_000_000, currency: 'EUR' } }],
    })).toBe(40_000_000);
    expect(assetAcquisitionPrice({
      acquisitionStatus: 'DOCUMENTED', assetPriceEurCents: 40_000_000,
      lines: [{ status: 'RETAINED_CONSOLIDATED', kind: 'REALIZED_COST', category: 'ACQUISITION', includedCents: 42_500_000 }],
    })).toBe(40_000_000);
    expect(assetAcquisitionPrice({ acquisitionStatus: 'MISSING', assetPriceEurCents: null, lines: [] })).toBeNull();
  });

  it('L111F-08 — dépenses d’usage estimées : moyenne avec estimations sur la même base hors acquisition, part estimée signalée', () => {
    const t = computeTco(entree({
      assetCategory: 'VEHICULE', assetPrice: prix(2_000_000), assetAcquisitionDate: '2024-11-06',
      budgets: [{ id: 1, assetId: MAISON, category: 'FUEL', label: null, amountMinor: 10_000, currency: 'EUR', periodicity: 'MONTHLY', validFrom: '2024-11-06', validTo: null }],
    }));
    const estime = t.summary.estimatedUsageComplementCents;
    expect(estime).toBeGreaterThan(0);
    expect(t.usage.complement.averageWithEstimatesCents).toBe(annualizeCents(t.summary.totalWithEstimatesCents - 2_000_000, t.annual.average.duration!));
    expect(t.indicators.annualAverage.cents).toBe(t.usage.complement.averageWithEstimatesCents);
    expect(t.indicators.annualAverage.estimatedShareCents).toBeGreaterThan(0);
    expect(t.indicators.total).toMatchObject({ cents: t.summary.totalWithEstimatesCents, estimatedShareCents: estime });
    // Véhicule sans estimation datée : prix d'achat jamais une valeur actuelle.
    expect(t.indicators.net.cents).toBeNull();
  });

  it('L111F-09 — bien vendu : prix réalisé, frais de vente réels comptés une fois ; jamais de frais hypothétiques', () => {
    const vente = op(950, 'DISPOSAL', [comp('PROCEED', 45_000_000), comp('REALIZED_COST', 1_000_000, { economicDate: '2026-06-01', label: 'Frais d’agence' })], { realizedDate: '2026-06-01' });
    const t = computeTco(entree({ assetStatus: 'VENDU', operations: [vente], documents: [travaux(501, 2_000_000, '2023-01-01')],
      valuationHistory: [{ value: 999_999, date: '2026-01-01' }] }));
    expect(t.summary.cumulativeCostCents).toBe(43_000_000);
    expect(t.summary.netFinalCents).toBe(43_000_000 - 45_000_000);
    expect(t.indicators.net).toMatchObject({ kind: 'FINAL', cents: -2_000_000, realizedPriceCents: 45_000_000, disposalFeesCents: 1_000_000 });
    expect(t.summary.currentValue).toBeNull();
    const a = ownershipCostAnswer({ id: MAISON, name: 'Maison' } as never, t) as { answer: string };
    expect(a.answer).toMatch(/coût net final : −?\s?-?20\s?000,00\s?€/);
  });
});

describe('L111F — prêts (Opérations FINANCING existantes)', () => {
  it('L111F-FIN-01 — plusieurs prêts reliés au bien : consolidés sans doublon, jamais fusionnés', () => {
    const a = pretMaison(900, 9001);
    const b = pretMaison(901, 9002, { passees: 5, futures: 0, montant: 20_000 });
    b.details = { ...b.details, reference: 'PTZ-1', principalAmountMinor: 5_000_000 };
    b.operation.components[0] = { ...b.operation.components[0], amountMinor: 5_000_000 };
    const t = computeTco(entree({
      operations: [a.operation, b.operation], componentProvenance: new Map([...a.prov, ...b.prov]),
      financingDetails: new Map([[900, a.details], [901, b.details]]),
    }));
    expect(t.indicators.financing.loans.map((l) => [l.reference, l.costToDateCents])).toEqual([['PRET-1', 2_000_000], ['PTZ-1', 100_000]]);
    expect(t.indicators.financing.costToDateCents).toBe(2_100_000);
    expect(t.summary.cumulativeCostCents).toBe(40_000_000 + 2_100_000);
    expect(t.lines.filter((l) => l.reason === 'LOAN_PRINCIPAL')).toHaveLength(2);
  });

  it('L111F-FIN-02 — avenant : remplace l’échéancier à partir de sa date d’effet, sans prêt fictif', () => {
    const c = (cents: number, date: string) => ({ id: seq++, kind: 'FORECAST_COST' as const, amountMinor: cents, currency: 'EUR', amountEurCents: null, date });
    const orig = [c(1_000, '2025-01-05'), c(1_000, '2025-02-05'), c(1_000, '2025-03-05'), c(1_000, '2027-01-05')];
    const avenant = [c(700, '2025-03-05'), c(700, '2027-01-05')];
    const all = [...orig, ...avenant];
    const plan = planFinancingComponents({
      components: all, details: null, today: TODAY, dateOf: (id) => all.find((x) => x.id === id)!.date,
      filesOf: (id) => (orig.some((x) => x.id === id) ? [1] : [2]), documentDates: new Map([[1, '2024-12-01'], [2, '2025-02-20']]),
    });
    expect(plan.get(orig[0].id)).toMatchObject({ kind: 'CONTRACTUAL_TO_DATE' });
    expect(plan.get(orig[1].id)).toMatchObject({ kind: 'CONTRACTUAL_TO_DATE' });
    expect(plan.get(orig[2].id)).toMatchObject({ kind: 'SUPERSEDED', byFileId: 2, effectiveFrom: '2025-03-05' });
    expect(plan.get(orig[3].id)).toMatchObject({ kind: 'SUPERSEDED' });
    expect(plan.get(avenant[0].id)).toMatchObject({ kind: 'CONTRACTUAL_TO_DATE' });
    expect(plan.has(avenant[1].id)).toBe(false); // future : prévisionnel
  });

  it('L111F-FIN-03 — avenant dans le moteur : coût à date et prévisionnel recalculés, aucune alerte de doublon', () => {
    const debut = pretMaison(900, 9001, { passees: 4, futures: 2, montant: 100_000, debut: '2025-01-05' });
    const av = [comp('FORECAST_COST', 70_000, { economicDate: '2026-05-05' }), comp('FORECAST_COST', 70_000, { economicDate: '2027-01-05' }), comp('FORECAST_COST', 70_000, { economicDate: '2027-02-05' })]
      .map((x) => ({ ...x, operationId: 900 }));
    const operation = { ...debut.operation, components: [...debut.operation.components, ...av], documents: [...debut.operation.documents, { fileId: 9100, title: 'Avenant', role: 'CONTRACT_DOCUMENT', date: '2026-04-15' }] };
    const prov = new Map([...debut.prov, ...provenance(av.map((x) => [x.id, [9100]]))]);
    const t = computeTco(entree({ operations: [operation], componentProvenance: prov, financingDetails: new Map([[900, debut.details]]) }));
    // Échéances d'origine : 05/01, 05/03, 05/05, 05/07/2025 (passées) ; futures 2030… remplacées (≥ 05/05/2026).
    expect(t.indicators.financing.loans[0]).toMatchObject({ costToDateCents: 400_000 + 70_000, remainingCents: 140_000, supersededCount: 2 });
    expect(t.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
  });

  it('L111F-FIN-04 — aucun prêt documenté : aucun coût de financement inventé, sous-partie absente', () => {
    const t = computeTco(entree({ documents: [travaux(601, 100_000, '2024-01-01')] }));
    expect(t.indicators.financing).toMatchObject({ loans: [], costToDateCents: 0, contractualTotalCents: null, basisLabel: null });
  });

  it('L111F-FIN-05 — paiement prouvé d’une échéance : reste un fait payé (jamais rétrogradé en « présumé »)', () => {
    const c = comp('REALIZED_COST', 50_000, { economicDate: '2025-06-05', economicDateResolution: { basis: 'PAYMENT', date: '2025-06-05', status: 'RESOLVED' } as never });
    const operation = op(910, 'FINANCING', [c], { documents: [{ fileId: 9200, title: 'Relevé', role: 'PAYMENT_PROOF', date: '2025-06-06' }] });
    const t = computeTco(entree({ operations: [operation], componentProvenance: provenance([[operation.components[0].id, [9200]]]) }));
    const l = t.lines.find((x) => x.id === `c:${operation.components[0].id}`)!;
    expect(l.includedCents).toBe(50_000);
    expect(l.financingBasis).toBeUndefined();
  });
});

describe('L111F — DTO, T2, écran', () => {
  it('L111F-DTO — indicateurs transmis à la fiche (aucune règle côté interface)', () => {
    const p = pretMaison();
    const d = toTcoDto(computeTco(entree({ operations: [p.operation], componentProvenance: p.prov, financingDetails: new Map([[900, p.details]]) })));
    expect(d.indicators.financing.basisLabel).toBe(TCO_FINANCING_BASIS_LABEL);
    expect(d.indicators.net.unavailableReason).toBeTruthy();
    expect(d.lineReasonLabels.FINANCING_SCHEDULE_SUPERSEDED).toMatch(/avenant/);
  });

  it('L111F-T2 — « combien m’a coûté » / « coût annuel » / « coût net » : mêmes définitions que la fiche', () => {
    const p = pretMaison();
    const t = computeTco(entree({
      operations: [p.operation], componentProvenance: p.prov, financingDetails: new Map([[900, p.details]]),
      documents: [travaux(101, 5_000_000, '2023-03-01')], valuationHistory: [{ value: 430_000, date: '2026-09-01' }],
    }));
    const a = (ownershipCostAnswer({ id: MAISON, name: 'Maison' } as never, t) as { answer: string }).answer;
    expect(a).toMatch(/470\s?000,00\s?€/);
    expect(a).toMatch(/coût annuel moyen de possession/i);
    expect(a).toMatch(/hors prix d’achat/);
    expect(a).toMatch(/coût net estimé 40\s?000,00\s?€/);
    expect(a).toMatch(/Calculé selon l’échéancier du prêt/);
    expect(a).not.toMatch(/réellement payé/);
  });

  it('L111F-UI — fiche : « – » + information, libellés du ticket, plus de « TCO moyen annuel » ni de phrase sur l’achat inclus', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/assets/TcoSection.tsx'), 'utf8');
    expect(src).toMatch(/Coût annuel moyen de possession/);
    expect(src).toMatch(/Coût net estimé/);
    expect(src).toMatch(/data-tco-indicator="net"/);
    expect(src).toMatch(/data-tco-financing/);
    expect(src).toMatch(/TcoInfoTip/);
    expect(src).not.toMatch(/l’achat initial y est inclus/);
    expect(src).not.toMatch(/'TCO moyen annuel'/);
    const drawer = readFileSync(join(process.cwd(), 'src/components/assets/ValuationHistoryDrawer.tsx'), 'utf8');
    expect(drawer).toMatch(/Date de valorisation \*/);
    expect(drawer).toMatch(/civilDateParis/);
  });
});

describe('L111F — durée en années anniversaires (décision PO du 05/11)', () => {
  it('L111F-DUR-01 — années pleines + reste en jours / jours de l’année anniversaire en cours', () => {
    expect(ownershipDuration('2021-11-05', '2026-11-05')).toEqual({ fullYears: 5, remainderDays: 0, yearDays: 365 });
    expect(ownershipDuration('2021-11-05', '2026-11-04')).toEqual({ fullYears: 4, remainderDays: 364, yearDays: 365 });
    expect(ownershipDuration('2023-11-05', '2024-05-05')).toEqual({ fullYears: 0, remainderDays: 182, yearDays: 366 }); // année anniversaire avec 29/02
    expect(ownershipDuration('2026-11-05', '2026-11-05')).toEqual({ fullYears: 0, remainderDays: 1, yearDays: 365 }); // achat le jour même
    expect(ownershipDuration('2026-11-06', '2026-11-05')).toBeNull();
    expect(annualizeCents(7_000_000, ownershipDuration('2021-11-05', '2026-11-05')!)).toBe(1_400_000);
  });

  it('L111F-DUR-02 — 29 février : anniversaire au 28 février les années non bissextiles', () => {
    expect(ownershipDuration('2024-02-29', '2025-02-27')).toEqual({ fullYears: 0, remainderDays: 364, yearDays: 365 });
    expect(ownershipDuration('2024-02-29', '2025-02-28')).toEqual({ fullYears: 1, remainderDays: 0, yearDays: 365 });
    expect(ownershipDuration('2024-02-29', '2028-02-29')).toEqual({ fullYears: 4, remainderDays: 0, yearDays: 365 });
    expect(ownershipDuration('2024-02-29', '2028-02-28')).toEqual({ fullYears: 3, remainderDays: 365, yearDays: 366 });
  });
});
