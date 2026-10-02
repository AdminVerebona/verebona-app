/**
 * CDC BO IA GEN-004, NFR-003, §10.4 — file T1 (lot 16b : file durable seule).
 *
 * La file en mémoire (`analysis-queue.ts`) et son drapeau `AI_DURABLE_QUEUE`
 * sont retirés : toute mise en file T1 passe par `ai_job_queue`. Ces tests
 * portent sur le point d'entrée unique des appelants, `enqueueFileAnalyses`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const updates: Array<Record<string, unknown>> = [];
vi.mock('@/db', () => ({
  db: {
    update: () => ({
      set: (set: Record<string, unknown>) => ({ where: async () => { updates.push(set); } }),
    }),
  },
  pgClient: { unsafe: async () => [] },
}));
const nudge = vi.fn();
vi.mock('../../../queue/queue-worker', () => ({
  registerJobHandler: () => {},
  nudgeQueueWorker: () => nudge(),
}));
const enqueue = vi.fn(async (..._a: unknown[]) => ({ decision: 'create', jobId: 1 }));
vi.mock('../../../queue/job-queue.repository', () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));
const triggerActive = vi.fn(async (_t: string, _c: string) => true);
vi.mock('../../../queue/triggers', () => ({ isTriggerActive: (t: string, c: string) => triggerActive(t, c) }));

const { enqueueFileAnalyses, UPLOAD_ORIGIN } = await import('../t1-handler');
const { AI_FLAGS } = await import('@/services/ai/flags/ai-feature-flags');

const racine = process.cwd();

beforeEach(() => {
  updates.length = 0;
  nudge.mockClear();
  enqueue.mockClear();
  triggerActive.mockReset().mockResolvedValue(true);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('file T1 : durable seule', () => {
  it('un dépôt : fichiers marqués « en file », un job durable par fichier, boucleur réveillé', async () => {
    const r = await enqueueFileAnalyses([7, 8, 7], 5, { origin: UPLOAD_ORIGIN, userId: 3 });
    expect(r).toEqual([7, 8]);
    expect(updates).toEqual([expect.objectContaining({ analysisState: 'UPLOADED' })]);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      treatment: 'T1', scope: { accountId: 5, targetType: 'asset_file', targetId: 7 },
      triggerCode: 'source_uploaded', payload: { fileId: 7, userId: 3, origin: UPLOAD_ORIGIN },
    });
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('T1-UI-08 : déclencheur « source_uploaded » inactif — rien n’est mis en file ni marqué', async () => {
    triggerActive.mockResolvedValue(false);
    expect(await enqueueFileAnalyses([7], 5, { origin: UPLOAD_ORIGIN })).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('reprise serveur : pas de filtre de déclencheur, non facturée', async () => {
    triggerActive.mockResolvedValue(false);
    expect(await enqueueFileAnalyses([9], 5, { origin: 'analysis-recovery', billable: false })).toEqual([9]);
    expect(triggerActive).not.toHaveBeenCalled();
    expect(enqueue.mock.calls[0][0]).toMatchObject({ payload: { billable: false } });
  });

  it('WF-10 : un fichier déjà en file n’est pas compté deux fois', async () => {
    enqueue.mockResolvedValueOnce({ decision: 'skip', jobId: 4 });
    expect(await enqueueFileAnalyses([7], 5, { origin: 'documents/analyze-batch' })).toEqual([]);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('plus de file en mémoire ni de drapeau AI_DURABLE_QUEUE (lot 16b)', () => {
    expect(existsSync(join(racine, 'src/services/ai/source-analysis/analysis-queue.ts'))).toBe(false);
    expect(existsSync(join(racine, 'src/app/api/analysis/check-pending/route.ts'))).toBe(false);
    expect(readFileSync(join(racine, 'src/services/ai/source-analysis/queue/t1-handler.ts'), 'utf8')).not.toMatch(/process\.env\.AI_DURABLE_QUEUE/);
    expect(AI_FLAGS as readonly string[]).not.toContain('AI_DURABLE_QUEUE');
  });
});
