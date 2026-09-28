/**
 * Recherche lexicale V1 : repli à l'exécution si `verebona_unaccent_lower`
 * (migration 0208) est absente — jamais d'erreur 42883 sur les recherches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const h = vi.hoisted(() => ({ unsafe: vi.fn() }));
vi.mock('@/db', () => ({ pgClient: { unsafe: h.unsafe }, db: {} }));

const { searchExprMode, resetSearchExprCache, normalizedSql, normalizedText } = await import('../search-sql');
const rendu = (q: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(q).sql;

beforeEach(() => { resetSearchExprCache(); h.unsafe.mockReset(); });

describe('détection et cache', () => {
  it('fonction présente : mode « wrapper », détecté une seule fois (cache définitif)', async () => {
    h.unsafe.mockResolvedValue([{ wrapper: true, unaccent: true }]);
    expect(await Promise.all([searchExprMode(), searchExprMode()])).toEqual(['wrapper', 'wrapper']);
    expect(await searchExprMode(Date.now() + 10 * 60_000)).toBe('wrapper');
    expect(h.unsafe).toHaveBeenCalledTimes(1);
  });

  it('fonction absente, unaccent présente : forme historique ; relu après une minute', async () => {
    h.unsafe.mockResolvedValueOnce([{ wrapper: false, unaccent: true }]).mockResolvedValueOnce([{ wrapper: true, unaccent: true }]);
    expect(await searchExprMode()).toBe('unaccent');
    expect(await searchExprMode(Date.now() + 30_000)).toBe('unaccent');
    expect(h.unsafe).toHaveBeenCalledTimes(1);
    expect(await searchExprMode(Date.now() + 61_000)).toBe('wrapper');
  });

  it('ni fonction ni unaccent, ou détection en erreur : lower() simple', async () => {
    h.unsafe.mockResolvedValueOnce([{ wrapper: false, unaccent: false }]);
    expect(await searchExprMode()).toBe('lower');
    resetSearchExprCache();
    h.unsafe.mockRejectedValueOnce(new Error('connexion'));
    expect(await searchExprMode()).toBe('lower');
  });
});

describe('expressions', () => {
  it('SQL drizzle : enveloppe de l’index, sinon repli ; la valeur reste un paramètre lié', () => {
    expect(rendu(normalizedSql('wrapper', '%plomb%'))).toBe('verebona_unaccent_lower($1)');
    expect(rendu(normalizedSql('unaccent', sql.raw('"name"')))).toBe(`unaccent(lower(coalesce("name", '')))`);
    expect(rendu(normalizedSql('lower', '%x%'))).toBe(`lower(coalesce($1, ''))`);
  });

  it('SQL brut', () => {
    expect(normalizedText('wrapper', 'name')).toBe('verebona_unaccent_lower(name)');
    expect(normalizedText('unaccent', '$2')).toBe(`unaccent(lower(coalesce($2, '')))`);
    expect(normalizedText('lower', 'name')).toBe(`lower(coalesce(name, ''))`);
  });
});
