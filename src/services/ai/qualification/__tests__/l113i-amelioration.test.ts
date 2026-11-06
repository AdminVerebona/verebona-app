/**
 * Lot 113I — CDC V2 « amélioration automatique IA » : tests unitaires des règles pures (aucune base).
 * Les transactions PostgreSQL concurrentes, la promotion / le retour arrière ciblés et le budget réel sont recettés
 * par `src/test/e2e/scenarios/l113i-amelioration-ia.e2e.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: async () => [] , begin: async () => { throw new Error('pas de base en test unitaire'); } }, db: {} }));

import {
  assertOnlyTreatmentChanged, buildSnapshot, changedAxes, changedTreatments, replaceTreatmentPart, treatmentFingerprint, treatmentPart, TreatmentDeltaRefused,
  type ConfigSnapshot,
} from '../../config/config-snapshot';
import { emptyTreatmentConfig } from '../../config/config-types';
import { TREATMENTS, type Treatment } from '../../config/treatments';
import { budgetMonth, envelopeOf, estimateInputTokens, toEurMicros, upperBound } from '../improvement-budget';
import { defaultPolicy, normalizePolicy, PolicyRefused, POLICY_DEFAULTS, stabilityProof, type ImprovementPolicy } from '../improvement-policy';
import { canTransition, queueOrder, TERMINAL_STATUSES } from '../improvement-objectives';
import { chooseCandidatesByTreatment, lexicographicGain } from '../verdict';
import { assessPostActivation, EMPTY_USAGE, replaySuspicion } from '../post-activation';
import { nextWatchStatus, WATCH_STATUS_LABELS } from '../promotion-watch';
import { capabilityState } from '../promotion-status';
import { transactionGuard, type GateReference } from '../promotion-gate';
import { assessNonRegression } from '../non-regression';

const snap = (models: Partial<Record<Treatment, string>> = {}): ConfigSnapshot => buildSnapshot(TREATMENTS.map((t) => ({ ...emptyTreatmentConfig(t), primaryModel: models[t] ?? 'gemini-3.5-flash' })));
const policyWith = (o: Record<string, unknown>): ImprovementPolicy => ({ ...defaultPolicy(), ...normalizePolicy({ ...POLICY_DEFAULTS, ...o }) });

describe('L113I-U01 — unité de changement par traitement (PRO-03/05, SQL-005, LIF-007)', () => {
  it('empreinte par traitement : changer T3 ne change que T3', () => {
    const a = snap();
    const b = snap({ T3: 'gemini-2.5-pro' });
    expect(changedTreatments(a, b)).toEqual(['T3']);
    for (const t of TREATMENTS.filter((x) => x !== 'T3')) expect(treatmentFingerprint(a, t)).toBe(treatmentFingerprint(b, t));
  });
  it('delta d’un seul traitement accepté ; deux traitements → MULTI_TREATMENT_DELTA ; garde-fou modifié → FORBIDDEN_CHANGE ; aucun effet → NO_EFFECT', () => {
    const base = snap();
    const d = assertOnlyTreatmentChanged(base, snap({ T6: 'gemini-3.1-flash-lite' }), 'T6');
    expect(d.axes).toEqual(['MODEL']);
    expect(d.beforeFingerprint).not.toBe(d.afterFingerprint);
    expect(() => assertOnlyTreatmentChanged(base, snap({ T6: 'x', T1: 'y' }), 'T6')).toThrow(TreatmentDeltaRefused);
    try { assertOnlyTreatmentChanged(base, snap({ T6: 'x', T1: 'y' }), 'T6'); } catch (e) { expect((e as TreatmentDeltaRefused).code).toBe('MULTI_TREATMENT_DELTA'); }
    const garde = buildSnapshot(base.entries.map((e) => (e.treatment === 'T6' ? { ...e, guardrails: [{ code: 'X', threshold: 1, reaction: 'alert' as never }] } : e)));
    try { assertOnlyTreatmentChanged(base, garde, 'T6'); throw new Error('attendu'); } catch (e) { expect((e as TreatmentDeltaRefused).code).toBe('FORBIDDEN_CHANGE'); }
    try { assertOnlyTreatmentChanged(base, snap(), 'T6'); throw new Error('attendu'); } catch (e) { expect((e as TreatmentDeltaRefused).code).toBe('NO_EFFECT'); }
  });
  it('fusion ciblée sur la DERNIÈRE active : T1 modifié entre-temps est conservé, seule la part T3 est remplacée (REC-064)', () => {
    const qualifieeSur = snap();
    const candidate = snap({ T3: 'gemini-2.5-pro' });
    const activeCourante = snap({ T1: 'gemini-2.5-flash' }); // T1 changé pendant les tests de T3
    const next = replaceTreatmentPart(activeCourante, treatmentPart(candidate, 'T3'));
    expect(next.entries.find((e) => e.treatment === 'T1')!.primaryModel).toBe('gemini-2.5-flash');
    expect(next.entries.find((e) => e.treatment === 'T3')!.primaryModel).toBe('gemini-2.5-pro');
    expect(changedTreatments(activeCourante, next)).toEqual(['T3']);
    expect(treatmentFingerprint(qualifieeSur, 'T3')).toBe(treatmentFingerprint(activeCourante, 'T3'));
    // Retour arrière symétrique : seule la part antérieure de T3 revient (TX-02).
    const retour = replaceTreatmentPart(next, treatmentPart(activeCourante, 'T3'));
    expect(changedTreatments(next, retour)).toEqual(['T3']);
    expect(retour.entries.find((e) => e.treatment === 'T1')!.primaryModel).toBe('gemini-2.5-flash');
  });
  it('axes du delta : modèle, repli, profil, prompt distingués (GEN-02)', () => {
    const a = treatmentPart(snap(), 'T2');
    const b = treatmentPart(buildSnapshot(snap().entries.map((e) => (e.treatment === 'T2' ? { ...e, fallback1: 'gemini-2.5-flash', maxOutputTokens: 900 } : e))), 'T2');
    expect(changedAxes(a, b).sort()).toEqual(['FALLBACK_CHAIN', 'INFERENCE_PROFILE']);
  });
});

describe('L113I-U02 — politique administrée (BUD-01, EVA-006, C-004)', () => {
  it('valeurs de départ = décisions acquises ; paramètres « À DÉFINIR » laissés vides', () => {
    const p = defaultPolicy();
    expect(p.budget).toEqual({ monthlyEur: 100, experimentEur: 80, monitorEur: 20, infoAlertEur: 50, vigilanceAlertEur: 75 });
    expect(p.variants.maxPerObjective).toBe(3);
    expect(p.fx.usdToEur).toBeNull();
    expect(p.costBound.safetyMultiplier).toBeNull();
    expect(p.judges).toEqual({ primary: null, secondary: null });
    expect(p.version).toBe(0);
  });
  it('refus : expérimentation + surveillance > budget ; taux sans source/date ; variantes > 3', () => {
    expect(() => normalizePolicy({ budget: { monthlyEur: 100, experimentEur: 90, monitorEur: 20 } })).toThrow(PolicyRefused);
    expect(() => normalizePolicy({ fx: { usdToEur: 0.9 } })).toThrow(/source et la date/);
    expect(() => normalizePolicy({ variants: { maxPerObjective: 4 } })).toThrow(PolicyRefused);
    // Les juges ne sont jamais lus depuis la saisie (aucun faux réglage, UI-003).
    expect(normalizePolicy({ judges: { primary: 'x' } }).judges).toEqual({ primary: null, secondary: null });
  });
  it('stabilité : présumée par le nom → UNVERIFIED ; structurée → prouvée ; attestée → prouvée ; preview → NOT_STABLE (MODT-01)', () => {
    const p = defaultPolicy();
    expect(stabilityProof('m', { lifecycle: 'stable', basis: 'name_rule' }, p)).toMatchObject({ verified: false, status: 'UNVERIFIED' });
    expect(stabilityProof('m', null, p)).toMatchObject({ verified: false, status: 'UNVERIFIED' });
    expect(stabilityProof('m', { lifecycle: 'stable', basis: 'structured' }, p)).toMatchObject({ verified: true, status: 'STABLE_STRUCTURED' });
    expect(stabilityProof('m', { lifecycle: 'preview', basis: 'name_rule' }, p)).toMatchObject({ verified: false, status: 'NOT_STABLE' });
    const att = policyWith({ verifiedStableModels: [{ model: 'm', source: 'https://ai.google.dev/models' }] });
    expect(stabilityProof('m', { lifecycle: 'stable', basis: 'name_rule' }, att)).toMatchObject({ verified: true, status: 'STABLE_ATTESTED' });
  });
});

describe('L113I-U03 — budget : borne supérieure, devise, phases (BUD-03/06, FIN-002/003)', () => {
  const prix = { inputMicrosPerToken: 0.3, outputMicrosPerToken: 2.5, currency: 'USD' };
  it('tarif inconnu, marge non définie, sortie inconnue → COST_UNKNOWN ; USD sans taux → FX_UNAVAILABLE (aucune comparaison USD/EUR)', () => {
    const p = defaultPolicy();
    expect(upperBound({ price: null, inputTokens: 100, maxOutputTokens: 100, attempts: 1, policy: p })).toMatchObject({ ok: false, code: 'COST_UNKNOWN' });
    expect(upperBound({ price: prix, inputTokens: 100, maxOutputTokens: 100, attempts: 1, policy: p })).toMatchObject({ ok: false, code: 'COST_UNKNOWN' });
    const m = policyWith({ costBound: { safetyMultiplier: 1.5 } });
    expect(upperBound({ price: prix, inputTokens: 100, maxOutputTokens: null, attempts: 1, policy: m })).toMatchObject({ ok: false, code: 'COST_UNKNOWN' });
    expect(upperBound({ price: prix, inputTokens: 100, maxOutputTokens: 100, attempts: 1, policy: m })).toMatchObject({ ok: false, code: 'FX_UNAVAILABLE' });
  });
  it('conversion PRUDENTE centralisée : (entrée × prix + sortie max × prix) × essais × marge, puis taux × (1 + marge FX), arrondi supérieur', () => {
    const p = policyWith({ costBound: { safetyMultiplier: 1.5 }, fx: { usdToEur: 0.9, source: 'BCE', date: '2026-11-05', marginRatio: 0.1 } });
    const b = upperBound({ price: prix, inputTokens: 1000, maxOutputTokens: 2000, attempts: 2, policy: p });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    // (1000 × 0,3 + 2000 × 2,5) × 2 × 1,5 = 15 900 µ$ → × 0,9 × 1,1 = 15 741 µ€
    expect(b.quotedMicros).toBe(15_900);
    expect(b.maxEurMicros).toBe(15_741);
    expect(b.fx).toMatchObject({ rate: 0.9, marginRatio: 0.1, source: 'BCE', date: '2026-11-05' });
    expect(toEurMicros(1000, 'EUR', defaultPolicy())).toEqual({ eurMicros: 1000, fx: null });
    expect(toEurMicros(1000, 'GBP', p)).toBeNull();
  });
  it('enveloppes séparées 80 / 20 ; mois UTC ; volume d’entrée sans historique → non estimable', () => {
    expect(envelopeOf(defaultPolicy(), 'EXPERIMENT')).toBe(80_000_000);
    expect(envelopeOf(defaultPolicy(), 'MONITOR')).toBe(20_000_000);
    expect(budgetMonth(new Date('2026-11-30T23:30:00-02:00'))).toBe('2026-12');
    expect(estimateInputTokens({ observedMax: null, variables: {}, attachments: 0, attachmentMaxTokens: null }).tokens).toBeNull();
    expect(estimateInputTokens({ observedMax: 500, variables: {}, attachments: 1, attachmentMaxTokens: null }).tokens).toBeNull();
    expect(estimateInputTokens({ observedMax: 500, variables: { q: 'x'.repeat(4000) }, attachments: 2, attachmentMaxTokens: 300 }).tokens).toBe(Math.ceil(4008 / 2) + 600);
  });
});

describe('L113I-U04 — objectifs : transitions et file (LIF-004, EVT-05)', () => {
  it('transitions de la table §27.2 ; terminal = aucune sortie', () => {
    expect(canTransition('QUEUED', 'EXPERIMENTING')).toBe(true);
    expect(canTransition('DETECTED', 'EXPERIMENTING')).toBe(false);
    expect(canTransition('WAITING_BUDGET', 'QUEUED')).toBe(true);
    for (const t of TERMINAL_STATUSES) expect(canTransition(t, 'QUEUED')).toBe(false);
  });
  it('FIFO par date ; seule exception : retrait officiel en tête (REC-024, REC-025)', () => {
    const l = [
      { id: 1, priority: 'FIFO' as const, createdAt: '2026-11-01T00:00:00Z', t: 'T1' },
      { id: 2, priority: 'FIFO' as const, createdAt: '2026-11-02T00:00:00Z', t: 'T3' },
      { id: 3, priority: 'FIFO' as const, createdAt: '2026-11-03T00:00:00Z', t: 'T2' },
      { id: 4, priority: 'RETIREMENT' as const, createdAt: '2026-11-04T00:00:00Z', t: 'T4' },
    ];
    expect(queueOrder(l).map((x) => x.t)).toEqual(['T4', 'T1', 'T3', 'T2']);
  });
});

describe('L113I-U05 — décision qualité > coût > latence, par traitement (DEC-01..05, EC-01)', () => {
  const m = (caseId: string, durationMs: number, costMicros: number | null) => ({ caseId, durationMs, costMicros, outcome: 'PASSED' as const });
  const serie = (d: number, c: number | null) => [m('a', d, c), m('a', d, c), m('b', d, c), m('b', d, c)];
  it('plus rapide mais plus chère, qualité équivalente → LOSS (REC-050, EVALT-05) — aucune priorité latence pour T2', () => {
    expect(lexicographicGain(serie(1000, 10), serie(100, 20), { maxP95Ms: null }).outcome).toBe('LOSS');
  });
  it('moins chère mais plus lente : plafond À DÉFINIR → POLICY_NOT_CONFIGURED ; sous le plafond → GAIN ; au-delà → LOSS (REC-051)', () => {
    expect(lexicographicGain(serie(100, 20), serie(500, 10), { maxP95Ms: null }).outcome).toBe('POLICY_NOT_CONFIGURED');
    expect(lexicographicGain(serie(100, 20), serie(500, 10), { maxP95Ms: 600 })).toMatchObject({ outcome: 'GAIN', basis: 'COST' });
    expect(lexicographicGain(serie(100, 20), serie(500, 10), { maxP95Ms: 400 }).outcome).toBe('LOSS');
  });
  it('plus rapide à coût égal → GAIN latence ; coût inconnu → NOT_COMPARABLE (jamais zéro)', () => {
    expect(lexicographicGain(serie(500, 10), serie(100, 10), { maxP95Ms: null })).toMatchObject({ outcome: 'GAIN', basis: 'LATENCY' });
    expect(lexicographicGain(serie(500, null), serie(100, null), { maxP95Ms: null }).outcome).toBe('NOT_COMPARABLE');
  });
  it('décisions indépendantes par traitement : T1 et T3 qualifiées → deux choix (REC-063)', () => {
    const g = [{ operationCode: 'x', outcome: 'GAIN' as const }];
    const r = chooseCandidatesByTreatment([
      { key: '11', treatment: 'T1', verdicts: ['ADMISSIBLE'], gains: g, score: 0.5 },
      { key: '12', treatment: 'T1', verdicts: ['ADMISSIBLE'], gains: g, score: 0.9 },
      { key: '31', treatment: 'T3', verdicts: ['ADMISSIBLE'], gains: g, score: 0.8 },
    ]);
    expect(Object.fromEntries(r.chosen)).toEqual({ T1: '11', T3: '31' });
  });
  it('non-régression : plus de +20 % uniforme — hausse de coût sans borne → POLICY_NOT_CONFIGURED (EVALT-04)', () => {
    const obs = (cost: number) => ({ caseId: 'c', source: 'CORPUS_FIXTURE' as const, expectedSource: 'REFERENCE' as const, mandatory: true, observation: 1, outcome: 'PASSED' as const, defects: [], inconclusiveReason: null, durationMs: 10, timeoutMs: 1000, costMicros: cost, servedModel: 'm', traceId: `t${cost}`, accountId: null, captureId: null, historicalSha256: null, observedSha256: null, matchesHistorical: null, attempts: 1 });
    const run = { operationCode: 'op', reference: { verdict: 'ADMISSIBLE' as const, reasons: [], observations: [obs(10)], evidenceId: 1 }, candidate: { verdict: 'ADMISSIBLE' as const, reasons: [], observations: [obs(11)], evidenceId: 2 } };
    expect(assessNonRegression({ runs: [run as never], coverage: null }).blockingReasons.join(' ')).toMatch(/POLICY_NOT_CONFIGURED/);
    expect(assessNonRegression({ runs: [run as never], coverage: null, economics: { maxExtraCostMicrosPerCall: 5 } }).decision).toBe('QUALIFIED');
  });
});

describe('L113I-U06 — surveillance : jalons, jamais d’échéance de rejet (MON-01..03, C-002)', () => {
  const fin = '2026-11-04T00:00:00Z';
  it('aucun appel à H+72 → INSUFFICIENT_USAGE ; à J+7 → toujours INSUFFICIENT_USAGE, candidate conservée (REC-074, REC-075)', () => {
    expect(nextWatchStatus({ verdict: 'INSUFFICIENT_DATA', afterCalls: 0, minCallsValidated: 20, now: new Date('2026-11-03T00:00:00Z'), initialWindowEnd: fin, previous: 'WATCHING' })).toBe('WATCHING');
    expect(nextWatchStatus({ verdict: 'INSUFFICIENT_DATA', afterCalls: 0, minCallsValidated: 20, now: new Date('2026-11-04T01:00:00Z'), initialWindowEnd: fin, previous: 'WATCHING' })).toBe('INSUFFICIENT_USAGE');
    expect(nextWatchStatus({ verdict: 'INSUFFICIENT_DATA', afterCalls: 0, minCallsValidated: 20, now: new Date('2026-11-09T00:00:00Z'), initialWindowEnd: fin, previous: 'INSUFFICIENT_USAGE' })).toBe('INSUFFICIENT_USAGE');
    expect(WATCH_STATUS_LABELS.INSUFFICIENT_USAGE).toBe('Qualification acquise ; observations d’usage insuffisantes ; configuration conservée');
  });
  it('usage suffisant sans dégradation → VALIDATED_IN_USAGE (REC-077) ; télémétrie illisible → OBSERVATION_UNAVAILABLE (REC-079)', () => {
    expect(nextWatchStatus({ verdict: 'OK', afterCalls: 25, minCallsValidated: 20, now: new Date(fin), initialWindowEnd: fin, previous: 'INSUFFICIENT_USAGE' })).toBe('VALIDATED_IN_USAGE');
    expect(nextWatchStatus({ verdict: 'OBSERVATION_UNAVAILABLE', afterCalls: 0, minCallsValidated: 20, now: new Date(fin), initialWindowEnd: fin, previous: 'WATCHING' })).toBe('OBSERVATION_UNAVAILABLE');
    const a = assessPostActivation({ before: { ...EMPTY_USAGE, unavailable: true }, after: { ...EMPTY_USAGE, unavailable: true }, replay: null, candidateActive: true });
    expect(a).toMatchObject({ verdict: 'OBSERVATION_UNAVAILABLE', rollback: false });
  });
  it('rejeu payant seulement sur suspicion, jamais pour combler un manque d’usage (MON-06, REC-075)', () => {
    expect(replaySuspicion(EMPTY_USAGE, EMPTY_USAGE, [])).toBeNull();
    expect(replaySuspicion(EMPTY_USAGE, { ...EMPTY_USAGE, calls: 3, invalid: 1 }, [])).toMatch(/sorties refusées/);
    expect(replaySuspicion({ ...EMPTY_USAGE, unavailable: true }, { ...EMPTY_USAGE, calls: 3, invalid: 1 }, [])).toBeNull();
  });
  it('régression certifiée imputable → retour arrière sans attendre de volume (REC-078)', () => {
    const a = assessPostActivation({ before: EMPTY_USAGE, after: EMPTY_USAGE, replay: { campaignId: 1, status: 'COMPLETED', regressions: [{ operationCode: 't4', caseId: 'c', defects: ['date inventée'] }], reason: null }, candidateActive: true });
    expect(a).toMatchObject({ verdict: 'DEGRADED_IMPUTABLE', rollback: true });
  });
});

describe('L113I-U07 — état de capacité par traitement (RLS-004)', () => {
  it('production → observation ; budget bloqué → BLOCKED ; A1 structurel → qualification seulement ; surveillance → actif', () => {
    expect(capabilityState({ environment: 'production', budgetBlocked: null, structuralA1: 0, activeWatch: false }).state).toBe('OBSERVATION_ONLY');
    expect(capabilityState({ environment: 'preprod', budgetBlocked: 'taux À DÉFINIR', structuralA1: 0, activeWatch: false }).state).toBe('BLOCKED');
    expect(capabilityState({ environment: 'preprod', budgetBlocked: null, structuralA1: 2, activeWatch: false }).state).toBe('QUALIFICATION_AVAILABLE');
    expect(capabilityState({ environment: 'preprod', budgetBlocked: null, structuralA1: 0, activeWatch: true }).state).toBe('AUTONOMOUS_ACTIVE');
    expect(capabilityState({ environment: 'preprod', budgetBlocked: null, structuralA1: 0, activeWatch: false }).state).toBe('AUTONOMOUS_PROMOTION_READY');
  });
});

describe('L113I-U08 — gel illisible = refus dans la transaction (PRO-07, EC-07, REC-067, TX-03)', () => {
  it('la lecture des interventions échoue → PROMOTION_GUARD_UNAVAILABLE (jamais « aucun gel »)', async () => {
    const ref: GateReference = {
      environment: 'preprod', candidateVersionId: 7, campaignId: 3, treatment: 'T6', assessmentId: 1, rulesVersion: 'a1-v2', contextFingerprint: 'x', inventoryVersion: null,
      manifestVersion: 1, certificationStamp: 'a0:0|d0:0', activeVersionId: 1, candidateRevisionId: 9, evidence: [], paramsVersion: 'p',
    };
    const sql = {
      unsafe: async (t: string) => {
        if (t.includes('to_regclass($1)')) return [{ ok: false }];
        if (t.includes('ai_corpus_oracle_approvals') || t.includes('ai_corpus_case_decisions')) return [{ n: 0, m: 0 }];
        if (t.includes('FROM ai_config_versions WHERE id')) return [{ candidate_state: 'QUALIFIED', candidate_campaign_id: 3, current_revision_id: 9 }];
        if (t.includes("to_regclass('ai_config_interventions')")) return [{ ok: true }];
        if (t.includes('ai_config_interventions')) throw new Error('connexion perdue');
        return [];
      },
    };
    await expect(transactionGuard(ref)(sql as never)).rejects.toMatchObject({ gateCode: 'PROMOTION_GUARD_UNAVAILABLE' });
  });
});
