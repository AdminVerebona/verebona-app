/**
 * APP-PERF-03 — budgets HTTP, annulation et nouvelles tentatives.
 *
 * Recette : T-01 (en-têtes rapides, corps JSON bloqué), T-02 (annulation de
 * l'appelant, aucun retry ni écrasement tardif), T-03 (401, renouvellement
 * lent, rejeu, délai : budget et tentatives bornés). Plus : aucun POST doublé,
 * 401 de saisie non renouvelé (APP-PERF-20 CA-02).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiClient,
  ApiClientError,
  HTTP_POLICIES,
  REFRESH_TIMEOUT_MS,
  __resetApiClientForTests,
  isRequestAborted,
  setHttpObserver,
  type HttpObservation,
} from '@/lib/api-client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** En-têtes immédiats, corps JSON qui ne se termine jamais. */
const corpsBloque = () => new Response(new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode('{"partiel":')); },
}), { status: 200, headers: { 'content-type': 'application/json' } });

/** fetch qui ne répond jamais, mais honore l'annulation. */
const sansReponse = (_url: string, init?: RequestInit) => new Promise<Response>((_r, reject) => {
  init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

async function attendreErreur(p: Promise<unknown>): Promise<ApiClientError> {
  try { await p; } catch (e) { return e as ApiClientError; }
  throw new Error('la promesse aurait dû échouer');
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetApiClientForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetApiClientForTests();
});

describe('CA-01 — signal de l’appelant respecté', () => {
  it('déjà annulé : aucun envoi', async () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    const c = new AbortController();
    c.abort();
    const err = await attendreErreur(apiClient.get('/api/x', { signal: c.signal }));
    expect(isRequestAborted(err)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('annulation pendant l’attente : REQUEST_ABORTED, sans nouvelle tentative', async () => {
    const fetchMock = vi.fn(sansReponse);
    vi.stubGlobal('fetch', fetchMock);
    const c = new AbortController();
    const p = attendreErreur(apiClient.get('/api/x', { signal: c.signal }));
    await vi.advanceTimersByTimeAsync(100);
    c.abort();
    const err = await p;
    expect(err.code).toBe('REQUEST_ABORTED');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('annulation pendant la lecture du corps : le consommateur est détaché (T-02)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => corpsBloque()));
    const c = new AbortController();
    const p = attendreErreur(apiClient.get('/api/x', { signal: c.signal }));
    await vi.advanceTimersByTimeAsync(50);
    c.abort();
    expect((await p).code).toBe('REQUEST_ABORTED');
  });

  it('le signal transmis à fetch n’est plus celui du seul délai : il suit l’appelant', async () => {
    let recu: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => { recu = init?.signal ?? undefined; return sansReponse(_u, init); }));
    const c = new AbortController();
    const p = attendreErreur(apiClient.post('/api/x', { a: 1 }, { signal: c.signal }));
    await vi.advanceTimersByTimeAsync(10);
    expect(recu?.aborted).toBe(false);
    c.abort();
    expect(recu?.aborted).toBe(true);
    expect((await p).code).toBe('REQUEST_ABORTED');
  });
});

describe('CA-02 — corps bloqué : fin contrôlée dans le budget (T-01)', () => {
  it('GET : délai par tentative, une nouvelle tentative, échec ≤ budget total', async () => {
    const fetchMock = vi.fn(async () => corpsBloque());
    vi.stubGlobal('fetch', fetchMock);
    const debut = Date.now();
    const p = attendreErreur(apiClient.get('/api/x'));
    await vi.advanceTimersByTimeAsync(HTTP_POLICIES.read.totalBudgetMs + 1_000);
    const err = await p;
    expect(err.code).toBe('REQUEST_TIMEOUT');
    expect(err.message).toMatch(/Délai/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - debut).toBeLessThanOrEqual(HTTP_POLICIES.read.totalBudgetMs + 1_000);
  });

  it('le minuteur reste actif jusqu’à la fin du parsing, puis est libéré', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: 1 })));
    await expect(apiClient.get('/api/x')).resolves.toEqual({ ok: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('réponse JSON annoncée trop volumineuse : refusée avant parsing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': String(100 * 1024 * 1024) },
    })));
    expect((await attendreErreur(apiClient.get('/api/x'))).code).toBe('RESPONSE_TOO_LARGE');
  });
});

