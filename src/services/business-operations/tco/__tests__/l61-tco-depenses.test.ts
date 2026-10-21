/**
 * Lot 61 — ticket P1 « TCO — intégration de toutes les dépenses,
 * consolidation anti-double comptage et tiroir dédié » : recette §7
 * (TCO-01 à TCO-17) et compléments (transitions document seul → Opération,
 * corrections, doublons, avoirs, réattribution, données incomplètes).
 * Tests PURS (aucune base) ; le cœur est rejoué sur PostgreSQL 16 réel :
 * `src/test/e2e/scenarios/l61-tco-depenses.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, type TcoAssetPrice, type TcoInput, type TcoOperation } from '../model';
import { toTcoDto } from '../dto';
import { qualifyDocumentLines, type EconomicDocumentCandidate, type EconomicDocumentInput, type EconomicHint } from '../../finance/economic-lines';
import { dedupePossibleMerges } from '@/services/verebona-assistant/canonical/expense-classes';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

const VELO = 7;
const AUTRE = 8;
const TODAY = '2026-10-15';
let seq = 1000;

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
const comp = (kind: FinancialComponentKind, eur: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: eur, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', parentOperationId: null, realizedDate: '2026-06-01', startDate: null, plannedDate: null,
  assetIds: [VELO], label: typeCode, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const prix300: TcoAssetPrice = { amountMinor: 30_000, currency: 'EUR', origin: 'USER', evidenceFileIds: [] };
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: VELO, today: TODAY, operations: [], assetAcquisitionDate: null, assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: null, ...o,
});
/** Facture qualifiée sans Opération (indice T1 coût réalisé total). */
const facture = (fileId: number, cents: number, o: Partial<EconomicDocumentInput> = {}) =>
  doc(fileId, { amountCents: cents, candidates: [cand([hint('REALIZED_COST', cents)], { typeHint: 'ACQUISITION' })], ...o });
const ligne = (t: ReturnType<typeof computeTco>, fileId: number) => t.lines.filter((l) => l.fileId === fileId && l.source === 'DOCUMENT');

const BEQUILLE = 101;
const ANTIVOL = 102;

// ═══ Recette §7 ═════════════════════════════════════════════════════════════

