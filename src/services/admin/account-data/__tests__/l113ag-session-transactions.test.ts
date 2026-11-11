/**
 * Lot 113AG (#734) — session de lecture : accès sérialisés, point de reprise
 * sûr, incident fatal, première erreur tracée. SANS base : connexion réservée
 * SIMULÉE qui applique les règles de PostgreSQL (transaction invalidée →
 * 25P02 ; RELEASE / ROLLBACK TO d'un point de reprise inexistant → 3B001 ;
 * RELEASE n détruit les points de reprise ouverts après n) et répond avec un
 * délai (les accès concurrents seraient visibles). La preuve sur PostgreSQL
 * réel est dans l113ag-diagnostic-transactions.e2e.ts.
 */
import { describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => {
  const state = { sent: [] as string[], inFlight: 0, maxInFlight: 0, released: 0, ended: [] as string[] };
  const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });
  function reserve() {
    let aborted = false;
    let inTx = false;
    const sps: string[] = [];
    return {
      async unsafe(sql: string): Promise<Row[]> {
        state.sent.push(sql);
        state.inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        await new Promise((r) => setTimeout(r, 1));
        state.inFlight--;
        const t = sql.trim();
        if (/^BEGIN/.test(t)) { inTx = true; return []; }
        if (/^ROLLBACK$/.test(t)) { inTx = false; aborted = false; sps.length = 0; state.ended.push('ROLLBACK'); return []; }
        let m = /^ROLLBACK TO SAVEPOINT (\w+)$/.exec(t);
        if (m) {
          const k = sps.lastIndexOf(m[1]);
          if (k < 0) { aborted = true; throw pgErr('3B001', `savepoint "${m[1]}" does not exist`); }
          sps.length = k + 1;
          aborted = false;
          return [];
        }
        if (aborted) throw pgErr('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
        m = /^SAVEPOINT (\w+)$/.exec(t);
        if (m) { sps.push(m[1]); return []; }
        m = /^RELEASE SAVEPOINT (\w+)$/.exec(t);
        if (m) {
          const k = sps.lastIndexOf(m[1]);
          if (k < 0) { aborted = true; throw pgErr('3B001', `savepoint "${m[1]}" does not exist`); }
          sps.length = k;
          return [];
        }
        if (/^SET LOCAL/.test(t)) return [];
        if (/pg_current_snapshot/.test(t)) return [{ at: '2026-11-10T15:36:03.000000Z', snap: '1:2:' }];
        if (/PANNE/.test(t)) { if (inTx) aborted = true; throw pgErr('22012', 'division by zero'); }
        m = /^SELECT (\d+) AS x$/.exec(t);
        if (m) return [{ x: Number(m[1]) }];
        return [];
      },
      release() { state.released++; },
    };
  }
  return { state, reserve };
});

vi.mock('@/db', () => ({ pgClient: { reserve: async () => fake.reserve() }, db: {} }));
vi.mock('@/services/business-operations/diagnostics/service', () => ({ DIAG_STATEMENT_TIMEOUT_MS: 30_000 }));

const reset = () => { fake.state.sent = []; fake.state.inFlight = 0; fake.state.maxInFlight = 0; fake.state.released = 0; fake.state.ended = []; };
const open = async (opts: Record<string, unknown> = {}) => (await import('../session')).openReadSession({}, opts);
const body = () => fake.state.sent.filter((t) => !/^(BEGIN|SET LOCAL|SELECT to_char)/.test(t.trim()));