describe('CA-03 — tentatives et durée bornées par classe', () => {
  it('POST en panne réseau : une seule tentative (jamais doublé)', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetchMock);
    const err = await attendreErreur(apiClient.post('/api/assets', { nom: 'x' }));
    expect(err.code).toBe('NETWORK_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('POST sans réponse : REQUEST_TIMEOUT après le délai d’écriture, une seule tentative', async () => {
    const fetchMock = vi.fn(sansReponse);
    vi.stubGlobal('fetch', fetchMock);
    const p = attendreErreur(apiClient.post('/api/assets', { nom: 'x' }));
    await vi.advanceTimersByTimeAsync(HTTP_POLICIES.write.attemptTimeoutMs + 10);
    expect((await p).code).toBe('REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GET en panne réseau : exactement une nouvelle tentative', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetchMock);
    const p = attendreErreur(apiClient.get('/api/x'));
    await vi.advanceTimersByTimeAsync(HTTP_POLICIES.read.retryDelayMs + 10);
    expect((await p).code).toBe('NETWORK_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(1 + HTTP_POLICIES.read.maxNetworkRetries);
  });

  it('JSON invalide : pas de nouvelle tentative (ce n’est pas le réseau)', async () => {
    const fetchMock = vi.fn(async () => new Response('{oops', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await attendreErreur(apiClient.get('/api/x'))).code).toBe('INVALID_RESPONSE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T-03 : 401, renouvellement lent, rejeu sans réponse — budget total et tentatives bornés', async () => {
    const appels: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      appels.push(url);
      if (url === '/api/auth/refresh') {
        // Renouvellement lent mais réussi (9 s, sous REFRESH_TIMEOUT_MS).
        return new Promise<Response>((resolve) => setTimeout(() => resolve(json({})), REFRESH_TIMEOUT_MS - 1_000));
      }
      if (appels.filter((u) => u === '/api/x').length === 1) return Promise.resolve(json({ code: 'INVALID_TOKEN' }, 401));
      return sansReponse(url, init);
    }));
    const observations: HttpObservation[] = [];
    setHttpObserver((o) => observations.push(o));
    const debut = Date.now();
    const p = attendreErreur(apiClient.get('/api/x'));
    await vi.advanceTimersByTimeAsync(HTTP_POLICIES.read.totalBudgetMs + 5_000);
    const err = await p;
    expect(err.code).toBe('REQUEST_TIMEOUT');
    expect(Date.now() - debut).toBeLessThanOrEqual(HTTP_POLICIES.read.totalBudgetMs + 5_000);
    // 1 envoi initial + 1 rejeu après renouvellement + au plus 1 nouvelle tentative réseau.
    const envois = appels.filter((u) => u === '/api/x').length;
    expect(envois).toBeLessThanOrEqual(3);
    expect(appels.filter((u) => u === '/api/auth/refresh')).toHaveLength(1);
    expect(observations.at(-1)?.durationMs).toBeLessThanOrEqual(HTTP_POLICIES.read.totalBudgetMs);
  });

  it('un 401 de saisie (mot de passe faux) ne déclenche aucun renouvellement', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'Mot de passe incorrect', code: 'INVALID_CURRENT_PASSWORD', message: 'faux' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const err = await attendreErreur(apiClient.post('/api/users/me/x', {}));
    expect(err.status).toBe(401);
    expect(err.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('un 403 de quota n’est ni un renouvellement ni une déconnexion', async () => {
    const fetchMock = vi.fn(async () => json({ code: 'DOCUMENT_QUOTA_REACHED', message: 'quota' }, 403));
    vi.stubGlobal('fetch', fetchMock);
    const err = await attendreErreur(apiClient.get('/api/x'));
    expect(err.code).toBe('DOCUMENT_QUOTA_REACHED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renouvellement en panne : 503 SERVICE_UNAVAILABLE, pas de déconnexion', async () => {
    const handle = vi.spyOn(apiClient, 'handleAuthFailure');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/auth/refresh' ? json({}, 502) : json({}, 401))));
    const err = await attendreErreur(apiClient.get('/api/x'));
    expect(err.status).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  });

  it('onAuthFailure: silent — refus définitif levé sans procédure de sortie', async () => {
    const handle = vi.spyOn(apiClient, 'handleAuthFailure');
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 401)));
    const err = await attendreErreur(apiClient.get('/api/x', { onAuthFailure: 'silent' }));
    expect(err.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });
});
