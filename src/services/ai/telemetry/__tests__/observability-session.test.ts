/**
 * Relecture lot 17 — session de calcul réelle (client simulé) : connexion
 * réservée, transaction READ ONLY, `SET LOCAL statement_timeout`, chaque
 * requête dans un SAVEPOINT (une requête annulée n'empêche pas les suivantes).
 */
import { describe, it, expect, vi } from 'vitest';

const journal: string[] = [];
let modes: string[] = [];

vi.mock('@/db', () => ({
  pgClient: {
    begin: async (mode: string, fn: (tx: unknown) => Promise<unknown>) => {
      modes.push(mode);
      journal.push('BEGIN');
      const tx = {
        unsafe: async (q: string) => { journal.push(q); return []; },
        savepoint: async (f: (sp: unknown) => Promise<unknown>) => {
          journal.push('SAVEPOINT');
          try {
            return await f({
              unsafe: async (q: string) => {
                journal.push(q.trim().split(/\s+/).slice(0, 4).join(' '));
                if (/FROM field_evidence/.test(q)) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
                return [];
              },
            });
          } catch (e) {
            journal.push('ROLLBACK TO SAVEPOINT');
            throw e;
          }
        },
      };
      try {
        return await fn(tx);
      } finally {
        journal.push('COMMIT');
      }
    },
  },
}));

const { getObservability, observabilityQueryForTests, QUERY_TIMEOUT_MS } = await import('../observability.repository');

describe('session d’observabilité', () => {
  it('une transaction READ ONLY, statement_timeout local, un savepoint par requête', async () => {
    modes = [];
    journal.length = 0;
    const r = await getObservability({ domain: 'T3', days: 7 }, new Date('2026-09-30T12:00:00Z'));
    expect(modes).toEqual(['read only']);
    expect(journal[0]).toBe('BEGIN');
    expect(journal[1]).toBe(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    expect(journal.at(-1)).toBe('COMMIT');
    const requetes = journal.filter((l) => l === 'SAVEPOINT').length;
    expect(requetes).toBeGreaterThanOrEqual(5);
    // La requête annulée (57014) n'a pas interrompu les suivantes.
    expect(journal).toContain('ROLLBACK TO SAVEPOINT');
    expect(r.metrics.find((m) => m.key === 'evidence_active')!.value).toBeNull();
    expect(r.metrics.find((m) => m.key === 'fields_updated')!.value).toBe(0);
    expect(r.notes.join(' ')).toMatch(/annulée par la base/);
  });

  it('requête de test : même session', async () => {
    modes = [];
    await observabilityQueryForTests('SELECT 1');
    expect(modes).toEqual(['read only']);
  });
});
