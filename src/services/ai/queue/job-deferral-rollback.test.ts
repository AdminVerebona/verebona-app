/**
 * Lot 3 — dépôt de la file : report, interruption de la file mémoire,
 * cibles vivantes.
 *
 *  · `deferJob` (MOD-005, OPS-017) : tentative rendue, délai croissant,
 *    compteur dans le contexte, échec définitif motivé, conditionné au jeton ;
 *  · `requeueRunning` (VER-017, WF-06) : le rollback, l'arrêt d'urgence et la
 *    désactivation interrompent AUSSI les exécutions T1 de la file mémoire ;
 *  · `listLiveTargets` (§10.4) : ce qu'une reprise ne doit pas relancer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let respond: (sql: string, params: unknown[]) => unknown[] = () => [];

vi.mock('@/db', () => ({
  pgClient: { unsafe: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return respond(sql, params); } },
}));

const { deferJob, requeueRunning, listLiveTargets } = await import('../job-queue.repository');
const { registerLocalExecution, unregisterLocalExecution, ExecutionCancelledError } = await import('../execution-control');

const placeholders = (sql: string) => Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));

beforeEach(() => { calls.length = 0; respond = () => []; });

describe('deferJob', () => {
  it('premier report : PENDING dans 5 min, tentative rendue, jeton révoqué, compteur écrit', async () => {
    respond = (sql) => (sql.startsWith('SELECT') ? [{ deferrals: 0 }] : [{ id: 1 }]);
    const r = await deferJob(1, 'quota d’analyse du compte épuisé', '00000000-0000-0000-0000-000000000001');
    expect(r).toEqual({ permanent: false, retryInSeconds: 300, deferrals: 1 });
    const upd = calls.find((c) => c.sql.includes('UPDATE ai_job_queue'))!;
    expect(placeholders(upd.sql)).toBe(upd.params.length);
    expect(upd.params[1]).toBe('PENDING');
    expect(String(upd.params[2])).toMatch(/quota.*reporté \(1\).*5 min/);
    expect(upd.params[3]).toBe('300');
    expect(upd.params[5]).toBe(1);
    expect(upd.sql).toContain('attempts = GREATEST(attempts - 1, 0)');
    expect(upd.sql).toContain('execution_id = NULL');
    expect(upd.sql).toContain("jsonb_set(COALESCE(payload, '{}'::jsonb), '{deferrals}'");
    expect(upd.sql).toContain("status = 'RUNNING'");
    expect(upd.sql).toContain('execution_id = $5::uuid');
  });

  it('au-delà du plafond : FAILED avec un motif lisible (le fichier reste « non analysé »)', async () => {
    delete process.env.AI_QUEUE_MAX_DEFERRALS;
    respond = (sql) => (sql.startsWith('SELECT') ? [{ deferrals: 3 }] : [{ id: 2 }]);
    const r = await deferJob(2, 'quota d’analyse du compte épuisé', null);
    expect(r.permanent).toBe(true);
    const upd = calls.find((c) => c.sql.includes('UPDATE ai_job_queue'))!;
    expect(upd.params[1]).toBe('FAILED');
    expect(String(upd.params[2])).toMatch(/reporté 3 fois, abandonné/);
  });

  it('exécution dépossédée : rien n’est écrit', async () => {
    respond = (sql) => (sql.startsWith('SELECT') ? [{ deferrals: 0 }] : []);
    expect(await deferJob(3, 'quota', 'x')).toEqual({ permanent: false, stale: true });
  });
});

describe('requeueRunning (file durable seule, lot 16b)', () => {
  it('interrompt les exécutions locales des jobs remis en file, et ne compte que ceux-ci', async () => {
    respond = () => [{ id: 10 }];
    const c10 = new AbortController();
    const autre = new AbortController();
    registerLocalExecution(10, c10);
    registerLocalExecution(11, autre);

    const n = await requeueRunning('T1', 'restauration de la version 4');
    expect(n).toBe(1);
    expect(c10.signal.aborted).toBe(true);
    expect(c10.signal.reason).toBeInstanceOf(ExecutionCancelledError);
    expect(String((c10.signal.reason as Error).message)).toMatch(/restauration de la version 4/);
    expect(autre.signal.aborted).toBe(false);

    unregisterLocalExecution(10, c10);
    unregisterLocalExecution(11, autre);
  });
});

describe('listLiveTargets', () => {
  it('cibles ayant un job PENDING ou RUNNING, comparées en texte', async () => {
    respond = () => [{ target_id: '7' }];
    const s = await listLiveTargets('T1', 'asset_file', [7, 8]);
    expect([...s]).toEqual(['7']);
    const q = calls[0];
    expect(q.sql).toContain("status IN ('PENDING', 'RUNNING')");
    expect(q.params).toEqual(['T1', 'asset_file', ['7', '8']]);
  });

  it('liste vide : aucune requête', async () => {
    expect((await listLiveTargets('T1', 'asset_file', [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
