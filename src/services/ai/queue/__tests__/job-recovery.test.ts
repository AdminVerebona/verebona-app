/**
 * Reprise automatique des jobs RUNNING abandonnés (arrêt brutal du
 * processus) — sans jamais reprendre un job encore vivant ailleurs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const claimNext = vi.fn();
const completeJob = vi.fn(async () => ({ requeued: false }));
const failJob = vi.fn(async () => ({ permanent: false }));
const renewLease = vi.fn(async () => true);
vi.mock('../job-queue.repository', () => ({
  claimNext: (...a: unknown[]) => claimNext(...a),
  completeJob: (...a: unknown[]) => completeJob(...(a as [])),
  failJob: (...a: unknown[]) => failJob(...(a as [])),
  renewLease: (...a: unknown[]) => renewLease(...(a as [])),
  recoverAbandonedJobs: async () => [],
  isExecutionActive: async () => true,
  LEASE_SECONDS: 3,
}));

const { runOne, registerJobHandler, clearJobHandlers, WORKER_ID } = await import('../queue-worker');
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

beforeEach(() => {
  clearJobHandlers();
  claimNext.mockReset(); completeJob.mockClear(); failJob.mockClear(); renewLease.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('bail d’exécution', () => {
  it('le prélèvement porte l’identité du processus ; la clôture exige le jeton', async () => {
    claimNext.mockResolvedValueOnce({ id: 1, treatment: 'T1', executionId: 'exec-1' });
    registerJobHandler('T1', async () => {});
    await runOne('T1');
    expect(claimNext).toHaveBeenCalledWith('T1', WORKER_ID);
    expect(completeJob).toHaveBeenCalledWith(1, 'exec-1');
  });

  it('le bail est renouvelé tant que l’exécutant travaille', async () => {
    vi.useFakeTimers();
    claimNext.mockResolvedValueOnce({ id: 2, treatment: 'T1', executionId: 'exec-2' });
    let fin!: () => void;
    registerJobHandler('T1', () => new Promise<void>((r) => { fin = r; }));
    const p = runOne('T1');
    await vi.advanceTimersByTimeAsync(3_500);
    expect(renewLease).toHaveBeenCalledWith(2, 'exec-2');
    fin();
    await p;
    const n = renewLease.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renewLease.mock.calls.length).toBe(n); // arrêté à la fin
    vi.useRealTimers();
  });

  it('un échec n’est écrit que par l’exécution titulaire', async () => {
    claimNext.mockResolvedValueOnce({ id: 3, treatment: 'T1', executionId: 'exec-3' });
    registerJobHandler('T1', async () => { throw new Error('x'); });
    await runOne('T1');
    expect(failJob).toHaveBeenCalledWith(3, 'x', 'exec-3');
  });
});

describe('reprise des RUNNING abandonnés (SQL)', () => {
  const repo = read('src/services/ai/queue/job-queue.repository.ts');
  const recover = repo.slice(repo.indexOf('export async function recoverAbandonedJobs'), repo.indexOf('/**\n * Clôt une exécution réussie.'));

  it('seuls les baux expirés sont repris, une seule fois même à plusieurs instances', () => {
    expect(recover).toContain("status = 'RUNNING'");
    expect(recover).toContain('lease_expires_at < NOW()');
    expect(recover).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('tentatives cohérentes : épuisées → FAILED, sinon PENDING en tête ; jeton révoqué, payload conservé', () => {
    expect(recover).toContain("CASE WHEN q.attempts >= $2 THEN 'FAILED' ELSE 'PENDING' END");
    expect(recover).toContain('execution_id = NULL');
    expect(recover).toContain('head_priority = TRUE');
    expect(recover).not.toContain('payload =');
    expect(recover).not.toMatch(/attempts\s*=\s*q?\.?attempts/);
  });

  it('le boucleur reprend les abandonnés avant de prélever', () => {
    const worker = read('src/services/ai/queue/queue-worker.ts');
    const tick = worker.slice(worker.indexOf('const tick'));
    expect(tick.indexOf('recoverAbandonedJobs()')).toBeLessThan(tick.indexOf('runOnce()'));
  });
});
