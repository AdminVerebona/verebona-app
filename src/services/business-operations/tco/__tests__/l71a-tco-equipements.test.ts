/**
 * Lot 71A — TCO : dépenses des ÉQUIPEMENTS agrégées au bien sans doublon,
 * prix d'achat du bien indépendant (tests PURS ; rejoué sur PG16 :
 * `src/test/e2e/scenarios/l71a-bien-equipement.e2e.ts`).
 *
 * EQP-30  Prix d'achat de la fiche d'un équipement : dépense du bien
 *         (« Accessoires, équipements »), jamais son acquisition.
 * EQP-31  Facture de l'équipement (preuve de son prix, ou rattachée à lui au
 *         même montant) : comptée une fois — la ligne fiche est un doublon.
 * EQP-32  Composante consolidée ciblant l'équipement au même montant : la
 *         ligne fiche est « déjà comptée par ailleurs ».
 * EQP-33  Prix d'achat du bien inchangé et indépendant ; la facture de
 *         l'équipement n'est plus prise pour celle du bien.
 */
import { describe, expect, it } from 'vitest';
import { computeTco, type TcoEquipmentPrice, type TcoInput, type TcoOperation } from '../model';
import type { EconomicDocumentInput } from '../../finance/economic-lines';

const MAISON = 30;
const ROBOT = 501;
const doc = (fileId: number, cents: number, o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: `Facture ${fileId}`, typeCode: 'ACQUISITION_INVOICE', legacyType: null, date: '2025-03-10', supplier: null,
  amountCents: cents, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [MAISON], multiAsset: false, operations: [],
  candidates: [{ id: fileId * 10, typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [],
    targets: [{ type: 'ASSET', entityId: MAISON }], t3Outcome: null,
    hints: [{ role: 'REALIZED_COST', amountMinor: cents, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null }] }],
  ...o,
});
const prixRobot = (o: Partial<TcoEquipmentPrice> = {}): TcoEquipmentPrice => ({
  equipmentId: ROBOT, name: 'Robot aspirateur', amountMinor: 49_900, currency: 'EUR', date: '2025-03-10', origin: 'USER', evidenceFileIds: [], ...o,
});
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: MAISON, today: '2026-10-19', operations: [], assetAcquisitionDate: '2019-06-14', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [],
  assetPrice: { amountMinor: 30_000_000, currency: 'EUR', origin: 'USER', evidenceFileIds: [] }, ...o,
});
const lignesEq = (t: ReturnType<typeof computeTco>) => t.lines.filter((l) => l.source === 'EQUIPMENT_DATA');

describe('EQP-30 — prix d’achat d’un équipement : dépense du bien', () => {
  it('retenu en « Accessoires, équipements », jamais dans l’acquisition du bien', () => {
    const t = computeTco(entree({ equipmentPrices: [prixRobot()] }));
    expect(lignesEq(t)).toEqual([expect.objectContaining({ status: 'RETAINED_DIRECT', category: 'ACCESSORIES', includedCents: 49_900, date: '2025-03-10' })]);
    expect(t.summary.acquisitionCents).toBe(30_000_000);
    expect(t.summary.cumulativeCostCents).toBe(30_049_900);
    expect(t.breakdown.find((b) => b.category === 'ACCESSORIES')).toMatchObject({ costsCents: 49_900, count: 1 });
  });
});

describe('EQP-31 — facture de l’équipement : comptée une seule fois', () => {
  it('facture preuve du prix de l’équipement : ligne fiche en doublon, facture retenue', () => {
    const t = computeTco(entree({ documents: [doc(77, 49_900)], equipmentPrices: [prixRobot({ evidenceFileIds: [77] })] }));
    expect(lignesEq(t)[0]).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_EQUIPMENT_DOCUMENT', includedCents: 0, fileId: 77 });
    expect(t.summary.cumulativeCostCents).toBe(30_049_900);
  });
  it('facture rattachée à l’équipement, même montant (sans preuve T1) : doublon', () => {
    const t = computeTco(entree({ documents: [doc(78, 49_900, { linkedEquipmentIds: [ROBOT] })], equipmentPrices: [prixRobot()] }));
    expect(lignesEq(t)[0]).toMatchObject({ status: 'DUPLICATE' });
    expect(t.summary.cumulativeCostCents).toBe(30_049_900);
  });
  it('facture d’un AUTRE montant rattachée à l’équipement (entretien) : les deux comptent', () => {
    const t = computeTco(entree({ documents: [doc(79, 9_000, { linkedEquipmentIds: [ROBOT] })], equipmentPrices: [prixRobot()] }));
    expect(lignesEq(t)[0]).toMatchObject({ status: 'RETAINED_DIRECT' });
    expect(t.summary.cumulativeCostCents).toBe(30_000_000 + 49_900 + 9_000);
  });
});

describe('EQP-32 — composante consolidée ciblant l’équipement', () => {
  it('même montant : ligne fiche « déjà comptée par ailleurs »', () => {
    const o: TcoOperation = {
      id: 5, typeCode: 'ACQUISITION', status: 'REALIZED', parentOperationId: null, realizedDate: '2025-03-10', startDate: null, plannedDate: null,
      assetIds: [MAISON], label: 'Achat — Robot', documents: [], sourceKinds: ['DOCUMENT'],
      components: [{ id: 9, operationId: 5, kind: 'REALIZED_COST', amountMinor: 49_900, currency: 'EUR', amountEurCents: null, economicDate: '2025-03-10',
        periodStart: null, periodEnd: null, targetAssetId: null, targetEquipmentId: ROBOT }],
    };
    const t = computeTco(entree({ operations: [o], equipmentAssets: new Map([[ROBOT, MAISON]]), equipmentPrices: [prixRobot()] }));
    expect(lignesEq(t)[0]).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE', reason: 'EQUIPMENT_PRICE_CONSOLIDATED', operationId: 5 });
    expect(t.summary.cumulativeCostCents).toBe(30_049_900);
  });
});

describe('EQP-33 — prix d’achat du bien indépendant', () => {
  it('la facture du robot n’est jamais la facture d’achat de la maison (preuves du bien seulement)', () => {
    // Sans preuve du BIEN, la facture du robot reste une dépense distincte.
    const t = computeTco(entree({ documents: [doc(80, 49_900)] }));
    const l = t.lines.find((x) => x.fileId === 80 && x.source === 'DOCUMENT')!;
    expect(l.status).not.toBe('DUPLICATE');
    expect(l.category).toBe('ACCESSORIES');
    expect(t.summary.acquisitionCents).toBe(30_000_000);
  });
});
