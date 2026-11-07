/**
 * Lot 109C — TCO : alertes contextualisées et actionnables (ticket P2).
 * Tests PURS sur le moteur TCO RÉEL (`computeTco`) → diagnostics
 * (`computeTcoDiagnostics`) → DTO (`toTcoDto`) → présentation
 * (`TcoOpenDiagnostics`, `TcoInformationDiagnostics`, rendu serveur) et
 * garde-fous de la fiche (TcoSection). Base réelle :
 * `src/test/e2e/scenarios/l109c-tco-diagnostics.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeTco, type TcoAssetPrice, type TcoInput, type TcoOperation, type TcoResult, type TcoWarning } from '../model';
import { computeTcoDiagnostics, TCO_DIAGNOSTIC_MATRIX, TCO_DIAGNOSTIC_MAX_SOURCES, type TcoDiagnosticCode } from '../diagnostics';
import { TCO_WARNING_LABELS, toTcoDto } from '../dto';
import type { ComponentProvenance } from '../fact-identity';
import type { TcoAmountRecoveryView } from '../amount-recovery';
import type { EconomicDocumentCandidate, EconomicDocumentInput, EconomicHint } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

(globalThis as { React?: typeof React }).React = React;

const BIEN = 109;
const TODAY = '2026-11-04';
let seq = 109_000;

const comp = (kind: FinancialComponentKind, cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: '2025-03-01', startDate: null, plannedDate: null,
  assetIds: [BIEN], label: `Dépense ${id}`, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const pv = (documentFileIds: number[], o: Partial<ComponentProvenance> = {}): ComponentProvenance => ({
  documentFileIds, withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: documentFileIds.length ? true : null, ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const hint = (role: string, amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'INTERVENTION', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [],
  targets: [{ type: 'ASSET', entityId: BIEN }], hints, t3Outcome: null, ...o,
});
const doc = (fileId: number, o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: `Facture ${fileId}`, typeCode: 'REPAIR_INVOICE', legacyType: null, date: '2026-06-01', supplier: null,
  amountCents: null, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [BIEN], multiAsset: false, candidates: [], operations: [], ...o,
});
const reparation = (fileId: number, cents: number, date: string) => doc(fileId, { amountCents: cents, date, candidates: [cand([hint('REALIZED_COST', cents)])] });
const achatDoc = (fileId: number, cents: number, date: string) =>
  doc(fileId, { typeCode: 'ACQUISITION_INVOICE', amountCents: cents, date, candidates: [cand([hint('REALIZED_COST', cents)], { typeHint: 'ACQUISITION' })] });
const sansMontant = (fileId: number) => doc(fileId, { typeCode: 'MAINTENANCE_INVOICE', title: `Facture illisible ${fileId}` });
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: BIEN, today: TODAY, operations: [], assetAcquisitionDate: '2024-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: prix(1_000_000), ...o,
});
const diag = (t: TcoResult) => computeTcoDiagnostics(t);
const item = (t: TcoResult, code: TcoDiagnosticCode) => diag(t).items.find((d) => d.code === code);
const ouverts = (t: TcoResult) => diag(t).items.filter((d) => d.status === 'OPEN').map((d) => d.code);
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('L109C-M — matrice : inventaire complet des codes, classe fondée sur le sens réel', () => {
  it('L109C-M01 — chaque code du moteur (TcoWarning, libellés dto.ts) a sa classe ; NO_RELIABLE_VALUATION absent (#646)', () => {
    const codes = Object.keys(TCO_WARNING_LABELS) as TcoWarning[];
    for (const c of codes) expect(TCO_DIAGNOSTIC_MATRIX[c], c).toBeDefined();
    expect(Object.keys(TCO_DIAGNOSTIC_MATRIX)).not.toContain('NO_RELIABLE_VALUATION');
    // Lot 111V : + USER_DECISION_TO_RECONFIRM (choix rouvert par une preuve nouvelle contraire).
    expect(Object.keys(TCO_DIAGNOSTIC_MATRIX).sort()).toEqual([...codes, 'SAME_FACT_PROVEN', 'LEDGER_ANOMALY', 'USER_DECISION_TO_RECONFIRM'].sort());
  });

  it('L109C-M02 — matrice du ticket §3B', () => {
    const nature = (c: TcoDiagnosticCode) => TCO_DIAGNOSTIC_MATRIX[c].nature;
    expect(nature('PRESUMED_DUPLICATES')).toBe('ANOMALY');
    expect(nature('STATUS_CONTRADICTIONS')).toBe('ANOMALY');
    expect(nature('UNCERTAIN_MATCHES')).toBe('ANOMALY');
    expect(nature('AMOUNTS_UNKNOWN')).toBe('COVERAGE');
    expect(nature('AMOUNTS_RECOVERY_PENDING')).toBe('COVERAGE');
    for (const c of ['NOT_REALIZED_EXPENSES', 'NOT_OWNERSHIP_COSTS', 'SAME_FACT_PROVEN', 'USER_DECISIONS', 'USER_INCLUDED_DUPLICATES', 'PRORATA_APPLIED'] as const) {
      expect(nature(c), c).toBe('INFORMATION');
    }
    // Aucun texte ne promet une prise en compte automatique « à sa date de paiement » sans preuve.
    for (const m of Object.values(TCO_DIAGNOSTIC_MATRIX)) expect(m.text).not.toMatch(/le seront à leur date|sera comptée à sa date de paiement/);
    expect(TCO_WARNING_LABELS.NOT_REALIZED_EXPENSES).not.toMatch(/le seront à leur date de paiement/);
    // Jamais le mot « Opération » visible.
    for (const m of Object.values(TCO_DIAGNOSTIC_MATRIX)) expect(`${m.title(2)} ${m.text} ${m.action?.label ?? ''}`).not.toMatch(/opération/i);
  });
});

describe('L109C-R — recette du ticket (moteur → diagnostics)', () => {
  it('L109C-R01 — dépense future prévue non payée : exclue avec motif, aucun cas ouvert, pas de contradiction (cause racine), statut inchangé', () => {
    const prevue = comp('REALIZED_COST', 30_000, { economicDate: '2026-12-01' });
    const base = computeTco(entree());
    const t = computeTco(entree({ operations: [op(1, 'INTERVENTION', [prevue], { status: 'ENVISAGED', realizedDate: null, plannedDate: '2026-12-01' })], componentProvenance: new Map([[prevue.id, pv([11])]]) }));
    expect(t.summary.cumulativeCostCents).toBe(base.summary.cumulativeCostCents);
    // Avant 109C : la trace PLANNED_WITHOUT_PROOF levait STATUS_CONTRADICTIONS (message rouge) et rendait le TCO incomplet.
    expect(t.lines.find((l) => l.id === `c:${prevue.id}`)).toMatchObject({ contradiction: 'PLANNED_WITHOUT_PROOF', notRealized: true, includedCents: 0 });
    expect(t.reliability.warnings).not.toContain('STATUS_CONTRADICTIONS');
    expect(t.status).toBe(base.status);
    expect(ouverts(t)).toEqual([]);
    expect(item(t, 'NOT_REALIZED_EXPENSES')).toMatchObject({ nature: 'INFORMATION', status: 'INFORMATIONAL', count: 1, sources: [expect.objectContaining({ lineId: `c:${prevue.id}`, fileId: 11, retained: false })] });
    const dto = toTcoDto(t);
    expect(dto.diagnostics.open.families).toBe(0);
    expect(dto.otherLinesByReason).toEqual([expect.objectContaining({ reason: 'NOT_REALIZED', count: 1, review: 0 })]);
  });

  it('L109C-R02 — « réalisée » mais datée après aujourd’hui : anomalie précise (dates, justificatif) ; correction → disparition et recalcul', () => {
    const futur = comp('REALIZED_COST', 20_000, { economicDate: '2026-12-15' });
    const t = computeTco(entree({ operations: [op(2, 'INTERVENTION', [futur], { realizedDate: '2026-12-15' })], componentProvenance: new Map([[futur.id, pv([21])]]) }));
    const d = item(t, 'STATUS_CONTRADICTIONS')!;
    expect(d).toMatchObject({ nature: 'ANOMALY', status: 'OPEN', count: 1, traced: true, action: { kind: 'OPEN_DOCUMENT' } });
    expect(d.sources[0]).toMatchObject({ lineId: `c:${futur.id}`, fileId: 21, operationId: 2 });
    expect(d.sources[0].detail).toMatch(/« réalisée » mais datée du 15\/12\/2026/);
    // Pas une double présentation : la ligne n'est pas aussi une « information » de dépense future.
    expect(item(t, 'NOT_REALIZED_EXPENSES')).toBeUndefined();
    const corrige = comp('REALIZED_COST', 20_000, { id: futur.id, economicDate: '2026-10-15' });
    const u = computeTco(entree({ operations: [op(2, 'INTERVENTION', [corrige], { realizedDate: '2026-10-15' })], componentProvenance: new Map([[futur.id, pv([21])]]) }));
    expect(item(u, 'STATUS_CONTRADICTIONS')).toBeUndefined();
    expect(u.summary.cumulativeCostCents).toBe(t.summary.cumulativeCostCents + 20_000);
  });

  it('L109C-R03 — plusieurs cas d’une même famille : un seul diagnostic groupé, nombre exact, chaque source accessible', () => {
    const a = comp('REALIZED_COST', 10_000, { economicDate: '2026-12-01' });
    const b = comp('REALIZED_COST', 15_000, { economicDate: '2027-01-10' });
    const t = computeTco(entree({
      operations: [op(3, 'INTERVENTION', [a], { realizedDate: '2026-12-01' }), op(4, 'CONTRACT', [b], { realizedDate: '2027-01-10' })],
      componentProvenance: new Map([[a.id, pv([31])], [b.id, pv([41])]]),
    }));
    const d = item(t, 'STATUS_CONTRADICTIONS')!;
    expect(d.count).toBe(2);
    expect(d.sources.map((s) => s.fileId).sort()).toEqual([31, 41]);
    expect(d.amountCents).toBe(25_000);
    expect(diag(t).items.filter((x) => x.code === 'STATUS_CONTRADICTIONS')).toHaveLength(1);
  });

  it('L109C-R04 — prévue mais payée (paiement daté et justifié) : comptée et signalée (vraie contradiction)', () => {
    const acompte = comp('REALIZED_COST', 13_000, { economicDate: '2026-06-01' });
    const t = computeTco(entree({ operations: [op(5, 'INTERVENTION', [acompte], { status: 'ENVISAGED', realizedDate: null, plannedDate: '2026-11-20' })], componentProvenance: new Map([[acompte.id, pv([51])]]) }));
    expect(t.reliability.warnings).toContain('STATUS_CONTRADICTIONS');
    expect(item(t, 'STATUS_CONTRADICTIONS')!.sources[0].detail).toMatch(/« prévue » mais payée le 01\/06\/2026 : comptée/);
    expect(item(t, 'STATUS_CONTRADICTIONS')!.sources[0].retained).toBe(true);
  });

  it('L109C-R05 — achat d’objet distinct hors périmètre confirmé : « Non retenues », aucune alerte', () => {
    const t = computeTco(entree({ assetCategory: 'IMMOBILIER', documents: [achatDoc(61, 27_735, '2025-06-03')] }));
    expect(t.lines.find((l) => l.fileId === 61)).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_OWNERSHIP_COST' });
    expect(ouverts(t)).toEqual([]);
    expect(item(t, 'NOT_OWNERSHIP_COSTS')).toMatchObject({ nature: 'INFORMATION', count: 1, sources: [expect.objectContaining({ fileId: 61 })] });
    // Le libellé historique reste transmis aux consommateurs existants (rétrocompatibilité).
    expect(toTcoDto(t).warningLabels).toContain(TCO_WARNING_LABELS.NOT_OWNERSHIP_COSTS);
  });

  it('L109C-R06 — même fait sur deux justificatifs avec preuve forte : un coût, information, pas de doublon présumé', () => {
    const t = computeTco(entree({ assetPrice: prix(1_000_000, { evidenceFileIds: [71] }), documents: [achatDoc(71, 1_000_000, '2024-01-10')] }));
    expect(t.summary.cumulativeCostCents).toBe(1_000_000);
    expect(t.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    expect(ouverts(t)).toEqual([]);
    expect(item(t, 'SAME_FACT_PROVEN')).toMatchObject({ nature: 'INFORMATION', count: 1, sources: [expect.objectContaining({ fileId: 71 })] });
  });

  it('L109C-R07 — même somme sur 3 justificatifs d’une dépense sans preuve de transactions distinctes : anomalie ciblée (2 occurrences, justificatif compté lié)', () => {
    const [x, y, z] = [comp('REALIZED_COST', 80_000, { economicDate: '2026-02-01' }), comp('REALIZED_COST', 80_000, { economicDate: '2026-02-03' }), comp('REALIZED_COST', 80_000)];
    const o = op(8, 'INTERVENTION', [x, y, z], { realizedDate: '2026-02-01', documents: [{ fileId: 81, title: 'Facture A', role: 'INVOICE' }, { fileId: 82, title: 'Facture B', role: 'INVOICE' }, { fileId: 83, title: 'Facture C', role: 'INVOICE' }] });
    const t = computeTco(entree({ operations: [o], componentProvenance: new Map([[x.id, pv([81])], [y.id, pv([82])], [z.id, pv([83])]]) }));
    expect(t.summary.cumulativeCostCents).toBe(1_000_000 + 80_000);
    const d = item(t, 'PRESUMED_DUPLICATES')!;
    expect(d).toMatchObject({ nature: 'ANOMALY', status: 'OPEN', count: 2 });
    expect(d.sources.map((s) => [s.fileId, s.relatedFileId])).toEqual([[82, 81], [83, 81]]);
    expect(d.sources[0].detail).toMatch(/Même somme que « Dépense 8 »/);
    // Lignes « à revoir » dans « Dépenses non retenues » ; deux dépenses distinctes (références) : deux coûts, aucun cas.
    const dto = toTcoDto(t);
    expect(dto.diagnostics.reviewLineIds.sort()).toEqual([`c:${y.id}`, `c:${z.id}`].sort());
    expect(dto.otherLinesByReason.find((m) => m.reason === 'SAME_FACT_OTHER_DOCUMENT')).toMatchObject({ count: 2, review: 2 });
    const distinctes = computeTco(entree({ operations: [o], componentProvenance: new Map([[x.id, pv([81], { invoiceRefs: ['F1'] })], [y.id, pv([82], { invoiceRefs: ['F2'] })], [z.id, pv([83], { invoiceRefs: ['F3'] })]]) }));
    expect(distinctes.summary.cumulativeCostCents).toBe(1_000_000 + 240_000);
    expect(item(distinctes, 'PRESUMED_DUPLICATES')).toBeUndefined();
  });

  it('L109C-R08 — justificatif sans montant : lecture en cours = état discret (aucun cas ouvert) ; échec = « Montant à confirmer », document identifié, jamais 0 €', () => {
    const t = computeTco(entree({ documents: [sansMontant(91), sansMontant(92)] }));
    expect(t.lines.filter((l) => l.amountUnknown).map((l) => l.fileId).sort()).toEqual([91, 92]);
    // Sans état de récupération (table absente) : la trace du moteur.
    expect(item(t, 'AMOUNTS_UNKNOWN')).toMatchObject({ status: 'OPEN', count: 2, amountCents: null });
    const vue = (states: Array<'READING' | 'TO_CONFIRM' | 'NOT_FOUND'>): TcoAmountRecoveryView => ({
      items: states.map((state, i) => ({ fileId: 91 + i, title: `Facture illisible ${91 + i}`, state })),
      inProgress: states.filter((s) => s === 'READING').length, toConfirm: states.filter((s) => s === 'TO_CONFIRM').length, notFound: states.filter((s) => s === 'NOT_FOUND').length,
    });
    // Lot 111V : « en cours » = travail T1 réellement RUNNING (état READING, issu de la file).
    // Reprise en cours (warningsAfterRecovery de 108B : AMOUNTS_RECOVERY_PENDING, pas AMOUNTS_UNKNOWN).
    const enCours: TcoResult = { ...t, amountRecovery: vue(['READING', 'READING']), reliability: { ...t.reliability, warnings: [...t.reliability.warnings.filter((w) => w !== 'AMOUNTS_UNKNOWN'), 'AMOUNTS_RECOVERY_PENDING'] } };
    expect(ouverts(enCours)).toEqual([]);
    expect(item(enCours, 'AMOUNTS_RECOVERY_PENDING')).toMatchObject({ status: 'IN_PROGRESS', count: 2 });
    expect(toTcoDto(enCours).warningLabels.join(' ')).not.toMatch(/Lecture automatique|montant lisible/);
    // Échec réel pour l'un, reprise pour l'autre.
    const echec: TcoResult = { ...t, amountRecovery: vue(['NOT_FOUND', 'READING']), reliability: { ...t.reliability, warnings: [...t.reliability.warnings, 'AMOUNTS_RECOVERY_PENDING'] } };
    const d = item(echec, 'AMOUNTS_UNKNOWN')!;
    expect(d).toMatchObject({ status: 'OPEN', count: 1, title: 'Montant à confirmer', sources: [expect.objectContaining({ fileId: 91, detail: 'Montant introuvable', amountCents: null })] });
    expect(item(echec, 'AMOUNTS_RECOVERY_PENDING')!.sources.map((s) => s.fileId)).toEqual([92]);
    expect(echec.status).toBe('INCOMPLETE');
    // Montant retrouvé (justificatif relu avec son montant) : plus aucun message.
    const retrouve = computeTco(entree({ documents: [reparation(91, 4_500, '2026-05-01'), reparation(92, 3_000, '2026-05-02')] }));
    expect(diag(retrouve).items.filter((x) => x.code.startsWith('AMOUNTS'))).toEqual([]);
  });

  it('L109C-R09 — sans valorisation actuelle : aucune alerte, TCO historique complet (#646)', () => {
    const t = computeTco(entree({ valuationHistory: [] }));
    expect(t.status).toBe('COMPLETE');
    expect(diag(t)).toMatchObject({ open: { families: 0 }, completeness: 'COMPLETE' });
    expect(JSON.stringify(diag(t))).not.toMatch(/valorisation/i);
  });

  it('L109C-R10 — aucun signalement : aucun cas ouvert ; COMPLETE n’est jamais « exhaustif » (texte de la fiche)', () => {
    const t = computeTco(entree({ documents: [reparation(101, 5_000, '2025-05-05')] }));
    expect(diag(t).items.filter((d) => d.status !== 'INFORMATIONAL')).toEqual([]);
    const ui = lire('src/components/assets/TcoSection.tsx');
    expect(ui).not.toContain('Calcul complet :');
    // Lot 113X (#722, décision PO) : la ligne « Aucune anomalie détectée sur N élément(s) documenté(s) » est
    // SUPPRIMÉE, sans remplacement (« Aucune incohérence détectée » interdit) : aucun état positif affiché.
    expect(ui).not.toContain('Aucune anomalie détectée');
    expect(ui).not.toContain('Aucune incohérence détectée');
    expect(ui).toContain("t.status !== 'COMPLETE' && (");
  });

  it('L109C-R11 — plusieurs familles : ordre selon l’impact réel (anomalie > couverture ; total > période ; montant en jeu), pas l’ordre des codes', () => {
    const futur = comp('REALIZED_COST', 20_000, { economicDate: '2026-12-15' });
    const t = computeTco(entree({
      assetPrice: null, assetAcquisitionDate: null,
      operations: [op(11, 'INTERVENTION', [futur], { realizedDate: '2026-12-15' })], componentProvenance: new Map([[futur.id, pv([111])]]),
      documents: [sansMontant(112)],
    }));
    const codes = diag(t).items.filter((d) => d.status === 'OPEN').map((d) => d.code);
    expect(codes[0]).toBe('STATUS_CONTRADICTIONS');
    expect(codes.indexOf('AMOUNTS_UNKNOWN')).toBeLessThan(codes.indexOf('ACQUISITION_DATE_MISSING'));
    expect(codes.indexOf('ACQUISITION_COST_MISSING')).toBeLessThan(codes.indexOf('ACQUISITION_DATE_MISSING'));
    expect(item(t, 'ACQUISITION_DATE_MISSING')).toMatchObject({ count: 1, sources: [expect.objectContaining({ assetField: 'acquisitionDate' })], action: { kind: 'ASSET_FIELD', field: 'acquisitionDate' } });
  });

  it('L109C-R12 — sécurité : un signalement d’anomalie sans source retrouvée reste affiché (jamais masqué), nombre inconnu', () => {
    const t = computeTco(entree());
    const force: TcoResult = { ...t, reliability: { ...t.reliability, warnings: [...t.reliability.warnings, 'UNCERTAIN_MATCHES'] } };
    expect(item(force, 'UNCERTAIN_MATCHES')).toMatchObject({ status: 'OPEN', traced: false, count: null, sources: [] });
    const ecart: TcoResult = { ...t, reliability: { ...t.reliability, anomalies: [{ code: 'SUM_MISMATCH', detail: 'x' } as never] } };
    expect(item(ecart, 'LEDGER_ANOMALY')).toMatchObject({ status: 'OPEN', count: 1 });
  });

  it('L109C-R13 — décision de l’utilisateur : information, pas un avertissement obsolète ; un code d’information n’apparaît que s’il porte sur une ligne', () => {
    const t = computeTco(entree({ documents: [reparation(121, 5_000, '2025-05-05')] }));
    const l = t.lines.find((x) => x.fileId === 121)!;
    const u = computeTco(entree({ documents: [reparation(121, 5_000, '2025-05-05')], userDecisions: [{ key: l.decisionKey!, decision: 'EXCLUDE', decidedAt: '2026-11-01T10:00:00Z', decidedByUserId: 1 } as never] }));
    expect(item(u, 'USER_DECISIONS')).toMatchObject({ nature: 'INFORMATION', count: 1 });
    expect(ouverts(u)).toEqual([]);
    expect(item(t, 'USER_DECISIONS')).toBeUndefined();
  });

  it('L109C-R14 — compteur des non retenues = des LIGNES (toutes, pas la page), motifs consultables ; sources bornées, nombre exact', () => {
    const docs = Array.from({ length: 60 }, (_, i) => sansMontant(2_000 + i));
    const t = computeTco(entree({ documents: docs }));
    const dto = toTcoDto(t, { linesLimit: 10 });
    expect(dto.linesTruncated).toBe(true);
    expect(dto.otherLinesByReason.reduce((n, m) => n + m.count, 0)).toBe(dto.otherLinesTotal);
    const d = dto.diagnostics.items.find((x) => x.code === 'AMOUNTS_UNKNOWN')!;
    expect(d.count).toBe(60);
    expect(d.sources).toHaveLength(TCO_DIAGNOSTIC_MAX_SOURCES);
    expect(d.sourcesTruncated).toBe(true);
    expect(dto.diagnostics.reviewLineIds).toHaveLength(60);
  });
});

describe('L109C-D — DTO rétrocompatible', () => {
  it('L109C-D01 — warningLabels et reliability.warnings conservés (consommateurs existants, BO) ; diagnostics ajoutés', () => {
    const futur = comp('REALIZED_COST', 20_000, { economicDate: '2026-12-15' });
    const t = computeTco(entree({ operations: [op(2, 'INTERVENTION', [futur], { realizedDate: '2026-12-15' })], componentProvenance: new Map([[futur.id, pv([21])]]) }));
    const dto = toTcoDto(t);
    expect(dto.warningLabels).toEqual(t.reliability.warnings.filter((w) => w !== 'AMOUNTS_RECOVERY_PENDING').map((w) => TCO_WARNING_LABELS[w]));
    expect(dto.reliability.warnings).toEqual(t.reliability.warnings);
    expect(dto.diagnostics.items.map((d) => d.code)).toContain('STATUS_CONTRADICTIONS');
    expect(dto.diagnostics.completeness).toBe(t.status);
    // Trace BO jamais transmise à la fiche via les diagnostics : ni résolution de date, ni entrées.
    expect(JSON.stringify(dto.diagnostics)).not.toMatch(/economicDate"|legacyDate|"entries"/);
  });

  it('L109C-D02 — BO : la route de diagnostic expose les mêmes diagnostics, la vue BO les affiche sans couleur brute', () => {
    expect(lire('src/app/api/admin/operations/tco/route.ts')).toContain('computeTcoDiagnostics(complet');
    const bo = lire('src/app/admin/operations/_components/TcoDiagnostic.tsx');
    expect(bo).toContain('data-bo-tco-diagnostic=');
    expect(bo).not.toMatch(/#[0-9a-fA-F]{3,6}\b|text-(red|green|amber|orange)-\d/);
  });
});

describe('L109C-U — fiche (desktop et mobile, même composant)', () => {
  const ui = lire('src/components/assets/TcoSection.tsx');
  const comp109 = lire('src/components/assets/tco-diagnostics.tsx');

  it('L109C-U01 — plus de bloc « Alertes de couverture » ; « Points à vérifier » seulement s’il existe un cas ouvert ; informations séparées', () => {
    expect(ui).not.toContain('Alertes de couverture');
    expect(ui).not.toMatch(/t\.warningLabels\.map/);
    expect(ui).toMatch(/\{diag && diag\.open\.families > 0 && \(\s*<Bloc title=\{`Points à vérifier/);
    expect(ui).toContain('<TcoInformationDiagnostics');
    // 108B : lecture en cours = bloc neutre existant, limité aux contrôles en attente. Lot 111V (décision du ticket
    // « TCO — anomalies corrigeables » §D) : états RÉELS (file, lecture RUNNING, reprise prévue, vérification à venir).
    expect(ui).toMatch(/items: t\.amountRecovery\.items\.filter\(\(i\) => AMOUNT_RECOVERY_PENDING_STATES\.has\(i\.state\)\)/);
  });

  it('L109C-U02 — aucune IA, aucune lecture de document, aucune carte « À traiter » à l’affichage ; jamais « Opération » visible', () => {
    for (const src of [ui, comp109]) {
      expect(src).not.toMatch(/services\/ai|to-process\/(?!document-preview)|\/api\/ai|analy[sz]e\(/);
    }
    const visible = comp109.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(visible).not.toMatch(/[Oo]pération/);
  });

  it('L109C-U03 — rendu : groupe avec compteur, nature écrite (pas seulement une couleur), liens justificatif / dépense / fiche', async () => {
    const { TcoOpenDiagnostics, TcoInformationDiagnostics } = await import('@/components/assets/tco-diagnostics');
    const [x, y, z] = [comp('REALIZED_COST', 80_000, { economicDate: '2026-02-01' }), comp('REALIZED_COST', 80_000, { economicDate: '2026-02-03' }), comp('REALIZED_COST', 80_000)];
    const o = op(8, 'INTERVENTION', [x, y, z], { realizedDate: '2026-02-01', documents: [{ fileId: 81, title: 'Facture A', role: 'INVOICE' }] });
    const prevue = comp('REALIZED_COST', 30_000, { economicDate: '2026-12-01' });
    const t = computeTco(entree({
      assetAcquisitionDate: null,
      operations: [o, op(9, 'INTERVENTION', [prevue], { status: 'ENVISAGED', realizedDate: null, plannedDate: '2026-12-01' })],
      componentProvenance: new Map([[x.id, pv([81])], [y.id, pv([82])], [z.id, pv([83])], [prevue.id, pv([91])]]),
    }));
    const d = toTcoDto(t).diagnostics;
    const html = renderToStaticMarkup(React.createElement(TcoOpenDiagnostics, { diagnostics: d, assetId: BIEN, onShowLine: () => {} }));
    expect(html).toContain('data-tco-diagnostic="PRESUMED_DUPLICATES"');
    expect(html).toContain('Même montant sur plusieurs justificatifs d’une dépense (2)');
    expect(html).toContain('À corriger');
    expect(html).toContain('Information manquante');
    expect(html).toContain('data-tco-doc-link="82"');
    expect(html).toContain(`data-tco-diagnostic-show-line="c:${y.id}"`);
    expect(html).toContain('data-tco-diagnostic-field="acquisitionDate"');
    expect(html).toContain(`href="/assets/${BIEN}?tab=details&amp;highlight=acquisitionDate"`);
    // L'information neutre n'est pas dans le bloc des points à vérifier.
    expect(html).not.toContain('NOT_REALIZED_EXPENSES');
    const info = renderToStaticMarkup(React.createElement(TcoInformationDiagnostics, { diagnostics: d, onShowLine: () => {} }));
    expect(info).toContain('data-tco-diagnostic="NOT_REALIZED_EXPENSES"');
    expect(info).toContain('Bon à savoir');
    expect(info).not.toContain('attention');
    // Aucun cas ouvert : rien n'est rendu.
    const vide = renderToStaticMarkup(React.createElement(TcoOpenDiagnostics, { diagnostics: { ...d, items: d.items.filter((i) => i.status !== 'OPEN') }, assetId: BIEN, onShowLine: () => {} }));
    expect(vide).toBe('');
  });

  it('L109C-U04 — « Dépenses non retenues » : lignes et motifs (à revoir / exclusions normales), pas des erreurs ; accessibilité et cibles mobiles', () => {
    expect(ui).toContain('ce sont des lignes, pas des erreurs');
    expect(ui).toContain('data-tco-excluded-summary');
    expect(ui).toContain('data-tco-excluded-review');
    expect(ui).toContain('Exclusions normales');
    expect(ui).toContain('À revoir — voir « Points à vérifier »');
    expect(ui).toMatch(/aria-label=\{`Dépenses non retenues : /);
    expect(comp109).toContain('min-h-[44px] md:min-h-0');
    expect(comp109).toMatch(/aria-labelledby="tco-informations-titre"/);
  });
});
