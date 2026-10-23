/**
 * Lot 76G — ticket P2 « TCO : ajouter les indicateurs annuels » (TCO moyen
 * annuel, dépenses de l'année, sélecteur d'année) et complément PO du 21/10
 * (« Dépenses retenues » fermé par défaut, ouvert dans un sous-tiroir).
 * Tests PURS sur le moteur TCO RÉEL (`computeTco`) : les indicateurs sont
 * dérivés de sa trace, jamais d'un second calcul. Lecture SQL, route et
 * modification d'une dépense sur PostgreSQL 16 :
 * `src/test/e2e/scenarios/l76g-tco-annuel.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, type TcoAssetPrice, type TcoEquipmentPrice, type TcoInput, type TcoOperation, type TcoResult } from '../model';
import { computeTcoAnnual, TCO_DAYS_PER_YEAR } from '../annual';
import { toTcoDto } from '../dto';
import type { EconomicDocumentCandidate, EconomicDocumentInput, EconomicHint } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

const VELO = 7;
const AUTRE = 8;
const ROBOT = 501;
const TODAY = '2026-10-21';
let seq = 76_000;

const hint = (role: string, amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'INTERVENTION', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [],
  targets: [{ type: 'ASSET', entityId: VELO }], hints, t3Outcome: null, ...o,
});
const doc = (fileId: number, o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: `Facture ${fileId}`, typeCode: 'REPAIR_INVOICE', legacyType: null, date: '2026-06-01', supplier: null,
  amountCents: null, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [VELO], multiAsset: false, candidates: [], operations: [], ...o,
});
/** Facture de réparation qualifiée par T1, datée. */
const reparation = (fileId: number, cents: number, date: string | null, o: Partial<EconomicDocumentInput> = {}, c: Partial<EconomicDocumentCandidate> = {}) =>
  doc(fileId, { amountCents: cents, date, candidates: [cand([hint('REALIZED_COST', cents)], c)], ...o });
const achat = (fileId: number, cents: number, date: string, o: Partial<EconomicDocumentInput> = {}, c: Partial<EconomicDocumentCandidate> = {}) =>
  doc(fileId, { typeCode: 'ACQUISITION_INVOICE', amountCents: cents, date, candidates: [cand([hint('REALIZED_COST', cents)], { typeHint: 'ACQUISITION', ...c })], ...o });
