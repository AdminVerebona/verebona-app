/**
 * Lot 108B — récupération automatique des montants inconnus (règles pures).
 * L108B-U-PLAN : décision par document ; L108B-U-VIEW : état présenté et
 * avertissements ; L108B-U-ROLES : rôles des montants lus (lot 107).
 */
import { describe, expect, it } from 'vitest';
import {
  amountRecoveryLimits, establishedAmount, planAmountRecovery, roleOfHint, textTotalsOfProfile, viewStateOf, warningsAfterRecovery,
  type AmountRecoveryInput, type AmountSourceCandidate,
} from '../amount-recovery';
import { buildReceiptProfile, linesOfTranscription } from '@/services/ai/source-analysis/projection/amount-roles';

const LIMITS = amountRecoveryLimits({});
const NOW = new Date('2026-11-03T10:00:00Z');
const src = (o: Partial<AmountSourceCandidate>): AmountSourceCandidate => ({ kind: 'T1_EXTRACTION', cents: 12_000, currency: 'EUR', role: 'DOCUMENT_TOTAL', confidence: 'probable', ref: 'x', ...o });
const base = (o: Partial<AmountRecoveryInput> = {}): AmountRecoveryInput => ({
  fileId: 7, amountUnknown: true, amountCents: null, userEditedAmount: false, analysisState: 'ANALYZED', t1JobLive: false,
  sources: [], row: null, fingerprint: 'fp1', t1Allowed: true, budgetLeft: true, now: NOW, limits: LIMITS, ...o,
});

