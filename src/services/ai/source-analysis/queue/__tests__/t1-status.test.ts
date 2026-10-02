/**
 * CDC BO IA E-06 — le bandeau d'analyse LIT l'état ; il ne relance plus rien.
 *
 * `/api/analysis/check-pending` relançait les analyses à l'ouverture de
 * l'application : la reprise T1 dépendait d'une session navigateur. Le bandeau
 * lit désormais `/api/analysis/queue-status` (lecture seule), sur l'état
 * persistant (file durable seule depuis le lot 16b ; route check-pending supprimée).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const calls: Array<{ sql: string; params: unknown[] }> = [];
let fichiers: unknown[] = [];
let jobs: unknown[] | Error = [];
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('FROM asset_files')) return fichiers;
      if (jobs instanceof Error) throw jobs;
      return jobs;
    },
  },
}));

const { getT1QueueStatus } = await import('../t1-status');

beforeEach(() => { calls.length = 0; fichiers = []; jobs = []; vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('getT1QueueStatus', () => {
  it('sans job vivant : état des fichiers du compte, en attente et en cours', async () => {
    fichiers = [{ id: 1, analysis_state: 'UPLOADED' }, { id: 2, analysis_state: 'ANALYZING' }];
    const s = await getT1QueueStatus(9);
    expect(s.mode).toBe('durable');
    expect(s.files).toEqual([
      { fileId: 1, state: 'queued', nextAttemptAt: null },
      { fileId: 2, state: 'analyzing', nextAttemptAt: null },
    ]);
    // Lecture seule, bornée au compte.
    expect(calls.every((c) => /^\s*SELECT/.test(c.sql))).toBe(true);
    expect(calls.every((c) => c.params[0] === 9)).toBe(true);
  });

  it('le job vivant fait foi et donne la prochaine tentative', async () => {
    fichiers = [{ id: 1, analysis_state: 'ANALYZING' }];
    jobs = [
      { target_id: '1', status: 'PENDING', available_at: '2026-09-27T10:05:00Z' },
      { target_id: '3', status: 'RUNNING', available_at: '2026-09-27T10:00:00Z' },
    ];
    const s = await getT1QueueStatus(9);
    expect(s.mode).toBe('durable');
    expect(s.files).toEqual([
      { fileId: 1, state: 'queued', nextAttemptAt: '2026-09-27T10:05:00.000Z' },
      { fileId: 3, state: 'analyzing', nextAttemptAt: null },
    ]);
  });

  it('file durable illisible : l’état des fichiers suffit', async () => {
    fichiers = [{ id: 4, analysis_state: 'UPLOADED' }];
    jobs = new Error('relation "ai_job_queue" does not exist');
    const s = await getT1QueueStatus(9);
    expect(s.files).toEqual([{ fileId: 4, state: 'queued', nextAttemptAt: null }]);
  });
});

describe('bandeau d’analyse (E-06)', () => {
  const root = resolve(__dirname, '../../../../../..');
  const bandeau = readFileSync(resolve(root, 'src/contexts/AnalysisBannerContext.tsx'), 'utf8');

  it('n’appelle plus /api/analysis/check-pending, supprimée (lot 16b)', () => {
    expect(bandeau).not.toMatch(/fetch\(\s*['"`]\/api\/analysis\/check-pending/);
    expect(existsSync(resolve(root, 'src/app/api/analysis/check-pending/route.ts'))).toBe(false);
  });

  it('lit l’état exposé par la file', () => {
    expect(bandeau).toMatch(/fetch\(\s*['"`]\/api\/analysis\/queue-status/);
  });

  it('la route de lecture existe et ne met rien en file', () => {
    const route = readFileSync(resolve(root, 'src/app/api/analysis/queue-status/route.ts'), 'utf8');
    expect(route).toContain('getT1QueueStatus');
    expect(route).not.toMatch(/enqueue|analyzeFileSources|runAnalysisRecovery/);
  });
});
