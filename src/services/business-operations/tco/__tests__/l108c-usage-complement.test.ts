/**
 * Lot 108C (ticket TCO-646 §E) — dépenses d'usage = estimation
 * COMPLÉMENTAIRE : complément = max(0, F − R) par catégorie et période échue,
 * contribution = max(F, R). Tests PURS (règle `computeUsageComplement` et
 * intégration `computeTco`) ; la même chose sur base réelle :
 * `src/test/e2e/scenarios/l108c-depenses-usage.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  calendarPeriod, computeUsageComplement, usageCategoriesOfText, usageKeyOf, type UsageComplementInput, type UsageLineAssignment,
} from '../usage-complement';
import { computeTco, type TcoEconomicLine, type TcoInput, type TcoOperation, type UsageBudget } from '../model';
import { toTcoDto } from '../dto';
import type { LedgerComponent } from '../../finance/engine';

const BIEN = 10;
let seq = 1;
const forfait = (o: Partial<UsageBudget> = {}): UsageBudget => ({
  id: seq++, assetId: BIEN, category: 'FUEL', label: null, amountMinor: 10_000, currency: 'EUR', periodicity: 'MONTHLY', validFrom: '2026-01-01', validTo: null, ...o,
});
const ligne = (cents: number, date: string | null, o: Partial<TcoEconomicLine> = {}): TcoEconomicLine => {
  const id = seq++;
  return {
    id: `doc:${id}`, source: 'DOCUMENT', provenance: 'DOCUMENT', label: 'Ticket carburant', kind: 'REALIZED_COST', amountMinor: cents, currency: 'EUR',
    eurCents: cents, includedCents: cents, category: 'OTHER', date, fileId: id, operationId: null, operationLabel: null, status: 'RETAINED_DIRECT',
    reason: null, note: null, relatedFileId: null, ...o,
  };
};
const calcul = (budgets: UsageBudget[], lines: TcoEconomicLine[], o: Partial<UsageComplementInput> = {}) => computeUsageComplement({
  budgets, lines, possession: { start: '2025-06-01', end: '2026-11-03', disposed: false }, today: '2026-11-03',
  documentedCents: lines.reduce((n, l) => n + l.includedCents, 0), averageDays: null, net: { estimatedCents: null, finalCents: null, provisionalCents: null }, ...o,
});
const octobre = (c: ReturnType<typeof calcul>) => c.windows.find((w) => w.periodStart === '2026-10-01')!;

describe('L108C — les quatre scénarios du ticket (forfait carburant 100 € pour un mois écoulé)', () => {
  // Remplace l'ancien TCO-09 (forfaits exclus du coût) : décision PO, le forfait complète le réel de sa catégorie.
  it.each([
    [0, 0, 10_000, 10_000],
    [4_000, 4_000, 6_000, 10_000],
    [10_000, 10_000, 0, 10_000],
    [14_000, 14_000, 0, 14_000],
  ])('tickets %i → réel %i, complément %i, contribution %i', (tickets, reel, complement, contribution) => {
    const lines = tickets ? [ligne(tickets, '2026-10-12')] : [];
    const c = calcul([forfait({ validFrom: '2026-10-01', validTo: '2026-10-31' })], lines);
    const w = octobre(c);
    expect([w.realCents, w.complementCents, w.contributionCents]).toEqual([reel, complement, contribution]);
    expect(c.estimatedComplementCents).toBe(complement);
    expect(c.totalWithEstimatesCents).toBe(contribution);
    // Le coût documenté reste strictement réel (jamais de cumul aveugle 100 + 40 = 140, jamais 100 remplacé par 40).
    expect(c.documentedCents).toBe(tickets);
  });

  it('plusieurs tickets du même mois s’additionnent dans R, avant le complément', () => {
    const c = calcul([forfait({ validFrom: '2026-10-01', validTo: '2026-10-31' })], [ligne(2_500, '2026-10-02'), ligne(1_500, '2026-10-20')]);
    expect(octobre(c)).toMatchObject({ realCents: 4_000, complementCents: 6_000, contributionCents: 10_000 });
    expect(octobre(c).lines).toHaveLength(2);
  });
});

describe('L108C — périodes, catégories, forfaits absent / expiré / modifié / supprimé', () => {
  it('même catégorie sur plusieurs mois : un complément par mois, jamais compensé par un autre mois', () => {
    const c = calcul([forfait({ validFrom: '2026-08-01', validTo: '2026-10-31' })], [ligne(14_000, '2026-08-10'), ligne(4_000, '2026-09-10')]);
    const parMois = Object.fromEntries(c.windows.map((w) => [w.periodStart, [w.realCents, w.complementCents]]));
    expect(parMois).toEqual({ '2026-08-01': [14_000, 0], '2026-09-01': [4_000, 6_000], '2026-10-01': [0, 10_000] });
    expect(c.estimatedComplementCents).toBe(16_000);
    expect(c.totalWithEstimatesCents).toBe(18_000 + 16_000);
  });

  it('catégories différentes le même mois : rapprochement catégoriel (un péage ne couvre pas le carburant)', () => {
    const c = calcul(
      [forfait({ validFrom: '2026-10-01', validTo: '2026-10-31' }), forfait({ category: 'TOLLS', amountMinor: 3_000, validFrom: '2026-10-01', validTo: '2026-10-31' })],
      [ligne(5_000, '2026-10-05', { label: 'Péage autoroute A6' })],
    );
    const fuel = c.windows.find((w) => w.key === 'FUEL')!;
    const tolls = c.windows.find((w) => w.key === 'TOLLS')!;
    expect([fuel.realCents, fuel.complementCents]).toEqual([0, 10_000]);
    expect([tolls.realCents, tolls.complementCents]).toEqual([5_000, 0]);
    expect(c.byCategory.map((b) => [b.key, b.contributionCents])).toEqual(expect.arrayContaining([['FUEL', 10_000], ['TOLLS', 5_000]]));
  });

  it('forfait absent : aucun complément, le réel seul ; forfait expiré : seulement ses périodes', () => {
    expect(calcul([], [ligne(4_000, '2026-10-05')]).estimatedComplementCents).toBe(0);
    const c = calcul([forfait({ validFrom: '2026-01-01', validTo: '2026-03-31' })], []);
    expect(c.windows.map((w) => w.periodStart)).toEqual(['2026-03-01', '2026-02-01', '2026-01-01']);
    expect(c.estimatedComplementCents).toBe(30_000);
  });

  it('forfait modifié (révision datée) : les périodes closes gardent l’ancien montant', () => {
    const v1 = forfait({ validFrom: '2026-08-01', validTo: '2026-09-30' });
    const v2 = forfait({ amountMinor: 12_000, validFrom: '2026-10-01', validTo: null, revisesBudgetId: v1.id });
    const c = calcul([v1, v2], []);
    expect(Object.fromEntries(c.windows.filter((w) => w.closed).map((w) => [w.periodStart, w.forfaitCents]))).toEqual({
      '2026-08-01': 10_000, '2026-09-01': 10_000, '2026-10-01': 12_000,
    });
    expect(c.budgets.find((b) => b.budgetId === v1.id)).toMatchObject({ revisedBy: v2.id, overlapWith: [] });
    expect(c.warnings).not.toContain('USAGE_BUDGET_OVERLAP');
  });

  it('révision au milieu d’un mois : un seul mois, forfait au prorata de chaque version', () => {
    const v1 = forfait({ validFrom: '2026-09-01', validTo: '2026-10-15' });
    const v2 = forfait({ amountMinor: 31_000, validFrom: '2026-10-16', validTo: '2026-10-31', revisesBudgetId: v1.id });
    const w = octobre(calcul([v1, v2], [ligne(5_000, '2026-10-20')]));
    expect(w.forfaitCents).toBe(Math.round((10_000 * 15) / 31) + Math.round((31_000 * 16) / 31));
    expect(w.budgetIds).toEqual(expect.arrayContaining([v1.id, v2.id]));
    expect(w.realCents).toBe(5_000);
  });

  it('forfait supprimé : il ne produit plus rien ; arrêté : ses périodes passées restent', () => {
    expect(calcul([], []).estimatedComplementCents).toBe(0);
    const arrete = calcul([forfait({ validFrom: '2026-09-01', validTo: '2026-09-30' })], []);
    expect(arrete.estimatedComplementCents).toBe(10_000);
  });

  it('jamais de période future ni en cours : le mois en cours est montré, jamais ajouté', () => {
    const c = calcul([forfait({ validFrom: '2026-10-01', validTo: null })], [ligne(3_000, '2026-11-02')]);
    const nov = c.windows.find((w) => w.periodStart === '2026-11-01')!;
    expect(nov.closed).toBe(false);
    expect(nov.realCents).toBe(3_000);
    expect(c.windows.some((w) => w.periodStart > '2026-11-01')).toBe(false);
    expect(c.estimatedComplementCents).toBe(10_000);
    // Forfait qui commence plus tard : aucun effet.
    const futur = calcul([forfait({ validFrom: '2027-01-01' })], []);
    expect(futur.estimatedComplementCents).toBe(0);
    expect(futur.budgets[0].status).toBe('NOT_STARTED');
  });

  it('forfait annuel : période civile, comptée une fois l’année échue', () => {
    const c = calcul([forfait({ category: 'TOLLS', periodicity: 'YEARLY', amountMinor: 120_000, validFrom: '2025-01-01' })], [ligne(30_000, '2025-07-14', { label: 'Péage' })],
      { possession: { start: '2025-01-01', end: '2026-11-03', disposed: false } });
    expect(c.windows.find((w) => w.periodStart === '2025-01-01')).toMatchObject({ closed: true, realCents: 30_000, complementCents: 90_000 });
    expect(c.windows.find((w) => w.periodStart === '2026-01-01')).toMatchObject({ closed: false });
    expect(c.byYear).toEqual([{ year: 2025, complementCents: 90_000, forfaitCents: 120_000, realCents: 30_000 }]);
  });
});

describe('L108C — tickets ajoutés, retirés, déplacés ; acquisition, cession, mois partiels', () => {
  it('ticket ajouté, retiré, déplacé : le complément se recalcule, le total ne saute pas', () => {
    const f = [forfait({ validFrom: '2026-09-01', validTo: '2026-10-31' })];
    const sans = calcul(f, []);
    const avec = calcul(f, [ligne(4_000, '2026-10-10')]);
    const deplace = calcul(f, [ligne(4_000, '2026-09-10')]);
    expect(sans.totalWithEstimatesCents).toBe(20_000);
    expect(avec.totalWithEstimatesCents).toBe(20_000); // 40 € réels remplacent 40 € d'estimation
    expect(deplace.totalWithEstimatesCents).toBe(20_000);
    expect(octobre(deplace).realCents).toBe(0);
    expect(deplace.windows.find((w) => w.periodStart === '2026-09-01')!.realCents).toBe(4_000);
  });

  it('acquisition en cours de mois : prorata au jour ; avant l’acquisition : rien', () => {
    const c = calcul([forfait({ validFrom: '2026-01-01' })], [], { possession: { start: '2026-09-16', end: '2026-11-03', disposed: false } });
    const sept = c.windows.find((w) => w.periodStart === '2026-09-01')!;
    expect(sept).toMatchObject({ coveredDays: 15, periodDays: 30, prorated: true, forfaitCents: 5_000 });
    expect(c.windows.some((w) => w.periodStart < '2026-09-01')).toBe(false);
    expect(c.estimatedComplementCents).toBe(15_000);
  });

  it('cession : le mois de la cession est clos au prorata, rien après', () => {
    const c = calcul([forfait({ validFrom: '2026-01-01' })], [], { possession: { start: '2026-01-01', end: '2026-03-10', disposed: true } });
    const mars = c.windows.find((w) => w.periodStart === '2026-03-01')!;
    expect(mars).toMatchObject({ closed: true, coveredDays: 10, forfaitCents: Math.round((10_000 * 10) / 31) });
    expect(c.windows.some((w) => w.periodStart > '2026-03-01')).toBe(false);
  });

  it('date d’achat inconnue et forfait sans début : aucune estimation inventée (signalé)', () => {
    const c = calcul([forfait({ validFrom: null })], [], { possession: { start: null, end: '2026-11-03', disposed: false } });
    expect(c.estimatedComplementCents).toBe(0);
    expect(c.budgets[0].status).toBe('START_UNKNOWN');
    expect(c.warnings).toContain('USAGE_START_UNKNOWN');
  });

  it('dépense d’usage sans date : comptée au réel, ne réduit aucune période (signalée)', () => {
    const c = calcul([forfait({ validFrom: '2026-10-01', validTo: '2026-10-31' })], [ligne(4_000, null)]);
    expect(octobre(c).realCents).toBe(0);
    expect(c.undated).toHaveLength(1);
    expect(c.warnings).toContain('USAGE_LINES_UNDATED');
  });

  it('avoir de la catégorie : R net ; jamais un complément supérieur au forfait', () => {
    const c = calcul([forfait({ validFrom: '2026-10-01', validTo: '2026-10-31' })], [
      ligne(6_000, '2026-10-02'), ligne(8_000, '2026-10-03', { kind: 'REFUND', label: 'Remboursement carburant' }),
    ]);
    expect(octobre(c)).toMatchObject({ realCents: -2_000, complementCents: 10_000, contributionCents: 8_000 });
  });
});

describe('L108C — catégorie jamais devinée au hasard, chevauchements explicites', () => {
  it('vocabulaire explicite seulement ; deux catégories reconnues → ambiguë ; marque ou fournisseur seul → non classée', () => {
    expect(usageCategoriesOfText('Ticket station SP95-E10')).toEqual(['FUEL']);
    expect(usageCategoriesOfText('Télépéage — relevé')).toEqual(['TOLLS']);
    expect(usageCategoriesOfText('Borne de recharge — session')).toEqual(['CHARGING']);
    expect(usageCategoriesOfText('Total Energies Lyon')).toEqual([]);
    expect(usageCategoriesOfText('Carburant et péage')).toEqual(['FUEL', 'TOLLS']);
  });

  it('dépense ambiguë ou sans vocabulaire : proposée au classement, jamais rapprochée', () => {
    const c = calcul([forfait({ validFrom: '2026-10-01', validTo: '2026-10-31' })], [
      ligne(4_000, '2026-10-05', { label: 'Station Total' }), ligne(2_000, '2026-10-06', { label: 'Carburant + péage' }),
    ]);
    expect(octobre(c).realCents).toBe(0);
    expect(c.unclassified.map((u) => u.ambiguous)).toEqual([[], ['FUEL', 'TOLLS']]);
    expect(c.warnings).toContain('USAGE_LINES_UNCLASSIFIED');
  });

  it('un achat, un entretien ou un financement n’est jamais rapproché par le libellé', () => {
    const c = calcul([forfait({ validFrom: '2026-10-01', validTo: '2026-10-31' })], [
      ligne(4_000, '2026-10-05', { label: 'Tondeuse essence', category: 'ACCESSORIES' }),
      ligne(4_000, '2026-10-05', { label: 'Filtre gazole', category: 'MAINTENANCE' }),
    ]);
    expect(octobre(c).realCents).toBe(0);
    expect(c.unclassified).toHaveLength(0);
  });

  it('classement de l’utilisateur prioritaire (y compris « pas une dépense d’usage ») ; « Autre » rapproché par son libellé', () => {
    const station = ligne(4_000, '2026-10-05', { label: 'Station Total' });
    const fauxAmi = ligne(3_000, '2026-10-06', { label: 'Carburant (bidon pour la tondeuse)' });
    const parking = ligne(1_500, '2026-10-07', { label: 'Ticket 1234' });
    const a = (l: TcoEconomicLine, category: UsageLineAssignment['category'], otherLabel: string | null = null): UsageLineAssignment => ({
      key: `f:${l.fileId}:REALIZED_COST:${l.amountMinor}:EUR`, category, otherLabel, decidedAt: '2026-10-20T10:00:00.000Z', decidedByUserId: 1,
    });
    const c = calcul(
      [forfait({ validFrom: '2026-10-01', validTo: '2026-10-31' }), forfait({ category: 'OTHER', label: 'Parking', amountMinor: 2_000, validFrom: '2026-10-01', validTo: '2026-10-31' })],
      [station, fauxAmi, parking], { assignments: [a(station, 'FUEL'), a(fauxAmi, 'NONE'), a(parking, 'OTHER', 'parking ')] },
    );
    const fuel = c.windows.find((w) => w.key === 'FUEL')!;
    expect(fuel.realCents).toBe(4_000);
    expect(fuel.lines[0].basis).toBe('USER');
    expect(c.windows.find((w) => w.key === usageKeyOf('OTHER', 'Parking'))).toMatchObject({ realCents: 1_500, complementCents: 500 });
    expect(c.unclassified).toHaveLength(0);
  });

  it('forfaits chevauchants de même catégorie : conflit explicite, le plus récent s’applique, jamais additionnés', () => {
    const a = forfait({ validFrom: '2026-01-01', validTo: null });
    const b = forfait({ amountMinor: 15_000, validFrom: '2026-10-01', validTo: '2026-10-31' });
    const c = calcul([a, b], []);
    expect(octobre(c).forfaitCents).toBe(15_000);
    expect(c.windows.find((w) => w.periodStart === '2026-09-01')!.forfaitCents).toBe(10_000);
    expect(c.warnings).toContain('USAGE_BUDGET_OVERLAP');
    expect(c.budgets.find((x) => x.budgetId === a.id)!.overlapWith).toEqual([b.id]);
  });

  it('devise étrangère : jamais additionnée en euros', () => {
    const c = calcul([forfait({ currency: 'CHF', validFrom: '2026-10-01', validTo: '2026-10-31' })], []);
    expect(c.estimatedComplementCents).toBe(0);
    expect(c.budgets[0].status).toBe('NOT_CONVERTIBLE');
  });

  it('périodes civiles', () => {
    expect(calendarPeriod('2024-02-10', 'MONTHLY')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(calendarPeriod('2026-11-03', 'QUARTERLY')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(calendarPeriod('2026-05-03', 'YEARLY')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });
});

// ── Intégration au moteur TCO (coût documenté inchangé, TCO avec estimations distinct) ──

const comp = (eur: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind: 'REALIZED_COST', amountMinor: eur, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: TcoOperation['typeCode'], label: string, date: string, components: LedgerComponent[]): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: date, startDate: null, plannedDate: null, assetIds: [BIEN], label,
  components: components.map((c) => ({ ...c, operationId: id, economicDate: c.economicDate ?? date })), documents: [{ fileId: id * 10, title: label, role: 'INVOICE', date }],
});
const entree = (operations: TcoOperation[], o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: BIEN, today: '2026-11-03', operations, assetAcquisitionDate: '2026-01-01', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, ...o,
});

describe('L108C — intégration computeTco (remplace TCO-09)', () => {
  it('coût documenté strictement réel ; TCO avec estimations = documenté + compléments ; moyenne et années cohérentes', () => {
    const ops = [
      op(1, 'ACQUISITION', 'Achat', '2026-01-01', [comp(1_000_000)]),
      op(2, 'OTHER', 'Ticket carburant', '2026-10-12', [comp(4_000)]),
    ];
    const t = computeTco(entree(ops, { budgets: [forfait({ validFrom: '2026-09-01', validTo: '2026-10-31' })] }));
    expect(t.summary.cumulativeCostCents).toBe(1_004_000);
    expect(t.summary.estimatedUsageComplementCents).toBe(10_000 + 6_000);
    expect(t.summary.totalWithEstimatesCents).toBe(1_020_000);
    expect(t.usage.complement.byYear).toEqual([{ year: 2026, complementCents: 16_000, forfaitCents: 20_000, realCents: 4_000 }]);
    expect(t.annual.average.totalCents).toBe(1_004_000);
    expect(t.usage.complement.averageWithEstimatesCents).toBe(Math.round((1_020_000 * 365.25) / t.annual.average.days!));
    // Les tickets restent visibles et inchangés ; aucune ligne « estimation » dans la trace des dépenses réelles.
    expect(t.lines.filter((l) => l.status === 'RETAINED_CONSOLIDATED').map((l) => l.includedCents)).toEqual(expect.arrayContaining([1_000_000, 4_000]));
    expect(t.lines).toHaveLength(2);
    expect(t.reliability.anomalies).toEqual([]);
    // DTO : libellés de la règle et du statut des forfaits transmis.
    const dto = toTcoDto(t);
    expect(dto.usage.complement.windows.length).toBeGreaterThan(0);
    expect(dto.usageLabels.warnings.USAGE_ESTIMATES_INCLUDED).toMatch(/estimations/);
  });

  it('budget annuel prévisionnel conservé à part ; devise étrangère jamais additionnée (ancien TCO-09, adapté)', () => {
    const t = computeTco(entree([op(120, 'ACQUISITION', 'Achat', '2026-01-01', [comp(100_000)])], {
      budgets: [
        forfait({ amountMinor: 12_000, validFrom: '2026-01-01' }),
        forfait({ category: 'TOLLS', amountMinor: 30_000, periodicity: 'YEARLY', validFrom: null, validTo: '2025-12-31' }),
        forfait({ category: 'OTHER', label: 'Vignette CH', amountMinor: 4_000, currency: 'CHF', periodicity: 'YEARLY', validFrom: null, validTo: null }),
      ],
    }));
    expect(t.summary.cumulativeCostCents).toBe(100_000);
    expect(t.usage.annualEstimateCents).toBe(144_000);
    expect(t.usage.otherCurrencies).toEqual([{ currency: 'CHF', annualEquivalentMinor: 4_000 }]);
    // Janvier à octobre 2026 échus : 10 × 120 € ; novembre en cours non compté ; péages 2025 hors possession.
    expect(t.summary.estimatedUsageComplementCents).toBe(120_000);
    expect(t.summary.totalWithEstimatesCents).toBe(220_000);
  });
});
