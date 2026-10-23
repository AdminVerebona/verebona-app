/**
 * Lot 83C — qualification administrative des exécutions métier, PAR
 * TRAITEMENT (tests purs, instant de référence injecté). CDC Pilotage IA V2
 * §4.2, §10, OP-04 à OP-06, RES-01/02, R17-R22, R39-R43, R58, R60, R61 ;
 * décisions PO 04 et 05.
 */
import { describe, expect, it } from 'vitest';
import {
  inPeriod, qualifyT1, qualifyT2, qualifyT3, qualifyT4, qualifyT6Evaluate, qualifyT6Formulate, referenceAt,
  type JobState, type T1Input, type T1ReportState,
} from '../mapping';

const NOW = new Date('2026-10-23T12:00:00Z');
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const job = (over: Partial<JobState> = {}): JobState => ({
  id: 1, status: 'DONE', attempts: 1, lastError: null, businessResult: null, businessResultDetail: null,
  createdAt: at(5), startedAt: at(5), finishedAt: at(4), availableAt: at(5), ...over,
});
const rapport = (over: Partial<T1ReportState> = {}): T1ReportState => ({
  id: 10, status: 'SUCCESS', createdAt: at(4.5), failedSteps: [], coverageQuality: 'COMPLETE', coverageAnomalies: [], ...over,
});
const t1 = (over: Partial<T1Input> = {}): T1Input => ({
  jobs: [job()], reports: [rapport()], coverage: null, file: { analysisState: 'ANALYZED', deleted: false }, ...over,
});