describe('L108B-U-PLAN — décision de récupération', () => {
  it('montant établi par les sources persistées → posé (preuve la plus forte, sources concordantes jointes)', () => {
    const a = planAmountRecovery(base({ sources: [src({ kind: 'SOURCE_TEXT_TOTAL', role: 'TOTAL_TTC', ref: 'unit:p1' }), src({ ref: 'extraction:3' })] }));
    expect(a).toMatchObject({ kind: 'APPLY', candidate: { kind: 'T1_EXTRACTION', cents: 12_000 } });
    if (a.kind === 'APPLY') expect(a.corroboratedBy.map((s) => s.kind)).toEqual(['SOURCE_TEXT_TOTAL']);
  });

  it('montants contradictoires → jamais posés : relance T1, puis « à confirmer » avec les propositions', () => {
    const sources = [src({ cents: 12_000 }), src({ kind: 'OPERATION_COMPONENT', role: 'TOTAL_TTC', cents: 10_000, ref: 'component:1' })];
    expect(planAmountRecovery(base({ sources }))).toMatchObject({ kind: 'RELAUNCH_T1', attempt: 1 });
    const apres = planAmountRecovery(base({ sources, row: { status: 'T1_PENDING', fingerprint: 'fp1', fingerprintAttempts: 1, totalAttempts: 1, technicalFailures: 0, lastRequestedAt: NOW.toISOString() } }));
    expect(apres).toMatchObject({ kind: 'FAIL', state: 'TO_CONFIRM', reason: 'AMOUNTS_CONTRADICTORY' });
    if (apres.kind === 'FAIL') expect(apres.proposals.map((p) => p.cents).sort((a, b) => a - b)).toEqual([10_000, 12_000]);
  });

  it('HT, TVA, paiement ou total non recoupé : propositions seulement (jamais le montant du document)', () => {
    for (const s of [src({ role: 'TOTAL_HT' }), src({ role: 'TAX' }), src({ role: 'PAYMENT' }), src({ kind: 'SOURCE_TEXT_TOTAL', role: 'TOTAL_TTC', confidence: 'uncorroborated' }), src({ confidence: 'conflictual' })]) {
      expect(establishedAmount([s])).toBeNull();
      expect(planAmountRecovery(base({ sources: [s] })).kind).toBe('RELAUNCH_T1');
    }
  });

  it('rien de persisté → relance T1 ; après la relance sans résultat → « introuvable » (jamais 0 €)', () => {
    expect(planAmountRecovery(base())).toMatchObject({ kind: 'RELAUNCH_T1', attempt: 1, retryAfterTechnical: false });
    const row = { status: 'T1_PENDING' as const, fingerprint: 'fp1', fingerprintAttempts: 1, totalAttempts: 1, technicalFailures: 0, lastRequestedAt: NOW.toISOString() };
    expect(planAmountRecovery(base({ row }))).toMatchObject({ kind: 'FAIL', state: 'NOT_FOUND', proposals: [] });
  });

  it('nouvelle empreinte (source, modèle ou traitement changés) → UNE nouvelle tentative ; plafond total respecté', () => {
    const row = { status: 'NOT_FOUND' as const, fingerprint: 'fp1', fingerprintAttempts: 1, totalAttempts: 1, technicalFailures: 0, lastRequestedAt: null };
    expect(planAmountRecovery(base({ row, fingerprint: 'fp2' }))).toMatchObject({ kind: 'RELAUNCH_T1', attempt: 2 });
    expect(planAmountRecovery(base({ row: { ...row, totalAttempts: LIMITS.maxTotal }, fingerprint: 'fp9' }))).toMatchObject({ kind: 'FAIL', state: 'NOT_FOUND' });
  });

  it('relance en cours, dépôt en analyse : attendre, jamais deux analyses', () => {
    const row = { status: 'T1_PENDING' as const, fingerprint: 'fp1', fingerprintAttempts: 1, totalAttempts: 1, technicalFailures: 0, lastRequestedAt: NOW.toISOString() };
    expect(planAmountRecovery(base({ row, t1JobLive: true }))).toMatchObject({ kind: 'WAIT', state: 'T1_PENDING' });
    expect(planAmountRecovery(base({ analysisState: 'ANALYZING' }))).toMatchObject({ kind: 'WAIT', state: 'PENDING' });
  });

  it('échec technique de la relance → TECHNICAL_FAILURE, reprise espacée, puis demande à l’utilisateur au plafond', () => {
    const row = { status: 'T1_PENDING' as const, fingerprint: 'fp1', fingerprintAttempts: 1, totalAttempts: 1, technicalFailures: 0, lastRequestedAt: NOW.toISOString() };
    expect(planAmountRecovery(base({ row, analysisState: 'ANALYSIS_FAILED' }))).toMatchObject({ kind: 'FAIL', state: 'TECHNICAL_FAILURE', reason: 'T1_RELAUNCH_FAILED' });
    const tech = { ...row, status: 'TECHNICAL_FAILURE' as const, technicalFailures: 1 };
    expect(planAmountRecovery(base({ row: tech, analysisState: 'ANALYSIS_FAILED' }))).toMatchObject({ kind: 'FAIL', state: 'TECHNICAL_FAILURE', reason: 'TECHNICAL_RETRY_DEFERRED' });
    const tard = new Date(NOW.getTime() + (LIMITS.technicalBackoffHours + 1) * 3_600_000);
    expect(planAmountRecovery(base({ row: tech, analysisState: 'ANALYSIS_FAILED', now: tard }))).toMatchObject({ kind: 'RELAUNCH_T1', retryAfterTechnical: true });
    expect(planAmountRecovery(base({ row: { ...row, technicalFailures: LIMITS.maxTechnicalFailures - 1 }, analysisState: 'ANALYSIS_FAILED' })))
      .toMatchObject({ kind: 'FAIL', state: 'TO_CONFIRM', reason: 'TECHNICAL_FAILURES_EXHAUSTED' });
  });

  it('montant saisi ou retiré par l’utilisateur : jamais remplacé ; montant apparu : provenance consignée', () => {
    expect(planAmountRecovery(base({ userEditedAmount: true, sources: [src({})] }))).toMatchObject({ kind: 'FAIL', state: 'USER_OWNED' });
    const row = { status: 'T1_PENDING' as const, fingerprint: 'fp1', fingerprintAttempts: 1, totalAttempts: 1, technicalFailures: 0, lastRequestedAt: NOW.toISOString() };
    expect(planAmountRecovery(base({ amountUnknown: false, amountCents: 4_500, row }))).toEqual({ kind: 'RECORD_RESULT', state: 'RECOVERED', amountCents: 4_500 });
    expect(planAmountRecovery(base({ amountUnknown: false, amountCents: 4_500, row: null }))).toEqual({ kind: 'NONE', state: null });
  });

  it('compte sans droits TCO ou budget épuisé : aucune relance IA', () => {
    expect(planAmountRecovery(base({ t1Allowed: false }))).toMatchObject({ kind: 'FAIL', state: 'NOT_FOUND', reason: 'NO_AMOUNT_T1_NOT_ALLOWED' });
    expect(planAmountRecovery(base({ budgetLeft: false }))).toMatchObject({ kind: 'WAIT', state: 'PENDING', reason: 'T1_BUDGET_EXHAUSTED' });
  });

  it('acompte ici, solde là pour un même montant : à confirmer', () => {
    expect(establishedAmount([src({ role: 'DEPOSIT' }), src({ kind: 'OPERATION_COMPONENT', role: 'BALANCE', ref: 'c' })])).toHaveProperty('conflict');
  });
});

