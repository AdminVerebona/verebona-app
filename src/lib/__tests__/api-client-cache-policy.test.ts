/**
 * APP-PERF-22 — cache de réponses du navigateur (`useCache`).
 *
 * T-01 : action « À traiter » résolue puis retour immédiat à l'accueil →
 *        compteur relu (client ET serveur), sans attendre 5 minutes.
 * T-02 : alternance de comptes → aucune réponse d'un autre contexte.
 * Fraîcheur explicite → contournement réel du cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiClient,
  RESPONSE_CACHE_POLICIES,
  __resetApiClientForTests,
  responseCacheKey,
  responseCacheTtl,
} from '@/lib/api-client';
import { beginSessionTransition, getSessionEpoch } from '@/lib/session/session-lifecycle';
import { markAccountDataMutated } from '@/lib/data-freshness';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let n = 0;
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ n: ++n }));
const headerOf = (i: number, name: string) => new Headers(fetchMock.mock.calls[i]?.[1]?.headers).get(name);

beforeEach(() => {
  __resetApiClientForTests();
  n = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); __resetApiClientForTests(); });

describe('clé et durée par ressource', () => {
  it('la clé porte la version, l’époque de session, la méthode et l’URL complète', () => {
    expect(responseCacheKey('/api/assets?limit=20', 'GET', 3)).toBe('v2|e3|GET|/api/assets?limit=20');
  });

  it('compteurs 15 s, résumés 30 s, liens de fichiers 60 s, le reste 5 min (jamais allongé)', () => {
    expect(responseCacheTtl('/api/to-process')).toBe(15_000);
    expect(responseCacheTtl('/api/dashboard/a-traiter')).toBe(15_000);
    expect(responseCacheTtl('/api/home/summary')).toBe(30_000);
    expect(responseCacheTtl('/api/users/me')).toBe(30_000);
    expect(responseCacheTtl('/api/files/12/view')).toBe(60_000);
    expect(responseCacheTtl('/api/document-types')).toBe(5 * 60_000);
    for (const p of RESPONSE_CACHE_POLICIES) expect(p.ttlMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it('un compteur en cache expire après 15 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await apiClient.get('/api/to-process', { useCache: true });
    await apiClient.get('/api/to-process', { useCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 16_000);
    await apiClient.get('/api/to-process', { useCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('CA-01 / T-01 — les mutations invalident avant relecture', () => {
  it('écriture réussie → la lecture suivante va au serveur, avec demande de fraîcheur', async () => {
    const a = await apiClient.get<{ n: number }>('/api/dashboard/a-traiter', { useCache: true });
    expect(await apiClient.get('/api/dashboard/a-traiter', { useCache: true })).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await apiClient.post('/api/to-process/actions/1/resolve', {});
    const b = await apiClient.get<{ n: number }>('/api/dashboard/a-traiter', { useCache: true });
    expect(b.n).toBeGreaterThan(a.n);
    // Le cache SERVEUR est aussi contourné, quelle que soit l'instance.
    expect(headerOf(2, 'x-verebona-fresh')).toBe('1');

    // Une seule fois : la lecture suivante reprend le chemin normal.
    await apiClient.get('/api/dashboard/a-traiter', { useCache: false });
    expect(headerOf(3, 'x-verebona-fresh')).toBeNull();
  });

  it('événement métier (sans écriture apiClient) → réponses antérieures périmées', async () => {
    await apiClient.get('/api/to-process', { useCache: true });
    markAccountDataMutated(Date.now() + 1);
    await apiClient.get('/api/to-process', { useCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('les écritures sans effet sur les données (analytics, auth) n’invalident rien', async () => {
    await apiClient.get('/api/document-types', { useCache: true });
    await apiClient.post('/api/analytics/event', { e: 1 });
    await apiClient.get('/api/document-types', { useCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2); // GET + POST, second GET servi du cache
  });

  it('une réponse partie AVANT une écriture n’alimente pas le cache', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    const lente = apiClient.get('/api/assets?limit=20', { useCache: true });
    await Promise.resolve();
    markAccountDataMutated(Date.now() + 1);
    release(json({ ancienne: true }));
    await lente;
    await apiClient.get('/api/assets?limit=20', { useCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fraîcheur explicite', () => {
  it.each([
    [{ cache: 'no-cache' as RequestCache }],
    [{ cache: 'reload' as RequestCache }],
    [{ headers: { 'x-verebona-fresh': '1' } }],
  ])('%j contourne le cache', async (opts) => {
    await apiClient.get('/api/assets/1/overview', { useCache: true });
    await apiClient.get('/api/assets/1/overview', { useCache: true, ...opts });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('CA-02 / T-02 — isolement par contexte de session', () => {
  it('changement de compte : la réponse de l’autre compte n’est jamais relue', async () => {
    await apiClient.get('/api/users/me', { useCache: true });
    const avant = getSessionEpoch();
    beginSessionTransition('account-change');
    expect(getSessionEpoch()).not.toBe(avant);
    await apiClient.get('/api/users/me', { useCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('une réponse reçue après une transition n’alimente pas le cache du nouveau contexte', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    const lente = apiClient.get('/api/assets?limit=20', { useCache: true, dedupe: false });
    await Promise.resolve();
    beginSessionTransition('login');
    release(json({ compte: 'A' }));
    await lente.catch(() => undefined);
    await apiClient.get('/api/assets?limit=20', { useCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
