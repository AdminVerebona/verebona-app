/**
 * Lot 80A — tiroir TCO : « Ajouter au TCO » / « Retirer du TCO » (décision
 * utilisateur persistée, réversible, prioritaire sur les règles automatiques).
 * Tests PURS sur le moteur RÉEL (`computeTco` + `./user-decisions`) ; écriture
 * en base, route, droits, T2 et diagnostic BO sur PostgreSQL 16 :
 * `src/test/e2e/scenarios/l80a-tco-decisions.e2e.ts`.
 *
 *   L80A-D01 clé stable : justificatif du fait (document, composante), Opération
 *            sans justificatif, fiche — identique avant et après consolidation T3 ;
 *   L80A-D02 Retirer : total, moyenne annuelle, dépenses de l'année à jour ;
 *   L80A-D03 Ajouter un achat non incorporé (78B §3C) : décision prioritaire ;
 *   L80A-D04 Ajouter un doublon présumé (78B §3B) : avertissement explicite,
 *            ligne signalée, jamais à l'insu de l'utilisateur ;
 *   L80A-D05 décision rattachée au fait : survit à la consolidation T3 ;
 *   L80A-D06 un AJOUT ne compte jamais deux fois un fait déjà retenu ;
 *   L80A-D07 lignes non ajoutables (montant inconnu, devise, autre bien…) ;
 *   L80A-D08 la plus récente l'emporte ; décisions sans ligne remontées (BO) ;
 *   L80A-D09 DTO : gestes calculés côté serveur ;
 *   L80A-D10 prévision ajoutée : comptée comme dépense réalisée ; lot 81D (prime) :
 *            une prévision datée après la date de référence n'est pas ajoutable ;
 *   L80A-D11 T2 : ajout pris en compte une seule fois ;
 *   L80A-D12 règles PO inchangées sans décision (achat sans lien non incorporé,
 *            même montant compté une fois, moyenne dès 30 jours) ;
 *   L80A-UI  sous-tiroirs fermés par défaut, gestes desktop et mobile ;
 *   L80A-M   migration 0623 et classement des transferts de biens (DUO-06).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, type TcoAssetPrice, type TcoInput, type TcoOperation, type TcoResult } from '../model';
import { toTcoDto, TCO_WARNING_LABELS } from '../dto';
import { applyTcoUserDecisions, tcoAddDuplicateRisk, tcoLineAddable, tcoLineKeys, type TcoUserDecision } from '../user-decisions';
import { parseTcoDecisionBody } from '../user-decisions.service';
import type { ComponentProvenance } from '../fact-identity';
import type { EconomicDocumentCandidate, EconomicDocumentInput, EconomicHint } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';
import { addUserAddedExpenses, type ExpenseEntry, type OperationAggregateEntry } from '@/services/verebona-assistant/canonical/expenses';
import { ASSET_SCOPED_TABLES } from '@/services/assets/asset-account-transfer.service';

const MAISON = 80;
const TODAY = '2026-10-22';
let seq = 80_000;

const hint = (role: string, amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'INTERVENTION', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [],
  targets: [{ type: 'ASSET', entityId: MAISON }], hints, t3Outcome: null, ...o,
});
const doc = (fileId: number, cents: number | null, date: string | null, o: Partial<EconomicDocumentInput> = {}, c: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentInput => ({
  fileId, title: `Facture ${fileId}`, typeCode: 'REPAIR_INVOICE', legacyType: null, date, supplier: null,
  amountCents: cents, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [MAISON], multiAsset: false, candidates: cents == null ? [] : [cand([hint('REALIZED_COST', cents)], c)], operations: [], ...o,
});
const comp = (kind: FinancialComponentKind, cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: '2025-03-01', startDate: null, plannedDate: null,
  assetIds: [MAISON], label: typeCode, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const pv = (documentFileIds: number[], o: Partial<ComponentProvenance> = {}): ComponentProvenance => ({
  documentFileIds, withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: documentFileIds.length ? true : null, ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: MAISON, today: TODAY, operations: [], assetAcquisitionDate: '2024-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: prix(30_000_000),
  assetCategory: 'IMMOBILIER', ...o,
});
const dec = (key: string, decision: 'INCLUDE' | 'EXCLUDE', decidedAt = '2026-10-22T10:00:00.000Z'): TcoUserDecision => ({ key, decision, decidedAt, decidedByUserId: 1 });
const coherent = (t: TcoResult) => {
  const a = t.annual;
  const somme = a.years.reduce((n, y) => n + y.netCents, 0) + (a.undated.costsCents - a.undated.creditsCents);  // 81D : plus de dépenses « futures » retenues
  expect(somme).toBe(t.summary.cumulativeCostCents);
  expect(a.average.totalCents).toBe(t.summary.cumulativeCostCents);
  expect(t.reliability.anomalies.filter((x) => x.code === 'SUM_MISMATCH' || x.code === 'DUPLICATE_COMPONENT' || x.code === 'UNALLOCATED_COUNTED')).toEqual([]);
};
const ligneDoc = (t: TcoResult, fileId: number) => t.lines.find((l) => l.source === 'DOCUMENT' && l.fileId === fileId)!;
const annee = (t: TcoResult, y: number) => t.annual.years.find((a) => a.year === y)!;
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

/** Opération mêlée du lot 78B (#76) : commande de chaises + prix de la maison porté par trois justificatifs. */
function operation76() {
  const chaises = comp('REALIZED_COST', 27_735, { economicDate: '2021-06-03' });
  const acte = comp('REALIZED_COST', 30_000_000, { economicDate: '2024-01-10' });
  const attestation = comp('REALIZED_COST', 30_000_000, { economicDate: '2025-02-01' });
  const o = op(76, 'ACQUISITION', [chaises, acte, attestation], {
    label: 'Achat — Commande de mobilier', realizedDate: '2024-01-10',
    documents: [{ fileId: 10, title: 'Commande mobilier', role: 'INVOICE' }, { fileId: 11, title: 'Acte de vente', role: 'OTHER_EVIDENCE' }, { fileId: 12, title: 'Attestation', role: 'OTHER_EVIDENCE' }],
  });
  const provenance = new Map<number, ComponentProvenance>([[chaises.id, pv([10], { invoiceRefs: ['FA2021'] })], [acte.id, pv([11])], [attestation.id, pv([12])]]);
  return { o, chaises, acte, attestation, provenance };
}

