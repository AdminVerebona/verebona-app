/**
 * CDC 15 T4-08 (lot 14) — réanalyse SANS candidat : sous AI_T4_EFFECTS=enabled,
 * le travail T4 synchronise la source (`persist([], …, { sourceFileId })`),
 * ce qui retire les anciens éléments automatiques ; hors `enabled`, rien ne
 * change (travail ignoré, pas d'options passées).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runT4Job } from '../index';
import { NO_GUARD } from '../../queue/execution-control';
import type { QueuedJob } from '../../queue/job-queue.repository';

const job = (payload: Record<string, unknown>): QueuedJob => ({
  id: 1, treatment: 'T4', accountId: 5, targetType: 'asset_file', targetId: '3', status: 'RUNNING', origin: 'automatic',
  triggerCode: 'source_analyzed', attempts: 1, lastError: null, availableAt: new Date(), coalesceRequested: false,
  headPriority: false, createdAt: new Date(), startedAt: new Date(), finishedAt: null, payload, executionId: null,
  workerId: null, leaseExpiresAt: null, recoveredCount: 0, configVersionId: null,
});
const deps = (mode: 'legacy' | 'shadow' | 'enabled', write = true) => ({
  loadExisting: vi.fn(async () => []),
  persist: vi.fn(async (..._a: unknown[]) => {}),
  process: vi.fn(async () => [{ action: 'create' }]) as never,
  shouldWrite: () => write,
  t4Effects: () => mode,
});
const vide = { assetId: 2, userId: 1, leadSourceId: 3, candidates: [] };

afterEach(() => vi.restoreAllMocks());

describe('réanalyse sans candidat', () => {
  it('enabled, analyse complète : persist([], compte, bien, { sourceFileId, analysisComplete })', async () => {
    const d = deps('enabled');
    await runT4Job(job({ ...vide, analysisComplete: true }), NO_GUARD, d);
    expect(d.persist).toHaveBeenCalledWith([], 5, 2, { sourceFileId: 3, analysisComplete: true });
    expect(d.process).not.toHaveBeenCalled();
  });

  it('enabled, analyse incomplète ou complétude inconnue : rien (réanalyse vide ou dégradée)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const p of [vide, { ...vide, analysisComplete: false, incompleteReasons: ['PARTIAL_EXTRACTION'] }]) {
      const d = deps('enabled');
      await runT4Job(job(p), NO_GUARD, d);
      expect(d.persist).not.toHaveBeenCalled();
    }
    expect(info.mock.calls.some((c) => String(c[0]).includes('PARTIAL_EXTRACTION'))).toBe(true);
  });

  it('enabled mais moteur en observation : aucune écriture', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = deps('enabled', false);
    await runT4Job(job(vide), NO_GUARD, d);
    expect(d.persist).not.toHaveBeenCalled();
  });

  it('legacy / shadow : ignoré comme avant', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const mode of ['legacy', 'shadow'] as const) {
      const d = deps(mode);
      await runT4Job(job(vide), NO_GUARD, d);
      expect(d.persist).not.toHaveBeenCalled();
    }
  });
});

describe('options de persistance', () => {
  const cand = { ...vide, candidates: [{ title: 'Contrôle technique', date: '2027-01-10', confidence: 'certain', excerpt: '…' }] };
  it('enabled : sourceFileId et complétude transmis ; sinon trois arguments comme avant', async () => {
    const e = deps('enabled');
    await runT4Job(job({ ...cand, analysisComplete: false, incompleteReasons: ['FACTS_TRUNCATED'] }), NO_GUARD, e);
    expect(e.persist).toHaveBeenCalledWith([{ action: 'create' }], 5, 2, {
      sourceFileId: 3, analysisComplete: false, incompleteReasons: ['FACTS_TRUNCATED'],
    });
    const l = deps('legacy');
    await runT4Job(job(cand), NO_GUARD, l);
    expect(l.persist.mock.calls[0]).toEqual([[{ action: 'create' }], 5, 2]);
  });
});
