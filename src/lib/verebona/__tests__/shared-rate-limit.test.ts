/**
 * D-J2 (lot 21) — limiteur de débit PARTAGÉ (compteur par minute en base) :
 * deux instances, un plafond ; repli mémoire avec alerte si la base fait
 * défaut ; portées utilisateur, compte, adresse IP.
 */
import { describe, it, expect, vi } from 'vitest';
import { SharedRateLimiter, type RateCounterStore, type RateEntry } from '../rate-limit';

/** Stockage partagé en mémoire (une « base » pour plusieurs instances), même sémantique chaînée que la CTE. */
function memoryStore(): RateCounterStore & { counts: Map<string, number>; calls: number } {
  const counts = new Map<string, number>();
  const s = {
    counts,
    calls: 0,
    async hit(entries: Array<{ key: string; limit: number }>) {
      s.calls += 1;
      const out = new Map<string, number>();
      for (const [i, e] of entries.entries()) {
        if (i > 0 && (out.get(entries[i - 1].key) ?? Infinity) > entries[i - 1].limit) break;
        counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
        out.set(e.key, counts.get(e.key)!);
      }
      return { counts: out, resetMs: 42_000 };
    },
    async purge() {},
  };
  return s;
}

const entrees = (u: number, a: number, ip: string | null, limite: number): RateEntry[] => [
  { key: `q:u:${u}`, limit: limite, scope: 'user' },
  { key: `q:a:${a}`, limit: limite * 3, scope: 'account' },
  ...(ip ? [{ key: `q:ip:${ip}`, limit: limite * 5, scope: 'ip' as const }] : []),
];

