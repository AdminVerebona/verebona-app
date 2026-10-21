/**
 * Lot 75D — ticket P1 « TCO — écarts résiduels de consolidation financière,
 * déduplication et complétude » (corrections A à J, recette §4) et ticket
 * L71A résiduels §C (déduplication financière du TCO). Tests PURS (aucune
 * base) ; lectures SQL, consolidation T3 réelle, routes et T2 rejoués sur
 * PostgreSQL 16 : `src/test/e2e/scenarios/l75d-tco-residuels.e2e.ts`.
 *
 * Chaque test reproduisait un écart (ROUGE avant correction) ; l'identifiant
 * renvoie au point du ticket (TCO-R-<lettre>…) ou à la ligne de recette.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, type TcoAssetPrice, type TcoEquipmentPrice, type TcoInput, type TcoOperation } from '../model';
import { parseTcoLinesPage, toTcoDto, TCO_DTO_MAX_LINES } from '../dto';
import {
  operationCoverage, qualifyDocumentLines, type EconomicDocumentCandidate, type EconomicDocumentInput, type EconomicDocumentOperation, type EconomicHint,
} from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

const VELO = 7;
const AUTRE = 8;
const ROBOT = 501;
const TODAY = '2026-10-20';
let seq = 70_000;

const hint = (role: string, amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'INTERVENTION', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [],
  targets: [{ type: 'ASSET', entityId: VELO }], hints, t3Outcome: null, ...o,
});
const doc = (fileId: number, o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: `Facture ${fileId}`, typeCode: 'ACQUISITION_INVOICE', legacyType: null, date: '2026-06-01', supplier: null,
  amountCents: null, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [VELO], multiAsset: false, candidates: [], operations: [], ...o,
});
/** Facture d'achat qualifiée par T1 (accessoire ou achat), sans Opération. */
const achat = (fileId: number, cents: number, o: Partial<EconomicDocumentInput> = {}, c: Partial<EconomicDocumentCandidate> = {}) =>
  doc(fileId, { amountCents: cents, candidates: [cand([hint('REALIZED_COST', cents)], { typeHint: 'ACQUISITION', ...c })], ...o });
/** Facture de réparation / entretien qualifiée par T1. */
const reparation = (fileId: number, cents: number, o: Partial<EconomicDocumentInput> = {}, c: Partial<EconomicDocumentCandidate> = {}) =>
  doc(fileId, { typeCode: 'REPAIR_INVOICE', amountCents: cents, candidates: [cand([hint('REALIZED_COST', cents)], c)], ...o });