describe('L80A-D — décisions « Ajouter / Retirer du TCO »', () => {
  it('L80A-D01 — clé stable : justificatif du fait, Opération sans justificatif, fiche ; identique avant / après T3', () => {
    expect(tcoLineKeys({ id: 'doc:501:9:0', source: 'DOCUMENT', kind: 'REALIZED_COST', amountMinor: 2_999, currency: 'EUR', fileId: 501, operationId: null }).primary)
      .toBe('f:501:REALIZED_COST:2999:EUR');
    // Composante : SES justificatifs (le justificatif affiché en clé principale, les autres en secondaires).
    expect(tcoLineKeys({ id: 'c:9', source: 'OPERATION', kind: 'REALIZED_COST', amountMinor: 2_999, currency: 'EUR', fileId: 502, sourceFileIds: [503, 502], operationId: 4 }))
      .toEqual({ primary: 'f:502:REALIZED_COST:2999:EUR', secondary: ['f:503:REALIZED_COST:2999:EUR'] });
    // Sans justificatif (fiche, saisie) : l'Opération (stable aux supersessions de composantes).
    expect(tcoLineKeys({ id: 'c:10', source: 'OPERATION', kind: 'REALIZED_COST', amountMinor: 100, currency: 'EUR', fileId: 777, sourceFileIds: [], operationId: 4 }).primary)
      .toBe('o:4:REALIZED_COST:100:EUR');
    expect(tcoLineKeys({ id: 'asset:80:acquisitionPrice', source: 'ASSET_DATA', kind: 'REALIZED_COST', amountMinor: 1, currency: 'EUR', fileId: null, operationId: null }).primary)
      .toBe('asset:80:acquisitionPrice');
    // Même fait avant T3 (justificatif seul) et après T3 (composante citant ce justificatif) : même clé.
    const avant = computeTco(entree({ documents: [doc(501, 2_999, '2026-10-09')] }));
    const c = comp('REALIZED_COST', 2_999, { economicDate: '2026-10-09' });
    const apres = computeTco(entree({
      operations: [op(40, 'CONTRACT', [c], { documents: [{ fileId: 501, title: 'Facture 501', role: 'INVOICE' }] })],
      componentProvenance: new Map([[c.id, pv([501])]]),
      documents: [doc(501, 2_999, '2026-10-09', { operations: [{ operationId: 40, label: 'Contrat', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: true, typeCode: 'CONTRACT', citesForOtherAssetOnly: false, citesOtherDocuments: false, freeComponents: [] }] })],
    }));
    expect(ligneDoc(avant, 501).decisionKey).toBe('f:501:REALIZED_COST:2999:EUR');
    expect(apres.lines.find((l) => l.id === `c:${c.id}`)!.decisionKey).toBe('f:501:REALIZED_COST:2999:EUR');
  });

  it('L80A-D02 — Retirer : TCO total, TCO moyen annuel et dépenses de l’année reflètent la décision', () => {
    const docs = [doc(601, 50_000, '2026-04-02'), doc(602, 12_000, '2025-05-03')];
    const sans = computeTco(entree({ documents: docs }));
    const k = ligneDoc(sans, 601).decisionKey!;
    const avec = computeTco(entree({ documents: docs, userDecisions: [dec(k, 'EXCLUDE')] }));
    expect(avec.summary.cumulativeCostCents).toBe(sans.summary.cumulativeCostCents - 50_000);
    expect(annee(avec, 2026).costsCents).toBe(annee(sans, 2026).costsCents - 50_000);
    expect(annee(avec, 2025).costsCents).toBe(annee(sans, 2025).costsCents);
    expect(avec.annual.average.cents!).toBeLessThan(sans.annual.average.cents!);
    expect(ligneDoc(avec, 601)).toMatchObject({
      status: 'EXCLUDED', reason: 'USER_EXCLUDED', includedCents: 0,
      userDecision: { decision: 'EXCLUDE', applied: true, automaticStatus: 'RETAINED_DIRECT', automaticReason: null, decidedByUserId: 1 },
    });
    expect(avec.reliability.warnings).toContain('USER_DECISIONS');
    expect(avec.status).toBe(sans.status);
    coherent(avec);
    // Réversible : sans la décision, le résultat automatique revient à l'identique.
    expect(computeTco(entree({ documents: docs, userDecisions: [] })).summary).toEqual(sans.summary);
  });

  it('L80A-D03 — Ajouter un achat non incorporé (achat sans lien avec la maison) : la décision prime, signalement 78B retiré', () => {
    const { o, chaises, provenance } = operation76();
    const base = entree({ operations: [o], componentProvenance: provenance });
    const sans = computeTco(base);
    const ligne = sans.lines.find((l) => l.id === `c:${chaises.id}`)!;
    expect(ligne).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_OWNERSHIP_COST' }); // règle PO inchangée par défaut
    expect(sans.reliability.warnings).toContain('NOT_OWNERSHIP_COSTS');
    expect(tcoLineAddable(ligne)).toEqual({ ok: true });
    expect(tcoAddDuplicateRisk(ligne, sans.lines)).toBeNull();
    const avec = computeTco({ ...base, userDecisions: [dec(ligne.decisionKey!, 'INCLUDE')] });
    expect(avec.summary.cumulativeCostCents).toBe(sans.summary.cumulativeCostCents + 27_735);
    expect(avec.lines.find((l) => l.id === `c:${chaises.id}`)).toMatchObject({
      status: 'RETAINED_CONSOLIDATED', reason: null, includedCents: 27_735, category: 'ACCESSORIES',
      userDecision: { decision: 'INCLUDE', applied: true, automaticReason: 'NOT_OWNERSHIP_COST' },
    });
    expect(avec.reliability.warnings).not.toContain('NOT_OWNERSHIP_COSTS');
    expect(avec.reliability.warnings).toContain('USER_DECISIONS');
    expect(avec.summary.acquisitionCents).toBe(sans.summary.acquisitionCents); // jamais « l'acquisition du bien »
    expect(annee(avec, 2021).costsCents).toBe(27_735);
    coherent(avec);
  });

  it('L80A-D04 — Ajouter un doublon présumé : avertissement explicite avant, ligne comptée et signalée après', () => {
    const { o, attestation, provenance } = operation76();
    const base = entree({ operations: [o], componentProvenance: provenance });
    const sans = computeTco(base);
    const ligne = sans.lines.find((l) => l.id === `c:${attestation.id}`)!;
    expect(ligne).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_FACT_OTHER_DOCUMENT' }); // même montant compté une fois
    const risque = tcoAddDuplicateRisk(ligne, sans.lines);
    expect(risque).toMatch(/^Doublon présumé : .*deux fois/);
    // DTO : le texte de la confirmation est fourni par le serveur.
    const dto = toTcoDto(sans);
    expect(dto.lines.find((l) => l.id === ligne.id)!.actions).toMatchObject({ addable: true, removable: false, duplicateWarning: risque });
    const avec = computeTco({ ...base, userDecisions: [dec(ligne.decisionKey!, 'INCLUDE')] });
    expect(avec.summary.cumulativeCostCents).toBe(sans.summary.cumulativeCostCents + 30_000_000);
    const l2 = avec.lines.find((l) => l.id === ligne.id)!;
    expect(l2.status).toBe('RETAINED_CONSOLIDATED');
    expect(l2.note).toContain('Doublon présumé');
    expect(l2.duplicateOf).toBeUndefined();
    expect(avec.reliability.warnings).toEqual(expect.arrayContaining(['USER_DECISIONS', 'USER_INCLUDED_DUPLICATES']));
    expect(avec.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    expect(avec.userDecisions).toMatchObject({ applied: 1, includedDuplicates: 1 });
    expect(TCO_WARNING_LABELS.USER_INCLUDED_DUPLICATES).toMatch(/même paiement/);
    coherent(avec);
  });

  it('L80A-D05 — la décision est rattachée au fait : prise sur le justificatif, elle s’applique à la composante après T3', () => {
    const avant = computeTco(entree({ documents: [doc(701, 4_050, '2026-08-05')] }));
    const k = ligneDoc(avant, 701).decisionKey!;
    const c = comp('REALIZED_COST', 4_050, { economicDate: '2026-08-05' });
    // Reconsolidation : nouvelle composante (identifiant différent), même justificatif.
    const apres = computeTco(entree({
      operations: [op(41, 'CONTRACT', [c], { documents: [{ fileId: 701, title: 'Facture 701', role: 'INVOICE' }] })],
      componentProvenance: new Map([[c.id, pv([701])]]),
      documents: [doc(701, 4_050, '2026-08-05', { operations: [{ operationId: 41, label: 'Contrat', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: true, typeCode: 'CONTRACT', citesForOtherAssetOnly: false, citesOtherDocuments: false, freeComponents: [] }] })],
      userDecisions: [dec(k, 'EXCLUDE')],
    }));
    expect(apres.lines.find((l) => l.id === `c:${c.id}`)).toMatchObject({ status: 'EXCLUDED', reason: 'USER_EXCLUDED', includedCents: 0 });
    expect(apres.summary.cumulativeCostCents).toBe(30_000_000);
    expect(apres.userDecisions.orphans).toEqual([]);
    coherent(apres);
  });

  it('L80A-D06 — un AJOUT ne compte jamais deux fois un fait déjà retenu (lignes de même clé)', () => {
    const c = comp('REALIZED_COST', 4_050, { economicDate: '2026-08-05' });
    const base = entree({
      operations: [op(42, 'CONTRACT', [c], { documents: [{ fileId: 702, title: 'Facture 702', role: 'INVOICE' }] })],
      componentProvenance: new Map([[c.id, pv([702])]]),
      documents: [doc(702, 4_050, '2026-08-05', { operations: [{ operationId: 42, label: 'Contrat', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: true, typeCode: 'CONTRACT', citesForOtherAssetOnly: false, citesOtherDocuments: false, freeComponents: [] }] })],
    });
    const sans = computeTco(base);
    const avec = computeTco({ ...base, userDecisions: [dec('f:702:REALIZED_COST:4050:EUR', 'INCLUDE')] });
    expect(avec.summary.cumulativeCostCents).toBe(sans.summary.cumulativeCostCents);
    expect(avec.userDecisions.applied).toBe(0);
    expect(avec.lines.filter((l) => l.userDecision).every((l) => l.userDecision!.applied === false)).toBe(true);
    // Application directe : une décision AJOUTER visant deux lignes non retenues n'en compte qu'UNE.
    const l1 = { ...ligneDoc(sans, 702), id: 'doc:702:a', status: 'NOT_QUALIFIED' as const, reason: 'THEME_UNKNOWN' as const, includedCents: 0 };
    const l2 = { ...l1, id: 'doc:702:b' };
    const r = applyTcoUserDecisions({ lines: [l1, l2], entries: [], decisions: [dec(l1.decisionKey!, 'INCLUDE')], operationCategory: new Map(), warnings: new Set() });
    expect(r.applied).toBe(1);
    expect([l1, l2].filter((l) => l.includedCents > 0)).toHaveLength(1);
  });

  it('L80A-D07 — jamais ajoutables : montant inconnu, devise sans contre-valeur, autre bien, déjà portée ailleurs, règlement', () => {
    expect(tcoLineAddable({ status: 'NOT_QUALIFIED', kind: 'REALIZED_COST', eurCents: null, amountUnknown: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/Montant inconnu/) });
    expect(tcoLineAddable({ status: 'UNCONVERTED', kind: 'REALIZED_COST', eurCents: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/devise/) });
    expect(tcoLineAddable({ status: 'OUT_OF_SCOPE', kind: 'REALIZED_COST', eurCents: 100 })).toMatchObject({ ok: false });
    expect(tcoLineAddable({ status: 'CONSOLIDATED_ELSEWHERE', kind: 'REALIZED_COST', eurCents: 100 })).toMatchObject({ ok: false });
    expect(tcoLineAddable({ status: 'PAYMENT', kind: null, eurCents: 100 })).toMatchObject({ ok: false, reason: expect.stringMatching(/pas une dépense/) });
    // Décision d'ajout sur un justificatif sans montant lisible : sans effet (jamais 0 € compté, jamais un montant inventé).
    const docs = [doc(801, null, '2026-02-02', { typeCode: 'REPAIR_INVOICE' })];
    const sans = computeTco(entree({ documents: docs }));
    const inconnu = sans.lines.find((l) => l.fileId === 801)!;
    expect(inconnu.amountUnknown).toBe(true);
    const avec = computeTco(entree({ documents: docs, userDecisions: [dec(inconnu.decisionKey!, 'INCLUDE')] }));
    expect(avec.summary.cumulativeCostCents).toBe(sans.summary.cumulativeCostCents);
    expect(avec.lines.find((l) => l.fileId === 801)!.userDecision?.applied).toBe(false);
  });

  it('L80A-D08 — plusieurs décisions sur un fait : la plus récente l’emporte ; décision sans ligne : remontée (BO)', () => {
    const docs = [doc(901, 7_000, '2026-03-03')];
    const k = ligneDoc(computeTco(entree({ documents: docs })), 901).decisionKey!;
    const t = computeTco(entree({
      documents: docs,
      userDecisions: [dec(k, 'EXCLUDE', '2026-10-22T09:00:00.000Z'), dec(k, 'INCLUDE', '2026-10-22T11:00:00.000Z'), dec('f:999:REALIZED_COST:1:EUR', 'EXCLUDE')],
    }));
    expect(ligneDoc(t, 901)).toMatchObject({ status: 'RETAINED_DIRECT', userDecision: { decision: 'INCLUDE', applied: false } });
    expect(t.userDecisions.orphans.map((o) => o.key)).toEqual(['f:999:REALIZED_COST:1:EUR']);
  });

  it('L80A-D09 — DTO : « Retirer » sur les retenues, « Ajouter » sur les non retenues, motif de blocage en langage utilisateur', () => {
    const t = computeTco(entree({ documents: [doc(1001, 5_000, '2026-01-05'), doc(1002, null, '2026-01-06')] }));
    const dto = toTcoDto(t);
    const retenue = dto.lines.find((l) => l.fileId === 1001)!;
    expect(retenue.actions).toEqual({ removable: true, addable: false, addBlockedReason: null, duplicateWarning: null });
    const inconnue = dto.lines.find((l) => l.fileId === 1002)!;
    expect(inconnue.actions).toMatchObject({ removable: false, addable: false, addBlockedReason: expect.stringMatching(/Montant inconnu/) });
    expect(dto.lineReasonLabels.USER_EXCLUDED).toBe('Retirée du coût de possession par vous');
    // Le prix d'achat (fiche) est une dépense retirable ; aucune ligne PROCEED ne l'est.
    expect(dto.lines.find((l) => l.source === 'ASSET_DATA')!.actions!.removable).toBe(true);
    // Annuler un retrait ne présente pas d'avertissement de doublon.
    const k = t.lines.find((l) => l.fileId === 1001)!.decisionKey!;
    const ex = toTcoDto(computeTco(entree({ documents: [doc(1001, 5_000, '2026-01-05')], userDecisions: [dec(k, 'EXCLUDE')] })));
    expect(ex.lines.find((l) => l.fileId === 1001)!.actions).toMatchObject({ addable: true, duplicateWarning: null });
  });

  // Lot 81D (le ticket du 22/10 prime sur 80A) : une dépense non réalisée ne contribue à AUCUN indicateur, même ajoutée.
  it('L80A-D10 — prévision ajoutée : comptée comme dépense réalisée ; datée dans le futur : non ajoutable (81D), décision existante sans effet', () => {
    const passe = doc(1102, 40_000, '2026-03-15', { typeCode: 'WORKS_QUOTE' }, { sourceRole: 'QUOTE', statusHint: 'ENVISAGED', hints: [hint('FORECAST_COST', 40_000, { economicDate: '2026-03-15' })] });
    const sansP = computeTco(entree({ documents: [passe] }));
    const lp = ligneDoc(sansP, 1102);
    expect(tcoLineAddable(lp).ok).toBe(true);
    const avecP = computeTco(entree({ documents: [passe], userDecisions: [dec(lp.decisionKey!, 'INCLUDE')] }));
    expect(avecP.summary.cumulativeCostCents).toBe(sansP.summary.cumulativeCostCents + 40_000);
    expect(ligneDoc(avecP, 1102)).toMatchObject({ kind: 'REALIZED_COST', status: 'RETAINED_DIRECT', annualYear: 2026 });
    coherent(avecP);
    const devis = doc(1101, 80_000, '2026-12-15', { typeCode: 'WORKS_QUOTE' }, { sourceRole: 'QUOTE', statusHint: 'ENVISAGED', hints: [hint('FORECAST_COST', 80_000, { economicDate: '2026-12-15' })] });
    const sans = computeTco(entree({ documents: [devis] }));
    const l = ligneDoc(sans, 1101);
    expect(l.includedCents).toBe(0);
    expect(tcoLineAddable(l)).toMatchObject({ ok: false, reason: expect.stringMatching(/non encore réalisée/) });
    const avec = computeTco(entree({ documents: [devis], userDecisions: [dec(l.decisionKey!, 'INCLUDE')] }));
    expect(avec.summary.cumulativeCostCents).toBe(sans.summary.cumulativeCostCents);
    expect(ligneDoc(avec, 1101)).toMatchObject({ includedCents: 0, userDecision: { applied: false } });
    coherent(avec);
  });

  it('L80A-D11 — T2 : une dépense ajoutée au TCO est comptée une fois (jamais si T2 la compte déjà)', () => {
    const entries: ExpenseEntry[] = [{ fileId: 1, amountCents: 500, cls: { kind: 'theme', theme: 'repair' } }, { fileId: 2, amountCents: 900, cls: { kind: 'excluded', reason: 'QUOTE' } }];
    const operations: OperationAggregateEntry[] = [];
    addUserAddedExpenses([
      { source: 'DOCUMENT', lineId: 'doc:1', operationId: null, componentId: null, fileId: 1, eurCents: 500, date: '2026-01-01', label: 'a', automaticReason: 'DUPLICATE_COPY' },
      { source: 'DOCUMENT', lineId: 'doc:2', operationId: null, componentId: null, fileId: 2, eurCents: 900, date: '2026-01-01', label: 'b', automaticReason: 'QUOTE' },
      { source: 'OPERATION', lineId: 'c:3', operationId: 3, componentId: 3, fileId: null, eurCents: 27_735, date: '2021-06-03', label: 'c', automaticReason: 'NOT_OWNERSHIP_COST' },
      { source: 'OPERATION', lineId: 'c:4', operationId: 4, componentId: 4, fileId: null, eurCents: 1_000, date: '2026-01-01', label: 'd', automaticReason: 'FORECAST' },
    ], { entries, operations, docs: [{ id: 2, v2: 'WORKS_QUOTE', legacy: null }], year: null });
    expect(entries).toEqual([{ fileId: 1, amountCents: 500, cls: { kind: 'theme', theme: 'repair' } }, { fileId: 2, amountCents: 900, cls: { kind: 'theme', theme: 'other' } }]);
    // Composante libérée d'une exclusion 78B : T2 la compte lui-même (pas d'ajout) ; prévision : ajoutée.
    expect(operations).toEqual([{ operationId: 4, amountCents: 1_000, theme: 'other' }]);
  });

  // Lot 81D (prime) : la moyenne annuelle n'a plus de seuil de durée (« dès 30 jours » remplacé par « dès le premier jour »).
  it('L80A-D12 — sans décision, règles PO inchangées (achat sans lien non incorporé, même montant compté une fois) ; moyenne sans seuil (81D)', () => {
    const { o, provenance } = operation76();
    const t = computeTco(entree({ operations: [o], componentProvenance: provenance }));
    expect(t.lines.filter((l) => l.userDecision)).toEqual([]);
    expect(t.userDecisions).toEqual({ applied: 0, includedDuplicates: 0, orphans: [] });
    expect(t.reliability.warnings).toEqual(expect.arrayContaining(['NOT_OWNERSHIP_COSTS', 'PRESUMED_DUPLICATES']));
    expect(t.reliability.warnings).not.toContain('USER_DECISIONS');
    expect(t.annual.average).not.toHaveProperty('minDays');
  });

  it('L80A-D13 — corps de la requête validé (geste, ligne)', () => {
    expect(parseTcoDecisionBody({ lineId: 'c:1', action: 'INCLUDE', confirmDuplicate: true })).toEqual({ ok: true, value: { lineId: 'c:1', lineKey: null, action: 'INCLUDE', confirmDuplicate: true } });
    expect(parseTcoDecisionBody({ lineId: 'c:1', action: 'DELETE' }).ok).toBe(false);
    expect(parseTcoDecisionBody({ action: 'EXCLUDE' }).ok).toBe(false);
    expect(parseTcoDecisionBody(null).ok).toBe(false);
  });
});

describe('L80A-UI — sous-tiroirs et gestes (desktop et mobile, même composant)', () => {
  const ui = lire('src/components/assets/TcoSection.tsx');

  it('L80A-UI-01 — « Dépenses retenues (N) » et « Dépenses non retenues (N) » : déclencheurs fermés par défaut, sous-tiroirs distincts', () => {
    expect(ui).toMatch(/useState\(false\)[^\n]*\/\/ L76G : sous-tiroir fermé par défaut/);
    expect(ui).toMatch(/useState\(false\)[^\n]*\/\/ L80A : sous-tiroir des non retenues fermé par défaut/);
    expect(ui).toContain('data-tco-excluded-trigger');
    expect(ui).toMatch(/`Dépenses non retenues \(\$\{ecartees\.length\}/);
    expect(ui).toMatch(/<SheetContent side="right"[^>]*className="w-full sm:max-w-lg[^"]*"[^>]*data-tco-excluded-drawer/);
    // La liste des non retenues n'est plus rendue dans le tiroir principal.
    const principal = ui.slice(0, ui.indexOf('<Sheet open={retainedOpen}'));
    expect(principal).not.toMatch(/ecartees\.map/);
    const declencheur = ui.slice(ui.lastIndexOf('<button', ui.indexOf('data-tco-excluded-trigger')), ui.indexOf('data-tco-excluded-trigger'));
    expect(declencheur).toContain('aria-expanded={excludedOpen}');
    expect(declencheur).toContain('min-h-[44px] md:min-h-[36px]');
    // Motif de chaque ligne non retenue en langage utilisateur.
    expect(ui).toContain('data-tco-line-reason');
    expect(ui).toContain('t.lineReasonLabels[l.reason]');
  });

  it('L80A-UI-02 — « Retirer du TCO » / « Ajouter au TCO » : gestes du serveur, confirmation légère, doublon annoncé, totaux remplacés par la réponse', () => {
    expect(ui).toContain("retenue ? 'Retirer du TCO' : 'Ajouter au TCO'");
    expect(ui).toMatch(/retenue \? actions\.removable : actions\.addable/);
    expect(ui).toContain('data-tco-decision-confirm');
    expect(ui).toContain('data-tco-duplicate-warning');
    expect(ui).toContain("'Ajouter quand même'");
    expect(ui).toContain('`/api/assets/${assetId}/tco/decisions`');
    expect(ui).toMatch(/setData\(r\.tco\);\s*setExtra\(\[\]\);/);
    expect(ui).toContain("err.code === 'DUPLICATE_CONFIRMATION_REQUIRED'");
    // Lecture seule (Standard verrouillé, droits insuffisants) : aucun geste.
    expect(ui).toMatch(/canEdit && onDecide && actions && !confirm/);
    // Les deux sous-tiroirs et les ajustements passent les gestes.
    // Lot 81D : + avoirs / remboursements / indemnités de l'année dans le sous-tiroir des retenues.
    expect((ui.match(/canEdit=\{canEdit\} onDecide=\{decide\}/g) ?? []).length).toBe(4);
  });
});

describe('L80A-M — migration 0623 et transferts de biens', () => {
  it('L80A-M01 — tables idempotentes, décision unique par bien et clé, journal append-only, garde d’isolation', () => {
    const m = lire('src/db/migrations/0623_l80a_tco_decisions_utilisateur.sql');
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS asset_cost_line_decisions/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS asset_cost_line_decision_events/);
    expect(m).toMatch(/UNIQUE \(account_id, asset_id, line_key\)/);
    expect(m).toMatch(/decision IN \('INCLUDE', 'EXCLUDE'\)/);
    expect(m).toMatch(/action IN \('INCLUDE', 'EXCLUDE', 'REVERT'\)/);
    expect(m).toMatch(/DROP TRIGGER IF EXISTS asset_cost_line_decisions_isolation_guard/);
    const idx = lire('src/db/migrations/0623_l80a_tco_decisions_utilisateur_idx_1.sql');
    expect(idx.split('\n').filter((l) => l.trim() && !l.startsWith('--'))).toHaveLength(2);
    expect(idx).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_cost_line_decision_events_asset_idx/);
  });

  it('L80A-M02 — les décisions et leur journal suivent le bien (ASSET_SCOPED_TABLES, L40 DUO-06)', () => {
    expect(ASSET_SCOPED_TABLES).toEqual(expect.arrayContaining(['asset_cost_line_decisions', 'asset_cost_line_decision_events']));
  });
});
