/**
 * Lot 113X — carte #722 « [P2][Post-MEP] TCO — Supprimer l'alerte de dates en doublon et permettre de renseigner
 * les dates ». Tests PURS : moteur TCO réel (`computeTco`), DTO (`undatedExpenses`), comptages, cible de saisie,
 * contrôle des dates, corps de l'API, diagnostics de la fiche et textes de l'interface (desktop et mobile : mêmes
 * composants). Écritures, recalculs, droits et isolation sur PostgreSQL : `src/test/e2e/scenarios/l113x-tco-dates.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, type TcoAssetPrice, type TcoInput, type TcoOperation, type TcoResult } from '../model';
import { toTcoDto } from '../dto';
import type { ComponentProvenance } from '../fact-identity';
import { tcoLineKeys, type TcoUndatedConfirmation } from '../user-decisions';
import {
  checkTcoExpenseDate, parseTcoDatesBody, tcoSheetDiagnostics, tcoUndatedButtonLabel, tcoUndatedExpenses, tcoUndatedMessage,
  TCO_EXPENSE_DATE_MIN, TCO_UNDATED_DIAGNOSTIC_CODE, TCO_UNDATED_MAX_ENTRIES,
} from '../undated-expenses';
import type { EconomicDocumentInput } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

const BIEN = 722;
const TODAY = '2026-11-07';
let seq = 722_000;

const comp = (kind: FinancialComponentKind, cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: null, startDate: null, plannedDate: null,
  assetIds: [BIEN], label: `Dossier ${id}`, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const pv = (documentFileIds: number[], o: Partial<ComponentProvenance> = {}): ComponentProvenance => ({
  documentFileIds, withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: documentFileIds.length ? true : null, ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const doc = (fileId: number, o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: `Document ${fileId}`, typeCode: 'REPAIR_INVOICE', legacyType: null, date: null, supplier: null,
  amountCents: null, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [BIEN], multiAsset: false, candidates: [], operations: [], ...o,
});
const conf = (key: string): TcoUndatedConfirmation => ({ key, confirmedAt: '2026-11-07T10:00:00.000Z', confirmedByUserId: 7 });

/**
 * Deux dépenses retenues sans date fiable — exemple ILLUSTRATIF du ticket (528,35 € au total) : deux échéances
 * d'assurance d'un même contrat (périodes distinctes, sans date de paiement) ; achat du bien daté sur la fiche.
 * Valeurs propres au test : aucune n'est codée dans l'application.
 */