const comp = (kind: FinancialComponentKind, eur: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: eur, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', parentOperationId: null, realizedDate: '2026-06-01', startDate: null, plannedDate: null,
  assetIds: [VELO], label: typeCode, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
/** Lien document → Opération tel que lu par le service (lot 75D : couverture au niveau du fait). */
const lien = (operationId: number, o: Partial<EconomicDocumentOperation> = {}): EconomicDocumentOperation => ({
  operationId, label: 'Intervention', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: false,
  typeCode: 'INTERVENTION', citesForOtherAssetOnly: false, citesOtherDocuments: false, freeComponents: [], ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: VELO, today: TODAY, operations: [], assetAcquisitionDate: '2026-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: null, ...o,
});
const ligne = (t: ReturnType<typeof computeTco>, fileId: number) => t.lines.filter((l) => l.fileId === fileId && l.source === 'DOCUMENT');
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

// ═══ Recette §4 du ticket TCO ═══════════════════════════════════════════════

describe('TCO-R — recette obligatoire (§4)', () => {
  it('TCO-R-01 — bien 300 € + accessoire 25 € + antivol 35 € → 360 €, calcul complet', () => {
    const t = computeTco(entree({ assetPrice: prix(30_000), documents: [achat(101, 2_500), achat(102, 3_500)] }));
    expect(t.summary).toMatchObject({ cumulativeCostCents: 36_000, acquisitionCents: 30_000, additionalCostsCents: 6_000, acquisitionStatus: 'DOCUMENTED' });
    expect(t.status).toBe('COMPLETE');
  });

  it('TCO-R-02 (A) — bien 300 € + accessoire DISTINCT 300 € → 600 € (jamais dédoublonné sur le seul montant)', () => {
    // Fiche datée du 10/01, accessoire acheté le 01/06 : mêmes montants, faits distincts.
    const t = computeTco(entree({ assetPrice: prix(30_000), documents: [achat(201, 30_000)] }));
    expect(t.summary.cumulativeCostCents).toBe(60_000);
    expect(ligne(t, 201)[0]).toMatchObject({ status: 'RETAINED_DIRECT', category: 'ACCESSORIES' });
    expect(ligne(t, 201)[0].uncertain).toBeUndefined();
    expect(t.status).toBe('COMPLETE');
    // Achat consolidé de même montant (sans donnée de la fiche ni preuve), autre date : distinct aussi.
    const accessoireOp = op(20, 'ACQUISITION', [comp('REALIZED_COST', 30_000, { targetAssetId: VELO })], { realizedDate: '2026-06-01' });
    const o = computeTco(entree({ assetPrice: prix(30_000), operations: [accessoireOp] }));
    expect(o.summary).toMatchObject({ cumulativeCostCents: 60_000, acquisitionCents: 30_000 });
    expect(o.lines.find((l) => l.source === 'ASSET_DATA')?.status).toBe('RETAINED_DIRECT');
  });

  it('TCO-R-02b (A) — identité établie : preuve T1, ou montant ET date concordants → un seul coût ; correction utilisateur prioritaire', () => {
    const memeJour = computeTco(entree({ assetPrice: prix(30_000), assetAcquisitionDate: '2026-06-01', documents: [achat(211, 30_000)] }));
    expect(memeJour.summary.cumulativeCostCents).toBe(30_000);
    expect(ligne(memeJour, 211)[0]).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_ASSET_PRICE' });
    // Prix corrigé par l'utilisateur (280) et facture preuve du prix (300) : même fait, la correction fait foi.
    const corrige = computeTco(entree({ assetPrice: prix(28_000, { origin: 'USER', evidenceFileIds: [212] }), documents: [achat(212, 30_000)] }));
    expect(corrige.summary.cumulativeCostCents).toBe(28_000);
    // Le prix de la fiche a sa propre preuve (facture 213) : une AUTRE facture de même montant est un autre fait.
    const autre = computeTco(entree({ assetPrice: prix(30_000, { evidenceFileIds: [213] }), assetAcquisitionDate: '2026-06-01', documents: [achat(213, 30_000), achat(214, 30_000, { hash: 'x' })] }));
    expect(autre.summary.cumulativeCostCents).toBe(60_000);
  });

  it('TCO-R-02c (A) — identité incertaine (même montant, date d’achat inconnue) → comptée, ambiguïté signalée, total non exhaustif', () => {
    const t = computeTco(entree({ assetPrice: prix(30_000), assetAcquisitionDate: null, documents: [achat(221, 30_000)] }));
    expect(t.summary.cumulativeCostCents).toBe(60_000);
    expect(ligne(t, 221)[0]).toMatchObject({ status: 'RETAINED_DIRECT', uncertain: true, note: expect.stringContaining('à vérifier') });
    expect(t.reliability.warnings).toContain('UNCERTAIN_MATCHES');
    expect(t.status).toBe('INCOMPLETE');
    // Achat consolidé de même montant, dates inconnues : idem (jamais absorbé sur le montant).
    const o = computeTco(entree({ assetPrice: prix(30_000), assetAcquisitionDate: null, operations: [op(22, 'ACQUISITION', [comp('REALIZED_COST', 30_000)], { realizedDate: null })] }));
    expect(o.summary.cumulativeCostCents).toBe(60_000);
    expect(o.lines.find((l) => l.source === 'OPERATION')).toMatchObject({ uncertain: true });
    expect(o.status).toBe('INCOMPLETE');
  });

  it('TCO-R-03 (B) — facture 180 € consolidée + facture 40 € NON consolidée dans la même opération → 220 €', () => {
    const o = op(30, 'INTERVENTION', [comp('REALIZED_COST', 18_000)], { documents: [{ fileId: 301, title: 'F180', role: 'INVOICE' }, { fileId: 302, title: 'F40', role: 'INVOICE' }] });
    const t = computeTco(entree({ assetPrice: prix(30_000), operations: [o], documents: [
      reparation(301, 18_000, { operations: [lien(30, { citesDocument: true })] }),
      reparation(302, 4_000, { operations: [lien(30, { citesOtherDocuments: true })] }),
    ] }));
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 22_000);
    expect(ligne(t, 301)[0]).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE' });
    expect(ligne(t, 302)[0]).toMatchObject({ status: 'RETAINED_DIRECT', operationId: 30, note: expect.stringContaining('n’en reprend pas le montant') });
  });

  it('TCO-R-03b (B) — composante prévisionnelle, autre bien, saisie de même nature, acompte d’un total consolidé', () => {
    const base = { title: 'X', amountCents: 4_000, userEditedAmount: false, acquisitionEvidence: false };
    const facture = { ...base, candidates: [cand([hint('REALIZED_COST', 4_000)])] };
    // Prévision seule : `citesDocument` est faux (une prévision ne couvre jamais une facture) → non couverte.
    expect(operationCoverage(lien(1, { citesOtherDocuments: true }), facture)).toBe('NOT_COVERED');
    // Composante citant la facture pour un AUTRE bien seulement : ce bien n'en a pas la part → non couverte.
    expect(operationCoverage(lien(1, { citesDocument: true, citesForOtherAssetOnly: true }), facture)).toBe('NOT_COVERED');
    // Opération d'un autre bien qui la cite : représentée ailleurs (autre bien).
    expect(operationCoverage(lien(1, { citesDocument: true, citesForOtherAssetOnly: true, inScope: false }), facture)).toBe('COVERED');
    // Saisie (sinistre, fiche, arbitrage) de MÊME nature sans justificatif : lien de consolidation + nature → couverte.
    const lettre = { ...base, candidates: [cand([hint('INDEMNITY', 4_000)])] };
    const saisie = [{ kind: 'INDEMNITY', amountMinor: 3_500, currency: 'EUR', documented: false }];
    expect(operationCoverage(lien(1, { freeComponents: saisie }), lettre)).toBe('COVERED');
    expect(operationCoverage(lien(1, { freeComponents: saisie }), facture)).toBe('NOT_COVERED');
    // Composante qu'aucun justificatif cité n'explique, même nature ET même montant (harnais ancien : composantes
    // rattachées à la seule première source) : couverte ; même nature, autre montant : non couverte.
    const libre = (amountMinor: number) => [{ kind: 'REALIZED_COST', amountMinor, currency: 'EUR', documented: true }];
    expect(operationCoverage(lien(1, { citesOtherDocuments: true, freeComponents: libre(4_000) }), facture)).toBe('COVERED');
    expect(operationCoverage(lien(1, { citesOtherDocuments: true, freeComponents: libre(18_000) }), facture)).toBe('NOT_COVERED');
    // Pièce sans fait de coût propre (devis ou preuve de paiement sans indice) : représentée par l'Opération.
    expect(operationCoverage(lien(1, { citesOtherDocuments: true }), { ...base, candidates: [], typeCode: 'REPAIR_QUOTE', legacyType: null })).toBe('COVERED');
    expect(operationCoverage(lien(1, { citesOtherDocuments: true }), { ...base, candidates: [], typeCode: 'WORKS_PAYMENT_PROOF', legacyType: null })).toBe('COVERED');
    // Acompte d'une Opération dont la facture totale est consolidée : compris dans le total.
    const acompte = { ...base, candidates: [cand([hint('REALIZED_COST', 4_000, { amountScope: 'DEPOSIT' })])] };
    expect(operationCoverage(lien(1, { citesOtherDocuments: true }), acompte)).toBe('INCLUDED_IN_TOTAL');
    // Opération sans montant : le justificatif fait foi (lot 61).
    expect(operationCoverage(lien(1, { exploitable: false }), facture)).toBe('NO_AMOUNT');
    // Entrée antérieure (couverture non lue) : règle du lot 61 conservée.
    expect(operationCoverage({ operationId: 1, label: 'X', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: false }, facture)).toBe('COVERED');
  });

  it('TCO-R-04 (C) — facture 200 € + acompte 50 € + solde 150 € LIÉS → 200 € ; lien par référence ou par Opération', () => {
    const r = [{ kind: 'ORDER', value: 'CMD-77' }];
    const t = computeTco(entree({ documents: [
      reparation(401, 20_000, { title: 'Facture' }, { references: r, provider: 'Garage A' }),
      reparation(402, 5_000, { title: 'Acompte' }, { references: r, provider: 'Garage A' }),
      doc(403, { typeCode: 'REPAIR_INVOICE', candidates: [cand([hint('REALIZED_COST', 15_000, { amountScope: 'BALANCE' })], { references: r })] }),
    ].map((d, i) => (i === 1 ? { ...d, candidates: [cand([hint('REALIZED_COST', 5_000, { amountScope: 'DEPOSIT' })], { references: r, provider: 'Garage A' })] } : d)) }));
    expect(t.lines.filter((l) => l.source === 'DOCUMENT' && l.includedCents).reduce((n, l) => n + l.includedCents, 0)).toBe(20_000);
    expect(ligne(t, 402)[0]).toMatchObject({ status: 'INCLUDED_IN_TOTAL', relatedFileId: 401 });
    // Lien explicite par la même Opération (acompte seul, somme ≠ total) : compris.
    const lie = computeTco(entree({ documents: [
      reparation(411, 20_000, { operations: [lien(41, { exploitable: false })] }),
      doc(412, { typeCode: 'REPAIR_INVOICE', candidates: [cand([hint('REALIZED_COST', 5_000, { amountScope: 'DEPOSIT' })])], operations: [lien(41, { exploitable: false })] }),
    ] }));
    expect(ligne(lie, 412)[0]).toMatchObject({ status: 'INCLUDED_IN_TOTAL' });
  });

  it('TCO-R-04b (C) — deux prestations indépendantes chez le même fournisseur → deux coûts ; acompte du même fournisseur sans lien → compté, signalé', () => {
    const p = { provider: 'Garage A' };
    const deux = computeTco(entree({ documents: [reparation(421, 12_000, {}, p), reparation(422, 8_000, {}, p)] }));
    expect(deux.summary.cumulativeCostCents).toBe(20_000);
    expect(deux.lines.some((l) => l.uncertain)).toBe(false);
    // Acompte 50 € du même fournisseur qu'une facture totale 200 €, sans référence commune ni somme exacte : jamais absorbé.
    const t = computeTco(entree({ documents: [
      reparation(431, 20_000, {}, p),
      doc(432, { typeCode: 'REPAIR_INVOICE', candidates: [cand([hint('REALIZED_COST', 5_000, { amountScope: 'DEPOSIT' })], p)] }),
    ] }));
    expect(t.summary.cumulativeCostCents).toBe(25_000);
    expect(ligne(t, 432)[0]).toMatchObject({ status: 'RETAINED_DIRECT', uncertain: true, relatedFileId: 431 });
    expect(t.reliability.warnings).toContain('UNCERTAIN_MATCHES');
  });

  it('TCO-R-05 (F) — équipement acheté 200 € puis réparé 200 € → 400 € (justificatif ou opération de réparation)', () => {
    const robot = (o: Partial<TcoEquipmentPrice> = {}): TcoEquipmentPrice => ({ equipmentId: ROBOT, name: 'Robot', amountMinor: 20_000, currency: 'EUR', date: '2026-02-01', origin: 'USER', evidenceFileIds: [], ...o });
    const base = { assetPrice: prix(30_000), equipmentAssets: new Map([[ROBOT, VELO]]) };
    // Facture de réparation rattachée au robot, même montant.
    const f = computeTco(entree({ ...base, equipmentPrices: [robot()], documents: [reparation(501, 20_000, { linkedEquipmentIds: [ROBOT] }, { targets: [{ type: 'EQUIPMENT', entityId: ROBOT }] })] }));
    expect(f.summary.cumulativeCostCents).toBe(30_000 + 40_000);
    expect(f.lines.find((l) => l.source === 'EQUIPMENT_DATA')).toMatchObject({ status: 'RETAINED_DIRECT' });
    // Intervention consolidée ciblant le robot, même montant.
    const i = computeTco(entree({ ...base, equipmentPrices: [robot()], operations: [op(50, 'INTERVENTION', [comp('REALIZED_COST', 20_000, { targetEquipmentId: ROBOT })])] }));
    expect(i.summary.cumulativeCostCents).toBe(30_000 + 40_000);
    // Facture d'ACHAT du robot (même montant, même date) : un seul coût, prix du bien inchangé.
    const a = computeTco(entree({ ...base, equipmentPrices: [robot()], documents: [achat(502, 20_000, { date: '2026-02-01', linkedEquipmentIds: [ROBOT] }, { targets: [{ type: 'EQUIPMENT', entityId: ROBOT }] })] }));
    expect(a.summary).toMatchObject({ cumulativeCostCents: 50_000, acquisitionCents: 30_000 });
    expect(a.lines.find((l) => l.source === 'EQUIPMENT_DATA')).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_EQUIPMENT_DOCUMENT' });
  });

  it('TCO-R-05b (F) — la dépense censée couvrir le prix de l’équipement doit être RETENUE ; autre facture que la preuve : distincte', () => {
    const robot: TcoEquipmentPrice = { equipmentId: ROBOT, name: 'Robot', amountMinor: 20_000, currency: 'EUR', date: null, origin: 'USER', evidenceFileIds: [] };
    // Facture d'achat liée au robot mais multi-biens non ventilée (non retenue) : le prix de la fiche reste compté.
    const nv = computeTco(entree({ assetPrice: prix(30_000), equipmentPrices: [robot], documents: [
      achat(511, 20_000, { linkedEquipmentIds: [ROBOT], linkedAssetIds: [VELO, AUTRE] }, { targets: [] }),
    ] }));
    expect(ligne(nv, 511)[0].status).toBe('UNALLOCATED');
    expect(nv.lines.find((l) => l.source === 'EQUIPMENT_DATA')).toMatchObject({ status: 'RETAINED_DIRECT', includedCents: 20_000 });
    // Le prix a sa preuve (facture 512) : une autre facture d'achat de même montant liée au robot est un autre fait.
    const p = computeTco(entree({ assetPrice: prix(30_000), equipmentPrices: [{ ...robot, evidenceFileIds: [512] }], documents: [
      achat(512, 20_000, { linkedEquipmentIds: [ROBOT] }), achat(513, 20_000, { linkedEquipmentIds: [ROBOT], hash: 'z' }),
    ] }));
    expect(p.summary.cumulativeCostCents).toBe(30_000 + 40_000);
    // L'achat consolidé d'un équipement n'est jamais l'acquisition du bien (sans prix dans la fiche).
    const eqOp = computeTco(entree({ operations: [op(52, 'ACQUISITION', [comp('REALIZED_COST', 20_000, { targetEquipmentId: ROBOT })])], equipmentAssets: new Map([[ROBOT, VELO]]) }));
    expect(eqOp.summary).toMatchObject({ acquisitionCents: 0, additionalCostsCents: 20_000, acquisitionStatus: 'MISSING' });
  });

  it('TCO-R-06 (G) — facture d’acquisition sans prix saisi dans la fiche → acquisition correctement identifiée', () => {
    const t = computeTco(entree({ documents: [achat(601, 30_000)] }));
    expect(t.summary).toMatchObject({ acquisitionCents: 30_000, additionalCostsCents: 0, acquisitionStatus: 'DOCUMENTED' });
    expect(ligne(t, 601)[0]).toMatchObject({ category: 'ACQUISITION', status: 'RETAINED_DIRECT' });
    expect(t.status).toBe('COMPLETE');
    // Preuve T1 du prix sur la facture du vélo, accessoire à côté : achat principal et achat complémentaire distingués.
    const p = computeTco(entree({ documents: [achat(602, 30_000, { acquisitionEvidence: true }), achat(603, 2_500)] }));
    expect(p.summary).toMatchObject({ acquisitionCents: 30_000, additionalCostsCents: 2_500 });
    // Deux factures d'achat possibles sans preuve : aucune affectation arbitraire, ambiguïté signalée.
    const amb = computeTco(entree({ documents: [achat(604, 30_000), achat(605, 2_500)] }));
    expect(amb.summary).toMatchObject({ acquisitionCents: 0, cumulativeCostCents: 32_500, acquisitionStatus: 'MISSING' });
    expect(amb.reliability.warnings).toEqual(expect.arrayContaining(['ACQUISITION_AMBIGUOUS', 'ACQUISITION_COST_MISSING']));
    expect(amb.status).toBe('INCOMPLETE');
  });

  it('TCO-R-07 (D) — facture financière sans montant exploitable → couverture incomplète, jamais 0 € certain', () => {
    const t = computeTco(entree({ assetPrice: prix(30_000), documents: [doc(701, { typeCode: 'REPAIR_INVOICE' }), doc(702, { typeCode: null, legacyType: 'FACTURE' })] }));
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    for (const f of [701, 702]) expect(ligne(t, f)[0]).toMatchObject({ status: 'NOT_QUALIFIED', reason: 'AMOUNT_UNKNOWN', eurCents: null, amountUnknown: true, includedCents: 0 });
    expect(t.reliability.warnings).toContain('AMOUNTS_UNKNOWN');
    expect(t.status).toBe('INCOMPLETE');
    // Le DTO la transmet comme montant inconnu (affichée « Montant inconnu », desktop et mobile).
    expect(toTcoDto(t).lines.find((l) => l.fileId === 701)).toMatchObject({ amountUnknown: true, eurCents: null });
    expect(lire('src/components/assets/TcoSection.tsx')).toContain("l.amountUnknown ? 'Montant inconnu'");
  });

  it('TCO-R-08 (E) — facture globale multibiens non ventilée → aucun montant attribué arbitrairement, même avec une cible unique', () => {
    const t = computeTco(entree({ assetPrice: prix(30_000), documents: [reparation(801, 12_000, { multiAsset: true })] }));
    expect(ligne(t, 801)[0]).toMatchObject({ status: 'UNALLOCATED', includedCents: 0 });
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    expect(t.status).toBe('INCOMPLETE');
  });

  it('TCO-R-09 (E) — facture multibiens avec parts fiables → chaque bien reçoit uniquement sa part (plusieurs lignes d’un même document)', () => {
    const d = doc(901, { typeCode: 'REPAIR_INVOICE', multiAsset: true, linkedAssetIds: [VELO, AUTRE], candidates: [
      cand([hint('REALIZED_COST', 4_000)], { targets: [{ type: 'ASSET', entityId: VELO }] }),
      cand([hint('REALIZED_COST', 8_000)], { targets: [{ type: 'ASSET', entityId: AUTRE }] }),
    ] });
    expect(computeTco(entree({ documents: [d] })).lines.filter((l) => l.includedCents).map((l) => l.includedCents)).toEqual([4_000]);
    expect(computeTco(entree({ assetId: AUTRE, documents: [d] })).lines.filter((l) => l.includedCents).map((l) => l.includedCents)).toEqual([8_000]);
    // Document NON multi-biens (T1), lié aussi à un autre bien : la cible T1 fait foi (non-régression L68 « Midas »).
    const midas = reparation(902, 51_154, { linkedAssetIds: [VELO, AUTRE] }, { targets: [{ type: 'ASSET', entityId: AUTRE }] });
    expect(ligne(computeTco(entree({ documents: [midas] })), 902)[0].status).toBe('OUT_OF_SCOPE');
    expect(computeTco(entree({ assetId: AUTRE, documents: [midas] })).summary.cumulativeCostCents).toBe(51_154);
  });

  it('TCO-R-10 (H) — prix d’acquisition attendu mais inconnu → INCOMPLETE ; location / prêt / don → sans objet, aucun faux manque', () => {
    const t = computeTco(entree({ documents: [reparation(1001, 5_000)] }));
    expect(t.summary.acquisitionStatus).toBe('MISSING');
    expect(t.reliability.warnings).toContain('ACQUISITION_COST_MISSING');
    expect(t.status).toBe('INCOMPLETE');
    const lld = computeTco(entree({ acquisitionExpected: false, documents: [reparation(1002, 5_000)] }));
    expect(lld.summary.acquisitionStatus).toBe('NOT_APPLICABLE');
    expect(lld.reliability.warnings).not.toContain('ACQUISITION_COST_MISSING');
    expect(lld.status).toBe('COMPLETE');
    // Statuts distincts conservés : PARTIAL (lecture), INCOMPLETE (information manquante), COMPLETE.
    expect(computeTco(entree({ readComplete: false, assetPrice: prix(1) })).status).toBe('PARTIAL');
    expect(computeTco(entree({ assetPrice: prix(30_000) })).status).toBe('COMPLETE');
  });

  it('TCO-R-11 (J) — plus de 400 lignes financières → total exact, liste abrégée signalée, lignes restantes accessibles par page', () => {
    const docs = Array.from({ length: 450 }, (_, i) => reparation(20_000 + i, 100, { hash: `p${i}`, date: `2026-0${1 + (i % 9)}-15` }, { references: [{ kind: 'INVOICE', value: `R-${i}` }] }));
    const t = computeTco(entree({ assetPrice: prix(30_000), documents: docs }));
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 45_000);
    const p1 = toTcoDto(t);
    expect(p1).toMatchObject({ linesTotal: 451, linesOffset: 0, linesCount: TCO_DTO_MAX_LINES, linesTruncated: true, retainedLinesTotal: 451, otherLinesTotal: 0 });
    expect(p1.summary).toEqual(t.summary);
    const p2 = toTcoDto(t, { linesOffset: 400 });
    expect(p2.linesCount).toBe(51);
    // Pages disjointes et complètes : chaque ligne une fois.
    const ids = [...p1.lines, ...p2.lines].map((l) => l.id);
    expect(new Set(ids).size).toBe(451);
    expect(p2.summary.cumulativeCostCents).toBe(t.summary.cumulativeCostCents);
    // Paramètres de page bornés, jamais d'erreur.
    expect(parseTcoLinesPage(new URLSearchParams('linesOffset=abc&linesLimit=999999'))).toEqual({ linesOffset: 0, linesLimit: 1000 });
    // Interface (desktop et mobile, même composant) : nombre présenté / total, et chargement complémentaire.
    const ui = lire('src/components/assets/TcoSection.tsx');
    expect(ui).toContain('data-tco-lines-truncated');
    expect(ui).toContain('linesOffset=${offset}');
    expect(ui).toContain('w-full sm:w-auto');
    expect(ui).not.toContain('slice(0, 100)');
  });

  it('TCO-R-12 — document repris par T3 : aucun changement artificiel du total (avant / après consolidation partielle puis complète)', () => {
    const f180 = (ops: EconomicDocumentOperation[]) => reparation(1201, 18_000, { operations: ops });
    const f40 = (ops: EconomicDocumentOperation[]) => reparation(1202, 4_000, { operations: ops });
    const avant = computeTco(entree({ assetPrice: prix(30_000), documents: [f180([]), f40([])] }));
    const o1 = op(12, 'INTERVENTION', [comp('REALIZED_COST', 18_000)]);
    const partiel = computeTco(entree({ assetPrice: prix(30_000), operations: [o1], documents: [f180([lien(12, { citesDocument: true })]), f40([lien(12, { citesOtherDocuments: true })])] }));
    const o2 = op(12, 'INTERVENTION', [comp('REALIZED_COST', 18_000), comp('REALIZED_COST', 4_000)]);
    const complet = computeTco(entree({ assetPrice: prix(30_000), operations: [o2], documents: [f180([lien(12, { citesDocument: true, citesOtherDocuments: true })]), f40([lien(12, { citesDocument: true, citesOtherDocuments: true })])] }));
    expect([avant, partiel, complet].map((t) => t.summary.cumulativeCostCents)).toEqual([52_000, 52_000, 52_000]);
  });

  it('TCO-R-13 — annulation ou fusion d’une opération : recalcul et réévaluation des documents', () => {
    const facture = (ops: EconomicDocumentOperation[]) => reparation(1301, 5_000, { operations: ops });
    // Annulée : justificatif écarté avec ce motif (lot 61 conservé).
    expect(ligne(computeTco(entree({ documents: [facture([lien(13, { cancelled: true, citesDocument: true })])] })), 1301)[0]).toMatchObject({ reason: 'OPERATION_CANCELLED_SOURCE' });
    // Fusionnée dans une Opération qui ne reprend pas son fait : le justificatif est réévalué et compté.
    expect(computeTco(entree({ documents: [facture([lien(14, { citesOtherDocuments: true })])] })).summary.cumulativeCostCents).toBe(5_000);
  });
});