describe('L113AG — session de lecture sérialisée', () => {
  it('quatre savepoint() lancés en Promise.all : exécutés l’un après l’autre, une instruction à la fois, aucune erreur', async () => {
    reset();
    const s = await open();
    const r = await Promise.all([1, 2, 3, 4].map((i) => s.savepoint(() => s.q(`SELECT ${i} AS x`, []))));
    expect(r.map((x) => x[0].x)).toEqual([1, 2, 3, 4]);
    expect(body()).toEqual([1, 2, 3, 4].flatMap((i) => [`SAVEPOINT vb_sp_${i}`, `SELECT ${i} AS x`, `RELEASE SAVEPOINT vb_sp_${i}`]));
    expect(fake.state.maxInFlight).toBe(1);
    expect(s.stats!.maxInFlight).toBe(1);
    expect(s.stats!.serializedWaits).toBe(3);
    expect(s.trace!.health()).toMatchObject({ state: 'HEALTHY', total: 0, firstError: null });
    await s.close();
    expect(fake.state.released).toBe(1);
  });

  it('Promise.all de q() nus et de points de reprise imbriqués : sérialisés, sans interblocage', async () => {
    reset();
    const s = await open();
    const r = await s.savepoint(() => Promise.all([
      s.q('SELECT 1 AS x', []),
      s.savepoint(() => Promise.all([s.q('SELECT 2 AS x', []), s.savepoint(() => s.q('SELECT 3 AS x', []))])),
      s.q('SELECT 4 AS x', []),
    ]));
    expect(r[0][0].x).toBe(1);
    expect((r[1] as Row[][]).map((x) => x[0].x)).toEqual([2, 3]);
    expect(r[2][0].x).toBe(4);
    expect(fake.state.maxInFlight).toBe(1);
    expect(s.trace!.health().total).toBe(0);
    await s.close();
  });

  it('erreur dans l’une des lectures parallèles : restaurée seule (ROLLBACK TO puis RELEASE), les autres lues, session saine', async () => {
    reset();
    const s = await open();
    s.trace!.setContext({ phase: 'EXTRACTION', file: 'ia/t3-rattachement-documents.json', generationId: '7b86a457' });
    const r = await Promise.all(['SELECT 1 AS x', 'SELECT PANNE', 'SELECT 3 AS x', 'SELECT 4 AS x'].map((t) => s.savepoint(() => s.q(t, [])).catch((e) => e as Error)));
    expect((r[1] as { code?: string }).code).toBe('22012');
    expect([r[0], r[2], r[3]].map((x) => (x as Row[])[0].x)).toEqual([1, 3, 4]);
    expect(body().slice(3, 7)).toEqual(['SAVEPOINT vb_sp_2', 'SELECT PANNE', 'ROLLBACK TO SAVEPOINT vb_sp_2', 'RELEASE SAVEPOINT vb_sp_2']);
    const h = s.trace!.health();
    expect(h).toMatchObject({ state: 'HEALTHY', origins: 1, consequences: 0 });
    expect(h.firstError).toMatchObject({ seq: 1, sqlstate: '22012', kind: 'ORIGIN', phase: 'EXTRACTION', file: 'ia/t3-rattachement-documents.json', generationId: '7b86a457', savepoint: 'vb_sp_2', recovered: true });
    expect(h.firstError!.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(h.firstError!.stack.length).toBeGreaterThan(0);
    await s.close();
  });

  it('erreur interceptée DANS le point de reprise : 25P02 rattaché à sa cause, l’erreur d’origine est relancée (jamais un résultat « lu »)', async () => {
    reset();
    const s = await open();
    const e = await s.savepoint(async () => {
      await s.q('SELECT PANNE', []).catch(() => []);
      await s.q('SELECT 2 AS x', []).catch(() => []);
      return 'résultat factice';
    }).catch((x) => x as { code?: string; message: string });
    expect(e).toMatchObject({ code: '22012', message: expect.stringContaining('interceptée par l’appelant') });
    const h = s.trace!.health();
    expect(h.incidents.map((x) => [x.kind, x.sqlstate, x.consequenceOf])).toEqual([['ORIGIN', '22012', null], ['CONSEQUENCE', '25P02', 1]]);
    expect(h.firstError!.sqlstate).toBe('22012');
    expect(h.state).toBe('HEALTHY');
    expect((await s.q('SELECT 5 AS x', []))[0].x).toBe(5);
    await s.close();
  });

  it('échec de ROLLBACK TO : incident FATAL, connexion libérée, plus aucune instruction, erreur d’origine ET échec de restauration conservés', async () => {
    reset();
    const fatals: unknown[] = [];
    const s = await open({ testFailRollbackTo: () => true, onFatal: (f: unknown) => fatals.push(f) });
    const e = (await s.savepoint(() => s.q('SELECT PANNE', [])).catch((x: unknown) => x)) as { code: string; fatal: { origin: Row; rollback: Row } };
    expect(e.code).toBe('VB_SESSION_BROKEN');
    expect(e.fatal.origin).toMatchObject({ sqlstate: '22012', recovered: false });
    expect(e.fatal.rollback).toMatchObject({ sqlstate: '3B001', kind: 'ROLLBACK_FAILED' });
    expect(fake.state.released).toBe(1);
    expect(fake.state.ended).toEqual(['ROLLBACK']);
    expect(fatals).toHaveLength(1);
    const n = fake.state.sent.length;
    await expect(s.q('SELECT 1 AS x', [])).rejects.toMatchObject({ code: 'VB_SESSION_BROKEN' });
    await expect(s.savepoint(() => s.q('SELECT 1 AS x', []))).rejects.toMatchObject({ code: 'VB_SESSION_BROKEN' });
    await expect((async () => { for await (const l of s.cursor('SELECT 1 AS x', [])) void l; })()).rejects.toMatchObject({ code: 'VB_SESSION_BROKEN' });
    expect(fake.state.sent.length).toBe(n);
    expect(s.trace!.health()).toMatchObject({ state: 'BROKEN', consequences: 0 });
    await s.close();
    expect(fake.state.released).toBe(1);
  });

  it('erreur HORS point de reprise : transaction invalidée → incident fatal (erreur d’origine relancée avec son code), aucune cascade 25P02', async () => {
    reset();
    const s = await open();
    await expect(s.q('SELECT PANNE', [])).rejects.toMatchObject({ code: '22012', vbSessionBroken: true });
    expect(s.trace!.health()).toMatchObject({ state: 'BROKEN', consequences: 0, fatal: { origin: { sqlstate: '22012' }, rollback: null } });
    await expect(s.q('SELECT 1 AS x', [])).rejects.toMatchObject({ code: 'VB_SESSION_BROKEN' });
    expect(fake.state.released).toBe(1);
  });

  it('since(mark) : erreurs d’un fichier, première erreur d’origine', async () => {
    reset();
    const s = await open();
    await s.savepoint(() => s.q('SELECT PANNE', [])).catch(() => undefined);
    const m = s.trace!.mark();
    expect(s.trace!.since(m)).toEqual({ count: 0, firstOrigin: null, consequences: 0 });
    await s.savepoint(async () => { await s.q('SELECT PANNE', []).catch(() => []); await s.q('SELECT 1 AS x', []).catch(() => []); }).catch(() => undefined);
    const x = s.trace!.since(m);
    expect(x).toMatchObject({ count: 2, consequences: 1, firstOrigin: { seq: 2, sqlstate: '22012' } });
    await s.close();
  });
});
