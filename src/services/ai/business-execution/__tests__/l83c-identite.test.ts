/**
 * Lot 83C — identité et contexte des exécutions métier (SEM-01, R22, R56),
 * période (SEM-02, BO-05), récapitulatif (BO-04). Tests purs.
 */
import { describe, expect, it } from 'vitest';
import {
  executionIdOfJob, newT1ExecutionId, parseExecutionId, readJobExecutionRef, t6EvaluateExecutionId,
} from '../identity';
import { businessExecutionOfCall, currentBusinessExecutionId, currentBusinessExecutionIds, runInBusinessExecution } from '../context';
import { runInJobContext } from '../../queue/job-context';
import { parisMidnight, periodFromQuery } from '../period';
import { summarize, t1Origin } from '../repository';
import type { BusinessExecution } from '../types';

describe('L83C-U-ID — identifiants', () => {
  it('L83C-U-ID-01 — formats lisibles et relus, entrée invalide refusée', () => {
    const id = newT1ExecutionId();
    expect(parseExecutionId(id)).toMatchObject({ treatment: 'T1', kind: 'uuid' });
    expect(parseExecutionId('T1:job:42')).toEqual({ treatment: 'T1', kind: 'job', jobId: 42 });
    expect(parseExecutionId('T1:report:7')).toEqual({ treatment: 'T1', kind: 'report', reportId: 7 });
    expect(parseExecutionId('T3:12')).toEqual({ treatment: 'T3', jobId: 12 });
    expect(parseExecutionId('T2:4f1c2d3e-0000-4000-8000-000000000000')).toMatchObject({ treatment: 'T2' });
    expect(parseExecutionId('T6F:abc-123')).toEqual({ treatment: 'T6', mode: 'FORMULATE', traceId: 'abc-123' });
    expect(parseExecutionId(t6EvaluateExecutionId(9, '2026-10-23T10:00:00Z'))).toEqual({ treatment: 'T6', mode: 'EVALUATE', agendaItemId: 9, requestedAtMs: Date.parse('2026-10-23T10:00:00Z') });
    for (const bad of ['', 'T1:', 'T1:job:x', 'T3:1:2', "T2:a';drop", 'T9:1', 'T6E:1']) expect(parseExecutionId(bad)).toBeNull();
  });

  it('L83C-U-ID-02 — R22 : un travail de reprise porte l’exécution reprise ; sans référence, le travail est sa propre exécution', () => {
    expect(executionIdOfJob({ id: 5, treatment: 'T1', targetType: 'asset_file', payload: { businessExecution: { id: 'T1:job:3', role: 'resume' } } })).toBe('T1:job:3');
    expect(executionIdOfJob({ id: 5, treatment: 'T1', targetType: 'asset_file', payload: { fileId: 1 } })).toBe('T1:job:5');
    expect(executionIdOfJob({ id: 6, treatment: 'T1', targetType: null, payload: {} })).toBeNull();
    expect(executionIdOfJob({ id: 7, treatment: 'T4', payload: {} })).toBe('T4:7');
    expect(readJobExecutionRef({ businessExecution: { id: 'T3:1' } })).toBeNull();
  });
});

describe('L83C-U-CTX — l’identifiant suit l’exécution jusqu’aux appels', () => {
  it('L83C-U-CTX-01 — contexte explicite, sinon travail de file, sinon technique ; T6 FORMULATE = exécution de la passerelle', async () => {
    expect(currentBusinessExecutionId()).toBeNull();
    expect(businessExecutionOfCall({ operationCode: 'model_probe', traceId: 'tr' })).toEqual({ id: null, ids: [] });
    expect(businessExecutionOfCall({ operationCode: 't6_formulate', traceId: 'tr' })).toEqual({ id: 'T6F:tr', ids: [] });
    await runInJobContext({ jobId: 3, treatment: 'T3', configVersionId: null, businessExecutionId: 'T3:3' }, async () => {
      expect(businessExecutionOfCall({ operationCode: 't3_value_conflict', traceId: 'x' }).id).toBe('T3:3');
      await runInBusinessExecution('T1:job:9', async () => {
        await Promise.resolve();
        expect(currentBusinessExecutionIds()).toEqual(['T1:job:9']);
      });
    });
  });

  it('L83C-U-CTX-02 — appel servant plusieurs exécutions (T6 EVALUATE) : liste, colonne vide (aucune attribution arbitraire)', async () => {
    await runInBusinessExecution(['T6E:1:1', 'T6E:2:1', 'T6E:1:1'], async () => {
      expect(businessExecutionOfCall({ operationCode: 't6_evaluate', traceId: 'x' })).toEqual({ id: null, ids: ['T6E:1:1', 'T6E:2:1'] });
    });
    await runInBusinessExecution([], async () => expect(currentBusinessExecutionIds()).toEqual([]));
  });
});

