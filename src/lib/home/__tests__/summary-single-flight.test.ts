/**
 * APP-PERF-09 — recalcul du résumé partagé par compte, côté serveur.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createKeyedSingleFlight } from '../summary-single-flight';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('createKeyedSingleFlight', () => {
  it('lectures ordinaires concurrentes : un seul calcul partagé', async () => {
    const d = deferred<string>();
    const compute = vi.fn(() => d.promise);
    const f = createKeyedSingleFlight(compute);
    const a = f.run('10'); const b = f.run('10');
    d.resolve('x');
    expect(await a).toBe('x');
    expect(await b).toBe('x');
    expect(compute).toHaveBeenCalledTimes(1);
    expect(f.stats()).toEqual({ computations: 1, joined: 1 });
  });

  it('N demandes fraîches pendant un calcul : au plus UN calcul de plus, qui démarre après', async () => {
    const calls: ReturnType<typeof deferred<string>>[] = [];
    const compute = vi.fn(() => { const d = deferred<string>(); calls.push(d); return d.promise; });
    const f = createKeyedSingleFlight(compute);
    const first = f.run('10');
    const fresh = [f.run('10', { fresh: true }), f.run('10', { fresh: true }), f.run('10', { fresh: true })];
    await flush();
    expect(compute).toHaveBeenCalledTimes(1);
    calls[0].resolve('avant la modification');
    await flush();
    expect(compute).toHaveBeenCalledTimes(2);
    // Une demande fraîche arrivée APRÈS le début du 2e calcul en programme
    // un 3e (le 2e a pu démarrer avant sa modification) — un seul.
    const late = [f.run('10', { fresh: true }), f.run('10', { fresh: true })];
    calls[1].resolve('après la modification');
    expect(await first).toBe('avant la modification');
    for (const p of fresh) expect(await p).toBe('après la modification');
    await flush();
    expect(compute).toHaveBeenCalledTimes(3);
    calls[2].resolve('dernier état');
    expect(await Promise.all(late)).toEqual(['dernier état', 'dernier état']);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('un échec du calcul en cours ne bloque pas le calcul frais suivant', async () => {
    const calls: ReturnType<typeof deferred<string>>[] = [];
    const f = createKeyedSingleFlight(() => { const d = deferred<string>(); calls.push(d); return d.promise; });
    const first = f.run('10');
    const fresh = f.run('10', { fresh: true });
    calls[0].reject(new Error('panne'));
    await expect(first).rejects.toThrow('panne');
    await flush();
    calls[1].resolve('ok');
    expect(await fresh).toBe('ok');
  });

  it('comptes distincts : calculs distincts', async () => {
    const compute = vi.fn(async (k: string) => k);
    const f = createKeyedSingleFlight(compute);
    expect(await Promise.all([f.run('1'), f.run('2')])).toEqual(['1', '2']);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

// ── Route : partage du calcul entre requêtes ───────────────────────────────

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => ({ userId: 1, currentAccountId: 77 })),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
const build = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/services/home/HomeSummaryService', () => ({
  buildHomeSummary: (...a: unknown[]) => build.fn(...a),
}));

describe('GET /api/home/summary', () => {
  beforeEach(async () => {
    build.fn.mockReset();
    const { serverCacheClear } = await import('@/lib/server-cache');
    serverCacheClear();
  });

  it('T-01 (serveur) : rafale de demandes fraîches → calculs bornés, état final exact', async () => {
    const { GET } = await import('@/app/api/home/summary/route');
    const calls: ReturnType<typeof deferred<{ v: number }>>[] = [];
    build.fn.mockImplementation(() => { const d = deferred<{ v: number }>(); calls.push(d); return d.promise; });
    const req = () => new NextRequest('http://x/api/home/summary', { headers: { 'x-verebona-fresh': '1' } });

    const responses = [GET(req()), GET(req()), GET(req()), GET(req())];
    await flush(); await flush();
    expect(build.fn).toHaveBeenCalledTimes(1);
    calls[0].resolve({ v: 1 });
    await flush(); await flush();
    expect(build.fn).toHaveBeenCalledTimes(2);
    calls[1].resolve({ v: 2 });
    const bodies = await Promise.all((await Promise.all(responses)).map((r) => r.json()));
    expect(bodies[0]).toEqual({ v: 1 });
    expect(bodies.slice(1)).toEqual([{ v: 2 }, { v: 2 }, { v: 2 }]);
    expect(build.fn).toHaveBeenCalledTimes(2);

    // Le résultat est remis en cache : une lecture ordinaire ne recalcule pas.
    const cached = await GET(new NextRequest('http://x/api/home/summary'));
    expect(await cached.json()).toEqual({ v: 2 });
    expect(build.fn).toHaveBeenCalledTimes(2);
  });
});
