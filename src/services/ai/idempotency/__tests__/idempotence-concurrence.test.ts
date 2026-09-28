/**
 * Idempotence sans verrou partagé — revue du lot 4 (défaut critique).
 *
 * Toutes les clés de l'assistant commencent par « assistant: » : l'ancien
 * identifiant de verrou (`parseInt(clé[0..8], 16)`) valait 10 pour toutes, et
 * sérialisait chaque appel modèle en retenant une connexion du pool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ unsafe: vi.fn(async (_sql: string, _p?: unknown[]) => [] as unknown[]) }));
vi.mock('@/db', () => ({ pgClient: { unsafe: h.unsafe } }));

const { withIdempotency, lockIdFromKey, inFlightCount } = await import('../idempotency.service');

beforeEach(() => {
  delete process.env.AI_IDEMPOTENCY_DISABLED;
  h.unsafe.mockReset();
  h.unsafe.mockImplementation(async () => []);
});

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('empreinte de clé', () => {
  it('deux clés de même préfixe ont des empreintes différentes (clé entière hachée)', () => {
    const a = lockIdFromKey('assistant:c12:aaaa');
    const b = lockIdFromKey('assistant:c12:bbbb');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(lockIdFromKey('assistant:c12:aaaa')).toBe(a);
  });
});

describe('concurrence', () => {
  it('des clés différentes s’exécutent en parallèle, sans aucun verrou consultatif', async () => {
    const debut = Date.now();
    const lent = (v: number) => async () => { await attendre(60); return { v }; };
    const r = await Promise.all([
      withIdempotency('assistant:c1:x', lent(1)),
      withIdempotency('assistant:c1:y', lent(2)),
      withIdempotency('assistant:c2:z', lent(3)),
    ]);
    expect(r.map((x) => x.v)).toEqual([1, 2, 3]);
    expect(Date.now() - debut).toBeLessThan(150);
    expect(h.unsafe.mock.calls.some(([sql]) => /pg_advisory/.test(String(sql)))).toBe(false);
  });

  it('la même clé en parallèle : une seule exécution, résultat partagé', async () => {
    const fn = vi.fn(async () => { await attendre(30); return { v: 1 } as Record<string, unknown>; });
    const [a, b] = await Promise.all([withIdempotency('assistant:c1:k', fn), withIdempotency('assistant:c1:k', fn)]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(a.v).toBe(1);
    expect(b).toMatchObject({ v: 1, fromCache: true });
    expect(inFlightCount()).toBe(0);
  });

  it('un échec libère la clé', async () => {
    await expect(withIdempotency('assistant:c1:e', async () => { throw new Error('boum'); })).rejects.toThrow('boum');
    expect(inFlightCount()).toBe(0);
  });
});