describe('L83C-U-PER — période (SEM-02, BO-05)', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  it('L83C-U-PER-01 — 7 jours glissants par défaut ; jours de Paris (heure d’été / d’hiver), fin incluse au jour près', () => {
    const p = periodFromQuery({}, now);
    expect(p.to.getTime() - p.from.getTime()).toBe(7 * 86_400_000 + 1);
    expect(parisMidnight('2026-10-23').toISOString()).toBe('2026-10-22T22:00:00.000Z');
    expect(parisMidnight('2026-12-01').toISOString()).toBe('2026-11-30T23:00:00.000Z');
    const c = periodFromQuery({ from: '2026-10-20', to: '2026-10-23' }, now);
    expect([c.from.toISOString(), c.to.toISOString()]).toEqual(['2026-10-19T22:00:00.000Z', '2026-10-23T22:00:00.000Z']);
    expect(periodFromQuery({ days: '365' }, now).to.getTime() - periodFromQuery({ days: '365' }, now).from.getTime()).toBe(90 * 86_400_000 + 1);
    expect(p.rule).toMatch(/fin de l’exécution.*Europe\/Paris/);
  });
});

describe('L83C-U-SUM — récapitulatif (BO-04, SEM-06)', () => {
  const x = (treatment: BusinessExecution['treatment'], outcome: BusinessExecution['outcome'], nature: BusinessExecution['nature'] = 'BUSINESS') => ({ treatment, outcome, nature }) as BusinessExecution;
  it('L83C-U-SUM-01 — chaque exécution comptée une fois ; technique à part, jamais dans les issues métier', () => {
    const s = summarize([x('T1', 'SUCCEEDED'), x('T1', 'SUCCEEDED'), x('T1', 'INCOMPLETE'), x('T3', 'FAILED'), x('T3', 'SUCCEEDED', 'TECHNICAL'), x('T3', 'NOT_FINAL'), x('T4', 'VOID')], ['T1', 'T3', 'T4']);
    expect(s).toEqual([
      { treatment: 'T1', succeeded: 2, incomplete: 1, failed: 0, notFinal: 0, void: 0, undetermined: 0, technical: 0 },
      { treatment: 'T3', succeeded: 0, incomplete: 0, failed: 1, notFinal: 1, void: 0, undetermined: 0, technical: 1 },
      { treatment: 'T4', succeeded: 0, incomplete: 0, failed: 0, notFinal: 0, void: 1, undetermined: 0, technical: 0 },
    ]);
  });
  it('L83C-U-SUM-02 — SEM-06 : origine explicite (utilisateur, administrateur, reprise, test, automatique)', () => {
    expect(t1Origin({ origin: 'files/confirm' })).toBe('USER');
    expect(t1Origin({ jobOrigin: 'manual', origin: 'admin/manual' })).toBe('ADMIN');
    expect(t1Origin({ origin: 'documents/analyze:reprise' })).toBe('RESUME');
    expect(t1Origin({ origin: 'analysis-recovery' })).toBe('RESUME');
    expect(t1Origin({ origin: 'corpus-pipeline' })).toBe('TEST');
    expect(t1Origin({ origin: 'referential-upgrade' })).toBe('AUTOMATIC');
    expect(t1Origin({})).toBe('UNKNOWN');
  });
});