describe('L83C-M-T1 — document logique (PO 04/05, R17-R19, R58)', () => {
  it('L83C-M-T1-01 — COMPLETE + rapport SUCCESS : Réussie, résultat natif conservé', () => {
    const q = qualifyT1(t1(), NOW);
    expect(q).toMatchObject({ outcome: 'SUCCEEDED', progress: null, cause: null });
    expect(q.native).toMatchObject({ source: 'ai_execution_reports', status: 'SUCCESS', result: 'COMPLETE' });
    expect(q.finishedAt).toEqual(at(4));
  });

  it('L83C-M-T1-02 — R18/R58 : JSON valide mais pages non vérifiées (VERIFICATION_INCOMPLETE) : Incomplète, jamais Réussie', () => {
    const q = qualifyT1(t1({ reports: [rapport({ coverageQuality: 'VERIFICATION_INCOMPLETE', coverageAnomalies: ['PAGE_UNVERIFIED', 'COVERAGE_UNVERIFIED'] })] }), NOW);
    expect(q.outcome).toBe('INCOMPLETE');
    expect(q.cause).toMatch(/T1_VERIFICATION_INCOMPLETE.*pages non vérifiées/);
  });

  it('L83C-M-T1-03 — PO 05 : COMPLETE_WITH_UNRESOLVED n’est jamais mappé à Réussie (raisons réelles exposées)', () => {
    const q = qualifyT1(t1({
      reports: [rapport({ createdAt: at(4.5), coverageQuality: 'COMPLETE_WITH_UNRESOLVED' })],
      coverage: { qualityState: 'COMPLETE_WITH_UNRESOLVED', anomalies: ['FACT_INVALID_DROPPED'], nextRetryAt: null, updatedAt: at(4.4), unresolvedUnits: 3, uncertainUnits: 1, droppedFacts: 2 },
    }), NOW);
    expect(q.outcome).toBe('INCOMPLETE');
    expect(q.cause).toContain('3 unité(s) non structurée(s), 1 incertaine(s), 2 fait(s) écarté(s)');
  });

  it('L83C-M-T1-04 — OP-06 / R61 : reprise ciblée programmée (INCOMPLETE_RETRYABLE) : non finale, suspendue', () => {
    const q = qualifyT1(t1({ coverage: { qualityState: 'INCOMPLETE_RETRYABLE', anomalies: ['REPAIR_PENDING'], nextRetryAt: at(-1), updatedAt: at(4.4) } }), NOW);
    expect(q).toMatchObject({ outcome: 'NOT_FINAL', progress: 'SUSPENDED', finishedAt: null });
    // Plus de reprise programmée : Incomplète (jamais Échouée par simple durée).
    const fin = qualifyT1(t1({ coverage: { qualityState: 'INCOMPLETE_RETRYABLE', anomalies: [], nextRetryAt: null, updatedAt: at(4.4) } }), NOW);
    expect(fin.outcome).toBe('INCOMPLETE');
    expect(qualifyT1(t1({ reports: [rapport({ coverageQuality: 'INCOMPLETE_FINAL' })] }), NOW).outcome).toBe('INCOMPLETE');
  });

  it('L83C-M-T1-05 — couverture courante prise seulement si plus récente que le rapport (sinon instantané du rapport)', () => {
    const ancienne = qualifyT1(t1({ reports: [rapport({ coverageQuality: 'COMPLETE' })], coverage: { qualityState: 'VERIFICATION_INCOMPLETE', anomalies: [], nextRetryAt: null, updatedAt: at(10) } }), NOW);
    expect(ancienne.outcome).toBe('SUCCEEDED');
    const reparee = qualifyT1(t1({ reports: [rapport({ coverageQuality: 'COMPLETE_WITH_UNRESOLVED' })], coverage: { qualityState: 'COMPLETE', anomalies: [], nextRetryAt: null, updatedAt: at(1) } }), NOW);
    expect(reparee).toMatchObject({ outcome: 'SUCCEEDED', finishedAt: at(1) });
  });

  it('L83C-M-T1-06 — R20 / RES-02 : persistance partielle (rapport PARTIAL) : Incomplète ; rapport FAILED : Échouée', () => {
    expect(qualifyT1(t1({ reports: [rapport({ status: 'PARTIAL', failedSteps: ['TITLE'] })] }), NOW))
      .toMatchObject({ outcome: 'INCOMPLETE', cause: expect.stringContaining('TITLE') });
    expect(qualifyT1(t1({ reports: [rapport({ status: 'FAILED', failedSteps: ['MASTER'] })], jobs: [job({ businessResult: 'FAILED', businessResultDetail: { cause: 'INVALID_OUTPUT / SCHEMA' } })] }), NOW).outcome).toBe('FAILED');
  });

  it('L83C-M-T1-07 — R22 / R61 : échec puis travail de reprise en attente : non finale (pas d’échec compté), puis réussite finale', () => {
    const echec = rapport({ id: 10, status: 'FAILED', createdAt: at(6), failedSteps: ['MASTER'] });
    const reprise = job({ id: 2, status: 'PENDING', attempts: 0, createdAt: at(5.9), startedAt: null, finishedAt: null, availableAt: at(5) });
    expect(qualifyT1(t1({ jobs: [reprise], reports: [echec] }), NOW)).toMatchObject({ outcome: 'NOT_FINAL', progress: 'PENDING' });
    const enCours = { ...reprise, status: 'RUNNING', startedAt: at(1) };
    expect(qualifyT1(t1({ jobs: [enCours], reports: [echec] }), NOW)).toMatchObject({ outcome: 'NOT_FINAL', progress: 'RUNNING' });
    const fini = { ...reprise, status: 'DONE', startedAt: at(1), finishedAt: at(0.5) };
    expect(qualifyT1(t1({ jobs: [fini], reports: [echec, rapport({ id: 11, createdAt: at(0.6) })] }), NOW)).toMatchObject({ outcome: 'SUCCEEDED', finishedAt: at(0.5) });
  });

  it('L83C-M-T1-08 — travail en reprise automatique (tentative consommée) ou reporté au plafond : suspendue', () => {
    const q = qualifyT1(t1({ jobs: [job({ status: 'PENDING', attempts: 2, lastError: '503', availableAt: at(-0.2), finishedAt: null })], reports: [] }), NOW);
    expect(q).toMatchObject({ outcome: 'NOT_FINAL', progress: 'SUSPENDED' });
    const plafond = qualifyT1(t1({ jobs: [job({ status: 'PENDING', attempts: 0, costCapDeferredUntil: '2026-11-01T00:01:00.000Z', finishedAt: null })], reports: [] }), NOW);
    expect(plafond.cause).toMatch(/plafond IA.*2026-11-01/);
  });

  it('L83C-M-T1-09 — annulé : sans objet ; DONE sans analyse : sans objet ; sans rapport ni échec : non déterminable', () => {
    expect(qualifyT1(t1({ jobs: [job({ status: 'CANCELLED', createdAt: at(1) })], reports: [] }), NOW).outcome).toBe('VOID');
    expect(qualifyT1(t1({ jobs: [job({ createdAt: at(1), startedAt: at(1), finishedAt: at(0.9) })], reports: [rapport({ createdAt: at(4) })] }), NOW).outcome).toBe('VOID');
    expect(qualifyT1(t1({ jobs: [], reports: [], file: { analysisState: 'ANALYZED', deleted: false } }), NOW).outcome).toBe('UNDETERMINED');
    expect(qualifyT1(t1({ reports: [rapport({ coverageQuality: null })] }), NOW).outcome).toBe('UNDETERMINED');
  });

  it('L83C-M-T1-10 — échec définitif du travail (timeout) : Échouée avec la cause native', () => {
    const q = qualifyT1(t1({ jobs: [job({ status: 'FAILED', lastError: 'délai global d’exécution dépassé', createdAt: at(2) })], reports: [] }), NOW);
    expect(q).toMatchObject({ outcome: 'FAILED', native: { source: 'ai_job_queue', status: 'FAILED' } });
    expect(q.cause).toContain('délai global');
  });
});

