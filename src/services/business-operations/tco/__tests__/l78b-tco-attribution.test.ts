/**
 * Lot 78B — ticket P1 « Opérations & TCO — identité économique, rapprochements,
 * données financières et provenance », §3 (fiabilisation financière et TCO) et
 * tests de non-régression §7 qui le concernent. Tests PURS (aucune base) ;
 * lectures SQL réelles, T3 réel et diagnostic BO (montants.json) sur
 * PostgreSQL 16 : `src/test/e2e/scenarios/l78b-tco-attribution.e2e.ts`.
 *
 * Cas du ticket (Opération #76) : une commande de chaises de jardin (277,35 €)
 * a absorbé les justificatifs de l'achat d'une maison (trois composantes de
 * 490 000 €). Aucune règle par commerçant : les fixtures ne nomment aucun
 * fournisseur, seules comptent la nature des faits et leurs relations.
 */
import { describe, expect, it } from 'vitest';
import { computeTco, type TcoAssetPrice, type TcoInput, type TcoOperation } from '../model';
import { distinctTransactions, presumedDuplicateComponents, purchaseIsOwnershipCost, unjustifiedComponent, type ComponentProvenance } from '../fact-identity';
import { toTcoDto, TCO_WARNING_LABELS } from '../dto';
import type { EconomicDocumentCandidate, EconomicDocumentInput, EconomicHint } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

const MAISON = 70;
const CHAISES = 71;
const VOITURE = 72;
const TODAY = '2026-10-21';
let seq = 78_000;

// Justificatifs (identifiants de fichiers).
const COMMANDE = 10;      // commande de mobilier (277,35 €)
const ACTE = 11;          // acte de vente (preuve T1 du prix de la maison)
const ATTESTATION = 12;   // attestation reprenant le prix, des années plus tard
const COPIE = 13;         // copie de l'acte sans référence lue