// ═══ L71A §C — déduplication financière du TCO (preuves retirées, règle centralisée) ═

describe('L71A-C — TCO : dépenses distinctes de même montant, preuves retirées', () => {
  it('L71A-C-1 — robot acheté 499 € puis réparé 499 € : les deux comptent ; facture d’achat = prix de la fiche : une fois', () => {
    const robot: TcoEquipmentPrice = { equipmentId: ROBOT, name: 'Robot', amountMinor: 49_900, currency: 'EUR', date: '2025-03-10', origin: 'USER', evidenceFileIds: [] };
    const t = computeTco(entree({ assetPrice: prix(30_000), equipmentPrices: [robot], documents: [
      reparation(1401, 49_900, { date: '2026-03-10', linkedEquipmentIds: [ROBOT] }),
    ] }));
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 2 * 49_900);
    const u = computeTco(entree({ assetPrice: prix(30_000), equipmentPrices: [{ ...robot, evidenceFileIds: [1402] }], documents: [achat(1402, 49_900, { linkedEquipmentIds: [ROBOT] })] }));
    expect(u.summary.cumulativeCostCents).toBe(30_000 + 49_900);
  });

  it('L71A-C-2 — règle de preuve ACTIVE centralisée : toutes les lectures de preuves du TCO passent par le filtre canonique (WITHDRAWN / SUPERSEDED exclues)', () => {
    const svc = lire('src/services/business-operations/tco/service.ts');
    expect(svc).toContain('evidenceReadFilter({ assetLevel: opts.assetLevel })');
    // Chaque lecture de field_evidence du TCO ajoute ce filtre (acquisitionEvidenceFiles, readAssetAcquisition, readEquipmentPrices).
    const lectures = svc.split('FROM field_evidence').length - 1;
    expect(lectures).toBe(3);
    expect(svc.match(/\$\{actives\}/g)?.length).toBe(3);
    expect(svc).not.toMatch(/lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE'/);
    const filtre = lire('src/services/ai/evidence/field-evidence.service.ts');
    expect(filtre).toMatch(/lifecycle_status IS NULL OR \$\{a\}lifecycle_status = 'ACTIVE'/);
  });
});

