/**
 * Rattrapages lancés depuis le BO (lot 25, chantier B) — exclusivité et
 * cycle de vie, sur un PostgreSQL SIMULÉ (verrou consultatif partagé entre
 * « conteneurs », table ops_backfill_runs avec son index unique partiel) :
 *   · un second lancement (autre client = autre conteneur) est refusé tant
 *     que le premier tourne, et tracé DENIED ; accepté après la fin ;
 *   · l'état final est écrit AVANT la libération du verrou ;
 *   · un échec du service est rapporté (statut, message masqué), verrou rendu ;
 *   · une ligne `running` orpheline est marquée interrompue au lancement.
 * Le scénario réel (PG16, route) est dans
 * `src/test/e2e/scenarios/l25-exploitation.e2e.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: {} }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: vi.fn(async () => {}) }));

const { startBackfill, waitForBackfill, BackfillBusyError } = await import('../backfill/runner');
type Deps = Parameters<typeof startBackfill>[2] & object;

interface FakeRow { id: string; status: string; script: string; action: string; step: string | null; summary?: string | null; error?: string | null; script_run_id?: string | null }

function fakePg() {
  const pg = { holder: null as object | null, rows: [] as FakeRow[], journal: [] as string[] };
  const vue = (r: FakeRow) => ({
    id: r.id, script: r.script, action: r.action, step: r.step, params: {}, status: r.status, reason: null, admin_user_id: 1,
    admin_email: 'a@x', script_run_id: r.script_run_id ?? null, progress: {}, error: r.error ?? null, owner: 'test',
    started_at: new Date(), heartbeat_at: new Date(), finished_at: null,
  });
  const client = () => {
    const ended = { v: false };
    const reserve = async () => {
      const cnx = Object.assign(
        async (strings: TemplateStringsArray) => {
          const q = strings.join('?');
          if (q.includes('pg_try_advisory_lock')) {
            const ok = pg.holder === null || pg.holder === cnx;
            if (ok) pg.holder = cnx;
            pg.journal.push(`lock:${ok}`);
            return [{ ok }];
          }
          if (q.includes('pg_advisory_unlock')) {
            if (pg.holder === cnx) pg.holder = null;
            pg.journal.push('unlock');
            return [{}];
          }
          return [];
        },
        {
          release: vi.fn(),
          unsafe: async (q: string, p: unknown[] = []) => {
            if (q.startsWith('INSERT INTO ops_backfill_runs')) {
              if (pg.rows.some((r) => r.status === 'running')) throw Object.assign(new Error('dup'), { code: '23505' });
              const r: FakeRow = { id: String(p[0]), script: String(p[1]), action: String(p[2]), step: (p[3] as string) ?? null, status: 'running' };
              pg.rows.push(r);
              pg.journal.push('insert');
              return [vue(r)];
            }
            if (q.includes("SET status = 'interrupted'")) {
              const orphelines = pg.rows.filter((r) => r.status === 'running');
              for (const r of orphelines) r.status = 'interrupted';
              return orphelines.map((r) => ({ id: r.id }));
            }
            if (q.includes('SET status = $2')) {
              const r = pg.rows.find((x) => x.id === p[0])!;
              r.status = String(p[1]);
              r.summary = p[2] as string | null;
              r.error = p[4] as string | null;
              r.script_run_id = p[5] as string | null;
              pg.journal.push(`final:${r.status}`);
              return [];
            }
            if (q.includes("WHERE status = 'running' ORDER BY")) return pg.rows.filter((r) => r.status === 'running').map(vue);
            return [];
          },
        },
      );
      return cnx;
    };
    return { reserve, end: vi.fn(async () => { ended.v = true; }), ended };
  };
  return { pg, client };
}

let porte: { ouvrir: () => void; promesse: Promise<void> };
function nouvellePorte() {
  let ouvrir = () => {};
  const promesse = new Promise<void>((r) => { ouvrir = r; });
  porte = { ouvrir, promesse };
}

const req = (over: Record<string, unknown> = {}) => ({
  script: 'merge-rooms' as const, action: 'apply' as const, step: null, runId: null, accountId: null, reason: 'Reprise D-G', ...over,
});

describe('exclusivité des rattrapages (plateforme)', () => {
  let f: ReturnType<typeof fakePg>;
  let audit: ReturnType<typeof vi.fn>;
  const deps = (execute?: Deps['execute']): Deps => ({
    openClient: () => f.client() as never,
    audit: audit as never,
    execute: execute ?? (async () => {
      await porte.promesse;
      return { result: { runId: '11111111-1111-4111-8111-111111111111', mode: 'apply', counts: { rooms: 2, failed: 0 }, changes: [], warnings: [] } };
    }),
  });

  beforeEach(() => {
    f = fakePg();
    audit = vi.fn(async () => {});
    nouvellePorte();
  });

  it('second lancement refusé pendant le premier (autre conteneur), DENIED tracé ; accepté après la fin', async () => {
    const a = await startBackfill(req(), { id: 1 }, deps());
    expect(a.status).toBe('running');
    await expect(startBackfill(req({ script: 'cdc15', action: 'simulate', reason: null }), { id: 2 }, deps()))
      .rejects.toBeInstanceOf(BackfillBusyError);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ adminId: 2, result: 'DENIED', action: 'OPS_BACKFILL_SIMULATE' }));
    expect(f.pg.rows.filter((r) => r.status === 'running')).toHaveLength(1);

    porte.ouvrir();
    await waitForBackfill(a.id);
    expect(f.pg.rows[0]).toMatchObject({ status: 'succeeded', script_run_id: '11111111-1111-4111-8111-111111111111' });
    // État final écrit AVANT la libération du verrou.
    const j = f.pg.journal;
    expect(j.indexOf('final:succeeded')).toBeLessThan(j.lastIndexOf('unlock'));
    expect(f.pg.holder).toBeNull();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ adminId: 1, result: 'SUCCESS', details: expect.objectContaining({ phase: 'finished' }) }));

    nouvellePorte();
    porte.ouvrir();
    const c = await startBackfill(req({ script: 'agenda', action: 'simulate', step: 'dedupe', reason: null }), { id: 3 }, deps(async () => ({
      result: { accountsScanned: 1, itemsScanned: 2, groups: [], removed: [], applied: false, lastAccountId: 1 },
    })));
    await waitForBackfill(c.id);
    expect(f.pg.rows.at(-1)!.status).toBe('succeeded');
  });

  it('échec du service : statut `failed`, message masqué, verrou rendu', async () => {
    const r = await startBackfill(req(), { id: 1 }, deps(async () => {
      throw new Error('connexion postgres://verebona:secret@db.internal:5432/x refusée');
    }));
    await waitForBackfill(r.id);
    const row = f.pg.rows[0];
    expect(row.status).toBe('failed');
    expect(row.error).toContain('postgres://***@db.internal');
    expect(row.error).not.toContain('secret');
    expect(f.pg.holder).toBeNull();
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'FAILURE' }));
  });

  it('pièce en échec (fusion) : `failed` comme le code de sortie 1 du script, synthèse conservée', async () => {
    porte.ouvrir();
    const r = await startBackfill(req({ action: 'simulate', reason: null }), { id: 1 }, deps(async () => ({
      result: { runId: 'x', mode: 'dry_run', counts: { rooms: 3, failed: 1 }, changes: [], warnings: ['pièce 9 : boom'] },
    })));
    await waitForBackfill(r.id);
    expect(f.pg.rows[0].status).toBe('failed');
    expect(JSON.parse(f.pg.rows[0].summary!).warnings).toEqual(['pièce 9 : boom']);
  });

  it('ligne `running` orpheline (conteneur arrêté, verrou libre) : interrompue au lancement suivant', async () => {
    f.pg.rows.push({ id: 'orpheline', status: 'running', script: 'cdc15', action: 'apply', step: null });
    porte.ouvrir();
    const r = await startBackfill(req(), { id: 1 }, deps());
    expect(f.pg.rows.find((x) => x.id === 'orpheline')!.status).toBe('interrupted');
    await waitForBackfill(r.id);
  });
});
