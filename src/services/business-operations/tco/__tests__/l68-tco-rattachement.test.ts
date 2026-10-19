/**
 * Lot 68 (68A) — bug PO « facture Midas de la Polo dans le TCO de la maison ».
 * Tests PURS : vue utilisateur des lignes (`tcoUserView`, `toTcoDto`), règle
 * de rattachement partagée TCO / T2 / liste des documents (SQL relu), et
 * présentation (desktop + mobile, même composant). Le cas réel est rejoué
 * sur PostgreSQL 16 : `src/test/e2e/scenarios/l68-tco-rattachement.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, type TcoInput, type TcoOperation } from '../model';
import { toTcoDto, tcoUserView } from '../dto';
import type { EconomicDocumentCandidate, EconomicDocumentInput, EconomicDocumentOperation, EconomicHint } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';

const MAISON = 1;
const POLO = 2;
const TODAY = '2026-10-18';
let seq = 5000;

const hint = (amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role: 'REALIZED_COST', amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], targets: EconomicDocumentCandidate['targets'], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'INTERVENTION', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [], targets, hints, t3Outcome: null, ...o,
});
const doc = (fileId: number, cents: number, o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: `Facture ${fileId}`, typeCode: 'MAINTENANCE_INVOICE', legacyType: null, date: '2026-06-01', supplier: null,
  amountCents: cents, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [MAISON], multiAsset: false, candidates: [cand([hint(cents)], [{ type: 'ASSET', entityId: MAISON }])], operations: [], ...o,
});
const comp = (id: number, operationId: number, cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id, operationId, kind: 'REALIZED_COST', amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: '2026-01-05',
  periodStart: null, periodEnd: null, targetAssetId: MAISON, ...o,
});
const opLien = (operationId: number, o: Partial<EconomicDocumentOperation> = {}): EconomicDocumentOperation => ({
  operationId, label: 'Contrat — Homiris', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: true, typeCode: 'CONTRACT', ...o,
});
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: MAISON, today: TODAY, operations: [], assetAcquisitionDate: null, assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: null, ...o,
});

// Facture Midas de la Polo rattachée AUSSI à la maison (SECONDARY), consolidée sur la seule Polo.
const MIDAS = 1090;
const midasPourMaison = doc(MIDAS, 51_154, {
  title: 'Facture Midas F-1614-2022-1090', linkedAssetIds: [MAISON, POLO], date: '2022-06-13',
  candidates: [cand([hint(51_154)], [{ type: 'ASSET', entityId: POLO }])],
  operations: [opLien(77, { label: 'Intervention — Midas', inScope: false, typeCode: 'INTERVENTION' })],
});
// Contrat Homiris consolidé (deux factures citées par deux composantes).
const HOM1 = 2001;
const HOM2 = 2002;
const homiris: TcoOperation = {
  id: 90, typeCode: 'CONTRACT', status: 'REALIZED', parentOperationId: null, realizedDate: '2025-11-05', startDate: null, plannedDate: null,
  assetIds: [MAISON], label: 'Contrat — Homiris', components: [comp(9001, 90, 4_050), comp(9002, 90, 4_050)],
  documents: [{ fileId: HOM1, title: 'Facture Homiris nov.', role: 'INVOICE' }, { fileId: HOM2, title: 'Facture Homiris janv.', role: 'INVOICE' }], sourceKinds: ['DOCUMENT'],
};
const homDocs = [
  doc(HOM1, 4_050, { title: 'Facture Homiris _ Novembre à décembre 2025', operations: [opLien(90)] }),
  doc(HOM2, 4_050, { title: 'Facture Homiris _ Janvier à février 2026', operations: [opLien(90)] }),
];

describe('L68A — TCO : présentation des dépenses non retenues pour CE bien', () => {
  it('L68-TCO-10 — facture attribuée à un autre bien : ligne conservée dans le calcul (BO), absente de la fiche ; total inchangé', () => {
    const t = computeTco(entree({ documents: [midasPourMaison, doc(3001, 9_000)] }));
    expect(t.lines.find((l) => l.fileId === MIDAS)).toMatchObject({ status: 'OUT_OF_SCOPE', reason: 'COUNTED_FOR_OTHER_ASSET', includedCents: 0 });
    const d = toTcoDto(t);
    expect(d.lines.some((l) => l.fileId === MIDAS)).toBe(false);
    expect(d.lines.some((l) => l.status === 'OUT_OF_SCOPE')).toBe(false);
    expect(d.summary).toEqual(t.summary);
    expect(d.hiddenLinesCount).toBe(1);
    expect(d.linesTotal).toBe(t.lines.length - 1);
    expect(tcoUserView(t.lines).hidden).toEqual({ [`doc:${MIDAS}`]: 'OTHER_ASSET' });
    // Côté Polo : comptée (même document, bien d'attribution = Polo).
    const polo = computeTco(entree({ assetId: POLO, documents: [{ ...midasPourMaison, operations: [] }] }));
    expect(polo.summary.cumulativeCostCents).toBe(51_154);
  });

  it('L68-TCO-11 — composante consolidée d’un autre bien et justificatif ciblant un autre bien (moteur) : masqués aussi', () => {
    const autre = { ...homiris, id: 91, components: [comp(9101, 91, 7_000, { targetAssetId: POLO })], assetIds: [MAISON, POLO], documents: [] };
    const cible = doc(3101, 2_000, { linkedAssetIds: [MAISON, POLO], candidates: [cand([hint(2_000)], [{ type: 'ASSET', entityId: POLO }])] });
    const t = computeTco(entree({ operations: [autre], documents: [cible] }));
    expect(t.lines.filter((l) => l.status === 'OUT_OF_SCOPE').map((l) => l.source).sort()).toEqual(['DOCUMENT', 'OPERATION']);
    expect(toTcoDto(t).lines).toEqual([]);
  });

  it('L68-TCO-12 — justificatifs repris par une dépense consolidée affichée (Homiris) : masqués des non retenues, ouvrables depuis la ligne retenue', () => {
    const t = computeTco(entree({ operations: [homiris], documents: homDocs }));
    expect(t.summary.cumulativeCostCents).toBe(8_100);
    expect(t.lines.filter((l) => l.status === 'CONSOLIDATED_ELSEWHERE').map((l) => l.fileId).sort()).toEqual([HOM1, HOM2]);
    const d = toTcoDto(t);
    expect(d.summary.cumulativeCostCents).toBe(8_100);
    expect(d.lines.map((l) => l.status)).toEqual(['RETAINED_CONSOLIDATED', 'RETAINED_CONSOLIDATED']);
    const ouvrables = d.lines.flatMap((l) => [l.fileId, ...(l.supportingDocuments ?? []).map((s) => s.fileId)]);
    expect(ouvrables).toEqual(expect.arrayContaining([HOM1, HOM2]));
    // Le justificatif déjà ouvert par la ligne (fileId) n'est pas répété.
    for (const l of d.lines) expect((l.supportingDocuments ?? []).some((s) => s.fileId === l.fileId)).toBe(false);
    expect(Object.values(tcoUserView(t.lines).hidden)).toEqual(['CONSOLIDATED_SHOWN', 'CONSOLIDATED_SHOWN']);
  });

  it('L68-TCO-13 — « déjà comptée par ailleurs » SANS ligne consolidée affichée : reste expliquée', () => {
    const t = computeTco(entree({ documents: [doc(4001, 3_000, { operations: [opLien(404)] })] }));
    expect(t.lines[0]).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE' });
    expect(toTcoDto(t).lines.map((l) => l.fileId)).toEqual([4001]);
  });

  it('L68-TCO-14 — restent visibles : non ventilée entre ce bien et d’autres, non qualifiée, devise non convertible, prévision', () => {
    const t = computeTco(entree({ documents: [
      doc(5001, 12_000, { linkedAssetIds: [MAISON, POLO], candidates: [cand([hint(12_000)], [])] }),
      doc(5002, 1_500, { typeCode: 'OTHER_DOCUMENT', candidates: [] }),
      doc(5003, 10_000, { candidates: [cand([hint(10_000, { currency: 'CHF' })], [{ type: 'ASSET', entityId: MAISON }])] }),
      doc(5004, 20_000, { typeCode: 'WORKS_QUOTE', candidates: [cand([hint(20_000, { role: 'FORECAST_COST' })], [{ type: 'ASSET', entityId: MAISON }], { statusHint: 'ENVISAGED' })] }),
    ] }));
    const d = toTcoDto(t);
    expect(d.lines.map((l) => l.status).sort()).toEqual(['FORECAST', 'NOT_QUALIFIED', 'UNALLOCATED', 'UNCONVERTED']);
    expect(d.hiddenLinesCount).toBe(0);
    expect(d.reliability.warnings).toContain('UNALLOCATED_AMOUNTS');
  });

  it('L68-TCO-15 — totaux identiques avant / après la vue (toutes les situations du lot 61 combinées)', () => {
    const t = computeTco(entree({ operations: [homiris], documents: [...homDocs, midasPourMaison, doc(6001, 2_500)] }));
    const d = toTcoDto(t);
    const somme = (ls: Array<{ includedCents: number }>) => ls.reduce((n, l) => n + l.includedCents, 0);
    expect(somme(d.lines)).toBe(somme(t.lines));
    expect(d.summary).toEqual(t.summary);
    expect(d.breakdown).toEqual(t.breakdown);
    expect('citedOnlyDocuments' in d).toBe(false);
  });
});

describe('L68A — même règle de rattachement (TCO, T2, liste des documents) et présentation', () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

  it('L68-TCO-16 — TCO et dépenses T2 : liens PRIMARY / SECONDARY seulement (jamais MENTIONED), même constante que la liste des documents du bien', () => {
    const scope = lire('src/services/documents/asset-document-scope.ts');
    expect(scope).toContain('export const ASSET_LIST_LINK_ROLES_SQL = ROLES_SQL');
    const tco = lire('src/services/business-operations/tco/service.ts');
    const lecture = tco.slice(tco.indexOf('export async function readAssetDocuments'), tco.indexOf('const ids = lus.map'));
    // Chaque lecture de document_asset_links (sélection ET biens d'attribution) filtre le rôle.
    expect(lecture.match(/FROM document_asset_links l/g)?.length).toBe(2);
    expect(lecture.match(/l\.link_role IN \$\{ROLES\}/g)?.length).toBe(2);
    const t2 = lire('src/services/verebona-assistant/canonical/expenses.ts');
    const l2 = t2.slice(t2.indexOf('async function readExpenseDocuments'), t2.indexOf('type DocLine'));
    expect(l2.match(/FROM document_asset_links l/g)?.length).toBe(2);
    expect(l2.match(/l\.link_role IN \$\{ASSET_LIST_LINK_ROLES_SQL\}/g)?.length).toBe(2);
  });

  it('L68-TCO-17 — fiche (desktop + mobile, un seul composant) : justificatifs repris ouvrables, aucune ligne « autre bien » ; BO : toutes les lignes, mention « masquée sur la fiche »', () => {
    const section = lire('src/components/assets/TcoSection.tsx');
    expect(section).toContain('l.supportingDocuments');
    expect(section).toContain("l.status !== 'OUT_OF_SCOPE'");
    expect(section).not.toMatch(/from '@\/db'|from '@\/services\/business-operations\/tco\/model'/);
    const diag = lire('src/app/admin/operations/_components/TcoDiagnostic.tsx');
    // Mobile (cartes) et desktop (tableau) : mention sur chaque ligne ; liste des justificatifs seulement cités.
    expect(diag.match(/<Masquee id=\{l\.id\} data=\{data\} \/>/g)?.length).toBe(2);
    expect(diag).toContain('citedOnlyDocuments');
    const route = lire('src/app/api/admin/operations/tco/route.ts');
    expect(route).toContain('userView: { hidden: tcoUserView(tco.lines).hidden }');
    expect(route).not.toContain('toTcoDto');
  });
});
