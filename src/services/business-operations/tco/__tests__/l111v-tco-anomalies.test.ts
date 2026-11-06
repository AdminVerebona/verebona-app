/**
 * Lot 111V — TCO : chaque anomalie a une issue (ticket P1 « TCO — rendre
 * chaque anomalie corrigeable, fiabiliser les exclusions et clôturer les
 * arbitrages »). Tests du moteur (classification, motif réel d'un ajout
 * impossible, arbitrages), du DTO, des diagnostics, de la récupération des
 * montants (états réels) et de la présentation. E2E base réelle :
 * `src/test/e2e/scenarios/l111v-tco-anomalies.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeTco, type TcoAssetPrice, type TcoInput, type TcoOperation, type TcoResult } from '../model';
import { computeTcoDiagnostics } from '../diagnostics';
import { toTcoDto } from '../dto';
import type { ComponentProvenance } from '../fact-identity';
import {
  tcoDecisionContradicted, tcoLineAddable, tcoLineDecisionOptions, tcoLineKeys, type TcoUserDecision,
} from '../user-decisions';
import { parseTcoDecisionBody } from '../user-decisions.service';
import { planAmountRecovery, viewStateOf, warningsAfterRecovery, amountRecoveryLimits, type AmountRecoveryInput } from '../amount-recovery';
import { classifyExpenseDocument, documentTypeExpectsAmount, AMOUNT_EXPECTED_V2_CODES } from '@/services/verebona-assistant/canonical/expense-classes';
import type { EconomicDocumentCandidate, EconomicDocumentInput, EconomicHint } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

(globalThis as { React?: typeof React }).React = React;

const BIEN = 111;
const TODAY = '2026-11-05';
let seq = 111_000;

const comp = (kind: FinancialComponentKind, cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: '2026-02-01', startDate: null, plannedDate: null,
  assetIds: [BIEN], label: `Abonnement ${id}`, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const pv = (documentFileIds: number[], o: Partial<ComponentProvenance> = {}): ComponentProvenance => ({
  documentFileIds, withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: documentFileIds.length ? true : null, ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const hint = (role: string, amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'OTHER', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [],
  targets: [{ type: 'ASSET', entityId: BIEN }], hints, t3Outcome: null, ...o,
});
const doc = (fileId: number, o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: `Document ${fileId}`, typeCode: 'REPAIR_INVOICE', legacyType: null, date: '2026-03-15', supplier: null,
  amountCents: null, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [BIEN], multiAsset: false, candidates: [], operations: [], ...o,
});
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: BIEN, today: TODAY, operations: [], assetAcquisitionDate: '2020-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: prix(30_000_000),
  assetCategory: 'IMMOBILIER', ...o,
});
const ligneD = (t: TcoResult, fileId: number) => t.lines.find((l) => l.source === 'DOCUMENT' && l.fileId === fileId)!;
const ligneC = (t: TcoResult, id: number) => t.lines.find((l) => l.id === `c:${id}`)!;
const decision = (key: string, value: TcoUserDecision['decision'], o: Partial<TcoUserDecision> = {}): TcoUserDecision => ({
  key, decision: value, decidedAt: '2026-11-05T10:00:00.000Z', decidedByUserId: 7, ...o,
});
const coherent = (t: TcoResult) => {
  const a = t.annual;
  expect(a.years.reduce((n, y) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents).toBe(t.summary.cumulativeCostCents);
  expect(t.reliability.anomalies.filter((x) => x.code === 'SUM_MISMATCH' || x.code === 'DUPLICATE_COMPONENT')).toEqual([]);
};

/** Avis de taxe foncière tel que stocké : type V2 connu, colonne historique au repli « AUTRE » (resolveDocumentTypeCode). */
const avisTaxe = (fileId: number, o: Partial<EconomicDocumentInput> = {}) => doc(fileId, {
  typeCode: 'PROPERTY_TAX_NOTICE', legacyType: 'AUTRE', title: 'Avis de taxe foncière 2026', amountCents: 140_000, date: '2026-09-01', ...o,
});