describe('limiteur partagé', () => {
  it('deux instances partagent le même plafond (10 / min, pas 2 × 10)', async () => {
    const store = memoryStore();
    const a = new SharedRateLimiter(store);
    const b = new SharedRateLimiter(store);
    for (let i = 0; i < 10; i++) expect((await (i % 2 ? a : b).check(entrees(1, 1, null, 10))).allowed).toBe(true);
    expect(await a.check(entrees(1, 1, null, 10))).toMatchObject({ allowed: false, scope: 'user', retryAfterMs: 42_000 });
    expect(await b.check(entrees(1, 1, null, 10))).toMatchObject({ allowed: false, scope: 'user' });
    // UNE requête par appel, toutes clés comprises.
    expect(store.calls).toBe(12);
  });

  it('portées compte (3×) et adresse IP (5×)', async () => {
    const store = memoryStore();
    const l = new SharedRateLimiter(store);
    for (let u = 1; u <= 3; u++) for (let i = 0; i < 10; i++) await l.check(entrees(u, 7, null, 10));
    expect(await l.check(entrees(4, 7, null, 10))).toMatchObject({ allowed: false, scope: 'account' });
    const s2 = new SharedRateLimiter(memoryStore());
    for (let u = 1; u <= 5; u++) for (let i = 0; i < 10; i++) await s2.check(entrees(u, 100 + u, '1.2.3.4', 10));
    expect(await s2.check(entrees(6, 200, '1.2.3.4', 10))).toMatchObject({ allowed: false, scope: 'ip' });
  });

  it('base indisponible : repli mémoire, jamais bloquant, alerte et état dégradé', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const l = new SharedRateLimiter({ hit: async () => { throw new Error('connexion refusée'); }, purge: async () => {} });
    expect((await l.check(entrees(1, 1, null, 2))).allowed).toBe(true);
    expect((await l.check(entrees(1, 1, null, 2))).allowed).toBe(true);
    expect(await l.check(entrees(1, 1, null, 2))).toMatchObject({ allowed: false, scope: 'user' });
    expect(l.health()).toMatchObject({ mode: 'shared', degraded: true, lastError: 'connexion refusée', fallbacks: 3 });
    expect(err).toHaveBeenCalledTimes(1); // une alerte par minute
  });

  it('base lente : repli au-delà du délai, puis retour au partagé', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let lent = true;
    const store = memoryStore();
    const l = new SharedRateLimiter({
      hit: (e) => (lent ? new Promise(() => {}) : store.hit(e)),
      purge: async () => {},
    }, undefined, 20);
    expect((await l.check(entrees(1, 1, null, 10))).allowed).toBe(true);
    expect(l.health().degraded).toBe(true);
    lent = false;
    expect((await l.check(entrees(1, 1, null, 10))).allowed).toBe(true);
    expect(l.health().degraded).toBe(false);
  });

  it('sans stockage (tests, démarrage) : mémoire seule', async () => {
    const l = new SharedRateLimiter(null);
    expect(l.health()).toMatchObject({ mode: 'memory', degraded: false });
    for (let i = 0; i < 3; i++) await l.check(entrees(1, 1, null, 3));
    expect((await l.check(entrees(1, 1, null, 3))).allowed).toBe(false);
  });

  it('clés chaînées : un utilisateur refusé ne consomme pas le quota de son compte ni de son IP', async () => {
    const store = memoryStore();
    const l = new SharedRateLimiter(store);
    for (let i = 0; i < 15; i++) await l.check(entrees(1, 7, '1.2.3.4', 10));
    expect(store.counts.get('q:u:1')).toBe(15);
    expect(store.counts.get('q:a:7')).toBe(10);
    expect(store.counts.get('q:ip:1.2.3.4')).toBe(10);
  });

  it('requête SQL : une CTE par clé, chacune conditionnée par la précédente', async () => {
    const { sharedRateLimitSql } = await import('../rate-limit');
    const q = sharedRateLimitSql(3);
    expect(q.match(/INSERT INTO verebona_rate_limit_counters/g)).toHaveLength(3);
    expect(q).toMatch(/c1 AS \([\s\S]*WHERE \(SELECT hits FROM c0\) <= \$2::int/);
    expect(q).toMatch(/c2 AS \([\s\S]*WHERE \(SELECT hits FROM c1\) <= \$4::int/);
  });

  it('stockage PostgreSQL : transaction courte, statement_timeout posé côté base', async () => {
    const { pgRateCounterStore } = await import('../rate-limit');
    const journal: string[] = [];
    const tx = { unsafe: async (q: string, p?: unknown[]) => { journal.push(q.trim().split('\n')[0]); if (p) journal.push(JSON.stringify(p)); return /^WITH/.test(q.trim()) ? [{ h0: 3, h1: 4, h2: null, reset_ms: 5000 }] : []; } };
    const client = { unsafe: tx.unsafe, begin: async <T>(fn: (t: typeof tx) => Promise<T>) => { journal.push('BEGIN'); const r = await fn(tx); journal.push('COMMIT'); return r; } };
    const s = pgRateCounterStore(client as never, 300);
    const r = await s.hit([{ key: 'u', limit: 10 }, { key: 'a', limit: 3 }, { key: 'ip', limit: 50 }]);
    expect(journal.slice(0, 2)).toEqual(['BEGIN', 'SET LOCAL statement_timeout = 300']);
    expect(journal).toContain(JSON.stringify(['u', 10, 'a', 3, 'ip']));
    expect([...r.counts]).toEqual([['u', 3], ['a', 4]]);
  });
});

describe('adresse du client (proxy de confiance)', () => {
  it('dernière entrée de X-Forwarded-For (1 saut, Scalingo) ; entrées de tête jamais retenues', async () => {
    const { clientIp } = await import('../api-guard');
    const req = (xff: string) => ({ headers: new Headers({ 'x-forwarded-for': xff }) });
    expect(clientIp(req('6.6.6.6, 1.2.3.4'), {} as NodeJS.ProcessEnv)).toBe('1.2.3.4');
    expect(clientIp(req('6.6.6.6, 1.2.3.4, 10.0.0.1'), { TRUSTED_PROXY_HOPS: '2' } as unknown as NodeJS.ProcessEnv)).toBe('1.2.3.4');
    expect(clientIp(req('1.2.3.4'), { TRUSTED_PROXY_HOPS: '0' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(clientIp(req('pas-une-ip'), {} as NodeJS.ProcessEnv)).toBeNull();
    expect(clientIp({ headers: new Headers() }, {} as NodeJS.ProcessEnv)).toBeNull();
  });
});

