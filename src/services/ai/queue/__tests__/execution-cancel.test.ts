/**
 * Arrêt manuel / rollback : l'exécution en cours est réellement interrompue.
 * Critère de recette : l'ancien appel IA répond après le rollback, aucune de
 * ses données n'est appliquée, et seule la nouvelle exécution clôt le job.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const claimNext = vi.fn();
const completeJob = vi.fn(async () => ({ requeued: false }));
const failJob = vi.fn(async () => ({ permanent: false }));
const actives = new Set<string>();
vi.mock('../job-queue.repository', () => ({
  claimNext: (...a: unknown[]) => claimNext(...a),
  completeJob: (...a: unknown[]) => completeJob(...(a as [])),
  failJob: (...a: unknown[]) => failJob(...(a as [])),
  renewLease: async (_id: number, exec: string) => actives.has(exec),
  recoverAbandonedJobs: async () => [],
  isExecutionActive: async (_id: number, exec: string) => actives.has(exec),
  LEASE_SECONDS: 300,
}));

const { runOne, registerJobHandler, clearJobHandlers } = await import('../queue-worker');
const { abortLocalExecutions, createExecutionGuard, ExecutionCancelledError, isExecutionCancelled } = await import('../execution-control');
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

beforeEach(() => {
  clearJobHandlers(); actives.clear();
  claimNext.mockReset(); completeJob.mockClear(); failJob.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('garde d’exécution', () => {
  it('lève après une interruption locale', async () => {
    const c = new AbortController();
    const g = createExecutionGuard({ id: 1, executionId: 'e1' }, c, async () => true);
    await expect(g.assertActive()).resolves.toBeUndefined();
    c.abort(new ExecutionCancelledError('rollback'));
    await expect(g.assertActive('persistance')).rejects.toSatisfy(isExecutionCancelled);
  });

  it('lève si le jeton a été révoqué en base (autre instance)', async () => {
    const c = new AbortController();
    const g = createExecutionGuard({ id: 1, executionId: 'e1' }, c, async () => false);
    await expect(g.assertActive('preuves')).rejects.toThrow(/révoquée/);
    expect(c.signal.aborted).toBe(true);
  });
});

describe('rollback pendant un traitement long', () => {
  it('l’ancienne exécution n’écrit rien et ne clôt pas le job', async () => {
    actives.add('old');
    claimNext.mockResolvedValueOnce({ id: 7, treatment: 'T1', executionId: 'old' });
    const ecritures: string[] = [];
    let repondre!: (v: string) => void;
    const appelIA = new Promise<string>((r) => { repondre = r; });

    registerJobHandler('T1', async (_job, guard) => {
      const reponse = await appelIA;               // l'IA répond… après le rollback
      await guard.assertActive('persistance');     // point de contrôle avant écriture
      ecritures.push(reponse);
    });

    const run = runOne('T1');
    await Promise.resolve();
    // Rollback : requeueRunning révoque le jeton et signale l'interruption.
    actives.delete('old');
    abortLocalExecutions([7], 'restauration de la version 3');
    repondre('résultat avec l’ancienne configuration');
    await run;

    expect(ecritures).toEqual([]);
    expect(completeJob).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled(); // pas un échec : le job est déjà en attente
  });

  it('la nouvelle exécution, relancée avec la configuration restaurée, termine le job', async () => {
    actives.add('new');
    claimNext.mockResolvedValueOnce({ id: 7, treatment: 'T1', executionId: 'new' });
    const ecritures: string[] = [];
    registerJobHandler('T1', async (_job, guard) => { await guard.assertActive('persistance'); ecritures.push('ok'); });
    await runOne('T1');
    expect(ecritures).toEqual(['ok']);
    expect(completeJob).toHaveBeenCalledWith(7, 'new');
  });
});

describe('câblage', () => {
  it('requeueRunning révoque le jeton et interrompt les exécutions locales', () => {
    const repo = read('src/services/ai/queue/job-queue.repository.ts');
    const fn = repo.slice(repo.indexOf('export async function requeueRunning'), repo.indexOf('export async function cancelJob'));
    expect(fn).toContain('execution_id = NULL');
    expect(fn).toContain('abortLocalExecutions(ids, reason)');
  });

  it('pipeline T1 : contrôle entre la réponse IA et la persistance ; interruption sans écriture d’échec', () => {
    const p = read('src/services/ai/source-analysis/pipeline.ts');
    const a = p.indexOf('await analyseGroup(');
    const g = p.indexOf("await guard?.assertActive('persistance du résultat')");
    const w = p.indexOf('await persistAnalysisResult(');
    expect(a).toBeLessThan(g);
    expect(g).toBeLessThan(w);
    const c = p.indexOf('if (isExecutionCancelled(e)) throw e;');
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(p.indexOf('await failSources(groupSourceIds'));
    for (const etape of ['base de connaissance', 'classement', 'preuves', 'finalisation', 'moteurs aval']) {
      expect(p).toContain(`await guard?.assertActive('${etape}')`);
    }
  });

  it('le disjoncteur n’interrompt pas (MOD-011)', () => {
    const cb = read('src/services/ai/queue/circuit-breaker.ts');
    expect(cb).not.toContain('requeueRunning');
    expect(cb).not.toContain('abortLocalExecutions');
  });
});