const comp = (kind: FinancialComponentKind, eur: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: eur, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: '2025-03-01', startDate: null, plannedDate: null,
  assetIds: [VELO], label: typeCode, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: VELO, today: TODAY, operations: [], assetAcquisitionDate: '2024-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: prix(30_000), ...o,
});
const annee = (t: TcoResult, y: number) => t.annual.years.find((a) => a.year === y);
/** Cohérence des trois indicateurs : Σ nets des années + non datées = TCO total (81D : plus de « futures » retenues). */
const coherent = (t: TcoResult) => {
  const a = t.annual;
  const somme = a.years.reduce((n, y) => n + y.netCents, 0) + (a.undated.costsCents - a.undated.creditsCents);
  expect(somme).toBe(t.summary.cumulativeCostCents);
  expect(a.average.totalCents).toBe(t.summary.cumulativeCostCents);
};
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('L76G — TCO moyen annuel', () => {
  it('L76G-01 — trois indicateurs cohérents : total cumulatif, moyenne = total / (jours / 365,25), dépenses par année', () => {
    const t = computeTco(entree({ documents: [reparation(101, 5_000, '2024-06-01'), reparation(102, 12_000, '2025-04-02'), reparation(103, 8_000, '2026-02-03')] }));
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 25_000);
    const jours = 1016; // du 10/01/2024 au 21/10/2026 inclus
    expect(t.annual.average).toMatchObject({ status: 'COMPUTED', days: jours, start: '2024-01-10', end: TODAY, extrapolated: false, incomplete: false });
    expect(t.annual.average.cents).toBe(Math.round((55_000 * TCO_DAYS_PER_YEAR) / jours));
    expect(t.annual.average.years).toBeCloseTo(2.78, 2);
    expect(t.annual.years.map((y) => [y.year, y.costsCents, y.count])).toEqual([[2024, 35_000, 2], [2025, 12_000, 1], [2026, 8_000, 1]]);
    // L'achat initial est dans l'année d'achat (date effective), jamais à la date d'ajout dans Verebona.
    expect(annee(t, 2024)?.costsCents).toBe(30_000 + 5_000);
    expect(t.annual.defaultYear).toBe(2026);
    expect(annee(t, 2026)).toMatchObject({ periodStart: '2026-01-01', periodEnd: TODAY });
    expect(annee(t, 2025)).toMatchObject({ periodStart: '2025-01-01', periodEnd: '2025-12-31' });
    coherent(t);
  });

  // Lot 81D (le ticket du 22/10 prime sur 76G) : le seuil de 30 jours est SUPPRIMÉ — moyenne calculée dès le premier jour, extrapolée.
  it('L76G-02 — achat récent : moyenne calculée sans seuil (81D), signalée « extrapolée » sous un an', () => {
    const neuf = computeTco(entree({ assetAcquisitionDate: '2026-10-12' }));
    expect(neuf.annual.average).toMatchObject({ status: 'COMPUTED', days: 10, extrapolated: true });
    expect(neuf.annual.average.cents).toBe(Math.round((30_000 * TCO_DAYS_PER_YEAR) / 10));
    expect(neuf.summary.cumulativeCostCents).toBe(30_000);
    expect(annee(neuf, 2026)?.costsCents).toBe(30_000);
    coherent(neuf);
    const jourMeme = computeTco(entree({ assetAcquisitionDate: TODAY }));
    expect(jourMeme.annual.average).toMatchObject({ status: 'COMPUTED', days: 1, extrapolated: true });
    const seuil = computeTco(entree({ assetAcquisitionDate: '2026-09-22' }));
    expect(seuil.annual.average).toMatchObject({ status: 'COMPUTED', days: 30, extrapolated: true });
    expect(seuil.annual.average.cents).toBe(Math.round((30_000 * TCO_DAYS_PER_YEAR) / 30));
    const sixMois = computeTco(entree({ assetAcquisitionDate: '2026-04-21' }));
    expect(sixMois.annual.average).toMatchObject({ status: 'COMPUTED', extrapolated: true });
  });

  it('L76G-03 — date d’achat inconnue : aucune valeur annuelle ; dépenses datées toujours consultables par année', () => {
    const t = computeTco(entree({ assetAcquisitionDate: null, documents: [reparation(201, 4_000, '2025-05-05')] }));
    expect(t.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_MISSING', cents: null, days: null, years: null });
    // Prix de la fiche sans date d'achat : compté au total, rattaché à aucune année (signalé).
    expect(t.annual.undated).toEqual({ count: 1, costsCents: 30_000, creditsCents: 0 });
    expect(t.annual.years.map((y) => y.year)).toEqual([2025, 2026]);
    expect(annee(t, 2025)?.costsCents).toBe(4_000);
    coherent(t);
  });

  // Lot 81D : une date historique valide (avant 1900) n'est plus rejetée ; future / après cession restent incohérentes.
  it('L76G-04 — date d’achat incohérente (future, postérieure à la cession) : aucune valeur annuelle ; date historique valide acceptée (81D)', () => {
    const futur = computeTco(entree({ assetAcquisitionDate: '2027-03-01' }));
    expect(futur.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', cents: null });
    coherent(futur);
    const apresCession = computeTco(entree({ assetAcquisitionDate: '2025-06-01', assetStatus: 'VENDU', assetSaleDate: '2025-01-01' }));
    expect(apresCession.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', cents: null });
    const ancienne = computeTco(entree({ assetAcquisitionDate: '1850-01-01' }));
    expect(ancienne.annual.average).toMatchObject({ status: 'COMPUTED', start: '1850-01-01' });
    expect(ancienne.annual.years[0].year).toBe(1850);
    coherent(ancienne);
  });

  it('L76G-05 — données manquantes : la moyenne est marquée incomplète comme le total (jamais présentée comme exhaustive)', () => {
    const t = computeTco(entree({ assetPrice: null }));
    expect(t.status).toBe('INCOMPLETE');
    expect(t.annual.average).toMatchObject({ status: 'COMPUTED', incomplete: true, totalCents: 0 });
  });

  it('L76G-06 — cession : la durée s’arrête à la cession, année par défaut = année de cession', () => {
    const t = computeTco(entree({ assetStatus: 'VENDU', assetSaleDate: '2025-07-01', documents: [reparation(301, 2_000, '2025-02-01')] }));
    expect(t.annual.average).toMatchObject({ status: 'COMPUTED', end: '2025-07-01', days: 539 });
    expect(t.annual.defaultYear).toBe(2025);
    expect(t.annual.years.map((y) => y.year)).toEqual([2024, 2025]);
    coherent(t);
  });
});

describe('L76G — dépenses de l’année', () => {
  it('L76G-10 — année sans dépense : présente dans le sélecteur, 0 € et aucune dépense (pas de trou dans la plage)', () => {
    const t = computeTco(entree({ assetAcquisitionDate: '2023-03-01', documents: [reparation(401, 6_000, '2026-01-15')] }));
    expect(t.annual.years.map((y) => y.year)).toEqual([2023, 2024, 2025, 2026]);
    expect(annee(t, 2024)).toMatchObject({ costsCents: 0, creditsCents: 0, netCents: 0, count: 0 });
    expect(annee(t, 2025)).toMatchObject({ costsCents: 0, count: 0 });
    coherent(t);
  });

  it('L76G-11 — dates réelles des opérations : une dépense consolidée compte à sa date réalisée ; prévisions et annulées jamais', () => {
    const t = computeTco(entree({ operations: [
      op(10, 'INTERVENTION', [comp('REALIZED_COST', 9_000)], { realizedDate: '2025-03-01' }),
      op(11, 'INTERVENTION', [comp('FORECAST_COST', 50_000)], { status: 'PLANNED', realizedDate: null, plannedDate: '2026-12-01' }),
      op(12, 'INTERVENTION', [comp('REALIZED_COST', 7_000)], { status: 'CANCELLED', realizedDate: '2026-02-01' }),
    ] }));
    expect(annee(t, 2025)?.costsCents).toBe(9_000);
    expect(annee(t, 2026)?.costsCents).toBe(0);
    expect(t.annual.notRealized.count).toBe(0);
    coherent(t);
  });

  // Lot 81D (le ticket du 22/10 prime sur 76G) : la dépense future n'est plus comptée au TCO total — exclue des trois indicateurs.
  it('L76G-12 — dépense datée après aujourd’hui (non réalisée) : exclue du total et de toute année (81D), signalée à part', () => {
    const t = computeTco(entree({ documents: [reparation(501, 3_000, '2026-12-15'), reparation(502, 1_000, '2026-03-01')] }));
    expect(annee(t, 2026)?.costsCents).toBe(1_000);
    expect(t.summary.cumulativeCostCents).toBe(31_000);
    expect(t.annual.notRealized).toEqual({ count: 1, costsCents: 3_000 });
    expect(t.annual.years.some((y) => y.year === 2027)).toBe(false);
    coherent(t);
  });

  it('L76G-13 — dépense sans date : jamais affectée arbitrairement à une année, signalée', () => {
    const t = computeTco(entree({ documents: [reparation(601, 2_500, null)] }));
    expect(t.annual.undated).toEqual({ count: 1, costsCents: 2_500, creditsCents: 0 });
    expect(t.annual.years.reduce((n, y) => n + y.costsCents, 0)).toBe(30_000);
    coherent(t);
  });

  it('L76G-14 — avoirs, remboursements et indemnités : présentés à part dans leur année (net = coûts − crédits)', () => {
    const t = computeTco(entree({ operations: [
      op(20, 'INTERVENTION', [comp('REALIZED_COST', 20_000, { economicDate: '2025-05-01' }), comp('REFUND', 5_000, { economicDate: '2026-01-10' })]),
    ] }));
    expect(annee(t, 2025)).toMatchObject({ costsCents: 20_000, creditsCents: 0, netCents: 20_000 });
    expect(annee(t, 2026)).toMatchObject({ costsCents: 0, creditsCents: 5_000, netCents: -5_000, count: 0 });
    coherent(t);
  });

  it('L76G-15 — équipements : prix d’achat de l’équipement et sa réparation comptés à leurs dates ; facture d’achat = même fait, une seule fois', () => {
    const robot = (o: Partial<TcoEquipmentPrice> = {}): TcoEquipmentPrice => ({ equipmentId: ROBOT, name: 'Robot', amountMinor: 20_000, currency: 'EUR', date: '2025-02-01', origin: 'USER', evidenceFileIds: [], ...o });
    const base = { equipmentAssets: new Map([[ROBOT, VELO]]) };
    const r = computeTco(entree({ ...base, equipmentPrices: [robot()], documents: [
      reparation(701, 4_000, '2026-05-01', { linkedEquipmentIds: [ROBOT] }, { targets: [{ type: 'EQUIPMENT', entityId: ROBOT }] }),
    ] }));
    expect(annee(r, 2025)?.costsCents).toBe(20_000);
    expect(annee(r, 2026)?.costsCents).toBe(4_000);
    coherent(r);
    // Facture d'achat du robot (même montant, même date) : le moteur la dédoublonne avec la fiche → une seule fois dans 2025.
    const a = computeTco(entree({ ...base, equipmentPrices: [robot()], documents: [
      achat(702, 20_000, '2025-02-01', { linkedEquipmentIds: [ROBOT] }, { targets: [{ type: 'EQUIPMENT', entityId: ROBOT }] }),
    ] }));
    expect(a.summary.cumulativeCostCents).toBe(50_000);
    expect(annee(a, 2025)).toMatchObject({ costsCents: 20_000, count: 1 });
    coherent(a);
    // Fiche de l'équipement sans date d'achat : jamais rattachée à l'année d'achat du bien — sans date, signalée.
    const sansDate = computeTco(entree({ ...base, equipmentPrices: [robot({ date: null })] }));
    expect(sansDate.annual.undated).toMatchObject({ count: 1, costsCents: 20_000 });
    expect(annee(sansDate, 2024)?.costsCents).toBe(30_000);
    coherent(sansDate);
  });

  it('L76G-16 — bien et facture d’achat du bien (même fait) : comptés une fois dans l’année ; dépense d’un autre bien jamais', () => {
    const t = computeTco(entree({ assetAcquisitionDate: '2025-06-01', documents: [
      achat(801, 30_000, '2025-06-01'),
      reparation(802, 9_900, '2025-07-01', { linkedAssetIds: [AUTRE] }, { targets: [{ type: 'ASSET', entityId: AUTRE }] }),
    ] }));
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    expect(annee(t, 2025)).toMatchObject({ costsCents: 30_000, count: 1 });
    coherent(t);
  });

  it('L76G-17 — modification d’une dépense (montant, date) : le total, la moyenne et l’année concernée suivent ; autre année inchangée', () => {
    const avant = computeTco(entree({ documents: [reparation(901, 5_000, '2025-04-01'), reparation(902, 1_000, '2026-04-01')] }));
    const apres = computeTco(entree({ documents: [doc(901, { amountCents: 8_000, userEditedAmount: true, date: '2025-04-01', candidates: [cand([hint('REALIZED_COST', 5_000)])] }), reparation(902, 1_000, '2026-04-01')] }));
    expect(annee(avant, 2025)?.costsCents).toBe(5_000);
    expect(annee(apres, 2025)?.costsCents).toBe(8_000);
    expect(annee(apres, 2026)?.costsCents).toBe(annee(avant, 2026)?.costsCents);
    expect(apres.annual.average.cents! - avant.annual.average.cents!).toBeGreaterThan(0);
    const deplacee = computeTco(entree({ documents: [doc(901, { amountCents: 5_000, userEditedAmount: true, date: '2026-02-01' }), reparation(902, 1_000, '2026-04-01')] }));
    expect(annee(deplacee, 2025)?.costsCents).toBe(0);
    expect(annee(deplacee, 2026)?.costsCents).toBe(6_000);
    coherent(avant); coherent(apres); coherent(deplacee);
  });

  it('L76G-18 — fonction pure : une ligne n’est jamais comptée deux fois, prix de cession jamais une dépense', () => {
    const a = computeTcoAnnual({
      lines: [
        { id: 'x', status: 'RETAINED_DIRECT', kind: 'REALIZED_COST', includedCents: 100, date: '2026-01-01' },
        { id: 'x', status: 'RETAINED_DIRECT', kind: 'REALIZED_COST', includedCents: 100, date: '2026-01-01' },
        { id: 'p', status: 'RETAINED_CONSOLIDATED', kind: 'PROCEED', includedCents: 9_999, date: '2026-01-01' },
        { id: 'e', status: 'EXCLUDED', kind: 'REALIZED_COST', includedCents: 0, date: '2026-01-01' },
      ],
      period: { start: '2025-01-01', end: TODAY, endSource: 'TODAY' }, cumulativeCostCents: 100, status: 'COMPLETE', today: TODAY, disposed: false,
    });
    expect(a.years.find((y) => y.year === 2026)).toMatchObject({ costsCents: 100, count: 1 });
  });

  it('L76G-19 — DTO de la fiche : indicateurs annuels transmis tels que calculés (aucun recalcul côté interface)', () => {
    const t = computeTco(entree({ documents: [reparation(1001, 5_000, '2025-04-01')] }));
    const dto = toTcoDto(t);
    expect(dto.annual).toEqual(t.annual);
  });
});

describe('L76G — tiroir TCO (desktop et mobile, même composant)', () => {
  const ui = lire('src/components/assets/TcoSection.tsx');

  it('L76G-UI-01 — trois valeurs distinctes : TCO total, TCO moyen annuel, dépenses de l’année + sélecteur d’année ; période indiquée', () => {
    expect(ui).toContain('data-tco-annual');
    expect(ui).toContain('TCO total');
    expect(ui).toContain('TCO moyen annuel');
    expect(ui).toContain('Dépenses de l’année');
    expect(ui).toContain('data-tco-year-select');
    // Distinction coût annualisé / dépenses constatées et achat initial inclus.
    expect(ui).toMatch(/achat initial/);
    expect(ui).toMatch(/réellement constatées|réellement engagées/);
  });

  it('L76G-UI-02 — « Dépenses retenues (N) » : déclencheur accessible fermé par défaut, sous-tiroir à droite (mécanisme Sheet existant)', () => {
    expect(ui).toMatch(/data-tco-retained-trigger/);
    expect(ui).toMatch(/aria-expanded=\{retainedOpen\}/);
    expect(ui).toMatch(/aria-haspopup="dialog"/);
    expect(ui).toMatch(/useState\(false\)[^\n]*\/\/ L76G : sous-tiroir fermé par défaut/);
    expect(ui).toMatch(/<SheetContent side="right"[^>]*data-tco-retained-drawer/);
    // Focus visible : règle globale de la charte (lot 66) sur tout <button>, jamais désactivée ici.
    const declencheur = ui.slice(ui.lastIndexOf('<button', ui.indexOf('data-tco-retained-trigger')), ui.indexOf('data-tco-retained-trigger'));
    expect(declencheur).toMatch(/^<button\s/);
    expect(declencheur).not.toMatch(/data-focus-ring="off"|outline-none/);
    expect(declencheur).toContain('min-h-[44px] md:min-h-[36px]');
    // Liste plus rendue dans le tiroir principal : seulement dans le sous-tiroir.
    const principal = ui.slice(0, ui.indexOf('<Sheet open={retainedOpen}'));
    expect(principal).not.toMatch(/depensesFiltrees\.map|depenses\.map\(\(l\) => <LigneDepense/);
    // Responsive : pleine largeur sur mobile, largeur bornée sur desktop.
    expect(ui).toMatch(/<SheetContent side="right"[^>]*className="w-full sm:max-w-lg/);
    // Retour au tiroir TCO (bouton dédié + fermeture standard du Sheet).
    expect(ui).toMatch(/onClick=\{\(\) => setRetainedOpen\(false\)\}[\s\S]{0,400}Coût total de possession/);
  });

  it('L76G-UI-03 — sous-tiroir : filtre « Toutes les années / année sélectionnée » sans casser la liste cumulée', () => {
    expect(ui).toContain('data-tco-retained-filter');
    expect(ui).toContain('Toutes les années');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Lot 81D — ticket P2 « TCO : corriger les écarts de calcul annuel et de
// cohérence financière » (22/10/2026). Le ticket du jour PRIME sur deux
// décisions antérieures : 76G/80A « dépense réalisée datée dans le futur :
// comptée au total, signalée » → désormais EXCLUE des trois indicateurs ; et
// « moyenne dès 30 jours » → aucun seuil.
// ═══════════════════════════════════════════════════════════════════════════
import { civilDateParis, evaluateComponent, isIsoDate } from '../../finance/engine';
import { parseTcoLinesPage } from '../dto';
import { tcoLineAddable } from '../user-decisions';
import type { ComponentProvenance } from '../fact-identity';

const pv81 = (documentFileIds: number[]): ComponentProvenance => ({
  documentFileIds, withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: documentFileIds.length ? true : null,
});
/** Réconciliation exigée par le ticket : Σ nets des années + montants retenus non datables = TCO total (sans doublon). */
const reconcilie = (t: TcoResult) => {
  const a = t.annual;
  expect(a.years.reduce((n, y) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents).toBe(t.summary.cumulativeCostCents);
  expect(a.average.totalCents).toBe(t.summary.cumulativeCostCents);
  expect(a.reconciled).toBe(true);
  // Le détail (lignes retenues rattachées à l'année par le moteur) reproduit exactement chaque année.
  for (const y of a.years) {
    const lignes = t.lines.filter((l) => l.annualYear === y.year);
    const couts = lignes.filter((l) => l.kind === 'REALIZED_COST');
    expect(couts.reduce((n, l) => n + l.includedCents, 0)).toBe(y.costsCents);
    expect(lignes.filter((l) => l.kind !== 'REALIZED_COST').reduce((n, l) => n + l.includedCents, 0)).toBe(y.creditsCents);
    expect(couts.length).toBe(y.count);
  }
};

describe('L81D — dépenses non réalisées exclues des trois indicateurs', () => {
  it('L81D-01 — dépense de 300 € prévue en décembre 2026 (non réalisée en octobre) : ni TCO total, ni moyenne, ni dépenses 2026 ; conservée avec son motif', () => {
    const prevue = comp('REALIZED_COST', 30_000, { economicDate: '2026-12-01' });
    const base = computeTco(entree());
    const t = computeTco(entree({ operations: [op(81, 'INTERVENTION', [prevue], { status: 'ENVISAGED', realizedDate: null, plannedDate: '2026-12-01' })], componentProvenance: new Map([[prevue.id, pv81([8101])]]) }));
    expect(t.summary.cumulativeCostCents).toBe(base.summary.cumulativeCostCents);
    expect(t.annual.average.cents).toBe(base.annual.average.cents);
    expect(annee(t, 2026)?.costsCents).toBe(annee(base, 2026)?.costsCents);
    const l = t.lines.find((x) => x.id === `c:${prevue.id}`)!;
    expect(l).toMatchObject({ includedCents: 0, reason: 'NOT_REALIZED', status: 'FORECAST', notRealized: true });
    expect(t.annual.notRealized).toEqual({ count: 1, costsCents: 30_000 });
    expect(t.reliability.warnings).toContain('NOT_REALIZED_EXPENSES');
    reconcilie(t);
  });

  it('L81D-02 — dépense RÉALISÉE mais datée après la date de référence (opération réalisée, justificatif daté dans le futur) : exclue partout, contradiction signalée', () => {
    const futur = comp('REALIZED_COST', 20_000, { economicDate: '2026-12-01' });
    const t = computeTco(entree({
      operations: [op(82, 'INTERVENTION', [futur], { realizedDate: '2026-12-01' })], componentProvenance: new Map([[futur.id, pv81([8201])]]),
      documents: [reparation(8202, 3_000, '2026-12-15')],
    }));
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    expect(t.lines.find((x) => x.id === `c:${futur.id}`)).toMatchObject({ includedCents: 0, reason: 'FUTURE_DATED', notRealized: true });
    expect(t.lines.find((x) => x.fileId === 8202)).toMatchObject({ includedCents: 0, reason: 'FUTURE_DATED' });
    expect(t.reliability.warnings).toEqual(expect.arrayContaining(['NOT_REALIZED_EXPENSES', 'STATUS_CONTRADICTIONS']));
    expect(t.annual.notRealized).toEqual({ count: 2, costsCents: 23_000 });
    reconcilie(t);
  });

  it('L81D-03 — dépense réellement payée pour une période future : retenue à sa date de paiement (jamais à la période couverte)', () => {
    const prime = comp('REALIZED_COST', 60_000, { economicDate: '2026-10-01', periodStart: '2027-01-01', periodEnd: '2027-12-31' });
    const t = computeTco(entree({ operations: [op(83, 'CONTRACT', [prime], { realizedDate: '2026-10-01' })], componentProvenance: new Map([[prime.id, pv81([8301])]]) }));
    expect(t.summary.cumulativeCostCents).toBe(90_000);
    expect(t.lines.find((x) => x.id === `c:${prime.id}`)).toMatchObject({ includedCents: 60_000, date: '2026-10-01', annualYear: 2026 });
    expect(annee(t, 2026)?.costsCents).toBe(60_000);
    expect(t.annual.years.some((y) => y.year === 2027)).toBe(false);
    reconcilie(t);
  });

  it('L81D-04 — opération PRÉVUE : une composante « coût réalisé » ne suffit pas ; date planifiée jamais utilisée ; paiement daté et justifié retenu (contradiction signalée)', () => {
    const sansDate = comp('REALIZED_COST', 11_000);
    const sansPreuve = comp('REALIZED_COST', 12_000, { economicDate: '2026-05-01' });
    const acompte = comp('REALIZED_COST', 13_000, { economicDate: '2026-06-01' });
    const t = computeTco(entree({
      operations: [
        op(84, 'INTERVENTION', [sansDate], { status: 'ENVISAGED', realizedDate: null, plannedDate: '2026-03-01' }),
        op(85, 'INTERVENTION', [sansPreuve], { status: 'ENVISAGED', realizedDate: null, plannedDate: '2026-05-01' }),
        op(86, 'INTERVENTION', [acompte], { status: 'ENVISAGED', realizedDate: null, plannedDate: '2026-11-01' }),
      ],
      componentProvenance: new Map([[sansPreuve.id, pv81([])], [acompte.id, pv81([8601])]]),
    }));
    expect(t.lines.find((x) => x.id === `c:${sansDate.id}`)).toMatchObject({ includedCents: 0, reason: 'NOT_REALIZED', date: null });
    expect(t.lines.find((x) => x.id === `c:${sansPreuve.id}`)).toMatchObject({ includedCents: 0, reason: 'NOT_REALIZED' });
    expect(t.lines.find((x) => x.id === `c:${acompte.id}`)).toMatchObject({ includedCents: 13_000, date: '2026-06-01', annualYear: 2026 });
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 13_000);
    expect(t.reliability.warnings).toContain('STATUS_CONTRADICTIONS');
    // Annulée : aucune dépense réalisée.
    const annulee = computeTco(entree({ operations: [op(87, 'INTERVENTION', [comp('REALIZED_COST', 9_000, { economicDate: '2026-02-01' })], { status: 'CANCELLED' })] }));
    expect(annulee.summary.cumulativeCostCents).toBe(30_000);
    reconcilie(t);
  });

  it('L81D-05 — opération réalisée sans date effective : la date planifiée ne la date jamais (non affectée à une année, signalée)', () => {
    const c = comp('REALIZED_COST', 7_000);
    const t = computeTco(entree({ operations: [op(88, 'INTERVENTION', [c], { realizedDate: null, startDate: null, plannedDate: '2025-06-01' })] }));
    expect(t.lines.find((x) => x.id === `c:${c.id}`)).toMatchObject({ includedCents: 7_000, date: null, annualYear: null });
    expect(t.annual.undated).toMatchObject({ count: 1, costsCents: 7_000 });
    reconcilie(t);
  });

  it('L81D-06 — moteur partagé : règles d’inclusion dans `evaluateComponent` (pas seulement dans l’annuel)', () => {
    const ctx = { scope: new Set([VELO]), operationAssetIds: [VELO], asOf: '2026-10-21' };
    const c = (o: Partial<LedgerComponent>) => ({ ...comp('REALIZED_COST', 100), ...o });
    expect(evaluateComponent(c({ economicDate: '2026-10-22' }), { ...ctx, operationStatus: 'REALIZED' })).toMatchObject({ included: false, exclusion: 'FUTURE_DATED', contradiction: 'REALIZED_FUTURE_DATE' });
    expect(evaluateComponent(c({ economicDate: '2026-10-21' }), { ...ctx, operationStatus: 'REALIZED' })).toMatchObject({ included: true });
    expect(evaluateComponent(c({}), { ...ctx, operationStatus: 'ENVISAGED', fallbackDate: '2026-01-01', realizationEvidence: true })).toMatchObject({ included: false, exclusion: 'NOT_REALIZED', date: null });
    expect(evaluateComponent(c({ economicDate: '2026-01-01' }), { ...ctx, operationStatus: 'ENVISAGED', realizationEvidence: true })).toMatchObject({ included: true, contradiction: 'PLANNED_WITH_PAYMENT' });
    expect(evaluateComponent(c({ economicDate: '2026-01-01' }), { ...ctx, operationStatus: 'CANCELLED' })).toMatchObject({ included: false, exclusion: 'OPERATION_CANCELLED' });
    // Date impossible : jamais normalisée (2025-02-29 ≠ 01/03/2025), dépense comptée sans date, signalée.
    expect(evaluateComponent(c({ economicDate: '2025-02-29' }), { ...ctx, operationStatus: 'REALIZED' })).toMatchObject({ included: true, date: null, dateRejected: '2025-02-29' });
  });

  it('L81D-07 — une dépense non réalisée ne peut pas être « ajoutée au TCO » ; un devis passé reste ajoutable (80A)', () => {
    const t = computeTco(entree({ documents: [
      reparation(8701, 4_000, '2026-12-20'),
      doc(8702, { typeCode: 'WORKS_QUOTE', amountCents: 5_000, date: '2026-03-01', candidates: [cand([hint('FORECAST_COST', 5_000)], { sourceRole: 'QUOTE', statusHint: 'ENVISAGED' })] }),
    ] }));
    const futur = t.lines.find((l) => l.fileId === 8701)!;
    expect(tcoLineAddable(futur)).toMatchObject({ ok: false, reason: expect.stringMatching(/non encore réalisée/) });
    expect(tcoLineAddable(t.lines.find((l) => l.fileId === 8702)!).ok).toBe(true);
  });
});

describe('L81D — TCO moyen annuel : sans seuil, date canonique et stricte', () => {
  it('L81D-10 — possession de 1, 10 ou 30 jours : moyenne calculée (total × 365,25 / jours inclus), signalée extrapolée', () => {
    for (const [debut, jours] of [[TODAY, 1], ['2026-10-12', 10], ['2026-09-22', 30]] as const) {
      const t = computeTco(entree({ assetAcquisitionDate: debut }));
      expect(t.annual.average).toMatchObject({ status: 'COMPUTED', days: jours, extrapolated: true, extrapolationLabel: 'Valeur extrapolée sur une durée de possession inférieure à un an' });
      expect(t.annual.average.cents).toBe(Math.round((30_000 * TCO_DAYS_PER_YEAR) / jours));
    }
    const an = computeTco(entree({ assetAcquisitionDate: '2025-10-21' }));
    expect(an.annual.average).toMatchObject({ status: 'COMPUTED', extrapolated: false, extrapolationLabel: null });
  });

  it('L81D-11 — date historique valide (avant 1900) acceptée ; date manquante : aucune moyenne fictive', () => {
    const t = computeTco(entree({ assetAcquisitionDate: '1890-05-01' }));
    expect(t.annual.average).toMatchObject({ status: 'COMPUTED', start: '1890-05-01' });
    expect(t.annual.average.cents).toBeGreaterThan(0);
    const m = computeTco(entree({ assetAcquisitionDate: null }));
    expect(m.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_MISSING', cents: null });
  });

  it('L81D-12 — dates calendaires strictes : 29/02/2024 valide ; 29/02/2025, 30/02/2026 invalides (jamais normalisées)', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2000-02-29')).toBe(true);
    expect(isIsoDate('1900-02-29')).toBe(false);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-04-31')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-00-10')).toBe(false);
    expect(isIsoDate('1850-01-01')).toBe(true);
    expect(isIsoDate('2026-02-01T10:00:00Z')).toBe(true);
    expect(isIsoDate('2026-02-01abc')).toBe(false);
    const bis = computeTco(entree({ assetAcquisitionDate: '2024-02-29' }));
    expect(bis.annual.average).toMatchObject({ status: 'COMPUTED', start: '2024-02-29' });
    for (const d of ['2025-02-29', '2026-02-30']) {
      const t = computeTco(entree({ assetAcquisitionDate: d }));
      expect(t.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', incoherence: 'INVALID_DATE', cents: null });
      expect(t.period.start).toBeNull();
      // Le prix d'achat reste compté (fait établi), sans date : non affecté à une année.
      expect(t.annual.undated.costsCents).toBe(30_000);
      reconcilie(t);
    }
  });

  it('L81D-13 — acquisition future ou postérieure à la cession : moyenne non calculée (motif distinct)', () => {
    const f = computeTco(entree({ assetAcquisitionDate: '2027-03-01' }));
    expect(f.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', incoherence: 'FUTURE', cents: null });
    // Le prix reste compté, sans date (la date future n'est jamais utilisée).
    expect(f.summary.cumulativeCostCents).toBe(30_000);
    reconcilie(f);
    const c = computeTco(entree({ assetAcquisitionDate: '2025-06-01', assetStatus: 'VENDU', assetSaleDate: '2025-01-01' }));
    expect(c.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', incoherence: 'AFTER_DISPOSAL', cents: null });
  });
});

describe('L81D — dépenses de l’année et détail parfaitement réconciliables', () => {
  it('L81D-20 — 1 000 € de dépenses et 200 € de remboursement : 1 000 € bruts, 800 € nets, détail identique', () => {
    const cout = comp('REALIZED_COST', 100_000, { economicDate: '2026-03-01' });
    const remb = comp('REFUND', 20_000, { economicDate: '2026-04-01' });
    const t = computeTco(entree({ assetPrice: null, assetAcquisitionDate: '2025-01-01', acquisitionExpected: false,
      operations: [op(90, 'INTERVENTION', [cout, remb])], componentProvenance: new Map([[cout.id, pv81([9001])], [remb.id, pv81([9002])]]) }));
    expect(annee(t, 2026)).toMatchObject({ costsCents: 100_000, creditsCents: 20_000, netCents: 80_000, count: 1, creditsCount: 1 });
    reconcilie(t);
  });

  it('L81D-21 — dépense sans date : affectée à aucune année ; année à 0 € marquée « potentiellement incomplète »', () => {
    const t = computeTco(entree({ assetAcquisitionDate: '2023-01-01', documents: [reparation(9101, 2_500, null)] }));
    expect(t.lines.find((l) => l.fileId === 9101)).toMatchObject({ annualYear: null });
    expect(annee(t, 2025)).toMatchObject({ costsCents: 0, possiblyIncomplete: true });
    const sans = computeTco(entree({ assetAcquisitionDate: '2023-01-01' }));
    expect(annee(sans, 2025)).toMatchObject({ costsCents: 0, possiblyIncomplete: false });
    reconcilie(t);
  });

  it('L81D-22 — détail filtré par année côté serveur (`linesYear`) : exactement les lignes de l’indicateur ; la pagination ne change aucun total', () => {
    const docs = Array.from({ length: 12 }, (_, i) => reparation(9200 + i, 1_000 + i, i % 2 ? '2025-05-01' : '2026-05-01'));
    const t = computeTco(entree({ documents: [...docs, reparation(9300, 999, null)] }));
    const page = parseTcoLinesPage(new URLSearchParams('linesYear=2025&linesLimit=2'));
    expect(page).toMatchObject({ linesYear: 2025, linesLimit: 2 });
    const complet = toTcoDto(t, { linesYear: 2025, linesLimit: 1000 });
    const y = complet.annual.years.find((a) => a.year === 2025)!;
    expect(complet.lines.every((l) => l.annualYear === 2025)).toBe(true);
    expect(complet.lines.filter((l) => l.kind === 'REALIZED_COST').reduce((n, l) => n + l.includedCents, 0)).toBe(y.costsCents);
    const p1 = toTcoDto(t, page);
    expect(p1.lines).toHaveLength(2);
    expect(p1.linesTotal).toBe(complet.linesTotal);
    expect(p1.summary).toEqual(complet.summary);
    expect(p1.annual).toEqual(complet.annual);
    expect(toTcoDto(t).annual).toEqual(t.annual);
    reconcilie(t);
  });

  it('L81D-23 — équipement et facture du même achat : une seule comptabilisation, dans l’année de l’équipement (dates indépendantes du bien)', () => {
    const robot: TcoEquipmentPrice = { equipmentId: ROBOT, name: 'Robot', amountMinor: 20_000, currency: 'EUR', date: '2025-02-01', origin: 'USER', evidenceFileIds: [9401] };
    const t = computeTco(entree({ equipmentAssets: new Map([[ROBOT, VELO]]), equipmentPrices: [robot], documents: [
      achat(9401, 20_000, '2025-02-01', { linkedEquipmentIds: [ROBOT] }, { targets: [{ type: 'EQUIPMENT', entityId: ROBOT }] }),
    ] }));
    expect(t.summary.cumulativeCostCents).toBe(50_000);
    expect(annee(t, 2025)).toMatchObject({ costsCents: 20_000, count: 1 });
    expect(annee(t, 2024)).toMatchObject({ costsCents: 30_000, count: 1 });
    reconcilie(t);
  });
});

describe('L81D — date civile Europe/Paris, injectable', () => {
  it('L81D-30 — passage du 31/12 au 01/01, changements d’heure : date civile de Paris (jamais la date UTC du serveur)', () => {
    expect(civilDateParis(new Date('2026-12-31T22:59:00Z'))).toBe('2026-12-31');
    expect(civilDateParis(new Date('2026-12-31T23:00:00Z'))).toBe('2027-01-01');
    expect(civilDateParis(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01'); // été (UTC+2)
    expect(civilDateParis(new Date('2026-03-29T00:59:00Z'))).toBe('2026-03-29'); // passage à l'heure d'été
    expect(civilDateParis(new Date('2026-10-24T22:30:00Z'))).toBe('2026-10-25'); // passage à l'heure d'hiver
    expect(civilDateParis(new Date('2026-10-25T22:59:00Z'))).toBe('2026-10-25');
  });

  it('L81D-31 — même date de référence pour le cumul, l’annualisation et l’année : 31/12 puis 01/01', () => {
    const fin = computeTco(entree({ today: '2026-12-31', documents: [reparation(9501, 1_000, '2026-12-31')] }));
    expect(fin.annual).toMatchObject({ defaultYear: 2026, referenceDate: '2026-12-31' });
    expect(annee(fin, 2026)).toMatchObject({ costsCents: 1_000, periodEnd: '2026-12-31' });
    const debut = computeTco(entree({ today: '2027-01-01', documents: [reparation(9501, 1_000, '2026-12-31'), reparation(9502, 2_000, '2027-01-01')] }));
    expect(debut.annual).toMatchObject({ defaultYear: 2027, referenceDate: '2027-01-01' });
    expect(annee(debut, 2027)).toMatchObject({ costsCents: 2_000, periodStart: '2027-01-01', periodEnd: '2027-01-01' });
    expect(debut.annual.average.end).toBe('2027-01-01');
    // La veille, la dépense du 01/01 n'était pas encore réalisée.
    const veille = computeTco(entree({ today: '2026-12-31', documents: [reparation(9502, 2_000, '2027-01-01')] }));
    expect(veille.summary.cumulativeCostCents).toBe(30_000);
    reconcilie(fin); reconcilie(debut); reconcilie(veille);
  });
});

describe('L81D — interface (desktop et mobile, même composant) : aucune règle financière recalculée', () => {
  const ui = lire('src/components/assets/TcoSection.tsx');
  it('L81D-UI-01 — détail de l’année = sélection du moteur (`annualYear`), plus aucun filtrage sur la date des lignes', () => {
    expect(ui).not.toMatch(/l\.date\?\.slice\(0, 4\)/);
    expect(ui).toMatch(/annualYear === anneeSel/);
    expect(ui).toContain('linesYear=');
  });
  it('L81D-UI-02 — plus de seuil de 30 jours ; libellé d’extrapolation fourni par le moteur ; brut / net ; année potentiellement incomplète', () => {
    expect(ui).not.toContain('TOO_RECENT');
    expect(ui).toContain('extrapolationLabel');
    expect(ui).toContain('data-tco-year-net');
    expect(ui).toContain('possiblyIncomplete');
    expect(ui).toContain('data-tco-annual-not-realized');
  });
  it('L81D-UI-03 — actualisation automatique : événements de mutation existants, regroupés, sans boucle', () => {
    expect(ui).toContain('createCoalescedRefresh');
    expect(ui).toContain('TCO_REFRESH_EVENTS');
    expect(ui).toContain('watchTcoMutations');
    const ev = lire('src/components/assets/tco-refresh.ts');
    for (const e of ['verebona:data-mutated', 'asset-details-updated', 'document-added', 'document-deleted', 'document-analysis-complete', 'agenda-mutated', 'refresh-a-traiter']) expect(ev).toContain(`'${e}'`);
  });
});

describe('L81D — actualisation automatique du TCO ouvert (mécanisme existant, sans boucle)', () => {
  it('L81D-R01 — mutation pendant l’ouverture : une rafale d’événements → UNE relecture ; section fermée ou autre bien : aucune ; écriture propre : aucune double lecture', async () => {
    const { watchTcoMutations, TCO_REFRESH_WINDOW_MS } = await import('@/components/assets/tco-refresh');
    const { createCoalescedRefresh } = await import('@/lib/home/coalesced-refresh');
    const minuteurs: Array<() => void> = [];
    let lectures = 0;
    let applique: number | null = null;
    const c = createCoalescedRefresh<number>({
      windowMs: TCO_REFRESH_WINDOW_MS, load: async () => ++lectures, apply: (v) => { applique = v; },
      setTimer: (fn) => { minuteurs.push(fn); return minuteurs.length; }, clearTimer: () => undefined,
    });
    const cible = new EventTarget();
    let ouvert = true;
    let ecriturePropre = false;
    const stop = watchTcoMutations({ target: cible, assetId: VELO, isOpen: () => ouvert, isOwnWrite: () => ecriturePropre, invalidate: () => c.invalidate() });
    const emettre = (n: string, detail?: unknown) => cible.dispatchEvent(Object.assign(new Event(n), { detail }));
    // Correction d'une dépense : écriture (`verebona:data-mutated`) + analyse terminée + fiche → une seule lecture.
    emettre('verebona:data-mutated'); emettre('document-analysis-complete'); emettre('asset-details-updated', { assetId: VELO });
    expect(minuteurs).toHaveLength(1);
    minuteurs.shift()!();
    await Promise.resolve(); await Promise.resolve();
    expect(lectures).toBe(1);
    expect(applique).toBe(1);
    // Autre bien : sans effet ; section fermée : sans effet (relue à l'ouverture).
    emettre('asset-details-updated', { assetId: AUTRE });
    ouvert = false; emettre('verebona:data-mutated'); ouvert = true;
    expect(minuteurs).toHaveLength(0);
    // « Ajouter / Retirer du TCO » : la réponse porte le TCO recalculé — son propre événement ne relance rien.
    ecriturePropre = true; emettre('verebona:data-mutated'); ecriturePropre = false;
    expect(minuteurs).toHaveLength(0);
    // Débranché : plus aucune lecture.
    stop();
    emettre('document-added');
    expect(minuteurs).toHaveLength(0);
    c.dispose();
  });

  it('L81D-R02 — année sélectionnée conservée après recalcul si elle reste disponible, sinon année par défaut', async () => {
    const { tcoKeptYear, tcoEventConcernsAsset } = await import('@/components/assets/tco-refresh');
    expect(tcoKeptYear(2024, [{ year: 2024 }, { year: 2025 }], 2025)).toBe(2024);
    expect(tcoKeptYear(2023, [{ year: 2024 }, { year: 2025 }], 2025)).toBe(2025);
    expect(tcoKeptYear(null, [{ year: 2025 }], 2025)).toBe(2025);
    expect(tcoEventConcernsAsset('asset-details-updated', {}, VELO)).toBe(true);
    expect(tcoEventConcernsAsset('asset-details-updated', { assetId: String(VELO) }, VELO)).toBe(true);
    expect(tcoEventConcernsAsset('agenda-mutated', null, VELO)).toBe(true);
  });
});

describe('L81D — e2e TCO critiques exécutables en CI', () => {
  it('L81D-CI-01 — script `test:e2e:tco` : L76G (dont L81D), L78B, L80A et les e2e TCO historiques', () => {
    const script = (JSON.parse(lire('package.json')) as { scripts: Record<string, string> }).scripts['test:e2e:tco'];
    for (const f of ['l76g-tco-annuel', 'l78b-tco-attribution', 'l80a-tco-decisions', 'l75d-tco-residuels', 'l61-tco-depenses', 'l54d-operations-tco']) {
      expect(script).toContain(`src/test/e2e/scenarios/${f}.e2e.ts`);
    }
    expect(script).toMatch(/--config vitest\.e2e\.config\.ts/);
  });
});
