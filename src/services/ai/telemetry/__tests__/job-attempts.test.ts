/**
 * Lot 34C — BO › Exécutions IA : tentatives du job ≠ appels modèle, retry
 * explicite (UXERR-01, 02, 03, 05, 06).
 */
import { describe, it, expect } from 'vitest';
import { buildJobExecutionView, type AttemptHistoryEntry } from '../job-attempts';
import type { ExecutionRow } from '../execution-log.repository';

const NOW = Date.parse('2026-10-09T10:00:00Z');
let seq = 0;

function call(p: { attempt: number | null; rank: 'primary' | 'fallback_1' | 'fallback_2'; model: string; ok?: boolean; at: string }): ExecutionRow {
  seq++;
  return {
    id: seq, createdAt: new Date(p.at), useCaseCode: 'U1', treatment: 'T1', operationCode: 't1_analyze_document',
    accountId: 1, userId: 1, provider: 'google', model: p.model, modelRank: p.rank, usedFallback: p.rank !== 'primary',
    inputTokens: 13_927, outputTokens: 1_790, costMicros: 10, durationMs: 30_700, status: p.ok ? 'success' : 'error',
    errorCode: p.ok ? null : 'INVALID_OUTPUT', errorMessage: p.ok ? null : 'Sortie non conforme au schéma',
    configVersionId: null, configVisibleNumber: null, appVersion: 'abc', jobId: 595, promptVersion: 'v1',
    objectType: 'asset_file', objectId: '42', trigger: null, origin: 'automatic', callerMode: null,
    task: 'ANALYZE_DOCUMENT', masterPromptCode: 't1_master', masterPromptVersion: '3', reasoning: null, maxOutputTokens: null,
    engine: 'new', callTrigger: null, callKind: 'analysis',
    failure: p.ok ? null : { family: 'INVALID_OUTPUT', subtype: 'SCHEMA_VALIDATION_FAILED', stage: 'schema_validation', signature: 's1' },
    providerMeta: null, repaired: false, jobAttempt: p.attempt, traceId: `trace-${p.attempt}`, runtimeContract: null, transformations: null, structuredContext: null,
  };
}
const cascade = (attempt: number, at: string, okLast = false) => [
  call({ attempt, rank: 'primary', model: 'gemini-2.5-pro', at }),
  call({ attempt, rank: 'fallback_1', model: 'gemini-3.5-flash', at }),
  call({ attempt, rank: 'fallback_2', model: 'gemini-3.1-flash-lite', ok: okLast, at }),
];
const hist = (h: Partial<AttemptHistoryEntry> & Pick<AttemptHistoryEntry, 'attempt' | 'outcome'>): AttemptHistoryEntry => ({
  startedAt: null, endedAt: null, ...h,
});
const job = (j: Partial<Parameters<typeof buildJobExecutionView>[0]['job']>) => ({
  id: 595, treatment: 'T1', status: 'DONE', attempts: 1, availableAt: null, businessResult: null, lastError: null, ...j,
});

