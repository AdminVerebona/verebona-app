/**
 * APP-PERF-21 — déconnexion bornée et nettoyage de tous les états de session.
 *
 * Recette : T-01 (désinscription push puis logout bloqués), T-02 (plusieurs
 * handleAuthFailure en parallèle), T-03 (réponse arrivée après la sortie).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiClient,
  LOGOUT_TIMEOUT_MS,
  PUSH_UNSUBSCRIBE_TIMEOUT_MS,
  __resetApiClientForTests,
} from '@/lib/api-client';
import { getSessionEpoch, onSessionTransition } from '@/lib/session/session-lifecycle';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sansReponse = (_url: string, init?: RequestInit) => new Promise<Response>((_r, reject) => {
  init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

function memoire(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

let fenetre: { location: { pathname: string; search: string; href: string }; localStorage: Storage; sessionStorage: Storage; dispatchEvent: () => boolean };

beforeEach(() => {
  vi.useFakeTimers();
  __resetApiClientForTests();
  fenetre = {
    location: { pathname: '/assets/12', search: '?onglet=docs', href: 'http://localhost/assets/12?onglet=docs' },
    localStorage: memoire(),
    sessionStorage: memoire(),
    dispatchEvent: () => true,
  };
  vi.stubGlobal('window', fenetre);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetApiClientForTests();
});

describe('CA-01 — jamais en attente sans borne', () => {
  it('T-01 : push puis logout bloqués → sortie dans le budget, sans faux succès serveur', async () => {
    vi.stubGlobal('fetch', vi.fn(sansReponse));
    const pushBloque = vi.fn((signal: AbortSignal) => new Promise<void>((_r, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const debut = Date.now();
    const p = apiClient.signOut({ unsubscribePush: pushBloque });
    await vi.advanceTimersByTimeAsync(PUSH_UNSUBSCRIBE_TIMEOUT_MS + LOGOUT_TIMEOUT_MS + 10);
    await expect(p).resolves.toEqual({ push: 'timeout', server: 'timeout' });
    expect(Date.now() - debut).toBeLessThanOrEqual(PUSH_UNSUBSCRIBE_TIMEOUT_MS + LOGOUT_TIMEOUT_MS + 10);
    expect(pushBloque.mock.calls[0][0].aborted).toBe(true);
  });

  it('une désinscription push qui ignore le signal ne retient pas la sortie', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, revocation: 'revoked' })));
    const p = apiClient.signOut({ unsubscribePush: () => new Promise<void>(() => undefined) });
    await vi.advanceTimersByTimeAsync(PUSH_UNSUBSCRIBE_TIMEOUT_MS + 10);
    await expect(p).resolves.toEqual({ push: 'timeout', server: 'revoked' });
  });

  it('les appels concurrents partagent la même procédure', async () => {
    const fetchMock = vi.fn(async () => json({ success: true, revocation: 'revoked' }));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([apiClient.signOut(), apiClient.signOut()]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Terminée : une nouvelle tentative (bouton « Réessayer ») reste possible.
    await apiClient.signOut();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('CA-03 — révocation réelle et échec distingués', () => {
  it.each([
    [json({ success: true, revocation: 'revoked' }), 'revoked'],
    [json({ success: true, revocation: 'none' }), 'revoked'],
    [json({ success: true, revocation: 'failed' }), 'cookies-cleared'],
    [json({ success: true }), 'cookies-cleared'],
    [json({ error: 'x' }, 500), 'failed'],
  ])('réponse serveur → %#', async (reponse, attendu) => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse));
    expect((await apiClient.signOut()).server).toBe(attendu);
  });

  it('panne réseau : failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await apiClient.signOut()).server).toBe('failed');
  });
});

describe('CA-02 — aucune donnée du compte précédent réutilisable', () => {
  it('purge : époque nouvelle, anciennes clés d’auth et données privées effacées, préférences conservées', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, revocation: 'revoked' })));
    fenetre.localStorage.setItem('user', '{"id":1}');
    fenetre.localStorage.setItem('verebona:conversationId', '42');
    fenetre.localStorage.setItem('verebona:recent-assets', '[1,2]');
    fenetre.localStorage.setItem('verebona-theme', 'blue');
    const raisons: string[] = [];
    const stop = onSessionTransition((t) => raisons.push(t.reason));
    const avant = getSessionEpoch();
    await apiClient.signOut();
    stop();
    expect(getSessionEpoch()).toBe(avant + 1);
    expect(raisons).toEqual(['logout']);
    expect(fenetre.localStorage.getItem('user')).toBeNull();
    expect(fenetre.localStorage.getItem('verebona:conversationId')).toBeNull();
    expect(fenetre.localStorage.getItem('verebona:recent-assets')).toBeNull();
    expect(fenetre.localStorage.getItem('verebona-theme')).toBe('blue');
  });

  it('T-03 : réponse API arrivée après la sortie → aucun repeuplement du cache', async () => {
    let relacher: (r: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/logout') return Promise.resolve(json({ success: true, revocation: 'revoked' }));
      return new Promise<Response>((resolve) => { relacher = resolve; });
    }));
    const lecture = apiClient.get('/api/assets?limit=20', { useCache: true, dedupe: false });
    await apiClient.signOut();
    relacher(json({ data: ['ancien compte'] }));
    await lecture.catch(() => undefined);

    const nouveau = vi.fn(async () => json({ data: ['nouveau compte'] }));
    vi.stubGlobal('fetch', nouveau);
    await expect(apiClient.get('/api/assets?limit=20', { useCache: true })).resolves.toEqual({ data: ['nouveau compte'] });
    expect(nouveau).toHaveBeenCalledTimes(1);
  });
});

describe('handleAuthFailure — une seule sortie, bornée', () => {
  it('T-02 : appels parallèles → un logout, une navigation (page et paramètres conservés)', async () => {
    const fetchMock = vi.fn(async () => json({ success: true, revocation: 'revoked' }));
    vi.stubGlobal('fetch', fetchMock);
    const raisons: string[] = [];
    const stop = onSessionTransition((t) => raisons.push(t.reason));
    await Promise.all([apiClient.handleAuthFailure(), apiClient.handleAuthFailure(), apiClient.handleAuthFailure()]);
    stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(raisons).toEqual(['auth-failure']);
    expect(fenetre.location.href).toBe(`/login?expired=1&returnUrl=${encodeURIComponent('/assets/12?onglet=docs')}`);
  });

  it('logout sans réponse : la navigation a lieu après LOGOUT_TIMEOUT_MS', async () => {
    vi.stubGlobal('fetch', vi.fn(sansReponse));
    const p = apiClient.handleAuthFailure();
    await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS - 10);
    expect(fenetre.location.href).not.toMatch(/^\/login/);
    await vi.advanceTimersByTimeAsync(20);
    await p;
    expect(fenetre.location.href).toMatch(/^\/login\?expired=1/);
  });

  it('compte suspendu : message dédié', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true })));
    await apiClient.handleAuthFailure({ code: 'ACCOUNT_SUSPENDED' });
    expect(fenetre.location.href).toBe('/login?error=ACCOUNT_SUSPENDED');
  });

  it('sur une page d’authentification : aucune navigation (pas de boucle)', async () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    fenetre.location.pathname = '/login';
    await apiClient.handleAuthFailure();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fenetre.location.href).toBe('http://localhost/assets/12?onglet=docs');
  });

  it('401 définitif sur plusieurs lectures concurrentes → une seule sortie', async () => {
    const appels: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      appels.push(url);
      if (url === '/api/auth/logout') return json({ success: true, revocation: 'revoked' });
      return json({ code: 'INVALID_TOKEN' }, 401);
    }));
    const r = await Promise.allSettled([apiClient.get('/api/a'), apiClient.get('/api/b'), apiClient.get('/api/c')]);
    expect(r.every((x) => x.status === 'rejected')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(appels.filter((u) => u === '/api/auth/refresh').length).toBeLessThanOrEqual(3);
    expect(appels.filter((u) => u === '/api/auth/logout')).toHaveLength(1);
  });
});
