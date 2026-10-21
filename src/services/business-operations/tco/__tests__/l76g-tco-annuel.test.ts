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
import { computeTcoAnnual, TCO_DAYS_PER_YEAR, TCO_MIN_ANNUALIZED_DAYS } from '../annual';
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
  id, typeCode, status: 'REALIZED', parentOperationId: null, realizedDate: '2025-03-01', startDate: null, plannedDate: null,
  assetIds: [VELO], label: typeCode, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: VELO, today: TODAY, operations: [], assetAcquisitionDate: '2024-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: prix(30_000), ...o,
});
const annee = (t: TcoResult, y: number) => t.annual.years.find((a) => a.year === y);
/** Cohérence des trois indicateurs : Σ nets des années + non datées + futures = TCO total. */
const coherent = (t: TcoResult) => {
  const a = t.annual;
  const somme = a.years.reduce((n, y) => n + y.netCents, 0) + (a.undated.costsCents - a.undated.creditsCents) + (a.future.costsCents - a.future.creditsCents);
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

  it('L76G-02 — achat récent : moins d’un mois → aucune moyenne fabriquée (TOO_RECENT) ; au-delà, moyenne signalée « extrapolée » sous un an', () => {
    const neuf = computeTco(entree({ assetAcquisitionDate: '2026-10-12' }));
    expect(neuf.annual.average).toMatchObject({ status: 'TOO_RECENT', cents: null, days: 10, minDays: TCO_MIN_ANNUALIZED_DAYS });
    expect(neuf.summary.cumulativeCostCents).toBe(30_000);
    expect(annee(neuf, 2026)?.costsCents).toBe(30_000);
    coherent(neuf);
    const jourMeme = computeTco(entree({ assetAcquisitionDate: TODAY }));
    expect(jourMeme.annual.average).toMatchObject({ status: 'TOO_RECENT', cents: null, days: 1 });
    // Seuil : 30 jours de possession inclus → calculée.
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

  it('L76G-04 — date d’achat incohérente (future, postérieure à la cession, avant 1900) : aucune valeur annuelle', () => {
    const futur = computeTco(entree({ assetAcquisitionDate: '2027-03-01' }));
    expect(futur.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', cents: null });
    coherent(futur);
    const apresCession = computeTco(entree({ assetAcquisitionDate: '2025-06-01', assetStatus: 'VENDU', assetSaleDate: '2025-01-01' }));
    expect(apresCession.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', cents: null });
    const ancienne = computeTco(entree({ assetAcquisitionDate: '1850-01-01' }));
    expect(ancienne.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', cents: null });
    // La date implausible ne fabrique pas non plus 177 années vides.
    expect(ancienne.annual.years.map((y) => y.year)).toEqual([2026]);
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
    expect(t.annual.future.costsCents).toBe(0);
    coherent(t);
  });

  it('L76G-12 — dépense datée après aujourd’hui (non réalisée) : comptée dans aucune année, signalée à part', () => {
    const t = computeTco(entree({ documents: [reparation(501, 3_000, '2026-12-15'), reparation(502, 1_000, '2026-03-01')] }));
    expect(annee(t, 2026)?.costsCents).toBe(1_000);
    expect(t.annual.future).toEqual({ count: 1, costsCents: 3_000, creditsCents: 0 });
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