describe('buildJobExecutionView', () => {
  it('UXERR-01 — principal en échec, job toujours RUNNING : « Fallback 1 : RUNNING »', () => {
    const v = buildJobExecutionView({
      job: job({ status: 'RUNNING', attempts: 1 }), history: [],
      calls: [call({ attempt: 1, rank: 'primary', model: 'gemini-2.5-pro', at: '2026-10-09T09:59:00Z' })],
      diagnostics: [], maxAttempts: 5, now: NOW,
    });
    expect(v.attempts).toHaveLength(1);
    expect(v.attempts[0]).toMatchObject({ attempt: 1, status: 'RUNNING', runningCall: { label: 'fallback 1', rank: 'fallback_1' } });
    expect(v.attempts[0].calls.map((c) => [c.label, c.status])).toEqual([['principal', 'FAILED']]);
    expect(v.retry).toMatchObject({ automatic: false, state: null, scheduled: false });
  });

  it('UXERR-02 — tous les modèles échouent, vrai retry planifié : Tentative #1 FAILED, Retry OUI, Tentative #2 QUEUED', () => {
    const v = buildJobExecutionView({
      job: job({ status: 'PENDING', attempts: 1, availableAt: new Date('2026-10-09T10:00:30Z') }),
      history: [hist({ attempt: 1, outcome: 'failed', retryScheduled: true, nextAttemptAt: '2026-10-09T10:00:30Z', error: 'analyse du fichier 42 en échec' })],
      calls: cascade(1, '2026-10-09T09:59:00Z'), diagnostics: [], maxAttempts: 5, now: NOW,
    });
    expect(v.attempts.map((a) => [a.attempt, a.status, a.modelCalls])).toEqual([[1, 'FAILED', 3], [2, 'QUEUED', 0]]);
    expect(v.attempts[0]).toMatchObject({ cause: 'INVALID_OUTPUT / SCHEMA_VALIDATION_FAILED', retryScheduled: true });
    expect(v.retry).toMatchObject({
      currentAttempt: 2, maxAttempts: 5, automatic: true, state: 'QUEUED', scheduled: true,
      reason: 'INVALID_OUTPUT / SCHEMA_VALIDATION_FAILED', nextAttempt: '2026-10-09T10:00:30.000Z',
    });
    const immediat = buildJobExecutionView({
      job: job({ status: 'PENDING', attempts: 1, availableAt: new Date('2026-10-09T09:00:00Z') }),
      history: [hist({ attempt: 1, outcome: 'failed', retryScheduled: true })], calls: [], diagnostics: [], maxAttempts: 5, now: NOW,
    });
    expect(immediat.retry.nextAttempt).toBe('IMMEDIATE');
  });

  it('UXERR-03 — tous les modèles échouent, aucun retry : Retry automatique NON, aucune tentative en file', () => {
    const v = buildJobExecutionView({
      job: job({ status: 'DONE', attempts: 1, businessResult: 'FAILED' }),
      history: [hist({ attempt: 1, outcome: 'done', businessResult: 'FAILED', retryScheduled: false })],
      calls: cascade(1, '2026-10-09T09:59:00Z'), diagnostics: [], maxAttempts: 5, now: NOW,
    });
    expect(v.retry).toMatchObject({ automatic: false, state: null, scheduled: false, nextAttempt: null });
    expect(v.attempts.map((a) => a.status)).toEqual(['FAILED']);
    expect(v.attempts.some((a) => a.status === 'QUEUED')).toBe(false);
  });

  it('UXERR-05 — job DONE, T1 en échec : statut du job et résultat métier séparés', () => {
    const v = buildJobExecutionView({
      job: job({ status: 'DONE', attempts: 2, businessResult: 'FAILED' }),
      history: [
        hist({ attempt: 1, outcome: 'failed', retryScheduled: true }),
        hist({ attempt: 2, outcome: 'done', businessResult: 'FAILED', retryScheduled: false }),
      ],
      calls: [...cascade(1, '2026-10-09T09:50:00Z'), ...cascade(2, '2026-10-09T09:55:00Z')], diagnostics: [], maxAttempts: 5, now: NOW,
    });
    expect(v.jobStatus).toBe('DONE');
    expect(v.businessResult).toBe('FAILED');
    expect(v.attempts[1].status).toBe('FAILED'); // DONE technique ≠ réussite
    expect(v.retry).toMatchObject({ automatic: true, state: 'FAILED', scheduled: false });
  });

  it('UXERR-06 — deux tentatives du job et trois modèles par tentative : 2 tentatives × 3 appels, jamais « 6 tentatives »', () => {
    const v = buildJobExecutionView({
      job: job({ status: 'DONE', attempts: 2, businessResult: null }),
      history: [
        hist({ attempt: 1, outcome: 'failed', retryScheduled: true }),
        hist({ attempt: 2, outcome: 'done', businessResult: null, retryScheduled: false }),
      ],
      calls: [...cascade(1, '2026-10-09T09:50:00Z'), ...cascade(2, '2026-10-09T09:55:00Z', true)], diagnostics: [], maxAttempts: 5, now: NOW,
    });
    expect(v.attemptsCount).toBe(2);
    expect(v.attempts.map((a) => [a.attempt, a.modelCalls, a.status])).toEqual([[1, 3, 'FAILED'], [2, 3, 'SUCCESS']]);
    expect(v.attempts[0].calls.map((c) => c.label)).toEqual(['principal', 'fallback 1', 'fallback 2']);
    expect(v.retry).toMatchObject({ automatic: true, state: 'SUCCESS' });
    expect(v.legacyCalls).toEqual([]);
  });

  it('traces antérieures au lot 34 (sans tentative) : rattachées par fenêtre de temps, sinon non attribuées', () => {
    const v = buildJobExecutionView({
      job: job({ status: 'DONE', attempts: 1 }),
      history: [hist({ attempt: 1, outcome: 'done', startedAt: '2026-10-09T09:00:00Z', endedAt: '2026-10-09T09:10:00Z' })],
      calls: [
        call({ attempt: null, rank: 'primary', model: 'm', ok: true, at: '2026-10-09T09:05:00Z' }),
        call({ attempt: null, rank: 'primary', model: 'm', ok: true, at: '2026-10-08T09:05:00Z' }),
      ],
      diagnostics: [], maxAttempts: 5, now: NOW,
    });
    expect(v.attempts[0].modelCalls).toBe(1);
    expect(v.legacyCalls).toHaveLength(1);
  });
});