function deuxSansDate(o: { ficheDate?: string | null; docs?: EconomicDocumentInput[] } = {}) {
  const achat = comp('REALIZED_COST', 500_000);
  const e1 = comp('REALIZED_COST', 21_476, { periodStart: '2025-09-24', periodEnd: '2026-09-23' });
  const e2 = comp('REALIZED_COST', 31_359, { periodStart: '2026-09-24', periodEnd: '2027-09-23' });
  const ops = [
    op(1, 'ACQUISITION', [achat], { label: 'Achat du bien', sourceKinds: ['ASSET_DATA'] }),
    op(2, 'CONTRACT', [e1, e2], {
      label: 'Assurance du bien', startDate: '2025-09-24',
      documents: [{ fileId: 601, title: 'Quittances', role: 'INVOICE', date: null }, { fileId: 602, title: 'Avis d’échéance', role: 'INVOICE', date: null }],
    }),
  ];
  const provenance = new Map<number, ComponentProvenance>([
    [achat.id, pv([], { otherSourceKinds: ['ASSET_DATA'], otherSourceKeys: [`ASSET_DATA:${BIEN}:ACQUISITION`] })],
    [e1.id, pv([601])], [e2.id, pv([602])],
  ]);
  const input = (x: Partial<TcoInput> = {}): TcoInput => ({
    assetId: BIEN, today: TODAY, operations: ops, assetAcquisitionDate: o.ficheDate === undefined ? '2024-03-15' : o.ficheDate, assetSaleDate: null,
    assetStatus: 'ACTIF', valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: o.docs ?? [],
    assetPrice: prix(500_000), assetCategory: 'VEHICULE', componentProvenance: provenance, ...x,
  });
  return { achat, e1, e2, input };
}
const ligne = (t: TcoResult, c: LedgerComponent) => t.lines.find((l) => l.id === `c:${c.id}`)!;
const coherent = (t: TcoResult) => {
  const a = t.annual;
  expect(a.years.reduce((n, y) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents).toBe(t.summary.cumulativeCostCents);
};

describe('L113X-U — dépenses sans date fiable : liste exacte, comptages du moteur, cible de saisie', () => {
  it('L113X-U-01 — 2 dépenses retenues sans date : nombre et montant = ventilation annuelle (annual.undated), lignes distinctes', () => {
    const { e1, e2, input } = deuxSansDate();
    const t = computeTco(input());
    const u = toTcoDto(t).undatedExpenses;
    expect(u).toMatchObject({ count: 2, costsCents: 52_835, truncated: false });
    expect(u.count).toBe(t.annual.undated.count);
    expect(u.costsCents).toBe(t.annual.undated.costsCents);
    expect(u.items.map((i) => i.lineId).sort()).toEqual([`c:${e1.id}`, `c:${e2.id}`].sort());
    // Une ligne économique = un élément (jamais le nombre de justificatifs) ; libellé et montant réels.
    for (const i of u.items) {
      expect(i.label).toBe('Assurance du bien');
      expect(i.origin).toBe('OPERATION');
      expect(i.currentDate).toBeNull();
      expect(i.documents.length).toBe(1);
    }
    coherent(t);
  });

  it('L113X-U-02 — échéances à période seule : aucune date inventée, aucun champ de saisie (correction à la source) ; #712 proposé', () => {
    const { input } = deuxSansDate();
    const u = toTcoDto(computeTco(input())).undatedExpenses;
    for (const i of u.items) {
      expect(i.target).toEqual({ kind: 'NONE' });
      expect(i.options.map((o) => o.label)).toEqual(['Conserver dans le TCO sans date']);
    }
  });

  it('L113X-U-03 — prix de la fiche sans date : cible = date d’achat de la fiche ; renseignée → ligne datée, total inchangé, 2 restantes', () => {
    const { achat, input } = deuxSansDate({ ficheDate: null });
    const t0 = computeTco(input());
    const u0 = toTcoDto(t0).undatedExpenses;
    expect(u0.count).toBe(3);
    expect(u0.items.find((i) => i.lineId === `c:${achat.id}`)!.target).toEqual({ kind: 'ASSET_FIELD', field: 'acquisitionDate' });
    const t1 = computeTco({ ...input(), assetAcquisitionDate: '2024-03-15' });
    const u1 = toTcoDto(t1).undatedExpenses;
    expect(u1).toMatchObject({ count: 2, costsCents: 52_835 });
    expect(ligne(t1, achat)).toMatchObject({ date: '2024-03-15', annualYear: 2024 });
    expect(t1.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents);
    expect(t1.annual.years.find((y) => y.year === 2024)!.costsCents).toBe(500_000);
    coherent(t1);
  });

  it('L113X-U-04 — facture seule sans date (justificatif unique) : cible = date du justificatif ; datée → disparition, ventilée dans son année', () => {
    const facture = doc(801, { typeCode: 'REPAIR_INVOICE', title: 'Facture de réparation', amountCents: 12_000 });
    const base: TcoInput = {
      assetId: BIEN, today: TODAY, operations: [], assetAcquisitionDate: '2020-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
      valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [facture], assetPrice: null,
    };
    const t0 = computeTco(base);
    const l0 = t0.lines.find((l) => l.fileId === 801)!;
    if (l0.status.startsWith('RETAINED')) {
      const u = toTcoDto(t0).undatedExpenses;
      expect(u.items.find((i) => i.lineId === l0.id)!.target).toEqual({ kind: 'DOCUMENT', fileId: 801 });
      const t1 = computeTco({ ...base, documents: [{ ...facture, date: '2025-06-02' }] });
      expect(toTcoDto(t1).undatedExpenses.count).toBe(u.count - 1);
      expect(t1.annual.years.find((y) => y.year === 2025)!.costsCents).toBe(12_000);
      expect(t1.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents);
    } else {
      // Facture non retenue par les règles automatiques : jamais listée (seules les dépenses RETENUES le sont).
      expect(toTcoDto(t0).undatedExpenses.items.some((i) => i.lineId === l0.id)).toBe(false);
    }
  });

  it('L113X-U-05 — devis / prévision non réalisée sans date : jamais listé (aucune transformation implicite en dépense)', () => {
    const devis = doc(901, { typeCode: 'REPAIR_QUOTE', legacyType: 'DEVIS', title: 'Devis', amountCents: 50_000 });
    const t = computeTco({
      assetId: BIEN, today: TODAY, operations: [], assetAcquisitionDate: '2020-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
      valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [devis], assetPrice: null,
    });
    const l = t.lines.find((x) => x.fileId === 901)!;
    expect(l.status.startsWith('RETAINED')).toBe(false);
    expect(toTcoDto(t).undatedExpenses.count).toBe(0);
  });

  it('L113X-U-06 — tout est daté : aucun avertissement, aucun bouton, aucun état positif', () => {
    const { input } = deuxSansDate();
    const e1 = comp('REALIZED_COST', 10_000, { economicDate: '2025-02-01' });
    const t = computeTco({ ...input(), operations: [op(9, 'INTERVENTION', [e1], { realizedDate: '2025-02-01' })], componentProvenance: new Map([[e1.id, pv([])]]), assetPrice: null });
    const u = toTcoDto(t).undatedExpenses;
    expect(u.count).toBe(0);
    expect(tcoUndatedMessage(u.count, u.costsCents)).toBeNull();
  });

  it('L113X-U-07 — #712 : « Conserver sans date » ne change ni le nombre ni le montant (information neutre conservée), geste « Annuler mon choix »', () => {
    const { e1, e2, input } = deuxSansDate();
    const t0 = computeTco(input());
    const t = computeTco(input({ undatedConfirmations: [e1, e2].map((c) => conf(tcoLineKeys(ligne(t0, c)).primary)) }));
    const u = toTcoDto(t).undatedExpenses;
    expect(u).toMatchObject({ count: 2, costsCents: 52_835 });
    for (const i of u.items) {
      expect(i.confirmedUndated).toBe(true);
      expect(i.options.map((o) => o.action)).toEqual(['REVERT_UNDATED']);
    }
    expect(t.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents);
  });

  it('L113X-U-08 — filtre d’année : la liste et le compte ne dépendent d’aucune année (page `linesYear` comprise)', () => {
    const { input } = deuxSansDate();
    const t = computeTco(input());
    for (const y of [2024, 2025, 2026]) expect(toTcoDto(t, { linesYear: y }).undatedExpenses).toEqual(toTcoDto(t).undatedExpenses);
    expect(toTcoDto(t, { linesLimit: 1 }).undatedExpenses.count).toBe(2);
  });

  it('L113X-U-09 — fonction pure sur la trace : dédoublonnage par identifiant de ligne', () => {
    const { input } = deuxSansDate();
    const t = computeTco(input());
    const lines = [...t.lines, ...t.lines];
    expect(tcoUndatedExpenses({ lines }).count).toBe(2);
  });
});

describe('L113X-U — textes, diagnostics de la fiche, contrôle des dates, API', () => {
  it('L113X-U-10 — texte du ticket à l’identique (pluriel), bouton « Renseigner les dates (N) » ; montant formaté, jamais codé', () => {
    expect(tcoUndatedMessage(2, 52_835)).toBe('2 dépenses sans date fiable (528,35 €). Elles sont incluses dans le coût total mais ne sont affectées à aucune année. Les montants annuels peuvent être incomplets.');
    expect(tcoUndatedButtonLabel(2)).toBe('Renseigner les dates (2)');
    expect(tcoUndatedMessage(1, 12_000)).toMatch(/^1 dépense sans date fiable \(120,00 €\)\. Elle est incluse dans le coût total/);
    expect(tcoUndatedMessage(0, 0)).toBeNull();
    const src = readFileSync(join(process.cwd(), 'src/services/business-operations/tco/undated-expenses.ts'), 'utf8');
    expect(src).not.toMatch(/528|52_835/);
  });

  it('L113X-U-11 — « Points à vérifier » de la fiche : le point « date non établie » n’est plus répété ; les autres restent ; DTO inchangé (T2, BO)', () => {
    const { input } = deuxSansDate({ ficheDate: null });
    const dto = toTcoDto(computeTco(input()));
    expect(dto.diagnostics.items.some((d) => d.code === TCO_UNDATED_DIAGNOSTIC_CODE && d.status === 'OPEN')).toBe(true);
    const fiche = tcoSheetDiagnostics(dto.diagnostics);
    expect(fiche.items.some((d) => d.code === TCO_UNDATED_DIAGNOSTIC_CODE && d.status === 'OPEN')).toBe(false);
    const autres = dto.diagnostics.items.filter((d) => d.status === 'OPEN' && d.code !== TCO_UNDATED_DIAGNOSTIC_CODE);
    expect(fiche.open.families).toBe(autres.length);
    expect(fiche.items.filter((d) => d.status === 'OPEN').map((d) => d.code)).toEqual(autres.map((d) => d.code));
    for (const i of dto.undatedExpenses.items) expect(fiche.reviewLineIds).not.toContain(i.lineId);
    // Aucun cas « date » : objet rendu tel quel.
    const sans = toTcoDto(computeTco({ ...input(), operations: [], componentProvenance: new Map(), assetPrice: null, assetAcquisitionDate: '2020-01-01' })).diagnostics;
    expect(tcoSheetDiagnostics(sans)).toBe(sans);
  });

  it('L113X-U-12 — contrôle des dates : stricte, jamais future, plausible ; contradiction avec la possession → confirmation explicite', () => {
    const ctx = { today: TODAY, possessionStart: '2024-03-15', disposalDate: null, target: 'DOCUMENT' as const };
    expect(checkTcoExpenseDate('2025-02-29', ctx)).toMatchObject({ ok: false, code: 'INVALID_DATE' });
    expect(checkTcoExpenseDate('15/03/2025', ctx)).toMatchObject({ ok: false, code: 'INVALID_DATE' });
    expect(checkTcoExpenseDate('2026-11-08', ctx)).toMatchObject({ ok: false, code: 'FUTURE_DATE' });
    expect(checkTcoExpenseDate('1899-12-31', ctx)).toMatchObject({ ok: false, code: 'TOO_OLD' });
    expect(TCO_EXPENSE_DATE_MIN).toBe('1900-01-01');
    expect(checkTcoExpenseDate('2023-01-01', ctx)).toMatchObject({ ok: false, code: 'NEEDS_CONFIRMATION' });
    expect(checkTcoExpenseDate('2023-01-01', { ...ctx, confirmed: true })).toEqual({ ok: true, date: '2023-01-01' });
    expect(checkTcoExpenseDate('2026-11-07', ctx)).toEqual({ ok: true, date: '2026-11-07' });
    expect(checkTcoExpenseDate('2025-01-10', { ...ctx, disposalDate: '2024-12-31' })).toMatchObject({ ok: false, code: 'NEEDS_CONFIRMATION' });
    // La date d'achat du bien définit la période : jamais contrôlée contre elle-même.
    expect(checkTcoExpenseDate('2023-01-01', { ...ctx, target: 'ASSET_FIELD' })).toEqual({ ok: true, date: '2023-01-01' });
  });

  it('L113X-U-13 — corps de l’API : entrées bornées, identifiants requis, doublons refusés', () => {
    expect(parseTcoDatesBody({ entries: [{ lineId: 'c:1', date: '2025-01-01' }] })).toEqual({ ok: true, value: [{ lineId: 'c:1', lineKey: null, date: '2025-01-01', confirm: false }] });
    expect(parseTcoDatesBody({ entries: [] })).toMatchObject({ ok: false });
    expect(parseTcoDatesBody(null)).toMatchObject({ ok: false });
    expect(parseTcoDatesBody({ entries: [{ date: '2025-01-01' }] })).toMatchObject({ ok: false });
    expect(parseTcoDatesBody({ entries: [{ lineId: 'c:1', date: '2025-01-01' }, { lineId: 'c:1', date: '2025-01-02' }] })).toMatchObject({ ok: false });
    expect(parseTcoDatesBody({ entries: Array.from({ length: TCO_UNDATED_MAX_ENTRIES + 1 }, (_, i) => ({ lineId: `c:${i}`, date: '2025-01-01' })) })).toMatchObject({ ok: false });
    expect(parseTcoDatesBody({ entries: [{ lineId: 'c:1', date: '2025-01-01', confirm: true, lineKey: 'k' }] })).toMatchObject({ ok: true, value: [{ confirm: true, lineKey: 'k' }] });
  });
});

describe('L113X-UI — fiche (desktop et mobile : mêmes composants)', () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
  const ui = lire('src/components/assets/TcoSection.tsx');
  const sheet = lire('src/components/assets/TcoUndatedDatesSheet.tsx');

  it('L113X-UI-01 — une seule information : plus de « Aucune anomalie / incohérence détectée », plus d’avertissement sous la ventilation', () => {
    expect(ui).not.toContain('Aucune anomalie détectée');
    expect(ui).not.toContain('Aucune incohérence détectée');
    expect(ui).not.toContain('data-tco-annual-undated');
    expect(ui).not.toContain('data-tco-year-incomplete');
    expect(ui).toContain('data-tco-undated');
    expect(ui).toContain('tcoUndatedMessage(');
    expect(ui).toContain('tcoUndatedButtonLabel(');
    expect(ui).toContain('tcoSheetDiagnostics(');
  });

  it('L113X-UI-02 — saisie : champ « Date effective de la dépense », un seul tiroir à la fois, écriture par la route dédiée ; lecture seule respectée', () => {
    expect(lire('src/services/business-operations/tco/undated-expenses.ts')).toContain('Date effective de la dépense');
    expect(sheet).toContain('/tco/dates');
    expect(sheet).toContain('type="date"');
    expect(sheet).toContain('htmlFor={idChamp}');
    expect(sheet).toContain('aria-describedby');
    expect(sheet).toContain('role="alert"');
    expect(sheet).toContain('onOpenChange(false);');
    expect(sheet).toContain('min-h-[44px]');
    expect(ui).toMatch(/\{t && canEdit && \(\s*<TcoUndatedDatesSheet/);
    expect(ui).toMatch(/\{canEdit && \(\s*<Button\s+ref=\{datesTrigger\}/);
  });

  it('L113X-UI-03 — charte Sérénité : aucune couleur brute ; jamais « Opération » visible', () => {
    const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    for (const s of [sheet, lire('src/services/business-operations/tco/undated-expenses.ts')].map(sansCommentaires)) {
      expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(s).not.toMatch(/rgba?\(/);
    }
    const textes = lire('src/services/business-operations/tco/undated-expenses.ts').match(/'[^']*'|`[^`]*`/g) ?? [];
    expect(textes.filter((x) => /Op[ée]ration/.test(x))).toEqual([]);
    expect(sheet.match(/>[^<{]*Op[ée]ration[^<]*</g) ?? []).toEqual([]);
  });
});