describe('L111V-U-CLS — classification : une charge établie n’est pas un « document sans valeur »', () => {
  it('L111V-U-CLS-01 — repli de stockage « AUTRE » ignoré pour un type V2 connu ; sans type V2, un type faible exclut toujours', () => {
    expect(classifyExpenseDocument('PROPERTY_TAX_NOTICE', 'AUTRE')).toEqual({ kind: 'unqualified' });
    expect(classifyExpenseDocument(null, 'AUTRE')).toMatchObject({ kind: 'excluded' });
    expect(classifyExpenseDocument('UNKNOWN_CODE', 'AUTRE')).toMatchObject({ kind: 'excluded' });
    expect(classifyExpenseDocument('MAINTENANCE_INVOICE', 'AUTRE')).toEqual({ kind: 'theme', theme: 'maintenance' });
    // Aucune règle codée « taxe foncière » : la même règle vaut pour tout type V2 sans équivalent V1.
    expect(classifyExpenseDocument('CHARGE_STATEMENT', 'AUTRE')).toEqual({ kind: 'unqualified' });
    const src = readFileSync(join(process.cwd(), 'src/services/verebona-assistant/canonical/expense-classes.ts'), 'utf8');
    expect(src).not.toMatch(/foncier|PROPERTY_TAX/i);
  });

  it('L111V-U-CLS-02 — avis de taxe foncière EUR, nature établie par T1 : charge retenue, aucun paiement inventé, aucune « devise étrangère »', () => {
    const t = computeTco(entree({ documents: [avisTaxe(41, { candidates: [cand([hint('REALIZED_COST', 140_000, { economicDate: '2026-09-01', periodStart: '2026-01-01', periodEnd: '2026-12-31' })])] })] }));
    expect(ligneD(t, 41)).toMatchObject({ status: 'RETAINED_DIRECT', includedCents: 140_000, kind: 'REALIZED_COST' });
    expect(t.summary.cumulativeCostCents).toBe(30_000_000 + 140_000);
    coherent(t);
  });

  it('L111V-U-CLS-03 — sans indice T1 : « Nature de la dépense à confirmer » avec Ajouter / Pas une dépense, montant EUR affiché, jamais exclu « sans valeur »', () => {
    const t = computeTco(entree({ documents: [avisTaxe(42)] }));
    const l = ligneD(t, 42);
    expect(l).toMatchObject({ status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN', kind: 'REALIZED_COST', eurCents: 140_000 });
    expect(l.reason).not.toBe('NOT_EXPENSE_DOCUMENT');
    expect(tcoLineAddable(l)).toEqual({ ok: true });
    expect(tcoLineDecisionOptions(l, t.lines).map((o) => o.action)).toEqual(['INCLUDE', 'CONFIRM_EXCLUSION']);
    expect(t.reliability.warnings).toContain('DOCUMENTS_NOT_QUALIFIED');
  });
});

describe('L111V-U-ADD — motif réel d’un ajout impossible (classification ≠ montant ≠ conversion ≠ réalisation)', () => {
  const base = { status: 'EXCLUDED' as const, kind: null, eurCents: null, amountUnknown: false, notRealized: undefined, reason: 'NOT_EXPENSE_DOCUMENT' as const, currency: 'EUR', amountMinor: 140_000 };
  it('L111V-U-ADD-01 — nature absente en euros : « Nature de la dépense à confirmer », jamais « devise étrangère »', () => {
    const a = tcoLineAddable(base);
    expect(a).toMatchObject({ ok: false, code: 'NATURE_TO_CONFIRM' });
    expect(JSON.stringify(a)).not.toMatch(/devise/);
  });
  it('L111V-U-ADD-02 — devise étrangère seulement si avérée ; montant inconnu → « Montant à renseigner » ; règlement → pas une dépense', () => {
    expect(tcoLineAddable({ ...base, status: 'UNCONVERTED', kind: 'REALIZED_COST', currency: 'USD', reason: null })).toMatchObject({ code: 'FOREIGN_CURRENCY' });
    expect(tcoLineAddable({ ...base, status: 'NOT_QUALIFIED', kind: 'REALIZED_COST', amountUnknown: true, reason: 'AMOUNT_UNKNOWN' })).toMatchObject({ code: 'AMOUNT_MISSING', reason: expect.stringContaining('Montant à renseigner') });
    expect(tcoLineAddable({ ...base, status: 'PAYMENT', reason: 'PAYMENT_PROOF' })).toMatchObject({ code: 'NOT_AN_EXPENSE' });
    expect(tcoLineAddable({ ...base, status: 'EXCLUDED', kind: 'REALIZED_COST', currency: '', reason: null })).toMatchObject({ code: 'AMOUNT_MISSING' });
  });
  it('L111V-U-ADD-03 — nature à confirmer sur une ligne exclue à montant EUR : gestes « C’est une dépense du bien » / « Pas une dépense du bien »', () => {
    const t = computeTco(entree({ documents: [doc(43, { typeCode: null, legacyType: 'AUTRE', amountCents: 9_900, title: 'Document divers' })] }));
    const l = ligneD(t, 43);
    expect(l).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_EXPENSE_DOCUMENT', kind: null });
    expect(tcoLineDecisionOptions(l, t.lines).map((o) => o.action)).toEqual(['REQUALIFY', 'CONFIRM_EXCLUSION', 'EDIT_DOCUMENT']);
  });
});

describe('L111V-U-REC — document non financier : aucune dépense fictive, aucune relecture', () => {
  it('L111V-U-REC-01 — attestation / contrat sans montant : aucune ligne, aucun « montant inconnu » ; une facture sans montant reste « montant inconnu »', () => {
    expect(documentTypeExpectsAmount('INSURANCE_CERTIFICATE')).toBe(false);
    expect(documentTypeExpectsAmount('INSURANCE_POLICY')).toBe(false);
    expect(AMOUNT_EXPECTED_V2_CODES).toContain('MAINTENANCE_INVOICE');
    expect(AMOUNT_EXPECTED_V2_CODES).not.toContain('INSURANCE_CERTIFICATE');
    const t = computeTco(entree({ documents: [doc(51, { typeCode: 'INSURANCE_CERTIFICATE', title: 'Attestation habitation' }), doc(52, { typeCode: 'INSURANCE_POLICY', title: 'Conditions générales' })] }));
    expect(t.lines.filter((l) => l.fileId === 51 || l.fileId === 52)).toEqual([]);
    expect(t.reliability.warnings).not.toContain('AMOUNTS_UNKNOWN');
    const f = computeTco(entree({ documents: [doc(53, { typeCode: 'MAINTENANCE_INVOICE' })] }));
    expect(ligneD(f, 53)).toMatchObject({ amountUnknown: true, reason: 'AMOUNT_UNKNOWN' });
  });

  it('L111V-U-REC-02 — récupération ouverte sur un document qui n’attend plus de montant : close « sans objet », jamais « retrouvé »', () => {
    const x: AmountRecoveryInput = {
      fileId: 51, amountUnknown: false, financialDocument: false, amountCents: null, userEditedAmount: false, analysisState: 'ANALYZED', t1JobLive: false, sources: [],
      row: { status: 'PENDING', fingerprint: 'f', fingerprintAttempts: 0, totalAttempts: 0, technicalFailures: 0, lastRequestedAt: null },
      fingerprint: 'f', t1Allowed: true, budgetLeft: true, now: new Date('2026-11-05T10:00:00Z'), limits: amountRecoveryLimits({}),
    };
    expect(planAmountRecovery(x)).toEqual({ kind: 'RECORD_RESULT', state: 'NOT_APPLICABLE', amountCents: null });
    expect(planAmountRecovery({ ...x, row: { ...x.row!, status: 'NOT_APPLICABLE' } })).toMatchObject({ kind: 'NONE' });
    // Montant établi après relance (indices T1) : toujours « retrouvé » (comportement 108B inchangé).
    expect(planAmountRecovery({ ...x, financialDocument: true })).toMatchObject({ kind: 'RECORD_RESULT', state: 'RECOVERED' });
  });

  it('L111V-U-REC-03 — états de récupération issus de la persistance ET de la file réelle (jamais « en cours » par défaut)', () => {
    const lim = { maxTechnicalFailures: 3, technicalBackoffHours: 6 };
    expect(viewStateOf(null, lim)).toEqual({ state: 'WAITING', nextAttemptAt: null });
    expect(viewStateOf(null, lim, { status: 'PENDING', availableAt: '2026-11-05T08:00:00.000Z' })).toEqual({ state: 'QUEUED', nextAttemptAt: '2026-11-05T08:00:00.000Z' });
    expect(viewStateOf({ status: 'T1_PENDING', technicalFailures: 0 }, lim, { status: 'RUNNING', availableAt: null }).state).toBe('READING');
    expect(viewStateOf({ status: 'T1_PENDING', technicalFailures: 0 }, lim).state).toBe('WAITING');
    expect(viewStateOf({ status: 'PENDING', technicalFailures: 0 }, lim).state).toBe('WAITING');
    expect(viewStateOf({ status: 'TECHNICAL_FAILURE', technicalFailures: 1, lastRequestedAt: '2026-11-05T00:00:00.000Z' }, lim))
      .toEqual({ state: 'RETRY_SCHEDULED', nextAttemptAt: '2026-11-05T06:00:00.000Z' });
    expect(viewStateOf({ status: 'TECHNICAL_FAILURE', technicalFailures: 3 }, lim).state).toBe('TECHNICAL_FAILURE');
    expect(viewStateOf({ status: 'TO_CONFIRM', technicalFailures: 0 }, lim).state).toBe('TO_CONFIRM');
    expect(viewStateOf({ status: 'NOT_FOUND', technicalFailures: 0 }, lim).state).toBe('NOT_FOUND');
    // Échec technique épuisé : le montant est demandé (point ouvert), jamais une lecture annoncée.
    const w = warningsAfterRecovery(['AMOUNTS_UNKNOWN'], { items: [{ fileId: 1, title: 'x', state: 'TECHNICAL_FAILURE' }], inProgress: 0, toConfirm: 0, notFound: 0 });
    expect(w).toEqual(['AMOUNTS_UNKNOWN']);
    const v = warningsAfterRecovery(['AMOUNTS_UNKNOWN'], { items: [{ fileId: 1, title: 'x', state: 'WAITING' }], inProgress: 1, toConfirm: 0, notFound: 0 });
    expect(v).toEqual(['AMOUNTS_RECOVERY_PENDING']);
  });
});

/** Deux justificatifs de 40,50 € dans la même dépense, sans période ni référence distincte : doublon présumé. */
function abonnements(o: { periodes?: boolean } = {}) {
  const [a, b] = [
    comp('REALIZED_COST', 4_050, { economicDate: '2026-02-03', ...(o.periodes ? { periodStart: '2026-02-01', periodEnd: '2026-02-28' } : {}) }),
    comp('REALIZED_COST', 4_050, { economicDate: '2026-02-03', ...(o.periodes ? { periodStart: '2026-03-01', periodEnd: '2026-03-31' } : {}) }),
  ];
  const ope = op(70, 'INTERVENTION', [a, b], { documents: [{ fileId: 71, title: 'Facture alarme A', role: 'INVOICE' }, { fileId: 72, title: 'Facture alarme B', role: 'INVOICE' }] });
  const input = (decisions: TcoUserDecision[] = []) => entree({ operations: [ope], componentProvenance: new Map([[a.id, pv([71])], [b.id, pv([72])]]), userDecisions: decisions });
  return { a, b, input };
}

describe('L111V-U-ARB — arbitrages explicites, durables et réversibles', () => {
  it('L111V-U-ARB-01 — abonnements de même montant, périodes distinctes : deux dépenses, aucun doublon présumé', () => {
    const { a, b, input } = abonnements({ periodes: true });
    const t = computeTco(input());
    expect(ligneC(t, a.id).includedCents + ligneC(t, b.id).includedCents).toBe(8_100);
    expect(t.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
  });

  it('L111V-U-ARB-02 — doublon présumé : point ouvert avec les deux justificatifs, la dépense comptée et les gestes « même fait » / « distinctes »', () => {
    const { b, input } = abonnements();
    const t = computeTco(input());
    const dup = ligneC(t, b.id);
    expect(dup).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_FACT_OTHER_DOCUMENT' });
    const d = computeTcoDiagnostics(t).items.find((i) => i.code === 'PRESUMED_DUPLICATES')!;
    expect(d.status).toBe('OPEN');
    expect(d.text).not.toMatch(/rien à faire/);
    expect(d.sources[0].actions!.map((x) => x.action)).toEqual(['SAME_FACT', 'DISTINCT_FACTS']);
    expect(d.sources[0].counterpart).toMatchObject({ label: expect.any(String), amountCents: 4_050, fileId: 71 });
    expect(computeTcoDiagnostics(t).open.decisions).toBe(1);
  });

  it('L111V-U-ARB-03 — « même fait » confirmé : une seule contribution, sources conservées, point clos, choix visible (groupe confirmé)', () => {
    const { a, b, input } = abonnements();
    const t0 = computeTco(input());
    const key = tcoLineKeys(ligneC(t0, b.id)).primary;
    const t = computeTco(input([decision(key, 'SAME_FACT', { basisStatus: 'DUPLICATE', basisReason: 'SAME_FACT_OTHER_DOCUMENT' })]));
    expect(t.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents);
    expect(ligneC(t, b.id)).toMatchObject({ status: 'DUPLICATE', reason: 'USER_SAME_FACT', fileId: 72 });
    expect(ligneC(t, a.id).includedCents).toBe(4_050);
    expect(t.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    const diag = computeTcoDiagnostics(t);
    expect(diag.items.filter((i) => i.status === 'OPEN').map((i) => i.code)).not.toContain('PRESUMED_DUPLICATES');
    expect(diag.items.find((i) => i.code === 'USER_DECISIONS')).toMatchObject({ status: 'DECIDED' });
    expect(diag.decided).toBe(1);
    expect(tcoLineDecisionOptions(ligneC(t, b.id), t.lines).map((o) => o.action)).toEqual(['REVERT']);
    coherent(t);
  });

  it('L111V-U-ARB-03b — T3 réunit ensuite les deux justificatifs en UNE composante : le choix « même fait » est satisfait, jamais la dépense retirée', () => {
    const { b, input } = abonnements();
    const key = tcoLineKeys(ligneC(computeTco(input()), b.id)).primary;
    const unique = comp('REALIZED_COST', 4_050, { economicDate: '2026-02-03' });
    const fusion = entree({ operations: [op(75, 'INTERVENTION', [unique])], componentProvenance: new Map([[unique.id, pv([71, 72])]]),
      userDecisions: [decision(key, 'SAME_FACT', { basisStatus: 'DUPLICATE', basisReason: 'SAME_FACT_OTHER_DOCUMENT' })] });
    const t = computeTco(fusion);
    expect(ligneC(t, unique.id)).toMatchObject({ status: 'RETAINED_CONSOLIDATED', includedCents: 4_050 });
    expect(ligneC(t, unique.id).userDecision).toMatchObject({ decision: 'SAME_FACT', applied: true });
    expect(ligneC(t, unique.id).userDecision!.contradicted).toBeUndefined();
    expect(computeTcoDiagnostics(t).items.filter((i) => i.status === 'OPEN')).toEqual([]);
    // Exclusion confirmée portée par une source désormais réunie à une autre : jamais retirée en silence, à reconfirmer.
    const ex = computeTco({ ...fusion, userDecisions: [decision('f:72:REALIZED_COST:4050:EUR', 'CONFIRM_EXCLUSION', { basisStatus: 'NOT_QUALIFIED' })] });
    expect(ligneC(ex, unique.id).includedCents).toBe(4_050);
    expect(computeTcoDiagnostics(ex).items.find((i) => i.code === 'USER_DECISION_TO_RECONFIRM')!.sources[0].actions!.map((a) => a.action)).toEqual(['REVERT']);
  });

  it('L111V-U-ARB-04 — faux doublon → « dépenses distinctes » : second coût inclus exactement, aucun avertissement de doublon, point clos', () => {
    const { b, input } = abonnements();
    const t0 = computeTco(input());
    const key = tcoLineKeys(ligneC(t0, b.id)).primary;
    const t = computeTco(input([decision(key, 'DISTINCT_FACTS', { basisStatus: 'DUPLICATE', basisReason: 'SAME_FACT_OTHER_DOCUMENT' })]));
    expect(t.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents + 4_050);
    expect(ligneC(t, b.id)).toMatchObject({ status: 'RETAINED_CONSOLIDATED', includedCents: 4_050 });
    expect(t.reliability.warnings).not.toContain('USER_INCLUDED_DUPLICATES');
    expect(t.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    expect(t.annual.years.find((y) => y.year === 2026)!.costsCents).toBe(8_100);
    coherent(t);
  });

  it('L111V-U-ARB-05 — exclusion confirmée : montant inchangé, point clos, persistante au recalcul ; une preuve contraire la ROUVRE sans l’effacer', () => {
    const t0 = computeTco(entree({ documents: [avisTaxe(61)] }));
    const l0 = ligneD(t0, 61);
    const d = decision(l0.decisionKey!, 'CONFIRM_EXCLUSION', { basisStatus: l0.status, basisReason: l0.reason });
    const t = computeTco(entree({ documents: [avisTaxe(61)], userDecisions: [d] }));
    expect(t.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents);
    expect(t.reliability.warnings).not.toContain('DOCUMENTS_NOT_QUALIFIED');
    expect(ligneD(t, 61).userDecision).toMatchObject({ decision: 'CONFIRM_EXCLUSION', applied: true });
    expect(computeTcoDiagnostics(t).items.filter((i) => i.status === 'OPEN')).toEqual([]);
    // Recalcul après relance T3 / requalification : T1 établit la nature (même montant) — le choix prime et reste appliqué,
    // signalé « à reconfirmer » (preuve nouvelle contraire), jamais effacé en silence.
    const avecT1 = avisTaxe(61, { candidates: [cand([hint('REALIZED_COST', 140_000, { economicDate: '2026-09-01' })])] });
    const t2 = computeTco(entree({ documents: [avecT1], userDecisions: [d] }));
    const l2 = ligneD(t2, 61);
    expect(l2.includedCents).toBe(0);
    expect(l2.userDecision).toMatchObject({ decision: 'CONFIRM_EXCLUSION', applied: true, contradicted: true });
    expect(t2.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents);
    const reouvert = computeTcoDiagnostics(t2).items.find((i) => i.code === 'USER_DECISION_TO_RECONFIRM')!;
    expect(reouvert).toMatchObject({ status: 'OPEN', nature: 'ANOMALY' });
    expect(reouvert.sources[0].actions!.map((x) => x.action)).toEqual(['CONFIRM_EXCLUSION', 'REVERT']);
    expect(tcoDecisionContradicted(d, { status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN' })).toBe(false);
  });

  it('L111V-U-ARB-06 — nature confirmée (ligne exclue sans nature) : comptée à son montant EUR dans la catégorie choisie ; le choix suit une requalification', () => {
    const d0 = doc(62, { typeCode: null, legacyType: 'AUTRE', amountCents: 9_900, title: 'Document divers', date: '2026-04-02' });
    const t0 = computeTco(entree({ documents: [d0] }));
    const key = ligneD(t0, 62).decisionKey!;
    expect(key).toBe('f:62:NONE:9900:EUR');
    const dec = decision(key, 'REQUALIFY', { requalifiedCategory: 'USAGE', basisStatus: 'EXCLUDED', basisReason: 'NOT_EXPENSE_DOCUMENT' });
    const t = computeTco(entree({ documents: [d0], userDecisions: [dec] }));
    expect(ligneD(t, 62)).toMatchObject({ status: 'RETAINED_DIRECT', includedCents: 9_900, kind: 'REALIZED_COST', category: 'USAGE' });
    expect(t.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents + 9_900);
    coherent(t);
    // La nature change ensuite (T1 qualifie le document) : même justificatif, même montant — la décision suit le fait.
    const requalifie = doc(62, { typeCode: 'OTHER_PROPERTY_MANAGEMENT', legacyType: null, amountCents: 9_900, title: 'Document divers', date: '2026-04-02' });
    const t2 = computeTco(entree({ documents: [requalifie], userDecisions: [dec] }));
    expect(t2.userDecisions.orphans).toEqual([]);
    expect(ligneD(t2, 62).includedCents).toBe(9_900);
  });

  it('L111V-U-ARB-07 — « Aucune dépense sur ce document » (montant inconnu) : plus de montant attendu, point clos, aucun 0 € compté', () => {
    const t0 = computeTco(entree({ documents: [doc(63, { typeCode: 'MAINTENANCE_INVOICE' })] }));
    const l0 = ligneD(t0, 63);
    expect(tcoLineDecisionOptions(l0, t0.lines).map((o) => o.action)).toEqual(['EDIT_DOCUMENT', 'CONFIRM_EXCLUSION']);
    const t = computeTco(entree({ documents: [doc(63, { typeCode: 'MAINTENANCE_INVOICE' })], userDecisions: [decision(l0.decisionKey!, 'CONFIRM_EXCLUSION', { basisStatus: l0.status, basisReason: l0.reason })] }));
    expect(t.reliability.warnings).not.toContain('AMOUNTS_UNKNOWN');
    expect(t.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents);
    expect(computeTcoDiagnostics(t).items.filter((i) => i.status === 'OPEN')).toEqual([]);
  });
});

describe('L111V-U-DTO — DTO et compteurs exacts', () => {
  it('L111V-U-DTO-01 — gestes par ligne, motif réel, lignes examinées ≠ décisions ouvertes, choix confirmés comptés à part', () => {
    const { b, input } = abonnements();
    const base = input();
    const t = computeTco({ ...base, documents: [avisTaxe(81), doc(82, { typeCode: 'INSURANCE_CERTIFICATE' }), doc(83, { typeCode: 'QUOTE_X', legacyType: 'DEVIS', amountCents: 50_000 })] });
    const dto = toTcoDto(t);
    const avis = dto.lines.find((l) => l.fileId === 81)!;
    expect(avis.actions).toMatchObject({ addable: true, addBlockedCode: null });
    expect(avis.actions!.options.map((o) => o.action)).toEqual(['INCLUDE', 'CONFIRM_EXCLUSION']);
    const dup = dto.lines.find((l) => l.id === `c:${b.id}`)!;
    expect(dup.actions!.options.map((o) => o.action)).toEqual(['SAME_FACT', 'DISTINCT_FACTS']);
    expect(dto.otherLinesTotal).toBeGreaterThan(dto.diagnostics.open.decisions);
    expect(dto.diagnostics.open.decisions).toBe(2);
    expect(dto.requalifyCategories).not.toContain('ACQUISITION');
    expect(dto.requalifyCategories).not.toContain('FINANCING');
    const key = tcoLineKeys(t.lines.find((l) => l.id === `c:${b.id}`)!).primary;
    const apres = toTcoDto(computeTco({ ...base, documents: [avisTaxe(81)], userDecisions: [decision(key, 'SAME_FACT', { basisStatus: 'DUPLICATE' })] }));
    expect(apres.decidedLinesTotal).toBe(1);
    expect(apres.diagnostics.open.decisions).toBe(1);
  });

  it('L111V-U-API-01 — corps de requête : arbitrages et annulation acceptés, catégorie contrôlée, geste inconnu refusé', () => {
    for (const action of ['INCLUDE', 'EXCLUDE', 'CONFIRM_EXCLUSION', 'SAME_FACT', 'DISTINCT_FACTS', 'REQUALIFY', 'REVERT']) {
      expect(parseTcoDecisionBody({ lineId: 'doc:1', action })).toMatchObject({ ok: true });
    }
    expect(parseTcoDecisionBody({ lineId: 'doc:1', action: 'REQUALIFY', category: 'USAGE' })).toMatchObject({ ok: true, value: { category: 'USAGE' } });
    expect(parseTcoDecisionBody({ lineId: 'doc:1', action: 'REQUALIFY', category: 'ACQUISITION' })).toMatchObject({ ok: false });
    expect(parseTcoDecisionBody({ lineId: 'doc:1', action: 'MERGE' })).toMatchObject({ ok: false });
  });
});

describe('L111V-U-UI — présentation (desktop et mobile, même composant)', () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

  it('L111V-U-UI-01 — gestes contextuels dans « Points à vérifier » : boutons nommés, dépense comptée à sa place, aucun geste en lecture seule', async () => {
    const { TcoOpenDiagnostics, TcoDecidedDiagnostics } = await import('@/components/assets/tco-diagnostics');
    const { b, input } = abonnements();
    const d = toTcoDto(computeTco(input())).diagnostics;
    const decide = { onDecide: async () => ({ ok: true as const }), categoryLabels: {}, categories: [] };
    const html = renderToStaticMarkup(React.createElement(TcoOpenDiagnostics, { diagnostics: d, assetId: BIEN, onShowLine: () => {}, decide }));
    expect(html).toContain('data-tco-arbitration="SAME_FACT"');
    expect(html).toContain('Confirmer le même fait');
    expect(html).toContain('data-tco-arbitration="DISTINCT_FACTS"');
    expect(html).toContain('data-tco-diagnostic-counterpart');
    expect(html).toContain('1 choix à faire');
    expect(html).toContain('aria-label="Que faire de cette ligne ?"');
    const lecture = renderToStaticMarkup(React.createElement(TcoOpenDiagnostics, { diagnostics: d, assetId: BIEN, onShowLine: () => {} }));
    expect(lecture).not.toContain('data-tco-arbitration=');
    // Choix confirmé : groupe distinct, réversible.
    const key = tcoLineKeys(computeTco(input()).lines.find((l) => l.id === `c:${b.id}`)!).primary;
    const d2 = toTcoDto(computeTco(input([decision(key, 'SAME_FACT', { basisStatus: 'DUPLICATE' })]))).diagnostics;
    expect(renderToStaticMarkup(React.createElement(TcoOpenDiagnostics, { diagnostics: d2, assetId: BIEN, onShowLine: () => {}, decide }))).toBe('');
    const choix = renderToStaticMarkup(React.createElement(TcoDecidedDiagnostics, { diagnostics: d2, onShowLine: () => {}, decide }));
    expect(choix).toContain('Vos choix confirmés (1)');
  });

  it('L111V-U-UI-02 — charte : aucune couleur brute, jamais « Opération » visible ; états de lecture réels (plus de filtre IN_PROGRESS)', () => {
    for (const f of ['src/components/assets/tco-decision-actions.tsx', 'src/components/assets/tco-diagnostics.tsx', 'src/components/assets/tco-amount-recovery.tsx']) {
      const src = lire(f);
      const visible = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(visible).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(|\b(red|green|blue|amber|orange|yellow)-\d{2,3}\b/);
      expect(visible).not.toMatch(/[Oo]pération/);
    }
    const ui = lire('src/components/assets/TcoSection.tsx');
    expect(ui).toContain('AMOUNT_RECOVERY_PENDING_STATES.has(i.state)');
    expect(ui).toContain('data-tco-excluded-decided');
    expect(ui).toContain('<TcoDecidedDiagnostics');
  });
});

describe('L111V-U-BO — diagnostic BO : statuts en français', () => {
  it('L111V-U-BO-01 — « Choix confirmé par l’utilisateur », jamais le code brut DECIDED', async () => {
    const { TcoDiagnosticView, STATUT_DIAGNOSTIC_BO } = await import('@/app/admin/operations/_components/TcoDiagnostic');
    const { b, input } = abonnements();
    const key = tcoLineKeys(computeTco(input()).lines.find((l) => l.id === `c:${b.id}`)!).primary;
    const t = computeTco(input([decision(key, 'SAME_FACT', { basisStatus: 'DUPLICATE' })]));
    const { entries: _e, ...tco } = t;
    const html = renderToStaticMarkup(React.createElement(TcoDiagnosticView, {
      data: { accountId: 1, assetId: BIEN, tco, componentsExamined: 0, labels: { status: {}, reason: {}, warning: {} }, diagnostics: computeTcoDiagnostics(t) },
    }));
    expect(html).toContain('data-bo-tco-diagnostic-status="DECIDED"');
    expect(html).toContain('Choix confirmé par l’utilisateur');
    expect(html).not.toMatch(/>DECIDED</);
    for (const s of ['OPEN', 'IN_PROGRESS', 'INFORMATIONAL', 'DECIDED']) expect(STATUT_DIAGNOSTIC_BO[s]).toBeTruthy();
  });
});

