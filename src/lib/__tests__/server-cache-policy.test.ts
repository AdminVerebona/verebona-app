/**
 * APP-PERF-22 — cache serveur : clés isolées par compte / utilisateur,
 * versionnées, invalidation ciblée, fraîcheur explicite, compteurs.
 *
 * T-02 (deux comptes, deux instances) : chaque instance a sa propre Map — la
 * convergence entre instances repose sur la demande de fraîcheur du client et
 * sur les durées courtes ; ce qui est vérifié ici, c'est qu'aucune clé d'un
 * compte n'est lue ni effacée pour un autre.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SERVER_CACHE_KEY_VERSION,
  __resetServerCacheStatsForTests,
  accountCacheKey,
  invalidateAccountReadCache,
  invalidateUserReadCache,
  isMutatingMethod,
  serverCacheClear,
  serverCacheGet,
  serverCacheSet,
  serverCacheStats,
  userCacheKey,
  wantsFreshRead,
} from '@/lib/server-cache';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

beforeEach(() => { serverCacheClear(); __resetServerCacheStatsForTests(); });

describe('CA-02 — aucune lecture privée réutilisée pour un autre compte', () => {
  it('clés versionnées, compte / utilisateur en tête', () => {
    expect(accountCacheKey(12, 'home-summary')).toBe(`${SERVER_CACHE_KEY_VERSION}:acct:12:home-summary`);
    expect(userCacheKey(7, 'me', 12)).toBe(`${SERVER_CACHE_KEY_VERSION}:user:7:me:12`);
    expect(accountCacheKey(12, 'x')).not.toBe(accountCacheKey(123, 'x'));
  });

  it('invalider le compte 12 n’atteint pas le compte 123 (préfixe fermé)', () => {
    serverCacheSet(accountCacheKey(12, 'a-traiter'), 1, 10_000);
    serverCacheSet(accountCacheKey(123, 'a-traiter'), 2, 10_000);
    serverCacheSet(userCacheKey(12, 'me', 0), 3, 10_000);
    expect(invalidateAccountReadCache(12)).toBe(1);
    expect(serverCacheGet(accountCacheKey(12, 'a-traiter'))).toBeNull();
    expect(serverCacheGet(accountCacheKey(123, 'a-traiter'))).toBe(2);
    // Un utilisateur portant le même numéro n'est pas un compte.
    expect(serverCacheGet(userCacheKey(12, 'me', 0))).toBe(3);
    expect(invalidateUserReadCache(12)).toBe(1);
  });

  it('identifiant invalide : refus explicite (jamais une clé partagée « undefined »)', () => {
    expect(() => accountCacheKey(0, 'x')).toThrow();
    expect(() => accountCacheKey(Number.NaN, 'x')).toThrow();
    expect(() => userCacheKey(-1, 'x')).toThrow();
  });

  it('users/me : clé par utilisateur ET compte courant (bascule d’espace)', () => {
    expect(read('src/app/api/users/me/route.ts')).toContain("userCacheKey(payload.userId, 'me', payload.currentAccountId ?? 0)");
  });
});

describe('CA-01 — fraîcheur explicite et méthodes d’écriture', () => {
  it('x-verebona-fresh: 1 est reconnu', () => {
    expect(wantsFreshRead(new Headers({ 'x-verebona-fresh': '1' }))).toBe(true);
    expect(wantsFreshRead(new Headers())).toBe(false);
  });

  it('écritures = toute méthode hors GET / HEAD / OPTIONS', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) expect(isMutatingMethod(m)).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS', undefined]) expect(isMutatingMethod(m)).toBe(false);
  });

  it.each([
    'src/app/api/home/summary/route.ts',
    'src/app/api/dashboard/a-traiter/route.ts',
    'src/app/api/to-process/suppliers/route.ts',
    'src/app/api/users/me/route.ts',
  ])('%s honore la demande de fraîcheur et n’autorise aucun cache HTTP réutilisable', (f) => {
    const src = read(f);
    expect(src).toMatch(/wantsFreshRead\((req|request)\.headers\)/);
    expect(src).not.toMatch(/stale-while-revalidate/);
  });

  it('le compteur « À traiter » n’est plus resservi par le cache HTTP du navigateur', () => {
    expect(read('src/app/api/to-process/route.ts')).toContain("'Cache-Control': 'private, no-cache'");
    expect(read('src/app/api/v2/to-process/route.ts')).toContain("'Cache-Control': 'private, no-cache'");
  });
});

describe('MESURES — hits / miss / invalidations', () => {
  it('compteurs', () => {
    serverCacheGet('absent');
    serverCacheSet(accountCacheKey(1, 'x'), 1, 10_000);
    serverCacheGet(accountCacheKey(1, 'x'));
    invalidateAccountReadCache(1);
    expect(serverCacheStats()).toMatchObject({ hits: 1, misses: 1, invalidations: 1, size: 0 });
  });
});