describe('L108B-U-ROLES — rôles des montants (lot 107, `amount-roles`)', () => {
  const profil = (t: string) => buildReceiptProfile(linesOfTranscription(t));
  it('total TTC recoupé par HT + TVA → proposé comme montant établi ; HT et TVA restent des propositions', () => {
    const s = textTotalsOfProfile(profil('Entretien chaudière\nTotal HT 100,00\nTVA 20 % 20,00\nTotal TTC 120,00'), 'EUR');
    expect(s.find((x) => x.role === 'TOTAL_TTC')).toMatchObject({ cents: 12_000, confidence: 'probable' });
    expect(s.filter((x) => x.role !== 'TOTAL_TTC').every((x) => x.confidence === 'uncorroborated')).toBe(true);
    expect(establishedAmount(s)).toMatchObject({ candidate: { cents: 12_000, role: 'TOTAL_TTC' } });
  });
  it('total seul, non recoupé → proposition ; ticket avec acompte → jamais établi', () => {
    expect(establishedAmount(textTotalsOfProfile(profil('Prestation\nTotal 80,00'), 'EUR'))).toBeNull();
    const a = textTotalsOfProfile(profil('Cuisine\nTotal TTC 1 000,00\nAcompte versé 300,00\nCB 1 000,00'), 'EUR');
    expect(a.find((x) => x.role === 'TOTAL_TTC')?.confidence).toBe('uncorroborated');
  });
  it('total payé égal au paiement → recoupé', () => {
    expect(establishedAmount(textTotalsOfProfile(profil('Pneu\nTotal 64,90\nCB 64,90'), 'EUR'))).toMatchObject({ candidate: { cents: 6_490 } });
  });
  it('indices T1 : coût réalisé total / acompte / solde / avoir ; paiement jamais montant du document', () => {
    expect([roleOfHint('REALIZED_COST', 'TOTAL'), roleOfHint('REALIZED_COST', 'DEPOSIT'), roleOfHint('REALIZED_COST', 'BALANCE'), roleOfHint('REDUCTION', null), roleOfHint('PAYMENT', null), roleOfHint('FORECAST_COST', 'TOTAL')])
      .toEqual(['TOTAL_TTC', 'DEPOSIT', 'BALANCE', 'CREDIT_NOTE', 'PAYMENT', null]);
  });
});

describe('L108B-U-VIEW — état présenté et alerte', () => {
  it('pas encore examiné / en cours / reprise technique → « en cours » ; échecs réels → à confirmer / introuvable', () => {
    expect(viewStateOf(null, LIMITS)).toBe('IN_PROGRESS');
    expect(viewStateOf({ status: 'T1_PENDING', technicalFailures: 0 }, LIMITS)).toBe('IN_PROGRESS');
    expect(viewStateOf({ status: 'TECHNICAL_FAILURE', technicalFailures: 1 }, LIMITS)).toBe('IN_PROGRESS');
    expect(viewStateOf({ status: 'TECHNICAL_FAILURE', technicalFailures: LIMITS.maxTechnicalFailures }, LIMITS)).toBe('TO_CONFIRM');
    expect(viewStateOf({ status: 'TO_CONFIRM', technicalFailures: 0 }, LIMITS)).toBe('TO_CONFIRM');
    expect(viewStateOf({ status: 'NOT_FOUND', technicalFailures: 0 }, LIMITS)).toBe('NOT_FOUND');
  });
  it('alerte « montant illisible » seulement après échec réel ; sinon avertissement neutre', () => {
    const v = (inProgress: number, toConfirm: number, notFound: number) => ({ items: [{ fileId: 1, title: 'F', state: 'IN_PROGRESS' as const }], inProgress, toConfirm, notFound });
    expect(warningsAfterRecovery(['AMOUNTS_UNKNOWN', 'USER_DECISIONS'], v(1, 0, 0))).toEqual(['USER_DECISIONS', 'AMOUNTS_RECOVERY_PENDING']);
    expect(warningsAfterRecovery(['AMOUNTS_UNKNOWN'], v(0, 0, 1))).toEqual(['AMOUNTS_UNKNOWN']);
    expect(warningsAfterRecovery(['AMOUNTS_UNKNOWN'], v(1, 1, 0))).toEqual(['AMOUNTS_UNKNOWN', 'AMOUNTS_RECOVERY_PENDING']);
    expect(warningsAfterRecovery(['USER_DECISIONS'], v(1, 0, 0))).toEqual(['USER_DECISIONS']);
  });
  it('paramètres centralisés (variables d’environnement)', () => {
    expect(LIMITS).toEqual({ maxPerFingerprint: 1, maxTotal: 3, maxTechnicalFailures: 3, technicalBackoffHours: 6 });
    expect(amountRecoveryLimits({ TCO_AMOUNT_RECOVERY_T1_MAX: '0', TCO_AMOUNT_RECOVERY_TECHNICAL_MAX: '0' })).toMatchObject({ maxTotal: 0, maxTechnicalFailures: 1 });
  });
});
