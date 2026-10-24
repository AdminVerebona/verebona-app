/**
 * Lot 86F — ticket P1 « TCO / Opérations : dates économiques injustifiées et
 * leur autoréparation » (complément du ticket #559).
 *
 * Tests PURS sur le moteur TCO RÉEL (`computeTco`) et le résolveur de date
 * économique (`finance/economic-date`). La date d'une Opération n'est JAMAIS
 * la date économique de ses composantes sans justification métier ; une
 * dépense réalisée sans date établie reste dans le TCO cumulatif, sans année
 * (ventilation annuelle signalée incomplète). Homiris n'est qu'un scénario de
 * non-régression : aucune règle propre à un fournisseur.
 * Lecture SQL, contrôle de cohérence et réparation du stock sur PostgreSQL 16 :
 * `src/test/e2e/scenarios/l86f-tco-dates-economiques.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, nonRealizedComponentIds, type TcoInput, type TcoOperation, type TcoResult } from '../model';
import { resolveEconomicDate, resolveOperationEconomicDates, economicDateSignature, type EconomicDateInput } from '../../finance/economic-date';
import { evaluateComponent } from '../../finance/engine';
import { qualifyDocumentLines, type EconomicDocumentInput } from '../../finance/economic-lines';
import { operationCostLines, summarizeOperationCosts, type AssistantOperationRead } from '@/services/verebona-assistant/canonical/operations';
import { COHERENCE_REGISTRY, getCheck } from '@/services/coherence/registry';
import { COVERAGE_INVENTORY } from '@/services/coherence/registry/coverage';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';
import type { ComponentProvenance } from '../fact-identity';

const MAISON = 14;
const TODAY = '2026-10-24';
let seq = 86_000;

const comp = (kind: FinancialComponentKind, eur: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: eur, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: null, startDate: null, plannedDate: null,
  assetIds: [MAISON], label: typeCode, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const pv = (files: number[]): ComponentProvenance => ({ documentFileIds: files, withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: true, otherAssetAcquisition: false });
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: MAISON, today: TODAY, operations: [], assetAcquisitionDate: '2020-06-01', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: null, acquisitionExpected: false, ...o,
});
const annee = (t: TcoResult, y: number) => t.annual.years.find((a) => a.year === y);
const ligne = (t: TcoResult, c: LedgerComponent) => t.lines.find((l) => l.id === `c:${c.id}`)!;
const coherent = (t: TcoResult) => {
  const a = t.annual;
  expect(a.years.reduce((n, y) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents).toBe(t.summary.cumulativeCostCents);
  expect(a.reconciled).toBe(true);
};

describe('L86F — date de l’Opération jamais reprise sans justification (moteur TCO)', () => {
  it('L86F-U-01 (Homiris, non-régression) — trois prestations 2026 d’un abonnement daté du 05/11/2025 : jamais affectées à 2025 sans preuve', () => {
    const [a, b, c] = ['2026-01-05', '2026-02-05', '2026-03-05'].map((d) => comp('REALIZED_COST', 4_050, { periodStart: d, periodEnd: `${d.slice(0, 5)}${String(Number(d.slice(5, 7)) + 1).padStart(2, '0')}-04` }));
    const t = computeTco(entree({
      operations: [op(5, 'CONTRACT', [a, b, c], { realizedDate: '2025-11-05', startDate: '2025-11-05' })],
      componentProvenance: new Map([[a.id, pv([3361])], [b.id, pv([3362])], [c.id, pv([3363])]]),
    }));
    // Montants conservés dans le TCO cumulatif…
    expect(t.summary.cumulativeCostCents).toBe(3 * 4_050);
    // …mais aucune année inventée : ni 2025 (date de l'Opération), ni le début de période (jamais systématique).
    expect(annee(t, 2025)?.costsCents ?? 0).toBe(0);
    expect(annee(t, 2026)?.costsCents ?? 0).toBe(0);
    expect(t.annual.undated).toMatchObject({ count: 3, costsCents: 3 * 4_050 });
    expect(t.annual.years.every((y) => y.possiblyIncomplete)).toBe(true);
    for (const x of [a, b, c]) expect(ligne(t, x)).toMatchObject({ date: null, annualYear: null, includedCents: 4_050 });
    coherent(t);
  });

  it('L86F-U-02 (générique) — échéances d’une même Opération : la date de l’Opération n’est reprise pour AUCUNE d’elles', () => {
    const acompte = comp('REALIZED_COST', 30_000);
    const solde = comp('REALIZED_COST', 70_000, { economicDate: '2026-02-10' });
    const t = computeTco(entree({
      operations: [op(40, 'INTERVENTION', [acompte, solde], { realizedDate: '2026-02-10' })],
      componentProvenance: new Map([[acompte.id, pv([4001])], [solde.id, pv([4002])]]),
    }));
    expect(t.summary.cumulativeCostCents).toBe(100_000);
    // Le solde garde SA date ; l'acompte, sans date propre, n'hérite pas de celle de l'Opération.
    expect(ligne(t, solde)).toMatchObject({ date: '2026-02-10', annualYear: 2026 });
    expect(ligne(t, acompte)).toMatchObject({ date: null, annualYear: null, includedCents: 30_000 });
    expect(annee(t, 2026)?.costsCents).toBe(70_000);
    expect(t.annual.undated.costsCents).toBe(30_000);
    coherent(t);
  });

  it('L86F-U-03 (générique) — fait unique dont la période couverte contredit la date de l’Opération : aucune année', () => {
    const prime = comp('REALIZED_COST', 48_000, { periodStart: '2026-04-01', periodEnd: '2027-03-31' });
    const t = computeTco(entree({
      operations: [op(41, 'OTHER', [prime], { realizedDate: '2025-12-20' })],
      componentProvenance: new Map([[prime.id, pv([4101])]]),
    }));
    expect(ligne(t, prime)).toMatchObject({ date: null, annualYear: null, includedCents: 48_000 });
    expect(annee(t, 2025)?.costsCents ?? 0).toBe(0);
    coherent(t);
  });
});

// ── Résolveur : dates distinguées, preuves, provenance ──────────────────────

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const base = (o: Partial<EconomicDateInput> = {}): EconomicDateInput => ({
  kind: 'REALIZED_COST', amountMinor: 4_050, currency: 'EUR', ownDate: null, periodStart: '2026-01-05', periodEnd: '2026-02-04',
  documents: [], payments: [], sameAmountSiblings: 3,
  operation: { typeCode: 'CONTRACT', status: 'REALIZED', realizedDate: '2025-11-05', startDate: '2025-11-05', plannedDate: null, factCount: 3 }, ...o,
});

describe('L86F — résolution de la date économique (règle unique)', () => {
  it('L86F-U-04 — prestation N+1 payée en N : paiement PROUVÉ sur son justificatif → année du paiement (anticipé)', () => {
    const r = resolveEconomicDate(base({
      documents: [{ fileId: 11, role: 'INVOICE', date: '2026-01-02' }],
      payments: [{ fileId: 11, amountMinor: 4_050, currency: 'EUR', date: '2025-12-20', origin: 'PAYMENT_HINT' }],
    }));
    expect(r).toMatchObject({ status: 'ESTABLISHED', date: '2025-12-20', basis: 'PAYMENT', provenance: { type: 'PAYMENT', fileId: 11 } });
    // Dates distinguées et tracées : paiement retenu, facture et période rejetées, dates de l'Opération jamais économiques.
    expect(r.candidates.map((c) => [c.type, c.retained, c.rejected ?? null])).toEqual(expect.arrayContaining([
      ['PAYMENT', true, null], ['DOCUMENT', false, 'SUPERSEDED'], ['PERIOD', false, 'NEVER_ECONOMIC'], ['OPERATION_START', false, 'NEVER_ECONOMIC'],
    ]));
  });

  it('L86F-U-05 — prestation N payée en N+1 : convention de décaissement → année N+1', () => {
    const r = resolveEconomicDate(base({
      periodStart: '2025-12-01', periodEnd: '2025-12-31', documents: [{ fileId: 12, role: 'INVOICE', date: '2025-12-31' }],
      payments: [{ fileId: 12, amountMinor: 4_050, currency: 'EUR', date: '2026-01-15' }],
    }));
    expect(r).toMatchObject({ date: '2026-01-15', basis: 'PAYMENT' });
  });

  it('L86F-U-06 — période connue, paiement non daté : aucune année inventée (ni début de période, ni date de l’Opération)', () => {
    const r = resolveEconomicDate(base({ payments: [{ fileId: 13, amountMinor: 4_050, currency: 'EUR', date: null }] }));
    expect(r).toMatchObject({ status: 'UNDETERMINED', date: null, reason: 'PERIOD_ONLY' });
    expect(r.justification).toMatch(/aucune année/);
  });

  it('L86F-U-07 — facturation anticipée d’une période d’une année ultérieure, sans paiement : année non établie', () => {
    const r = resolveEconomicDate(base({ documents: [{ fileId: 14, role: 'INVOICE', date: '2025-11-05' }] }));
    expect(r).toMatchObject({ status: 'UNDETERMINED', reason: 'ADVANCE_BILLING_UNPAID' });
    // Facture datée dans la période (ou la même année) : date d'engagement retenue, provenance vérifiable.
    expect(resolveEconomicDate(base({ documents: [{ fileId: 15, role: 'INVOICE', date: '2026-01-05' }] })))
      .toMatchObject({ date: '2026-01-05', basis: 'DOCUMENT', provenance: { type: 'DOCUMENT', fileId: 15, origin: 'INVOICE' } });
  });

  it('L86F-U-08 — plusieurs échéances d’un contrat : dates indépendantes ; un règlement de même montant n’est jamais attribué au hasard', () => {
    const op = {
      typeCode: 'CONTRACT', status: 'REALIZED', realizedDate: '2025-11-05', startDate: '2025-11-05', plannedDate: null,
      components: [
        { id: 1, kind: 'REALIZED_COST', amountMinor: 4_050, currency: 'EUR', economicDate: null, periodStart: '2025-11-05', periodEnd: '2025-12-04' },
        { id: 2, kind: 'REALIZED_COST', amountMinor: 4_050, currency: 'EUR', economicDate: null, periodStart: '2026-07-05', periodEnd: '2026-08-04' },
        { id: 3, kind: 'REALIZED_COST', amountMinor: 4_050, currency: 'EUR', economicDate: '2026-09-05', periodStart: '2026-09-05', periodEnd: '2026-10-04' },
      ],
    };
    const r = resolveOperationEconomicDates(op, {
      documents: new Map([[1, [{ fileId: 5, role: 'INVOICE', date: '2025-11-05' }]], [2, [{ fileId: 336, role: 'INVOICE', date: '2026-07-05' }]], [3, []]]),
      // Règlement de novembre 2025, sans période, porté par la facture de novembre seulement.
      payments: [{ fileId: 5, amountMinor: 4_050, currency: 'EUR', date: '2025-11-10' }],
    });
    expect(r.get(1)).toMatchObject({ date: '2025-11-10', basis: 'PAYMENT' });
    expect(r.get(2)).toMatchObject({ date: '2026-07-05', basis: 'DOCUMENT' });
    expect(r.get(2)!.candidates.find((c) => c.type === 'PAYMENT')).toMatchObject({ retained: false, rejected: 'NOT_ATTRIBUTABLE' });
    expect(r.get(3)).toMatchObject({ date: '2026-09-05', basis: 'AMOUNT_DATE' });
    // Deux règlements attribuables de dates différentes : incertitude conservée.
    const ambigu = resolveEconomicDate(base({
      documents: [{ fileId: 16, role: 'INVOICE', date: '2026-01-05' }],
      payments: [{ fileId: 16, amountMinor: 4_050, currency: 'EUR', date: '2026-01-06' }, { fileId: 16, amountMinor: 4_050, currency: 'EUR', date: '2026-02-06' }],
    }));
    expect(ambigu).toMatchObject({ status: 'UNDETERMINED', reason: 'AMBIGUOUS_PAYMENT' });
  });

  it('L86F-U-09 — date de l’Opération : retenue seulement pour une dépense ponctuelle UNIQUE réalisée, jamais pour un contrat, un sinistre ou plusieurs faits', () => {
    const unique = { typeCode: 'INTERVENTION', status: 'REALIZED', realizedDate: '2026-03-10', startDate: null, plannedDate: null, factCount: 1 };
    expect(resolveEconomicDate(base({ periodStart: null, periodEnd: null, operation: unique })))
      .toMatchObject({ date: '2026-03-10', basis: 'OPERATION_SINGLE_FACT', provenance: { type: 'OPERATION_REALIZED' } });
    for (const [o, motif] of [
      [{ ...unique, typeCode: 'CONTRACT' }, 'RECURRING_OPERATION'], [{ ...unique, typeCode: 'CLAIM' }, 'RECURRING_OPERATION'],
      [{ ...unique, factCount: 2 }, 'MULTIPLE_FACTS'], [{ ...unique, status: 'ENVISAGED' }, 'NOT_REALIZED'],
    ] as const) {
      const r = resolveEconomicDate(base({ periodStart: null, periodEnd: null, operation: o }));
      expect(r).toMatchObject({ status: 'UNDETERMINED', reason: 'OPERATION_DATE_NOT_RELEVANT' });
      expect(r.candidates.find((c) => c.type === 'OPERATION_REALIZED')).toMatchObject({ retained: false, rejected: motif });
    }
    // Date de début (contrat) ou planifiée : jamais une date économique.
    const r = resolveEconomicDate(base({ periodStart: null, periodEnd: null, operation: { ...unique, realizedDate: null, startDate: '2026-01-01', plannedDate: '2026-02-01' } }));
    expect(r.status).toBe('UNDETERMINED');
  });

  it('L86F-U-10 — moteur partagé : aucune date de repli ; la date effective de l’Opération ne sert qu’à constater une non-réalisation', () => {
    const c = { id: 1, operationId: 1, kind: 'REALIZED_COST' as const, amountMinor: 100, currency: 'EUR', amountEurCents: null, economicDate: null, targetAssetId: null };
    const ctx = { scope: null, operationAssetIds: [], operationStatus: 'REALIZED', asOf: TODAY };
    expect(evaluateComponent(c, { ...ctx, operationEffectiveDate: '2025-11-05' })).toMatchObject({ included: true, date: null });
    expect(evaluateComponent(c, { ...ctx, operationEffectiveDate: '2026-12-01' })).toMatchObject({ included: false, exclusion: 'FUTURE_DATED', date: null });
    expect(lire('src/services/business-operations/finance/engine.ts')).not.toMatch(/fallbackDate\s*\?:/);
    expect(lire('src/services/business-operations/tco/model.ts')).not.toMatch(/fallbackDate:/);
  });

  it('L86F-U-11 — dépense documentaire (avant T3) : même règle — facture anticipée d’une autre année non datée, paiement du document retenu', () => {
    const doc = (fileId: number, date: string, hints: EconomicDocumentInput['candidates'][number]['hints']): EconomicDocumentInput => ({
      fileId, title: `F${fileId}`, typeCode: 'SUBSCRIPTION_INVOICE', legacyType: null, date, supplier: null, amountCents: 4_050, currency: 'EUR', userEditedAmount: false,
      hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null, linkedAssetIds: [MAISON], multiAsset: false, operations: [],
      candidates: [{ id: fileId, typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [], targets: [{ type: 'ASSET', entityId: MAISON }], hints, t3Outcome: null }],
    });
    const h = (role: string, o: Record<string, unknown> = {}) => ({ role, amountMinor: 4_050, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: '2026-01-05', periodEnd: '2026-02-04', ...o });
    const [sans, paye] = qualifyDocumentLines([doc(901, '2025-11-05', [h('REALIZED_COST')]), doc(902, '2025-11-05', [h('REALIZED_COST'), h('PAYMENT', { economicDate: '2025-11-06' })])], { today: TODAY });
    expect(sans).toMatchObject({ date: null, dateResolution: { reason: 'ADVANCE_BILLING_UNPAID' } });
    expect(paye).toMatchObject({ date: '2025-11-06', dateResolution: { basis: 'PAYMENT' } });
    const t = computeTco(entree({ documents: [doc(901, '2025-11-05', [h('REALIZED_COST')])] }));
    expect(t.lines.find((l) => l.fileId === 901)).toMatchObject({ includedCents: 4_050, date: null, annualYear: null, dateLabel: 'Date non établie' });
    expect(t.reliability.warnings).toContain('ECONOMIC_DATE_UNDETERMINED');
    coherent(t);
  });

  it('L86F-U-12 — provenance visible : chaque ligne porte fondement, justification et dates rejetées ; signature stable (idempotence)', () => {
    const [a, b] = [comp('REALIZED_COST', 4_050, { periodStart: '2026-07-05', periodEnd: '2026-08-04' }), comp('REALIZED_COST', 4_050, { periodStart: '2026-08-05', periodEnd: '2026-09-04' })];
    const t = computeTco(entree({
      operations: [op(5, 'CONTRACT', [a, b], { realizedDate: '2025-11-05', documents: [
        { fileId: 336, title: 'Facture juillet', role: 'INVOICE', date: '2026-07-05' }, { fileId: 337, title: 'Facture août', role: 'INVOICE', date: '2026-08-05' }] })],
      componentProvenance: new Map([[a.id, pv([336])], [b.id, pv([337])]]),
    }));
    expect(ligne(t, a)).toMatchObject({ date: '2026-07-05', annualYear: 2026, dateLabel: 'Date du justificatif', economicDate: { basis: 'DOCUMENT', provenance: { fileId: 336 } } });
    expect(ligne(t, b).economicDate?.candidates.find((c) => c.type === 'OPERATION_REALIZED')).toMatchObject({ date: '2025-11-05', retained: false });
    expect(annee(t, 2026)?.costsCents).toBe(8_100);
    expect(annee(t, 2025)?.costsCents ?? 0).toBe(0);
    coherent(t);
    const r = ligne(t, a).economicDate!;
    expect(economicDateSignature(r)).toBe(economicDateSignature({ ...r, candidates: [] } as never));
  });

  it('L86F-U-13 — décisions « Ajouter / Retirer du TCO » conservées : clé sans date, appliquée quelle que soit la date retenue', () => {
    const a = comp('REALIZED_COST', 4_050, { periodStart: '2026-07-05', periodEnd: '2026-08-04' });
    const t = computeTco(entree({
      operations: [op(5, 'CONTRACT', [a], { realizedDate: '2025-11-05' })],
      componentProvenance: new Map([[a.id, pv([336])]]),
      userDecisions: [{ key: 'f:336:REALIZED_COST:4050:EUR', decision: 'EXCLUDE', decidedAt: '2026-10-01T10:00:00Z', decidedByUserId: 1 }],
    }));
    expect(ligne(t, a)).toMatchObject({ includedCents: 0, reason: 'USER_EXCLUDED' });
    expect(t.summary.cumulativeCostCents).toBe(0);
    coherent(t);
  });

  it('L86F-U-14 — T2 : même date que le TCO (composante non datée = « non datée » pour l’année demandée, jamais l’année de l’Opération)', () => {
    const o = {
      id: 5, active: true, typeCode: 'CONTRACT', status: 'REALIZED', assetIds: [MAISON], documents: [], technicalLabel: 'Abonnement',
      realizedDate: '2025-11-05', startDate: '2025-11-05', plannedDate: null, provider: null, claimType: null,
      components: [{ id: 1, kind: 'REALIZED_COST', amountMinor: 4_050, currency: 'EUR', amountEurCents: null, economicDate: null, targetAssetId: null, label: null }],
    } as unknown as AssistantOperationRead;
    const p2025 = summarizeOperationCosts(operationCostLines([o], { assetIds: [MAISON], year: 2025 }), null).part;
    expect(p2025.sumCents).toBe(0);
    expect(p2025.undated).toMatchObject({ count: 1, sumCents: 4_050 });
    // Compte entier : la non-réalisation suit la même règle que le TCO.
    expect([...nonRealizedComponentIds([{ typeCode: 'CONTRACT', status: 'REALIZED', realizedDate: '2025-11-05', startDate: null, components: [{ ...o.components[0], operationId: 5 }] }], new Map(), TODAY)]).toEqual([]);
    expect(lire('src/services/verebona-assistant/canonical/operations.ts')).not.toMatch(/economicDate \?\? line\.date/);
  });

  it('L86F-U-15 — contrôle COH-TCO-ECONOMIC-DATES : en fin de registre (position relative), actif, réparation par le service métier, domaine TCO couvert', () => {
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ids.indexOf('COH-TCO-ECONOMIC-DATES')).toBeGreaterThan(ids.indexOf('COH-T1-KNOWLEDGE-CONSUMPTION'));
    const c = getCheck('COH-TCO-ECONOMIC-DATES')!;
    expect(c).toMatchObject({ status: 'ACTIVE', domain: 'tco', objectType: 'operation' });
    expect(c.repair).toBeTypeOf('function');
    expect(c.services.join(' ')).toMatch(/applyOperationEconomicDates/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/date de l’Opération/);
    expect(COVERAGE_INVENTORY.find((e) => e.domain === 'tco')?.checks).toContain('COH-TCO-ECONOMIC-DATES');
    const src = lire('src/services/coherence/registry/checks/tco-economic-dates.ts');
    expect(src).not.toMatch(/homiris|eps\b/i);
  });
});

describe('L86F — non-régression 81D (Opération prévue)', () => {
  it('L86F-U-16 — Opération PRÉVUE : la date d’un justificatif ne vaut pas paiement (non réalisée) ; un paiement prouvé, si', () => {
    const c = comp('REALIZED_COST', 5_000);
    const t = computeTco(entree({
      operations: [op(60, 'INTERVENTION', [c], { status: 'ENVISAGED', plannedDate: '2026-11-01', documents: [{ fileId: 6001, title: 'Facture', role: 'INVOICE', date: '2026-09-01' }] })],
      componentProvenance: new Map([[c.id, pv([6001])]]),
    }));
    expect(ligne(t, c)).toMatchObject({ includedCents: 0, reason: 'NOT_REALIZED', notRealized: true });
    const paye = comp('REALIZED_COST', 5_000, { economicDate: '2026-09-02' });
    const u = computeTco(entree({
      operations: [op(61, 'INTERVENTION', [paye], { status: 'ENVISAGED', plannedDate: '2026-11-01' })],
      componentProvenance: new Map([[paye.id, pv([6101])]]),
    }));
    expect(ligne(u, paye)).toMatchObject({ includedCents: 5_000, contradiction: 'PLANNED_WITH_PAYMENT', annualYear: 2026 });
  });
});