const comp = (kind: FinancialComponentKind, cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', parentOperationId: null, realizedDate: '2007-05-14', startDate: null, plannedDate: null,
  assetIds: [MAISON], label: typeCode, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const pv = (documentFileIds: number[], o: Partial<ComponentProvenance> = {}): ComponentProvenance => ({
  documentFileIds, withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: documentFileIds.length ? true : null, ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: MAISON, today: TODAY, operations: [], assetAcquisitionDate: '2007-05-14', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: null,
  assetCategory: 'IMMOBILIER', ...o,
});
const hint = (role: string, amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [],
  targets: [{ type: 'ASSET', entityId: MAISON }], hints, t3Outcome: null, ...o,
});
const doc = (fileId: number, cents: number, o: Partial<EconomicDocumentInput> = {}, c: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentInput => ({
  fileId, title: `Justificatif ${fileId}`, typeCode: 'ACQUISITION_INVOICE', legacyType: null, date: '2026-06-01', supplier: null,
  amountCents: cents, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [MAISON], multiAsset: false, candidates: [cand([hint('REALIZED_COST', cents)], c)], operations: [], ...o,
});
const ligneC = (t: ReturnType<typeof computeTco>, componentId: number) => t.lines.find((l) => l.id === `c:${componentId}`)!;
const ligneD = (t: ReturnType<typeof computeTco>, fileId: number) => t.lines.filter((l) => l.source === 'DOCUMENT' && l.fileId === fileId);
/** Cohérence 76G : Σ nets des années + non datées + futures = TCO total (aucun second moteur). */
const coherent = (t: ReturnType<typeof computeTco>) => {
  const a = t.annual;
  const somme = a.years.reduce((n, y) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents;  // 81D : plus de dépenses « futures » retenues
  expect(somme).toBe(t.summary.cumulativeCostCents);
  expect(t.reliability.anomalies.filter((x) => x.code === 'SUM_MISMATCH' || x.code === 'DUPLICATE_COMPONENT')).toEqual([]);
};

/** Opération #76 du ticket : commande de mobilier + trois composantes de 490 000 € issues des justificatifs de la maison. */
function operation76() {
  const chaises = comp('REALIZED_COST', 27_735, { economicDate: '2021-06-03' });
  const acte = comp('REALIZED_COST', 49_000_000, { economicDate: '2007-05-14' });
  const attestation = comp('REALIZED_COST', 49_000_000, { economicDate: '2021-02-01' });
  const copie = comp('REALIZED_COST', 49_000_000);
  const o = op(76, 'ACQUISITION', [chaises, acte, attestation, copie], {
    label: 'Achat — Commande de mobilier',
    documents: [{ fileId: COMMANDE, title: 'Commande mobilier', role: 'INVOICE' }, { fileId: ACTE, title: 'Acte de vente', role: 'OTHER_EVIDENCE' },
      { fileId: ATTESTATION, title: 'Attestation', role: 'OTHER_EVIDENCE' }, { fileId: COPIE, title: 'Copie acte', role: 'OTHER_EVIDENCE' }],
  });
  const provenance = new Map<number, ComponentProvenance>([
    [chaises.id, pv([COMMANDE], { invoiceRefs: ['FA2021'] })], [acte.id, pv([ACTE])], [attestation.id, pv([ATTESTATION])], [copie.id, pv([COPIE])],
  ]);
  return { o, chaises, acte, attestation, copie, provenance };
}

// ═══ §3B — doublons financiers (règle pure) ═════════════════════════════════

describe('L78B-B — même somme portée par plusieurs justificatifs d’une même Opération', () => {
  const a = comp('REALIZED_COST', 80_000, { economicDate: '2026-01-10' });
  const b = comp('REALIZED_COST', 80_000, { economicDate: '2026-03-10' });

  it('L78B-B01 — preuves de transactions distinctes : même justificatif, périodes, relation récurrente, factures différentes, saisie', () => {
    expect(distinctTransactions(a, b, pv([1]), pv([2]), 'INTERVENTION')).toBe(false); // date différente SEULE : aucune preuve
    expect(distinctTransactions(a, b, pv([1]), pv([1, 2]), 'INTERVENTION')).toBe(true); // deux lignes d'un même document
    expect(distinctTransactions({ ...a, periodStart: '2025-01-01', periodEnd: '2025-12-31' }, { ...b, periodStart: '2026-01-01', periodEnd: '2026-12-31' }, pv([1]), pv([2]), 'OTHER')).toBe(true);
    expect(distinctTransactions(a, b, pv([1]), pv([2]), 'CONTRACT')).toBe(true); // échéances d'une relation récurrente
    expect(distinctTransactions(a, b, pv([1], { invoiceRefs: ['F1'] }), pv([2], { invoiceRefs: ['F2'] }), 'INTERVENTION')).toBe(true);
    expect(distinctTransactions(a, b, pv([1], { invoiceRefs: ['F1'] }), pv([2], { invoiceRefs: ['F1'] }), 'INTERVENTION')).toBe(false);
    expect(distinctTransactions(a, b, pv([1]), pv([], { otherSourceKinds: ['ASSET_DATA'] }), 'ACQUISITION')).toBe(true); // non documentaire
    expect(distinctTransactions(a, b, undefined, pv([2]), 'ACQUISITION')).toBe(true); // provenance non lue
  });

  it('L78B-B02 — la composante la mieux justifiée est comptée ; une prévision n’est jamais dédoublonnée', () => {
    const c = comp('REALIZED_COST', 80_000);
    const f = comp('FORECAST_COST', 80_000);
    const d = presumedDuplicateComponents({ typeCode: 'INTERVENTION', components: [a, b, c, f] },
      new Map([[a.id, pv([1])], [b.id, pv([2])], [c.id, pv([3])], [f.id, pv([4])]]), (id) => (id === b.id ? 5 : 0));
    expect([...d.keys()].sort()).toEqual([a.id, c.id].sort());
    expect(d.get(a.id)).toMatchObject({ keptComponentId: b.id, keptFileIds: [2] });
  });

  it('L78B-B03 (§7 « montant dans plusieurs documents ») — 3 justificatifs d’une même dépense, 800 € chacun → 800 € comptés une fois, signalé', () => {
    const [x, y, z] = [comp('REALIZED_COST', 80_000, { economicDate: '2026-02-01' }), comp('REALIZED_COST', 80_000, { economicDate: '2026-02-03' }), comp('REALIZED_COST', 80_000)];
    const o = op(5, 'INTERVENTION', [x, y, z], { realizedDate: '2026-02-01' });
    const provenance = new Map([[x.id, pv([21])], [y.id, pv([22])], [z.id, pv([23])]]);
    const t = computeTco(entree({ assetPrice: prix(49_000_000), operations: [o], componentProvenance: provenance }));
    expect(t.summary.cumulativeCostCents).toBe(49_000_000 + 80_000);
    expect(ligneC(t, x.id)).toMatchObject({ status: 'RETAINED_CONSOLIDATED', includedCents: 80_000, fileId: 21, sourceFileIds: [21] });
    for (const dup of [y, z]) {
      expect(ligneC(t, dup.id)).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_FACT_OTHER_DOCUMENT', includedCents: 0, duplicateOf: `c:${x.id}`, relatedFileId: 21 });
    }
    expect(t.reliability.warnings).toContain('PRESUMED_DUPLICATES');
    expect(t.status).toBe('INCOMPLETE');
    expect(toTcoDto(t).warningLabels).toContain(TCO_WARNING_LABELS.PRESUMED_DUPLICATES);
    coherent(t);
    // Factures numérotées différemment : trois transactions réelles, trois coûts.
    const distinctes = new Map([[x.id, pv([21], { invoiceRefs: ['F-1'] })], [y.id, pv([22], { invoiceRefs: ['F-2'] })], [z.id, pv([23], { invoiceRefs: ['F-3'] })]]);
    const u = computeTco(entree({ assetPrice: prix(49_000_000), operations: [o], componentProvenance: distinctes }));
    expect(u.summary.cumulativeCostCents).toBe(49_000_000 + 240_000);
    expect(u.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    // Provenance non lue (entrée antérieure) : comportement inchangé (aucune présomption).
    expect(computeTco(entree({ assetPrice: prix(49_000_000), operations: [o] })).summary.cumulativeCostCents).toBe(49_000_000 + 240_000);
  });
});

// ═══ §7 — cas du ticket ═════════════════════════════════════════════════════

describe('L78B-§7 — chaises, maison, taxe foncière, prévisionnel / réalisé, prix non multiplié', () => {
  it('L78B-01 — Opération #76 (mobilier 277,35 € + 3 × 490 000 €) : maison 490 000 € une fois, chaises hors TCO immobilier, chaque montant rattaché à SON justificatif', () => {
    const { o, chaises, acte, attestation, copie, provenance } = operation76();
    const t = computeTco(entree({ assetPrice: prix(49_000_000, { evidenceFileIds: [ACTE] }), operations: [o], componentProvenance: provenance }));
    expect(t.summary).toMatchObject({ cumulativeCostCents: 49_000_000, acquisitionCents: 49_000_000, additionalCostsCents: 0, acquisitionStatus: 'DOCUMENTED' });
    // Le prix de la maison est porté par l'acte (jamais par la commande de mobilier).
    expect(ligneC(t, acte.id)).toMatchObject({ status: 'RETAINED_CONSOLIDATED', category: 'ACQUISITION', includedCents: 49_000_000, fileId: ACTE, sourceFileIds: [ACTE] });
    for (const c of [attestation, copie]) expect(ligneC(t, c.id)).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_FACT_OTHER_DOCUMENT', duplicateOf: `c:${acte.id}`, relatedFileId: ACTE });
    // La commande de mobilier : transaction indépendante, non incorporée au coût de possession de la maison.
    expect(ligneC(t, chaises.id)).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_OWNERSHIP_COST', includedCents: 0, fileId: COMMANDE, eurCents: 27_735 });
    expect(t.lines.find((l) => l.source === 'ASSET_DATA')).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE', operationId: 76 });
    expect(t.reliability.warnings).toEqual(expect.arrayContaining(['PRESUMED_DUPLICATES', 'NOT_OWNERSHIP_COSTS']));
    coherent(t);
    // Sans preuve T1 du prix : identification par montant ET date de la COMPOSANTE (l'Opération mêlée n'a pas le montant du prix).
    const sansPreuve = computeTco(entree({ assetPrice: prix(49_000_000), operations: [o], componentProvenance: provenance }));
    expect(sansPreuve.summary).toMatchObject({ cumulativeCostCents: 49_000_000, acquisitionCents: 49_000_000 });
    expect(ligneC(sansPreuve, chaises.id)).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_OWNERSHIP_COST' });
  });

  it('L78B-02 — le prix de la maison ne devient jamais un coût de la commande : TCO du bien « Chaises » (preuve du prix d’un autre bien)', () => {
    const { o, chaises, acte, attestation, copie, provenance } = operation76();
    const autre = new Map(provenance);
    for (const c of [acte, attestation, copie]) autre.set(c.id, { ...provenance.get(c.id)!, otherAssetAcquisition: c === acte });
    const t = computeTco(entree({
      assetId: CHAISES, assetCategory: 'OBJET', assetAcquisitionDate: '2021-06-03', assetPrice: prix(27_735, { evidenceFileIds: [COMMANDE] }),
      operations: [{ ...o, assetIds: [CHAISES] }], componentProvenance: autre,
    }));
    expect(t.summary).toMatchObject({ cumulativeCostCents: 27_735, acquisitionCents: 27_735 });
    expect(ligneC(t, chaises.id)).toMatchObject({ status: 'RETAINED_CONSOLIDATED', category: 'ACQUISITION', fileId: COMMANDE });
    expect(ligneC(t, acte.id)).toMatchObject({ status: 'OUT_OF_SCOPE', reason: 'COUNTED_FOR_OTHER_ASSET', includedCents: 0 });
    // Les autres copies du même prix (doublons présumés de l'acte) ne sont pas comptées non plus.
    for (const c of [attestation, copie]) expect(ligneC(t, c.id).includedCents).toBe(0);
    // Quelle que soit la copie qui porte la preuve de l'autre bien, aucune copie du prix n'est comptée ici.
    const inverse = new Map(provenance);
    inverse.set(copie.id, { ...provenance.get(copie.id)!, otherAssetAcquisition: true });
    const v = computeTco(entree({
      assetId: CHAISES, assetCategory: 'OBJET', assetAcquisitionDate: '2021-06-03', assetPrice: prix(27_735, { evidenceFileIds: [COMMANDE] }),
      operations: [{ ...o, assetIds: [CHAISES] }], componentProvenance: inverse,
    }));
    expect(v.summary.cumulativeCostCents).toBe(27_735);
    // Masquées sur la fiche (autre bien), visibles au diagnostic BO.
    expect(toTcoDto(t).lines.some((l) => l.id === `c:${acte.id}`)).toBe(false);
    coherent(t);
  });

  it('L78B-03 — achat de chaises rattaché à la maison (Opération distincte, justificatif seul) : non incorporé ; équipement ou rattachement utilisateur : inclus ; bien mobile : accessoire compté', () => {
    const c = comp('REALIZED_COST', 27_735, { economicDate: '2021-06-03' });
    const achat = op(80, 'ACQUISITION', [c], { realizedDate: '2021-06-03', documents: [{ fileId: COMMANDE, title: 'Commande', role: 'INVOICE' }] });
    const base = entree({ assetPrice: prix(49_000_000) });
    const t = computeTco({ ...base, operations: [achat] });
    expect(t.summary.cumulativeCostCents).toBe(49_000_000);
    expect(ligneC(t, c.id)).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_OWNERSHIP_COST', category: null });
    expect(t.reliability.warnings).toContain('NOT_OWNERSHIP_COSTS');
    expect(t.status).toBe('COMPLETE'); // décision, pas une information manquante
    expect(computeTco({ ...base, operations: [{ ...achat, userLinked: true }] }).summary.cumulativeCostCents).toBe(49_027_735);
    expect(computeTco({ ...base, operations: [{ ...achat, equipmentLinked: true }] }).summary.cumulativeCostCents).toBe(49_027_735);
    // Justificatif seul (T3 en attente) : même règle.
    const d = computeTco({ ...base, documents: [doc(COMMANDE, 27_735, { date: '2021-06-03' })] });
    expect(d.summary.cumulativeCostCents).toBe(49_000_000);
    expect(ligneD(d, COMMANDE)[0]).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_OWNERSHIP_COST', includedCents: 0 });
    // Frais d'acquisition (portée FEE) : coût de l'acquisition, toujours comptés.
    const frais = computeTco({ ...base, documents: [doc(30, 750_000, {}, { hints: [hint('REALIZED_COST', 750_000, { amountScope: 'FEE' })] })] });
    expect(frais.summary.cumulativeCostCents).toBe(49_750_000);
    // Bien mobile : un achat qui le cible est un accessoire qui le suit (lots 61 / 75D inchangés).
    const v = computeTco(entree({ assetId: VOITURE, assetCategory: 'VEHICULE', assetPrice: prix(2_000_000), operations: [{ ...achat, assetIds: [VOITURE] }] }));
    expect(v.summary.cumulativeCostCents).toBe(2_027_735);
    expect(ligneC(v, c.id)).toMatchObject({ status: 'RETAINED_CONSOLIDATED', category: 'ACCESSORIES' });
    expect(purchaseIsOwnershipCost({ assetCategory: 'IMMOBILIER', concernsEquipment: false })).toBe(false);
    expect(purchaseIsOwnershipCost({ assetCategory: 'OBJET', concernsEquipment: false })).toBe(true);
  });

  it('L78B-04 — taxe foncière : charge récurrente retenue dans le TCO de la maison (chaque année), sans confusion avec l’achat de chaises', () => {
    const taxe = (fileId: number, annee: number) => doc(fileId, 123_400, { typeCode: 'PROPERTY_TAX_NOTICE', date: `${annee}-10-15`, title: `Taxe foncière ${annee}` },
      { typeHint: 'OTHER', sourceRole: 'INVOICE', hints: [hint('REALIZED_COST', 123_400, { economicDate: `${annee}-10-15`, periodStart: `${annee}-01-01`, periodEnd: `${annee}-12-31` })] });
    const t = computeTco(entree({ assetPrice: prix(49_000_000), documents: [taxe(41, 2024), taxe(42, 2025), doc(COMMANDE, 27_735, { date: '2021-06-03' })] }));
    expect(t.summary.cumulativeCostCents).toBe(49_000_000 + 2 * 123_400);
    for (const f of [41, 42]) expect(ligneD(t, f)[0]).toMatchObject({ status: 'RETAINED_DIRECT', includedCents: 123_400 });
    expect(ligneD(t, COMMANDE)[0]).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_OWNERSHIP_COST' });
    expect(t.annual.years.find((y) => y.year === 2024)).toMatchObject({ costsCents: 123_400, count: 1 });
    expect(t.annual.years.find((y) => y.year === 2025)).toMatchObject({ costsCents: 123_400, count: 1 });
    coherent(t);
    // Consolidée par T3 dans une même dépense : deux avis de même montant, périodes différentes → deux échéances, jamais un doublon.
    const [c24, c25] = [comp('REALIZED_COST', 123_400, { economicDate: '2024-10-15', periodStart: '2024-01-01', periodEnd: '2024-12-31' }),
      comp('REALIZED_COST', 123_400, { economicDate: '2025-10-15', periodStart: '2025-01-01', periodEnd: '2025-12-31' })];
    const o = op(90, 'OTHER', [c24, c25], { realizedDate: '2025-10-15' });
    const u = computeTco(entree({ assetPrice: prix(49_000_000), operations: [o], componentProvenance: new Map([[c24.id, pv([41])], [c25.id, pv([42])]]) }));
    expect(u.summary.cumulativeCostCents).toBe(49_000_000 + 2 * 123_400);
    expect(u.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    expect(u.reliability.warnings).not.toContain('NOT_OWNERSHIP_COSTS');
    // Relation récurrente (contrat) sans période lue : échéances datées différemment, distinctes aussi.
    const [e1, e2] = [comp('REALIZED_COST', 4_500, { economicDate: '2026-01-05' }), comp('REALIZED_COST', 4_500, { economicDate: '2026-02-05' })];
    const contrat = op(91, 'CONTRACT', [e1, e2], { realizedDate: null, startDate: '2026-01-01' });
    expect(computeTco(entree({ assetPrice: prix(49_000_000), operations: [contrat], componentProvenance: new Map([[e1.id, pv([43])], [e2.id, pv([44])]]) })).summary.cumulativeCostCents).toBe(49_009_000);
  });

  it('L78B-05 — prévisionnel et réalisé : devis et facture de même montant comptés une fois ; échéance future non anticipée ; dépense réalisée datée future exclue (81D)', () => {
    const devis = comp('FORECAST_COST', 150_000, { economicDate: '2026-03-01' });
    const facture = comp('REALIZED_COST', 150_000, { economicDate: '2026-04-01' });
    const o = op(60, 'INTERVENTION', [devis, facture], { realizedDate: '2026-04-01' });
    const t = computeTco(entree({ assetPrice: prix(49_000_000), operations: [o], componentProvenance: new Map([[devis.id, pv([51])], [facture.id, pv([52])]]) }));
    expect(t.summary.cumulativeCostCents).toBe(49_150_000);
    expect(ligneC(t, devis.id)).toMatchObject({ status: 'FORECAST', includedCents: 0 });
    expect(ligneC(t, facture.id)).toMatchObject({ status: 'RETAINED_CONSOLIDATED', includedCents: 150_000 });
    expect(t.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    // Justificatifs seuls : devis (prévision) + facture → +1 500 € une fois ; échéance future d'un contrat : jamais anticipée.
    const d = computeTco(entree({
      assetPrice: prix(49_000_000), documents: [
        doc(53, 150_000, { typeCode: 'WORKS_QUOTE' }, { typeHint: 'INTERVENTION', sourceRole: 'QUOTE', hints: [hint('FORECAST_COST', 150_000)] }),
        doc(54, 150_000, { typeCode: 'WORKS_INVOICE' }, { typeHint: 'INTERVENTION' }),
        doc(55, 9_000, { typeCode: 'INSURANCE_DUE_NOTICE' }, { typeHint: 'CONTRACT', hints: [hint('REALIZED_COST', 9_000, { amountScope: 'INSTALLMENT', economicDate: '2027-01-05' })] }),
      ],
    }));
    expect(d.summary.cumulativeCostCents).toBe(49_150_000);
    expect(ligneD(d, 55)[0]).toMatchObject({ status: 'FORECAST', reason: 'FUTURE_INSTALLMENT' });
    // Lot 81D (le ticket du 22/10 prime sur la décision PO 76G) : une dépense datée après la date de référence n'est pas
    // réalisée — exclue du TCO total, de la moyenne et de toute année, conservée avec son motif et signalée.
    const futur = comp('REALIZED_COST', 20_000, { economicDate: '2026-12-01' });
    const f = computeTco(entree({ assetPrice: prix(49_000_000), operations: [op(61, 'INTERVENTION', [futur], { realizedDate: '2026-12-01' })], componentProvenance: new Map([[futur.id, pv([56])]]) }));
    expect(f.summary.cumulativeCostCents).toBe(49_000_000);
    expect(f.annual.notRealized).toMatchObject({ count: 1, costsCents: 20_000 });
    expect(f.reliability.warnings).toEqual(expect.arrayContaining(['NOT_REALIZED_EXPENSES', 'STATUS_CONTRADICTIONS']));
    coherent(f);
  });

  it('L78B-06 — plusieurs justificatifs d’un seul achat immobilier, sans Opération ni prix dans la fiche : prix compté une fois (jamais × 3)', () => {
    const acte = (f: number, date: string) => doc(f, 49_000_000, { date, typeCode: 'ACQUISITION_INVOICE' });
    const t = computeTco(entree({ assetAcquisitionDate: null, documents: [acte(ACTE, '2007-05-14'), acte(ATTESTATION, '2021-02-01'), acte(COPIE, '2007-05-14')] }));
    expect(t.summary).toMatchObject({ cumulativeCostCents: 49_000_000, acquisitionCents: 49_000_000 });
    expect(ligneD(t, ACTE)[0]).toMatchObject({ status: 'RETAINED_DIRECT', category: 'ACQUISITION' });
    for (const f of [ATTESTATION, COPIE]) expect(ligneD(t, f)[0]).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_FACT_OTHER_DOCUMENT', relatedFileId: ACTE, includedCents: 0 });
    expect(t.reliability.warnings).toContain('PRESUMED_DUPLICATES');
    expect(t.reliability.warnings).not.toContain('ACQUISITION_AMBIGUOUS');
    coherent(t);
    // Avec le prix de la fiche (sans preuve) : une copie datée autrement n'est jamais un « accessoire » de 490 000 €.
    const p = computeTco(entree({ assetPrice: prix(49_000_000), documents: [acte(ACTE, '2007-05-14'), acte(ATTESTATION, '2021-02-01')] }));
    expect(p.summary.cumulativeCostCents).toBe(49_000_000);
    expect(ligneD(p, ATTESTATION)[0]).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_OWNERSHIP_COST', note: expect.stringContaining('Même montant que l’achat du bien') });
    // Factures numérotées différemment : l'ambiguïté reste signalée, rien n'est fusionné.
    const refs = computeTco(entree({ assetAcquisitionDate: null, documents: [
      doc(ACTE, 49_000_000, {}, { references: [{ kind: 'INVOICE', value: 'A-1' }] }), doc(ATTESTATION, 49_000_000, {}, { references: [{ kind: 'INVOICE', value: 'B-2' }] })] }));
    expect(refs.reliability.warnings).toContain('ACQUISITION_AMBIGUOUS');
    // Bien mobile : deux factures de même montant restent deux achats (règle PO TCO-21 inchangée).
    const obj = computeTco(entree({ assetCategory: 'OBJET', assetAcquisitionDate: null, documents: [doc(ACTE, 45_00), doc(ATTESTATION, 45_00)] }));
    expect(obj.summary.cumulativeCostCents).toBe(9_000);
  });

  it('L78B-07 — règle PO « deux dépenses de même montant sans date » inchangée : comptées, ambiguïté signalée (TCO-R-02c)', () => {
    const t = computeTco(entree({ assetCategory: 'OBJET', assetPrice: prix(30_000), assetAcquisitionDate: null, documents: [doc(61, 30_000, { date: null })] }));
    expect(t.summary.cumulativeCostCents).toBe(60_000);
    expect(ligneD(t, 61)[0]).toMatchObject({ status: 'RETAINED_DIRECT', uncertain: true });
    expect(t.reliability.warnings).toContain('UNCERTAIN_MATCHES');
  });
});

// ═══ §3A — attribution : un montant vient de SES justificatifs ══════════════

describe('L78B-A — attribution des composantes', () => {
  it('L78B-A01 — montant introuvable sur ses justificatifs, ou justificatif retiré : compté, signalé, total non exhaustif', () => {
    expect(unjustifiedComponent(pv([1], { explained: false }))).toBe('AMOUNT_NOT_ON_SOURCES');
    expect(unjustifiedComponent(pv([], { withdrawnFileIds: [1] }))).toBe('SOURCES_WITHDRAWN');
    expect(unjustifiedComponent(pv([], { withdrawnFileIds: [1], otherSourceKinds: ['USER'] }))).toBeNull();
    expect(unjustifiedComponent(pv([]))).toBeNull(); // composante sans source (saisie, migration) : non concernée
    expect(unjustifiedComponent(undefined)).toBeNull();
    const c = comp('REALIZED_COST', 12_000, { economicDate: '2026-03-01' });
    const o = op(70, 'INTERVENTION', [c], { realizedDate: '2026-03-01' });
    const t = computeTco(entree({ assetPrice: prix(49_000_000), operations: [o], componentProvenance: new Map([[c.id, pv([71], { explained: false })]]) }));
    expect(t.summary.cumulativeCostCents).toBe(49_012_000);
    expect(ligneC(t, c.id)).toMatchObject({ status: 'RETAINED_CONSOLIDATED', uncertain: true, note: expect.stringMatching(/justificatif/) });
    expect(t.reliability.warnings).toContain('UNJUSTIFIED_AMOUNTS');
    expect(t.status).toBe('INCOMPLETE');
    // Justificatif retiré de la dépense : le montant n'est plus attribué par elle ; le justificatif est réévalué seul (compté une fois).
    const retire = computeTco(entree({
      assetPrice: prix(49_000_000), operations: [o], componentProvenance: new Map([[c.id, pv([], { withdrawnFileIds: [71] })]]),
      documents: [doc(71, 12_000, { typeCode: 'REPAIR_INVOICE', date: '2026-03-01' }, { typeHint: 'INTERVENTION' })],
    }));
    expect(retire.summary.cumulativeCostCents).toBe(49_012_000);
    expect(ligneC(retire, c.id)).toMatchObject({ status: 'EXCLUDED', reason: 'SOURCE_WITHDRAWN', includedCents: 0, relatedFileId: 71 });
    expect(ligneD(retire, 71)[0]).toMatchObject({ status: 'RETAINED_DIRECT', includedCents: 12_000 });
    expect(retire.status).toBe('INCOMPLETE');
    coherent(retire);
    expect(computeTco(entree({ assetPrice: prix(49_000_000), operations: [o], componentProvenance: new Map([[c.id, pv([71])]]) })).status).toBe('COMPLETE');
  });

  it('L78B-A02 — sans prix dans la fiche, deux achats consolidés distincts : ambiguïté signalée (jamais un total présenté comme complet)', () => {
    const maison = op(81, 'ACQUISITION', [comp('REALIZED_COST', 49_000_000)]);
    const chaises = op(82, 'ACQUISITION', [comp('REALIZED_COST', 27_735)], { realizedDate: '2021-06-03' });
    const t = computeTco(entree({ operations: [maison, chaises] }));
    expect(t.reliability.warnings).toContain('ACQUISITION_AMBIGUOUS');
    expect(t.status).toBe('INCOMPLETE');
    expect(computeTco(entree({ operations: [maison] })).reliability.warnings).not.toContain('ACQUISITION_AMBIGUOUS');
  });

  it('L78B-A03 — reconsolidations répétées : même entrée, même résultat (calcul pur, idempotent)', () => {
    const { o, provenance } = operation76();
    const e = entree({ assetPrice: prix(49_000_000, { evidenceFileIds: [ACTE] }), operations: [o], componentProvenance: provenance });
    expect(JSON.stringify(computeTco(e))).toBe(JSON.stringify(computeTco(e)));
  });
});