describe('L83C-M-T3 — travail de réconciliation (R20, R39)', () => {
  it('L83C-M-T3-01 — APPLIED, NO_CHANGE, ABSTAIN : Réussie ; SUPERSEDED, TARGET_GONE : sans objet (jamais un échec)', () => {
    for (const r of ['APPLIED', 'NO_CHANGE', 'ABSTAIN']) expect(qualifyT3(job({ businessResult: r }), [], NOW)).toMatchObject({ outcome: 'SUCCEEDED', native: { result: r } });
    for (const r of ['SUPERSEDED', 'TARGET_GONE']) expect(qualifyT3(job({ businessResult: r }), [], NOW).outcome).toBe('VOID');
  });
  it('L83C-M-T3-02 — R20 : écritures obligatoires en échec (rapport) : pas de faux succès', () => {
    expect(qualifyT3(job({ businessResult: 'APPLIED' }), [{ id: 3, status: 'PARTIAL', createdAt: at(4), failedSteps: ['WRITE'] }], NOW).outcome).toBe('INCOMPLETE');
    expect(qualifyT3(job({ businessResult: 'APPLIED' }), [{ id: 3, status: 'FAILED', createdAt: at(4), failedSteps: [] }], NOW).outcome).toBe('FAILED');
  });
  it('L83C-M-T3-03 — FAILED technique : Échouée ; PENDING / RUNNING : non finale', () => {
    expect(qualifyT3(job({ status: 'FAILED', lastError: 'boom' }), [], NOW).outcome).toBe('FAILED');
    expect(qualifyT3(job({ status: 'RUNNING' }), [], NOW)).toMatchObject({ outcome: 'NOT_FINAL', progress: 'RUNNING' });
    expect(qualifyT3(job({ status: 'DONE', businessResult: null }), [], NOW).outcome).toBe('UNDETERMINED');
  });
});

describe('L83C-M-T4 — travail Agenda (R40, R41)', () => {
  it('L83C-M-T4-01 — ABSTAIN (date indéterminable) : issue valide ; travail ignoré : sans objet', () => {
    expect(qualifyT4(job({ businessResult: 'ABSTAIN' }), NOW).outcome).toBe('SUCCEEDED');
    expect(qualifyT4(job({ businessResult: null }), NOW).outcome).toBe('VOID');
  });
  it('L83C-M-T4-02 — R40 : application partielle en reprise : non finale ; épuisée : Incomplète (pas Échouée)', () => {
    expect(qualifyT4(job({ status: 'PENDING', attempts: 1, lastError: 'T4_PERSIST_PARTIAL : 1 écriture…' }), NOW)).toMatchObject({ outcome: 'NOT_FINAL', progress: 'SUSPENDED' });
    expect(qualifyT4(job({ status: 'FAILED', lastError: 'T4_INCOMPLETE : 2 candidat(s) sans décision' }), NOW))
      .toMatchObject({ outcome: 'INCOMPLETE', cause: expect.stringMatching(/^T4_INCOMPLETE/) });
    expect(qualifyT4(job({ status: 'FAILED', lastError: 'PermanentJobError' }), NOW).outcome).toBe('FAILED');
  });
});

