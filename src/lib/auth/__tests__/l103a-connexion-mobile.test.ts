/**
 * Lot 103A — connexion iOS : « Votre session a expiré » après une saisie correcte.
 *
 * Cause démontrée par le code (reproduite ici sur la logique) : dans l'app,
 * `NativeBridgeRuntime` lit la session dès l'écran de connexion → magasin
 * « non authentifié ». Après la connexion (navigation client), la page
 * protégée est rendue avec cet état PÉRIMÉ ; le fournisseur ouvre la nouvelle
 * époque (effet de mise en page) avant l'effet de `useSession`, qui lançait
 * quand même la procédure de sortie : logout serveur de la session tout juste
 * émise, puis `/login?expired=1`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_EXIT_MESSAGES, LOGIN_ATTEMPT_HEADER, LOGOUT_REASON_HEADER, POST_LOGIN_WINDOW_MS, SESSION_EXPIRED_MESSAGE,
  classifyAuthExit, currentLoginAttempt, isLoginAttemptId, loginBannerFromParams, loginFailureMessage,
  newLoginAttemptId, readLoginAttemptId, readLogoutReason, rememberLoginAttempt,
} from '@/lib/auth/login-diagnostics';
import { authDiagEntry } from '@/lib/auth/auth-diagnostics';
import { SessionStore } from '@/lib/session/session-store';
import { apiClient, __resetApiClientForTests } from '@/lib/api-client';
import { beginSessionTransition } from '@/lib/session/session-lifecycle';
import { postLogin } from '@/lib/auth/login-request';

vi.mock('next/navigation', () => ({ usePathname: () => '/accueil', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
const { shouldExitOnAuthFailure } = await import('@/hooks/useSession');

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

describe('L103A-1 — identifiant de corrélation (aucun secret)', () => {
  it('format lisible, validé à la lecture des en-têtes', () => {
    const id = newLoginAttemptId();
    expect(isLoginAttemptId(id)).toBe(true);
    expect(id).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(readLoginAttemptId(new Headers({ [LOGIN_ATTEMPT_HEADER]: id }))).toBe(id);
    expect(readLoginAttemptId(new Headers({ [LOGIN_ATTEMPT_HEADER]: 'x@y.fr' }))).toBeNull();
    expect(readLogoutReason(new Headers({ [LOGOUT_REASON_HEADER]: 'auth-failure' }))).toBe('auth-failure');
    expect(readLogoutReason(new Headers({ [LOGOUT_REASON_HEADER]: 'autre' }))).toBeNull();
  });

  it('mémoire de l’onglet bornée à la fenêtre de diagnostic', () => {
    const store = memoire();
    rememberLoginAttempt({ id: 'ABCDEFGH23', at: 1_000, ok: true }, store);
    expect(currentLoginAttempt(2_000, store)).toEqual({ id: 'ABCDEFGH23', at: 1_000, ok: true });
    expect(currentLoginAttempt(1_000 + 11 * 60_000, store)).toBeNull();
  });

  it('journal serveur : étape, statut, code, plateforme — jamais e-mail, mot de passe ni cookie', () => {
    const req = {
      headers: new Headers({
        [LOGIN_ATTEMPT_HEADER]: 'ABCDEFGH23', 'x-verebona-client': 'IOS', 'x-verebona-app-version': '1.2.3', 'x-verebona-app-build': '42',
        cookie: 'access_token=SECRET; refresh_token=SECRET2', authorization: 'Bearer SECRET3',
      }),
      nextUrl: { pathname: '/api/users/me' },
    };
    const e = authDiagEntry(req, 'api_rejected', 401, 'MISSING_TOKEN');
    expect(e).toMatchObject({ step: 'api_rejected', attemptId: 'ABCDEFGH23', status: 401, code: 'MISSING_TOKEN', client: 'IOS', appVersion: '1.2.3', path: '/api/users/me' });
    expect(JSON.stringify(e)).not.toMatch(/SECRET|@|password/i);
  });
});

describe('L103A-2 — refus de la connexion : messages distincts, jamais « session expirée »', () => {
  it.each([
    [401, { code: 'INVALID_CREDENTIALS', message: 'Identifiants incorrects. Veuillez réessayer.' }, 'INVALID_CREDENTIALS', /Identifiants incorrects/],
    [429, { code: 'RATE_LIMIT_EXCEEDED', message: 'Trop de tentatives de connexion. Réessayez dans 15 minutes, …' }, 'RATE_LIMIT_EXCEEDED', /Trop de tentatives/],
    [403, { code: 'ACCOUNT_SUSPENDED', message: 'Your account has been suspended' }, 'ACCOUNT_SUSPENDED', /compte est suspendu/],
    [403, { code: 'ACCOUNT_INACTIVE', message: 'Your account is inactive' }, 'ACCOUNT_INACTIVE', /n’est plus actif/],
    [403, { code: 'EMAIL_NOT_VERIFIED', message: 'Veuillez vérifier votre email' }, 'EMAIL_NOT_VERIFIED', /vérifier votre email/],
    [403, { code: 'CSRF_ORIGIN_REJECTED', message: 'Requête refusée' }, 'CSRF_ORIGIN_REJECTED', /raison de sécurité/],
    [426, { code: 'APP_UPDATE_REQUIRED' }, 'APP_UPDATE_REQUIRED', /mise à jour/],
    [503, { code: 'SERVICE_UNAVAILABLE' }, 'SERVICE_UNAVAILABLE', /temporairement indisponible/],
    [500, {}, 'HTTP_500', /erreur est survenue/],
    [401, { code: 'INVALID_TOKEN', message: SESSION_EXPIRED_MESSAGE }, 'INVALID_TOKEN', /n’a pas abouti/],
  ])('%i %j', (status, body, code, re) => {
    const r = loginFailureMessage(status, body);
    expect(r.code).toBe(code);
    expect(r.message).toMatch(re);
    expect(r.message).not.toBe(SESSION_EXPIRED_MESSAGE);
  });
});

describe('L103A-3 — motif du retour à la connexion', () => {
  const now = 10_000_000;
  it.each([
    ['AUTH_REQUIRED', null, 'no_session'],
    ['AUTH_REQUIRED', { id: 'ABCDEFGH23', at: now - 5_000, ok: true }, 'post_login_rejected'],
    ['AUTH_REQUIRED', { id: 'ABCDEFGH23', at: now - POST_LOGIN_WINDOW_MS - 1, ok: true }, 'no_session'],
    ['AUTH_REQUIRED', { id: 'ABCDEFGH23', at: now - 5_000, ok: false }, 'no_session'],
    ['SESSION_REVOKED', null, 'session_revoked'],
    ['INVALID_TOKEN', null, 'session_expired'],
    ['INVALID_TOKEN', { id: 'ABCDEFGH23', at: now - 5_000, ok: true }, 'session_expired'],
    ['ACCOUNT_SUSPENDED', null, 'account_suspended'],
  ] as const)('%s / %j → %s', (refreshCode, lastAttempt, attendu) => {
    expect(classifyAuthExit({ refreshCode, lastAttempt, now })).toBe(attendu);
  });

  it('écran de connexion : un message par motif ; anciens liens `?expired=1` compris', () => {
    const p = (q: string) => new URLSearchParams(q);
    expect(loginBannerFromParams(p('reason=post_login_rejected&diag=ABCDEFGH23'))?.message).toBe(AUTH_EXIT_MESSAGES.post_login_rejected);
    expect(loginBannerFromParams(p('expired=1&reason=no_session'))?.message).toBe(AUTH_EXIT_MESSAGES.no_session);
    expect(loginBannerFromParams(p('expired=1'))?.message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(loginBannerFromParams(p('error=ACCOUNT_SUSPENDED'))?.reason).toBe('account_suspended');
    expect(loginBannerFromParams(p('reason=inconnu'))).toBeNull();
    expect(loginBannerFromParams(p('returnUrl=/accueil'))).toBeNull();
    const messages = Object.values(AUTH_EXIT_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('écran de connexion : paramètres retirés après lecture, code de diagnostic, vérification post-connexion', () => {
    const page = read('src/app/(auth)/login/page.tsx');
    expect(page).toMatch(/LOGIN_BANNER_PARAMS\) if \(url\.searchParams\.has\(k\)\)/);
    expect(page).toMatch(/window\.history\.replaceState/);
    // Lot 110B : destination transmise pour reprendre après la seconde étape.
    expect(page).toMatch(/postLogin\(\{ email, password(, returnUrl)? \}, \{ attemptId \}\)/);
    expect(page).toMatch(/apiClient\.get\('\/api\/users\/me', \{ onAuthFailure: 'silent'/);
    expect(page).toMatch(/POST_LOGIN_SESSION_MISSING/);
    expect(page).not.toMatch(/data\.accessToken|data\.refreshToken/);
  });
});

describe('L103A-4 — cause racine : état « non authentifié » périmé après une connexion', () => {
  it('séquence de l’app : lu sur /login (401), puis transition « login » → plus aucune sortie', async () => {
    let connecte = false;
    const store = new SessionStore({
      fetchMe: async () => {
        if (!connecte) throw Object.assign(new Error('UNAUTHORIZED'), { status: 401, code: 'UNAUTHORIZED' });
        return { id: 7 } as never;
      },
    });
    // Écran de connexion dans l'app : NativeBridgeRuntime retient le magasin.
    store.retain();
    await store.refetch();
    const renduPerime = store.getSnapshot();
    expect(renduPerime.status).toBe('unauthenticated');
    expect(renduPerime.error?.message).toBe(SESSION_EXPIRED_MESSAGE);

    // Connexion acceptée, navigation client vers /accueil : le fournisseur
    // ouvre la nouvelle époque (effet de mise en page) AVANT l'effet du layout.
    connecte = true;
    store.reset('login');

    // Ancien comportement : décision sur l'état du rendu → sortie (bogue).
    expect(shouldExitOnAuthFailure(renduPerime, false)).toBe(true);
    // Correctif : décision sur l'état ACTUEL du magasin → aucune sortie.
    expect(shouldExitOnAuthFailure(store.getSnapshot(), false)).toBe(false);
    await store.refetch();
    expect(store.getSnapshot().status).toBe('authenticated');
  });

  it('refus définitif encore actuel → sortie ; déconnexion volontaire → aucune', () => {
    const err = { kind: 'unauthenticated' as const, code: 'UNAUTHORIZED', status: 401, message: SESSION_EXPIRED_MESSAGE };
    expect(shouldExitOnAuthFailure({ status: 'unauthenticated', error: err }, false)).toBe(true);
    expect(shouldExitOnAuthFailure({ status: 'unauthenticated', error: { ...err, code: 'SIGNED_OUT' } }, false)).toBe(false);
    expect(shouldExitOnAuthFailure({ status: 'unauthenticated', error: err }, true)).toBe(false);
    expect(shouldExitOnAuthFailure({ status: 'checking', error: null }, false)).toBe(false);
  });

  it('câblage : useSession décide sur `store.getSnapshot()`, pas sur l’état du rendu', () => {
    const hook = read('src/hooks/useSession.ts');
    expect(hook).toMatch(/const live = store\.getSnapshot\(\);\s*\n\s*if \(!shouldExitOnAuthFailure\(live, apiClient\.isSigningOut\(\)\)\) return;/);
  });
});

describe('L103A-5 — client HTTP : refus d’une requête d’une époque antérieure, motif et corrélation', () => {
  let fenetre: { location: { pathname: string; search: string; href: string; origin: string }; localStorage: Storage; sessionStorage: Storage; dispatchEvent: () => boolean };
  beforeEach(() => {
    __resetApiClientForTests();
    fenetre = {
      location: { pathname: '/accueil', search: '', href: 'https://app.test/accueil', origin: 'https://app.test' },
      localStorage: memoire(),
      sessionStorage: memoire(),
      dispatchEvent: () => true,
    };
    vi.stubGlobal('window', fenetre);
    vi.stubGlobal('sessionStorage', fenetre.sessionStorage);
  });
  afterEach(() => { vi.unstubAllGlobals(); __resetApiClientForTests(); });

  it('401 d’une lecture partie AVANT la connexion : aucune déconnexion de la nouvelle session', async () => {
    let relacherRefresh: (r: Response) => void = () => undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/auth/refresh') return new Promise<Response>((resolve) => { relacherRefresh = resolve; });
      if (url === '/api/auth/logout') return Promise.resolve(json({ success: true, revocation: 'revoked' }));
      return Promise.resolve(json({ code: 'MISSING_TOKEN' }, 401));
    });
    vi.stubGlobal('fetch', fetchMock);
    const lecture = apiClient.get('/api/home/summary', { dedupe: false });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/auth/refresh')).toBe(true));
    beginSessionTransition('login'); // connexion acceptée pendant le renouvellement
    relacherRefresh(json({ code: 'AUTH_REQUIRED' }, 401));
    await expect(lecture).rejects.toMatchObject({ status: 401 });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/auth/logout')).toBe(false);
    expect(fenetre.location.href).toBe('https://app.test/accueil');
  });

  it('refus juste après une connexion acceptée → motif `post_login_rejected` + code ; logout « auth-failure » corrélé', async () => {
    rememberLoginAttempt({ id: 'ABCDEFGH23', at: Date.now() - 3_000, ok: true }, fenetre.sessionStorage);
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/auth/refresh') return json({ code: 'AUTH_REQUIRED' }, 401);
      if (url === '/api/auth/logout') return json({ success: true, revocation: 'none' });
      return json({ code: 'MISSING_TOKEN' }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiClient.get('/api/home/summary', { dedupe: false })).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(fenetre.location.href).toMatch(/^\/login/));
    expect(fenetre.location.href).toContain('reason=post_login_rejected');
    expect(fenetre.location.href).toContain('diag=ABCDEFGH23');
    const first = fetchMock.mock.calls.find(([u]) => u === '/api/home/summary')!;
    expect((first[1]!.headers as Record<string, string>)[LOGIN_ATTEMPT_HEADER]).toBe('ABCDEFGH23');
    const logout = fetchMock.mock.calls.find(([u]) => u === '/api/auth/logout')!;
    expect((logout[1]!.headers as Record<string, string>)[LOGOUT_REASON_HEADER]).toBe('auth-failure');
  });

  it('jeton de renouvellement refusé longtemps après la connexion → session réellement expirée', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') return json({ code: 'INVALID_TOKEN' }, 401);
      if (url === '/api/auth/logout') return json({ success: true });
      return json({ code: 'INVALID_TOKEN' }, 401);
    }));
    await expect(apiClient.get('/api/home/summary', { dedupe: false })).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(fenetre.location.href).toMatch(/^\/login/));
    expect(fenetre.location.href).toContain('reason=session_expired');
    expect(fenetre.location.href).not.toContain('diag=');
  });

  it('déconnexion volontaire : origine « user »', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => json({ success: true, revocation: 'revoked' }));
    vi.stubGlobal('fetch', fetchMock);
    await apiClient.signOut({ unsubscribePush: async () => undefined });
    expect((fetchMock.mock.calls[0][1]!.headers as Record<string, string>)[LOGOUT_REASON_HEADER]).toBe('user');
  });
});

describe('L103A-6 — requête de connexion corrélée', () => {
  it('postLogin joint l’identifiant de tentative (jamais dans le corps ni l’URL)', async () => {
    const fetchImpl = vi.fn(async (_u: string, _i?: RequestInit) => json({ success: true })) as unknown as typeof fetch;
    await postLogin({ email: 'a@b.fr', password: 'x' }, { fetchImpl, attemptId: 'ABCDEFGH23' });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect((init.headers as Record<string, string>)[LOGIN_ATTEMPT_HEADER]).toBe('ABCDEFGH23');
    expect(String(init.body)).not.toContain('ABCDEFGH23');
  });

  it('routes instrumentées : connexion (toujours), renouvellement et déconnexion (corrélés), middleware (401 corrélés)', () => {
    expect(read('src/app/api/auth/login/route.ts')).toMatch(/withAuthDiag\(request, 'login', \(\) => login\(request\), \{ always: true \}\)/);
    expect(read('src/app/api/auth/refresh/route.ts')).toMatch(/withAuthDiag\(request, 'refresh'/);
    expect(read('src/app/api/auth/logout/route.ts')).toMatch(/withAuthDiag\(request, 'logout'/);
    const mw = read('src/middleware.ts');
    expect(mw).toMatch(/authDiagEntry\(request, 'api_rejected', 401, 'MISSING_TOKEN'\)/);
    expect(mw).toMatch(/authDiagEntry\(request, 'api_rejected', 401, 'INVALID_TOKEN'\)/);
  });
});
