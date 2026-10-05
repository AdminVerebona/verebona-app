/**
 * APP-PERF-23 — lectures GET partagées sans casser l'annulation.
 *
 * Recette : T-01 (quatre GET identiques, un consommateur annulé), T-02
 * (échec puis nouvel essai), T-03 (changement de contexte ou demande de
 * fraîcheur pendant une lecture).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiClient,
  ApiClientError,
  __inflightCountForTests,
  __resetApiClientForTests,
  dedupeKey,
} from '@/lib/api-client';
import { beginSessionTransition } from '@/lib/session/session-lifecycle';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** fetch piloté : chaque appel attend `relacher()` ; l'annulation est honorée. */
function fetchPilote() {
  const attentes: { url: string; signal?: AbortSignal; resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
  const mock = vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    attentes.push({ url, signal, resolve, reject });
  }));
  return { mock, attentes };
}

beforeEach(() => { __resetApiClientForTests(); });
afterEach(() => { vi.unstubAllGlobals(); __resetApiClientForTests(); });

describe('CA-01 — un transport pour N lectures identiques', () => {
  it('T-01 : quatre GET identiques, un annulé — un transport, les autres reçoivent le résultat', async () => {
    const { mock, attentes } = fetchPilote();
    vi.stubGlobal('fetch', mock);
    const c = new AbortController();
    const a = apiClient.get('/api/users/me', { dedupe: true });
    const b = apiClient.get('/api/users/me', { dedupe: true, signal: c.signal });
    const d = apiClient.get('/api/users/me', { dedupe: true });
    const e = apiClient.get('/api/users/me', { dedupe: true });
    expect(mock).toHaveBeenCalledTimes(1);

    c.abort();
    await expect(b).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(attentes[0].signal?.aborted).toBe(false);

    attentes[0].resolve(json({ id: 1 }));
    await expect(Promise.all([a, d, e])).resolves.toEqual([{ id: 1 }, { id: 1 }, { id: 1 }]);
    expect(__inflightCountForTests()).toBe(0);
  });

  it('chaque consommateur reçoit le même résultat JSON (pas un flux Response à usage unique)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ v: 2 })));
    const [x, y] = await Promise.all([
      apiClient.get('/api/a', { dedupe: true }),
      apiClient.get('/api/a', { dedupe: true }),
    ]);
    expect(x).toEqual({ v: 2 });
    expect(y).toEqual({ v: 2 });
  });

  it('tous les consommateurs annulés : le transport est annulé et la promesse retirée', async () => {
    const { mock, attentes } = fetchPilote();
    vi.stubGlobal('fetch', mock);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = apiClient.get('/api/a', { dedupe: true, signal: c1.signal }).catch((e) => e);
    const p2 = apiClient.get('/api/a', { dedupe: true, signal: c2.signal }).catch((e) => e);
    c1.abort();
    expect(attentes[0].signal?.aborted).toBe(false);
    c2.abort();
    expect(attentes[0].signal?.aborted).toBe(true);
    expect(((await p1) as ApiClientError).code).toBe('REQUEST_ABORTED');
    expect(((await p2) as ApiClientError).code).toBe('REQUEST_ABORTED');
    expect(__inflightCountForTests()).toBe(0);
  });

  it('useCache implique le partage ; dedupe:false le contourne explicitement', async () => {
    const { mock } = fetchPilote();
    vi.stubGlobal('fetch', mock);
    void apiClient.get('/api/a', { useCache: true }).catch(() => undefined);
    void apiClient.get('/api/a', { useCache: true }).catch(() => undefined);
    expect(mock).toHaveBeenCalledTimes(1);
    void apiClient.get('/api/a', { useCache: true, dedupe: false }).catch(() => undefined);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('jamais pour une écriture : deux POST identiques font deux requêtes', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([
      apiClient.post('/api/a', { x: 1 }, { dedupe: true }),
      apiClient.post('/api/a', { x: 1 }, { dedupe: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('CA-02 — contextes et fraîcheur distincts', () => {
  it('en-têtes ou politique de cache différents : clés distinctes', () => {
    expect(dedupeKey('/api/a', {}, 1)).not.toBe(dedupeKey('/api/a', { headers: { 'x-fresh': '1' } }, 1));
    expect(dedupeKey('/api/a', {}, 1)).not.toBe(dedupeKey('/api/a', { cache: 'default' }, 1));
    expect(dedupeKey('/api/a', {}, 1)).not.toBe(dedupeKey('/api/a', {}, 2));
    expect(dedupeKey('/api/a', { headers: { A: '1', b: '2' } }, 1)).toBe(dedupeKey('/api/a', { headers: { b: '2', a: '1' } }, 1));
  });

  it('T-03 : demande de fraîcheur pendant une lecture → transport séparé', async () => {
    const { mock } = fetchPilote();
    vi.stubGlobal('fetch', mock);
    void apiClient.get('/api/home/summary', { dedupe: true }).catch(() => undefined);
    void apiClient.get('/api/home/summary', { dedupe: true, headers: { 'x-verebona-fresh': '1' } }).catch(() => undefined);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('T-03 : changement de session pendant une lecture → ancienne lecture abandonnée, aucun partage', async () => {
    const { mock, attentes } = fetchPilote();
    vi.stubGlobal('fetch', mock);
    const ancienne = apiClient.get('/api/users/me', { dedupe: true }).catch((e) => e);
    beginSessionTransition('account-change');
    expect(attentes[0].signal?.aborted).toBe(true);
    expect(((await ancienne) as ApiClientError).code).toBe('REQUEST_ABORTED');

    const nouvelle = apiClient.get('/api/users/me', { dedupe: true });
    expect(mock).toHaveBeenCalledTimes(2);
    attentes[1].resolve(json({ id: 2 }));
    await expect(nouvelle).resolves.toEqual({ id: 2 });
  });
});

describe('CA-03 — pas de promesse rejetée conservée', () => {
  it('T-02 : échec puis nouvel essai → nouvelle requête', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ code: 'INTERNAL_ERROR' }, 500))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiClient.get('/api/a', { dedupe: true })).rejects.toMatchObject({ status: 500 });
    expect(__inflightCountForTests()).toBe(0);
    await expect(apiClient.get('/api/a', { dedupe: true })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('une réponse arrivée après une transition ne repeuple pas le cache', async () => {
    const { mock, attentes } = fetchPilote();
    vi.stubGlobal('fetch', mock);
    const p = apiClient.get('/api/a', { useCache: true, dedupe: false });
    beginSessionTransition('logout');
    attentes[0].resolve(json({ ancien: true }));
    await p.catch(() => undefined);
    const fetchMock = vi.fn(async () => json({ nouveau: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiClient.get('/api/a', { useCache: true })).resolves.toEqual({ nouveau: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