// ═══ Architecture : un seul moteur, T2 sans seconde logique ═════════════════

describe('TCO-R — architecture et cohérence T2', () => {
  it('TCO-R-14 — T2 et TCO : même règle de couverture (aucune comparaison de montants dans T2), un seul moteur', () => {
    const t2 = lire('src/services/verebona-assistant/canonical/expenses.ts');
    expect(t2).toContain('documentsNotCoveredByOperations');
    expect(t2).not.toMatch(/Number\(r\.amountCents\) !== achats/);
    const svc = lire('src/services/business-operations/tco/service.ts');
    expect(svc).toMatch(/operationCoverage\(o, entree\)/);
    const model = lire('src/services/business-operations/tco/model.ts');
    expect(model).toContain("from '../finance/engine'");
    expect(model).not.toMatch(/sumQualifiedExpenses/);
  });

  it('TCO-R-15 — plus de 500 équipements : lecture paginée, aucune borne silencieuse', () => {
    const svc = lire('src/services/business-operations/tco/service.ts');
    const f = svc.slice(svc.indexOf('export async function readEquipmentPrices'), svc.indexOf('// ── Forfaits d'));
    expect(f).toContain('e.id > ${curseur}');
    expect(f).not.toMatch(/LIMIT 500\b/);
    expect(f).toContain('complete = false');
    expect(svc).toContain('readComplete: readComplete && doc.complete && equipementsComplets');
  });

  it('TCO-R-16 — qualification : un justificatif de dépense sans montant ni candidat produit une ligne « montant inconnu »', () => {
    expect(qualifyDocumentLines([doc(1601, { typeCode: 'MAINTENANCE_INVOICE' })], { today: TODAY })).toEqual([expect.objectContaining({ reason: 'AMOUNT_UNKNOWN' })]);
    // Photo ou notice sans montant : aucune ligne (pas de bruit).
    expect(qualifyDocumentLines([doc(1602, { typeCode: 'PHOTO' })], { today: TODAY })).toEqual([]);
  });
});
