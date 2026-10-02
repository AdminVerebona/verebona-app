/**
 * Renouvellement de session : jamais d'attente infinie.
 *
 * Preprod, 2 oct. 2026 : `/api/auth/refresh` restait « pending » et toutes les
 * lectures de l'écran, qui attendent ce même renouvellement après un 401,
 * restaient bloquées (« Certaines informations n'ont pas pu être actualisées »).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, REFRESH_TIMEOUT_MS } from '@/lib/api-client';

/** fetch qui ne répond jamais, mais honore l'annulation (AbortSignal). */
function fetchSansReponse() {
  return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  }));
}

describe('apiClient.refreshToken', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('abandonne après REFRESH_TIMEOUT_MS et rend server_error (pas de déconnexion)', async () => {
    const fetchMock = fetchSansReponse();
    vi.stubGlobal('fetch', fetchMock);

    const resultat = apiClient.refreshToken();
    await vi.advanceTimersByTimeAsync(REFRESH_TIMEOUT_MS);

    await expect(resultat).resolves.toBe('server_error');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/refresh', expect.objectContaining({ method: 'POST' }));
  });

  it('les appels concurrents partagent la même tentative, puis un nouvel essai reste possible', async () => {
    const fetchMock = fetchSansReponse();
    vi.stubGlobal('fetch', fetchMock);

    const a = apiClient.refreshToken();
    const b = apiClient.refreshToken();
    await vi.advanceTimersByTimeAsync(REFRESH_TIMEOUT_MS);
    await expect(Promise.all([a, b])).resolves.toEqual(['server_error', 'server_error']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await expect(apiClient.refreshToken()).resolves.toBe(true);
  });

  it('un 401 du renouvellement reste un échec d’authentification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(apiClient.refreshToken()).resolves.toBe(false);
  });
});