describe('L83C-M-T2 — demande de l’assistant (R21)', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    requestId: 'r1', status: 'ok', machineFinalState: 'READY', mode: 'ai', errorCode: null, createdAt: at(1), latencyMs: 4000, supportLevel: 'supported', ...over,
  });
  it('L83C-M-T2-01 — réponse étayée : Réussie ; abstention / conflit sans affirmation non étayée : Réussie (absence légitime ≠ échec)', () => {
    expect(qualifyT2(run(), NOW, 30_000)).toMatchObject({ outcome: 'SUCCEEDED', finishedAt: new Date(at(1).getTime() + 4000) });
    expect(qualifyT2(run({ supportLevel: 'insufficient' }), NOW, 30_000).outcome).toBe('SUCCEEDED');
    expect(qualifyT2(run({ supportLevel: 'conflicting' }), NOW, 30_000).outcome).toBe('SUCCEEDED');
  });
  it('L83C-M-T2-02 — lacune objective (affirmations écartées par la validation) : Incomplète', () => {
    expect(qualifyT2(run({ supportLevel: 'partial' }), NOW, 30_000)).toMatchObject({ outcome: 'INCOMPLETE', cause: expect.stringContaining('T2_CLAIMS_DISCARDED') });
  });
  it('L83C-M-T2-03 — erreur : Échouée ; annulée : sans objet ; en cours : non finale ; abandonnée : non déterminable', () => {
    expect(qualifyT2(run({ status: 'error', errorCode: 'ASSISTANT_UNAVAILABLE' }), NOW, 30_000)).toMatchObject({ outcome: 'FAILED', cause: expect.stringContaining('ASSISTANT_UNAVAILABLE') });
    expect(qualifyT2(run({ status: 'cancelled' }), NOW, 30_000).outcome).toBe('VOID');
    expect(qualifyT2(run({ status: 'pending', createdAt: new Date(NOW.getTime() - 5_000) }), NOW, 30_000)).toMatchObject({ outcome: 'NOT_FINAL', progress: 'RUNNING' });
    expect(qualifyT2(run({ status: 'pending', createdAt: at(2) }), NOW, 30_000).outcome).toBe('UNDETERMINED');
  });
});

describe('L83C-M-T6 — FORMULATE et EVALUATE (R42, R43)', () => {
  it('L83C-M-T6-01 — R42 : génération en échec puis texte de secours : Échouée (le journal reste honnête)', () => {
    expect(qualifyT6Formulate({ traceId: 't', status: 'generated', mode: 'display', error: null, createdAt: at(1) }).outcome).toBe('SUCCEEDED');
    for (const status of ['validation_failed', 'error']) {
      expect(qualifyT6Formulate({ traceId: 't', status, mode: 'display', error: 'x', createdAt: at(1) }))
        .toMatchObject({ outcome: 'FAILED', cause: expect.stringContaining('texte de secours affiché') });
    }
  });
  it('L83C-M-T6-02 — R43 : EVALUATE a ses propres états (PENDING, RUNNING, RETRY_WAIT, COMPLETED, FAILED)', () => {
    const ev = (over: Record<string, unknown>) => ({
      agendaItemId: 5, status: 'PENDING', attempts: 0, requestedAt: at(3), startedAt: null, finishedAt: null, updatedAt: at(3),
      leaseUntil: null, nextAttemptAt: null, lastErrorKind: null, lastError: null, lastOutcome: null, mode: 'pregen', ...over,
    });
    expect(qualifyT6Evaluate(ev({}), NOW)).toMatchObject({ outcome: 'NOT_FINAL', progress: 'PENDING' });
    expect(qualifyT6Evaluate(ev({ status: 'RUNNING', leaseUntil: at(-0.1) }), NOW).progress).toBe('RUNNING');
    expect(qualifyT6Evaluate(ev({ status: 'RUNNING', leaseUntil: at(1) }), NOW).progress).toBe('SUSPENDED');
    expect(qualifyT6Evaluate(ev({ status: 'RETRY_WAIT', attempts: 1, lastErrorKind: 'model_unavailable', nextAttemptAt: at(-1) }), NOW)).toMatchObject({ outcome: 'NOT_FINAL', progress: 'SUSPENDED' });
    expect(qualifyT6Evaluate(ev({ status: 'COMPLETED', finishedAt: at(1), updatedAt: at(1) }), NOW)).toMatchObject({ outcome: 'SUCCEEDED', finishedAt: at(1) });
    expect(qualifyT6Evaluate(ev({ status: 'FAILED', lastErrorKind: 'invalid_output', finishedAt: at(1) }), NOW).cause).toMatch(/^T6_EVALUATE_INVALID_OUTPUT/);
  });
});

describe('L83C-M-PER — règle temporelle commune (SEM-02, BO-05, R60)', () => {
  it('L83C-M-PER-01 — exécution créée avant la période et terminée pendant : comptée ; non finale : par dernière activité', () => {
    const from = at(24 * 7);
    const q = qualifyT1(t1({ jobs: [job({ createdAt: at(24 * 9), startedAt: at(24 * 9), finishedAt: at(24 * 6) })], reports: [rapport({ createdAt: at(24 * 6.1) })] }), NOW);
    expect(referenceAt(q)).toEqual(at(24 * 6));
    expect(inPeriod(q, from, NOW)).toBe(true);
    expect(inPeriod(q, from, at(24 * 6))).toBe(false); // fin exclue
    const nf = qualifyT3(job({ status: 'RUNNING', createdAt: at(24 * 8), startedAt: at(24 * 8), finishedAt: null }), [], NOW);
    expect(inPeriod(nf, from, NOW)).toBe(false);
  });
});