describe('TCO — recette obligatoire (§7)', () => {
  it('TCO-01 — vélo acheté 300 €, prix saisi dans la fiche, sans opération consolidée → 300 € comptabilisés (sans date d’achat)', () => {
    const t = computeTco(entree({ assetPrice: prix300 }));
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    expect(t.summary.acquisitionCents).toBe(30_000);
    expect(t.breakdown).toEqual([expect.objectContaining({ category: 'ACQUISITION', costsCents: 30_000, count: 1 })]);
    expect(t.lines).toEqual([expect.objectContaining({ id: `asset:${VELO}:acquisitionPrice`, source: 'ASSET_DATA', provenance: 'USER', status: 'RETAINED_DIRECT', includedCents: 30_000 })]);
    // L'absence de date d'acquisition n'empêche pas de compter (§3.5) : seule la période est signalée.
    expect(t.reliability.warnings).toContain('ACQUISITION_DATE_MISSING');
    expect(t.reliability.warnings).not.toContain('ACQUISITION_COST_MISSING');
  });

  it('TCO-02 — facture de béquille 25 €, sans opération → TCO à 325 €', () => {
    const t = computeTco(entree({ assetPrice: prix300, documents: [facture(BEQUILLE, 2_500)] }));
    expect(t.summary.cumulativeCostCents).toBe(32_500);
    expect(t.summary.additionalCostsCents).toBe(2_500);
    expect(ligne(t, BEQUILLE)).toEqual([expect.objectContaining({ status: 'RETAINED_DIRECT', category: 'ACCESSORIES', includedCents: 2_500, provenance: 'T1', operationId: null })]);
    expect(t.reliability.documentsCounted).toBe(1);
    expect(t.reliability.documents.map((d) => d.fileId)).toContain(BEQUILLE);
  });

  it('TCO-03 — facture d’antivol 35 €, sans opération → TCO à 360 €', () => {
    const t = computeTco(entree({ assetPrice: prix300, documents: [facture(BEQUILLE, 2_500), facture(ANTIVOL, 3_500)] }));
    expect(t.summary.cumulativeCostCents).toBe(36_000);
    expect(t.breakdown.find((b) => b.category === 'ACCESSORIES')).toMatchObject({ costsCents: 6_000, count: 2 });
    expect(t.status).toBe('INCOMPLETE'); // date d'acquisition seule absente (période), total exact
  });

  it('TCO-04 — devis de réparation 150 €, puis facture 180 € → +180 € uniquement (devis = prévision)', () => {
    const devis = doc(201, { typeCode: 'REPAIR_QUOTE', amountCents: 15_000, candidates: [cand([hint('FORECAST_COST', 15_000)])] });
    const fact = doc(202, { typeCode: 'REPAIR_INVOICE', amountCents: 18_000, candidates: [cand([hint('REALIZED_COST', 18_000)])] });
    const t = computeTco(entree({ assetPrice: prix300, documents: [devis, fact] }));
    expect(t.summary.cumulativeCostCents).toBe(48_000);
    expect(ligne(t, 201)[0]).toMatchObject({ status: 'FORECAST', includedCents: 0 });
    expect(ligne(t, 202)[0]).toMatchObject({ status: 'RETAINED_DIRECT', category: 'MAINTENANCE' });
    // Devis seul, sans hint (document ancien) : prévision aussi.
    const t2 = computeTco(entree({ documents: [doc(203, { typeCode: 'REPAIR_QUOTE', amountCents: 15_000 })] }));
    expect(t2.summary.cumulativeCostCents).toBe(0);
    expect(ligne(t2, 203)[0].status).toBe('FORECAST');
  });

  it('TCO-05 — facture comptée directement, puis reprise par T3 → total inchangé (une seule fois, via la composante)', () => {
    const avant = computeTco(entree({ assetPrice: prix300, documents: [facture(BEQUILLE, 2_500)] }));
    const reprise = op(50, 'ACQUISITION', [comp('REALIZED_COST', 2_500, { targetAssetId: VELO })], { documents: [{ fileId: BEQUILLE, title: 'Béquille', role: 'INVOICE' }] });
    const apres = computeTco(entree({
      assetPrice: prix300, operations: [reprise],
      documents: [facture(BEQUILLE, 2_500, { operations: [{ operationId: 50, label: 'Achat — béquille', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: true }] })],
    }));
    expect(apres.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents);
    expect(apres.summary.cumulativeCostCents).toBe(32_500);
    expect(ligne(apres, BEQUILLE)[0]).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE', reason: 'COVERED_BY_OPERATION', operationId: 50 });
    expect(apres.lines.find((l) => l.source === 'OPERATION')).toMatchObject({ status: 'RETAINED_CONSOLIDATED', includedCents: 2_500, category: 'ACCESSORIES' });
    // Le prix de la fiche n'est pas masqué par l'achat d'un accessoire.
    expect(apres.summary.acquisitionCents).toBe(30_000);
  });

  it('TCO-06 — facture liée à une opération sans coût consolidé exploitable → facture qualifiée non perdue', () => {
    const vide = op(60, 'INTERVENTION', [comp('FORECAST_COST', 15_000)], { status: 'REALIZED' });
    const t = computeTco(entree({
      operations: [vide],
      documents: [doc(601, { typeCode: 'REPAIR_INVOICE', amountCents: 18_000, candidates: [cand([hint('REALIZED_COST', 18_000)])],
        operations: [{ operationId: 60, label: 'Intervention — frein', inScope: true, cancelled: false, hasAssets: true, exploitable: false, citesDocument: false }] })],
    }));
    expect(t.summary.cumulativeCostCents).toBe(18_000);
    expect(ligne(t, 601)[0]).toMatchObject({ status: 'RETAINED_DIRECT', operationId: 60, note: expect.stringContaining('sans montant consolidé') });
  });

  it('TCO-07 — facture en double (même empreinte, sans signalement) → comptée une seule fois', () => {
    const a = facture(701, 4_000, { hash: 'same' });
    const b = facture(702, 4_000, { hash: 'same' });
    const t = computeTco(entree({ documents: [a, b] }));
    expect(t.summary.cumulativeCostCents).toBe(4_000);
    expect(ligne(t, 702)[0]).toMatchObject({ status: 'DUPLICATE', reason: 'DUPLICATE_COPY' });
    // Même référence de facture et même montant, empreintes différentes (deux scans) : une fois.
    const r = [{ kind: 'INVOICE', value: 'F-2026-12' }];
    const c = doc(703, { hash: 'x', candidates: [cand([hint('REALIZED_COST', 9_900)], { references: r, provider: 'Cycles Martin' })] });
    const d = doc(704, { hash: 'y', candidates: [cand([hint('REALIZED_COST', 9_900)], { references: [{ kind: 'INVOICE', value: 'f 2026/12' }], provider: 'CYCLES MARTIN' })] });
    const t2 = computeTco(entree({ documents: [c, d] }));
    expect(t2.summary.cumulativeCostCents).toBe(9_900);
    expect(ligne(t2, 704)[0]).toMatchObject({ status: 'DUPLICATE', reason: 'DUPLICATE_REFERENCE', relatedFileId: 703 });
  });

  it('TCO-08 — facture totale 200 € + acompte 50 € + solde 150 € → coût de 200 € uniquement', () => {
    const p = { provider: 'Atelier Vélo' };
    const total = doc(801, { title: 'Facture', candidates: [cand([hint('REALIZED_COST', 20_000)], p)] });
    const acompte = doc(802, { title: 'Facture d’acompte', candidates: [cand([hint('REALIZED_COST', 5_000, { amountScope: 'DEPOSIT' })], p)] });
    const solde = doc(803, { title: 'Facture de solde', candidates: [cand([hint('REALIZED_COST', 15_000, { amountScope: 'BALANCE' })], p)] });
    const t = computeTco(entree({ documents: [total, acompte, solde] }));
    expect(t.summary.cumulativeCostCents).toBe(20_000);
    expect(ligne(t, 802)[0]).toMatchObject({ status: 'INCLUDED_IN_TOTAL', reason: 'INCLUDED_IN_TOTAL_INVOICE', relatedFileId: 801 });
    expect(ligne(t, 803)[0]).toMatchObject({ status: 'INCLUDED_IN_TOTAL', relatedFileId: 801 });
    // Sans fournisseur ni référence : la somme EXACTE des parts (même bien) suffit.
    const t2 = computeTco(entree({ documents: [doc(811, { candidates: [cand([hint('REALIZED_COST', 20_000)])] }),
      doc(812, { candidates: [cand([hint('REALIZED_COST', 5_000, { amountScope: 'DEPOSIT' })])] }),
      doc(813, { candidates: [cand([hint('REALIZED_COST', 15_000, { amountScope: 'BALANCE' })])] })] }));
    expect(t2.summary.cumulativeCostCents).toBe(20_000);
    // Acompte + solde sans facture totale : 50 + 150 = 200.
    const t3 = computeTco(entree({ documents: [acompte, solde] }));
    expect(t3.summary.cumulativeCostCents).toBe(20_000);
    // Même document : total 200 et acompte déjà versé 50 → 200.
    const t4 = computeTco(entree({ documents: [doc(820, { candidates: [cand([hint('REALIZED_COST', 20_000), hint('REALIZED_COST', 5_000, { amountScope: 'DEPOSIT' })])] })] }));
    expect(t4.summary.cumulativeCostCents).toBe(20_000);
    expect(t4.lines.find((l) => l.status === 'INCLUDED_IN_TOTAL')?.reason).toBe('INCLUDED_IN_TOTAL_SAME_DOCUMENT');
  });

  it('TCO-09 — facture 100 € + avoir 20 € → coût net de 80 € (avoir lu par T1, et avoir ancien reconnu au titre)', () => {
    const t = computeTco(entree({ documents: [
      doc(901, { typeCode: 'REPAIR_INVOICE', candidates: [cand([hint('REALIZED_COST', 10_000)])] }),
      doc(902, { typeCode: 'REPAIR_INVOICE', candidates: [cand([hint('REDUCTION', 2_000)], { sourceRole: 'CREDIT_NOTE' })] }),
    ] }));
    expect(t.summary.cumulativeCostCents).toBe(8_000);
    expect(t.reductionsCents).toBe(2_000);
    const ancien = computeTco(entree({ documents: [
      doc(903, { typeCode: 'REPAIR_INVOICE', amountCents: 10_000 }),
      doc(904, { typeCode: 'REPAIR_INVOICE', title: 'Avoir n° 12 sur facture', amountCents: 2_000 }),
    ] }));
    expect(ancien.summary.cumulativeCostCents).toBe(8_000);
  });

  it('TCO-10 — contrat avec échéances futures non facturées → pas de cumul anticipé de toutes les échéances', () => {
    const echeances = [1, 2, 3, 4].map((m) => hint('REALIZED_COST', 3_000, { amountScope: 'INSTALLMENT', economicDate: `2026-${String(8 + m).padStart(2, '0')}-05` }));
    // 09-05 et 10-05 passées (≤ 15/10) ; 11-05 et 12-05 futures.
    const t = computeTco(entree({ documents: [doc(1001, { typeCode: 'INSURANCE_DUE_NOTICE', candidates: [cand(echeances, { typeHint: 'CONTRACT' })] })] }));
    expect(t.summary.cumulativeCostCents).toBe(6_000);
    expect(t.lines.filter((l) => l.status === 'FORECAST' && l.reason === 'FUTURE_INSTALLMENT')).toHaveLength(2);
    expect(t.breakdown.find((b) => b.category === 'CONTRACTS')?.costsCents).toBe(6_000);
  });

  it('TCO-11 — facture concernant deux biens sans ventilation → aucune imputation arbitraire, montant signalé non attribué', () => {
    const t = computeTco(entree({ assetPrice: prix300, documents: [doc(1101, { typeCode: 'REPAIR_INVOICE', linkedAssetIds: [VELO, AUTRE], candidates: [cand([hint('REALIZED_COST', 12_000)], { targets: [] })] })] }));
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    expect(ligne(t, 1101)[0]).toMatchObject({ status: 'UNALLOCATED', includedCents: 0 });
    expect(t.reliability.unallocated).toEqual({ count: 1, eurCents: 12_000 });
    expect(t.status).toBe('INCOMPLETE');
    // Ventilée par T1 (cible = ce bien) : comptée pour ce bien seulement.
    const v = computeTco(entree({ documents: [doc(1102, { linkedAssetIds: [VELO, AUTRE], candidates: [cand([hint('REALIZED_COST', 4_000)], { targets: [{ type: 'ASSET', entityId: VELO }] }), cand([hint('REALIZED_COST', 8_000)], { targets: [{ type: 'ASSET', entityId: AUTRE }] })] })] }));
    expect(v.summary.cumulativeCostCents).toBe(4_000);
    // T1 a vu plusieurs biens, un seul lien : non attribué non plus.
    const m = computeTco(entree({ documents: [doc(1103, { multiAsset: true, candidates: [cand([hint('REALIZED_COST', 5_000)], { targets: [] })] })] }));
    expect(m.summary.cumulativeCostCents).toBe(0);
    expect(ligne(m, 1103)[0].status).toBe('UNALLOCATED');
  });

  it('TCO-12 — facture déplacée vers un autre bien : recalcul correct des deux biens (lecture des liens persistés)', () => {
    const f = (assets: number[]) => facture(1201, 2_500, { linkedAssetIds: assets, candidates: [cand([hint('REALIZED_COST', 2_500)], { targets: [] })] });
    expect(computeTco(entree({ documents: [f([VELO])] })).summary.cumulativeCostCents).toBe(2_500);
    // Déplacée : le vélo ne la lit plus ; l'autre bien la lit.
    expect(computeTco(entree({ documents: [] })).summary.cumulativeCostCents).toBe(0);
    expect(computeTco(entree({ assetId: AUTRE, documents: [f([AUTRE])] })).summary.cumulativeCostCents).toBe(2_500);
    // Cible T1 périmée (ancien bien) : la cible prime → hors de ce bien, motif visible.
    const perimee = computeTco(entree({ assetId: AUTRE, documents: [facture(1202, 2_500, { linkedAssetIds: [AUTRE] })] }));
    expect(ligne(perimee, 1202)[0]).toMatchObject({ status: 'OUT_OF_SCOPE' });
  });

  it('TCO-13 — T3 en attente ou en erreur → dépenses documentaires qualifiées conservées', () => {
    for (const t3Outcome of ['HOLD_UNRESOLVED', 'ARBITRATION_REQUIRED', null]) {
      const t = computeTco(entree({ documents: [doc(1301, { candidates: [cand([hint('REALIZED_COST', 4_200)], { t3Outcome })] })] }));
      expect(t.summary.cumulativeCostCents).toBe(4_200);
    }
  });

  it('TCO-14 — montant en devise non convertible → exclu du total EUR, motif visible', () => {
    const t = computeTco(entree({ documents: [doc(1401, { candidates: [cand([hint('REALIZED_COST', 10_000, { currency: 'CHF' })])] }), facture(1402, 1_000)] }));
    expect(t.summary.cumulativeCostCents).toBe(1_000);
    expect(ligne(t, 1401)[0]).toMatchObject({ status: 'UNCONVERTED', reason: 'UNCONVERTED_CURRENCY', eurCents: null });
    expect(t.reliability.unconverted).toEqual([{ currency: 'CHF', amountMinor: 10_000, kind: 'REALIZED_COST' }]);
    expect(t.reliability.warnings).toContain('UNCONVERTED_AMOUNTS');
    const dto = toTcoDto(t);
    expect(dto.lineReasonLabels.UNCONVERTED_CURRENCY).toMatch(/devise/i);
    // Contre-valeur EUR écrite : comptée.
    const ok = computeTco(entree({ documents: [doc(1403, { candidates: [cand([hint('REALIZED_COST', 10_000, { currency: 'CHF', amountEurMinor: 10_400 })])] })] }));
    expect(ok.summary.cumulativeCostCents).toBe(10_400);
  });

  it('TCO-15 — relecture du TCO et réponse T2 sur les mêmes dépenses → montants cohérents (T2 lit le service TCO)', async () => {
    const t = computeTco(entree({ assetPrice: prix300, documents: [facture(BEQUILLE, 2_500), facture(ANTIVOL, 3_500)] }));
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const r = ownershipCostAnswer({ id: VELO, name: 'Vélo' } as never, t) as { answer: string; sources: Array<{ meta?: Record<string, unknown> }> };
    expect(r.answer).toContain('360,00');
    expect(r.sources[0].meta).toMatchObject({ cumulativeCostCents: 36_000 });
    expect(String(r.sources[0].meta?.includedDocuments)).toContain(`doc-${BEQUILLE}`);
    // Les dépenses complémentaires = total documentaire T2 (mêmes justificatifs, même dédoublonnage).
    expect(t.summary.additionalCostsCents).toBe(6_000);
  });

  it('TCO-16 — tiroir autonome « Coût total de possession », hors « Valorisation », desktop et mobile (même composant)', () => {
    const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
    const tab = lire('src/components/assets/AssetDetailsTab.tsx');
    const section = lire('src/components/assets/TcoSection.tsx');
    expect(tab).toContain('<TcoSection');
    expect(tab).not.toMatch(/TcoDrawer|data-tco-open|setTcoDrawerOpen|Coût de possession/);
    // Le bouton de « Valorisation » ne porte plus que l'historique de valorisation.
    const valo = tab.slice(tab.indexOf("headerActions={key === 'valuation'"), tab.indexOf(') : undefined}', tab.indexOf("headerActions={key === 'valuation'")));
    expect(valo).toContain('Valorisation');
    expect(valo).not.toMatch(/tco|Tco|possession/);
    // Section dépliable de premier niveau, toutes familles (aucune condition de catégorie), sans fenêtre latérale.
    expect(section).toContain('Coût total de possession');
    expect(section).toContain('aria-expanded={open}');
    // Lot 76G (complément PO du 21/10) : seul le détail « Dépenses retenues » s'ouvre dans un sous-tiroir ;
    // la section TCO elle-même reste une section dépliable (aucun tiroir TCO autonome).
    expect(section).not.toMatch(/TcoDrawer|Drawer/);
    expect(section.match(/<Sheet /g)?.length).toBe(1);
    expect(section).toContain('<Sheet open={retainedOpen}');
    expect(tab).not.toMatch(/asset\.category === '[A-Z]+' && \(?\s*<TcoSection/);
    // Pas de bouton « Modifier » général du total ; justificatif ouvrable depuis chaque ligne.
    expect(section).not.toMatch(/>\s*Modifier\s*</);
    expect(section).toContain('href={`/documents/${fileId}`}');
    // Responsive : mêmes jetons que les autres sections ; un seul composant pour desktop et mobile.
    expect(section).toMatch(/flex items-start justify-between gap-3/);
    expect(section).toContain('grid grid-cols-1 sm:grid-cols-2');
    // Aucun import serveur / registre dans le paquet client (types seulement).
    expect(section).not.toMatch(/from '@\/db'|from '@\/services\/business-operations\/tco\/model'/);
  });

  it('TCO-17 — Standard : présentation verrouillée sans montant ; lecture seule : aucune écriture ; route contrôlée côté serveur', () => {
    const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
    const route = lire('src/app/api/assets/[id]/tco/route.ts');
    // 403 AVANT toute lecture financière.
    expect(route.indexOf('PREMIUM_REQUIRED')).toBeLessThan(route.indexOf('readAssetTco(asset.accountId'));
    const section = lire('src/components/assets/TcoSection.tsx');
    expect(section).toContain("code === 'PREMIUM_REQUIRED'");
    expect(section).toMatch(/setLocked\(true\); setData\(null\)/);
    // Montant dans l'en-tête seulement avec des données (jamais en verrouillé) ; forfaits modifiables seulement si droit d'écriture et hors lecture seule.
    expect(section).toMatch(/open && t && !locked/);
    expect(section).toContain('setCanEdit(!!r.canEdit && !readOnly)');
    expect(section).toMatch(/\{canEdit && \(/);
  });
});

// ═══ Compléments : hiérarchie des sources, transitions, données incomplètes ═

describe('TCO — compléments (hiérarchie, transitions, cas incomplets)', () => {
  it('TCO-18 — prix de la fiche + facture d’achat du vélo (preuve, ou montant ET date concordants) → jamais additionnés', () => {
    // Lot 75D (A) : le montant SEUL ne suffit plus — même montant et même date que l'achat de la fiche : même fait.
    const achat = facture(1801, 30_000);
    const t = computeTco(entree({ assetPrice: prix300, assetAcquisitionDate: '2026-06-01', documents: [achat] }));
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    expect(ligne(t, 1801)[0]).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_ASSET_PRICE', category: 'ACQUISITION' });
    // Même montant, date d'achat inconnue : identité incertaine → comptée, signalée, total non exhaustif (75D, TCO-R-A2).
    const incertain = computeTco(entree({ assetPrice: prix300, documents: [achat] }));
    expect(incertain.summary.cumulativeCostCents).toBe(60_000);
    expect(ligne(incertain, 1801)[0]).toMatchObject({ status: 'RETAINED_DIRECT', uncertain: true });
    expect(incertain.status).toBe('INCOMPLETE');
    // Preuve active du prix (T1 a extrait le prix de cette facture), montants différents (TTC / remise) : même fait.
    const t2 = computeTco(entree({ assetPrice: { ...prix300, origin: 'DOCUMENT_EXTRACTION', evidenceFileIds: [1802] }, documents: [facture(1802, 31_000)] }));
    expect(t2.summary.cumulativeCostCents).toBe(30_000);
    expect(t2.lines.find((l) => l.source === 'ASSET_DATA')?.provenance).toBe('T1');
  });

  it('TCO-19 — achat consolidé (depuis la fiche ou la facture) → le prix de la fiche n’est pas recompté', () => {
    const achat = op(90, 'ACQUISITION', [comp('REALIZED_COST', 30_000, { targetAssetId: VELO })], { sourceKinds: ['ASSET_DATA'] });
    const t = computeTco(entree({ assetPrice: prix300, operations: [achat], documents: [facture(1901, 30_000, { operations: [{ operationId: 90, label: 'Achat', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: true }] })] }));
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    expect(t.lines.find((l) => l.source === 'ASSET_DATA')).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE', reason: 'ASSET_PRICE_CONSOLIDATED', operationId: 90 });
    // Correction utilisateur du prix déjà consolidée (USER prime dans l'achat) : la composante fait foi, pas de second montant.
    const corrige = op(91, 'ACQUISITION', [comp('REALIZED_COST', 28_000, { targetAssetId: VELO })], { sourceKinds: ['ASSET_DATA', 'DOCUMENT'] });
    expect(computeTco(entree({ assetPrice: { ...prix300, amountMinor: 28_000 }, operations: [corrige] })).summary.cumulativeCostCents).toBe(28_000);
  });

  it('TCO-20 — preuve de paiement, capital emprunté, notice → jamais un coût', () => {
    const t = computeTco(entree({ documents: [
      doc(2001, { typeCode: 'WORKS_PAYMENT_PROOF', amountCents: 18_000, candidates: [cand([hint('PAYMENT', 18_000)])] }),
      doc(2002, { typeCode: 'FINANCING_CONTRACT', candidates: [cand([hint('LOAN_PRINCIPAL', 1_000_000), hint('REALIZED_COST', 12_000, { amountScope: 'FEE' })], { typeHint: 'FINANCING' })] }),
      doc(2003, { typeCode: 'USER_MANUAL', amountCents: 9_900, candidates: [cand([hint('REALIZED_COST', 9_900)])] }),
    ] }));
    expect(t.summary.cumulativeCostCents).toBe(12_000);
    expect(ligne(t, 2001)[0]).toMatchObject({ status: 'PAYMENT', reason: 'PAYMENT_PROOF' });
    expect(t.lines.find((l) => l.reason === 'LOAN_PRINCIPAL')).toBeTruthy();
    expect(ligne(t, 2003)[0]).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_EXPENSE_DOCUMENT' });
    expect(t.breakdown.find((b) => b.category === 'FINANCING')?.costsCents).toBe(12_000);
  });

  it('TCO-20b — liste des types non métier identique à la barrière T1', async () => {
    const { NON_BUSINESS_DOCUMENT_TYPES } = await import('@/services/ai/source-analysis/operation-candidates/prepare');
    const { NON_EXPENSE_DOCUMENT_TYPES } = await import('../../finance/economic-lines');
    expect([...NON_EXPENSE_DOCUMENT_TYPES].sort()).toEqual([...NON_BUSINESS_DOCUMENT_TYPES].sort());
  });

  it('TCO-21 — deux factures distinctes de même montant → deux coûts (aucune fusion sans preuve)', () => {
    const t = computeTco(entree({ documents: [facture(2101, 4_500), facture(2102, 4_500)] }));
    expect(t.summary.cumulativeCostCents).toBe(9_000);
  });

  it('TCO-22 — Opération annulée, invalidée ou fusionnée : aucun doublon, justificatif réévalué', () => {
    const lien = (o: Partial<EconomicDocumentInput['operations'][number]>) => [{ operationId: 70, label: 'Intervention', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: true, ...o }];
    // Annulée : composante exclue, justificatif écarté avec ce motif.
    const annulee = op(70, 'INTERVENTION', [comp('REALIZED_COST', 5_000)], { status: 'CANCELLED' });
    const a = computeTco(entree({ operations: [annulee], documents: [facture(2201, 5_000, { operations: lien({ cancelled: true }) })] }));
    expect(a.summary.cumulativeCostCents).toBe(0);
    expect(ligne(a, 2201)[0]).toMatchObject({ status: 'EXCLUDED', reason: 'OPERATION_CANCELLED_SOURCE' });
    // Invalidée / fusionnée : le service ne la lit plus (ni l'Opération, ni le lien) → facture comptée directement, une fois.
    const i = computeTco(entree({ documents: [facture(2201, 5_000)] }));
    expect(i.summary.cumulativeCostCents).toBe(5_000);
  });

  it('TCO-23 — justificatif d’une dépense d’un autre bien, ou au bien non confirmé → non compté ici, motif visible ; non confirmé = incomplet', () => {
    const autre = computeTco(entree({ documents: [facture(2301, 5_000, { operations: [{ operationId: 80, label: 'X', inScope: false, cancelled: false, hasAssets: true, exploitable: true, citesDocument: true }] })] }));
    expect(ligne(autre, 2301)[0]).toMatchObject({ status: 'OUT_OF_SCOPE', reason: 'COUNTED_FOR_OTHER_ASSET' });
    expect(autre.status).toBe('INCOMPLETE'); // seule la date d'acquisition manque
    expect(autre.reliability.warnings).not.toContain('UNCONFIRMED_ASSET_EXPENSES');
    const nc = computeTco(entree({ documents: [facture(2302, 5_000, { operations: [{ operationId: 81, label: 'X', inScope: false, cancelled: false, hasAssets: false, exploitable: true, citesDocument: true }] })] }));
    expect(ligne(nc, 2302)[0]).toMatchObject({ status: 'UNCONFIRMED_ASSET' });
    expect(nc.reliability.warnings).toContain('UNCONFIRMED_ASSET_EXPENSES');
  });

  it('TCO-24 — données incomplètes : facture sans montant, nature non établie → jamais 0 € certain (INCOMPLETE, motif)', () => {
    const t = computeTco(entree({ assetAcquisitionDate: '2026-01-01', assetPrice: prix300, documents: [
      doc(2401, { typeCode: 'REPAIR_INVOICE', amountCents: null }),
      doc(2402, { typeCode: 'OTHER_DOCUMENT', amountCents: 7_000 }),
    ] }));
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    expect(ligne(t, 2401)[0]).toMatchObject({ status: 'NOT_QUALIFIED', reason: 'AMOUNT_UNKNOWN' });
    expect(t.reliability.warnings).toContain('DOCUMENTS_NOT_QUALIFIED');
    expect(t.status).toBe('INCOMPLETE');
    // Lecture partielle : jamais présentée comme complète.
    expect(computeTco(entree({ readComplete: false })).status).toBe('PARTIAL');
  });

  it('TCO-25 — montant corrigé par l’utilisateur sur le document : la correction fait foi (USER, en euros)', () => {
    const t = computeTco(entree({ documents: [doc(2501, { typeCode: 'REPAIR_INVOICE', amountCents: 7_700, userEditedAmount: true, currency: 'CHF', candidates: [cand([hint('REALIZED_COST', 9_900)])] })] }));
    expect(t.summary.cumulativeCostCents).toBe(7_700);
    expect(ligne(t, 2501)[0]).toMatchObject({ provenance: 'USER', currency: 'EUR' });
  });

  it('TCO-26 — cession : dépense documentaire postérieure exclue, prorata appliqué aux périodes (mêmes règles que les composantes)', () => {
    const t = computeTco(entree({
      assetStatus: 'VENDU', assetSaleDate: '2026-06-30', documents: [
        doc(2601, { typeCode: 'REPAIR_INVOICE', date: '2026-08-01', candidates: [cand([hint('REALIZED_COST', 5_000, { economicDate: '2026-08-01' })])] }),
        doc(2602, { typeCode: 'INSURANCE_DUE_NOTICE', candidates: [cand([hint('REALIZED_COST', 36_500, { periodStart: '2026-01-01', periodEnd: '2026-12-31', economicDate: '2026-01-01' })], { typeHint: 'CONTRACT' })] }),
      ],
    }));
    expect(ligne(t, 2601)[0]).toMatchObject({ status: 'EXCLUDED', reason: 'AFTER_DISPOSAL' });
    expect(ligne(t, 2602)[0].includedCents).toBe(18_100); // 181 jours / 365
    expect(t.reliability.warnings).toContain('PRORATA_APPLIED');
  });

  it('TCO-27 — modèle commun : identifiants stables, statut et motif sur chaque ligne ; somme des retenues = coût cumulé', () => {
    const t = computeTco(entree({ assetPrice: prix300, operations: [op(95, 'INTERVENTION', [comp('REALIZED_COST', 4_000), comp('REDUCTION', 500)])], documents: [facture(BEQUILLE, 2_500), facture(2701, 2_500, { hash: `h${BEQUILLE}` })] }));
    const ids = t.lines.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of t.lines) {
      expect(l.id).toMatch(/^(c:\d+|doc:\d+(:\d+:\d+)?|asset:\d+:acquisitionPrice)$/);
      expect(l.status).toBeTruthy();
      if (!['RETAINED_DIRECT', 'RETAINED_CONSOLIDATED'].includes(l.status)) expect(l.includedCents).toBe(0);
    }
    const signe = (k: string | null) => (k === 'REALIZED_COST' ? 1 : -1);
    const somme = t.lines.filter((l) => l.includedCents && l.kind !== 'PROCEED').reduce((n, l) => n + signe(l.kind) * l.includedCents, 0);
    expect(somme).toBe(t.summary.cumulativeCostCents);
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 3_500 + 2_500);
    expect(t.reliability.anomalies).toEqual([]);
    // Même entrée persistée → mêmes identifiants (stables d'une lecture à l'autre).
    const persiste = facture(BEQUILLE, 2_500);
    const u = computeTco(entree({ assetPrice: prix300, documents: [persiste] }));
    expect(u.lines.map((l) => l.id)).toEqual(computeTco(entree({ assetPrice: prix300, documents: [persiste] })).lines.map((l) => l.id));
  });

  it('TCO-28 — dédoublonnage partagé T2 / TCO : copie exacte sans signalement, fusion ignorée respectée', () => {
    const r = (id: number, o: Partial<Parameters<typeof dedupePossibleMerges>[0][number]> = {}) => ({ id, v2: 'REPAIR_INVOICE', legacy: null, date: null, hash: 'H', title: 'F', assetId: 1, supplier: null, state: 'ANALYZED', ignored: null, ...o });
    expect(dedupePossibleMerges([r(1), r(2)]).removed).toEqual([2]);
    expect(dedupePossibleMerges([r(1), r(2, { ignored: [1] })]).removed).toEqual([]);
    expect(dedupePossibleMerges([r(1), r(2, { hash: 'X' })]).removed).toEqual([]);
  });

  it('TCO-29 — qualification persistée : aucune ligne pour un document sans montant ni indice, ni pour une photo', () => {
    expect(qualifyDocumentLines([doc(2901, { typeCode: 'PHOTO' })], { today: TODAY })).toEqual([]);
    expect(qualifyDocumentLines([doc(2902, { typeCode: 'OTHER_DOCUMENT' })], { today: TODAY })).toEqual([]);
  });

  it('TCO-30 — DTO : retenues d’abord, libellés de statuts / motifs / catégories, liste bornée, aucune trace brute', () => {
    const t = computeTco(entree({ assetPrice: prix300, documents: [facture(BEQUILLE, 2_500), doc(3001, { typeCode: 'REPAIR_QUOTE', amountCents: 100 })] }));
    const d = toTcoDto(t);
    expect('entries' in d).toBe(false);
    expect(d.lines[0].status).toMatch(/^RETAINED/);
    expect(d.lineStatusLabels.RETAINED_DIRECT).toBeTruthy();
    expect(d.lineReasonLabels.SAME_AS_ASSET_PRICE).toBeTruthy();
    expect(d.categoryLabels.ACCESSORIES).toMatch(/Accessoires/);
    expect(d.linesTotal).toBe(t.lines.length);
  });

  it('TCO-31 — accessoire rattaché par T3 à l’achat du bien (M2) sans en porter le prix → dépense distincte ; vraie facture d’achat (preuve T1) → même fait', () => {
    const achat = op(96, 'ACQUISITION', [comp('REALIZED_COST', 30_000, { targetAssetId: VELO })], { sourceKinds: ['ASSET_DATA', 'DOCUMENT'] });
    const lien = [{ operationId: 96, label: 'Achat', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: false, typeCode: 'ACQUISITION' }];
    const t = computeTco(entree({ assetPrice: prix300, operations: [achat], documents: [facture(BEQUILLE, 2_500, { operations: lien })] }));
    expect(t.summary.cumulativeCostCents).toBe(32_500);
    expect(ligne(t, BEQUILLE)[0]).toMatchObject({ status: 'RETAINED_DIRECT', category: 'ACCESSORIES', operationId: 96 });
    const vraie = computeTco(entree({ assetPrice: prix300, operations: [achat], documents: [facture(3101, 31_000, { operations: lien, acquisitionEvidence: true })] }));
    expect(vraie.summary.cumulativeCostCents).toBe(30_000);
    expect(ligne(vraie, 3101)[0]).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE' });
    // Même montant que l'achat consolidé, sans preuve : même fait aussi (jamais 600 €).
    const meme = computeTco(entree({ assetPrice: prix300, operations: [achat], documents: [facture(3102, 30_000, { operations: lien })] }));
    expect(meme.summary.cumulativeCostCents).toBe(30_000);
    expect(ligne(meme, 3102)[0]).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_ASSET_PRICE' });
  });
});
