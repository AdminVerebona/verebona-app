/**
 * Lot 115A — authentification : cartes #798 (session révoquée juste après une
 * connexion acceptée, iOS), #793 (faux écran « service indisponible » sur un
 * 403 MFA_REQUIRED) et #799 (diagnostic exploitable au BO).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST DÉMONTRÉ ICI, ET CE QUI NE PEUT PAS L'ÊTRE
 *
 * Aucun iPhone n'existe dans cet atelier : le défaut du 16/11 à 14 h 07 n'est
 * PAS reproduit sur un appareil. Ce qui est démontré, c'est la MÉCANIQUE du
 * code : la séquence d'appels qui mène de « connexion acceptée (200) » à
 * « POST /api/auth/logout trigger=auth-failure » + bandeau « la session n'a
 * pas pu être conservée sur cet appareil », appel par appel, avec la pile
 * WebView simulée (fenêtre, stockage de l'onglet, `fetch`). Chaque test de la
 * section L115A-CAUSE montre l'AVANT (ce que l'ancienne règle concluait) et
 * l'APRÈS (ce que la nouvelle conclut) sur les mêmes entrées.
 *
 * Aucun jeton, mot de passe ni cookie ne figure dans ces tests : les refus
 * sont décrits par leur code métier et leur statut HTTP.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_EXIT_MESSAGES, LOGOUT_CODE_HEADER, LOGOUT_REASON_HEADER, POST_LOGIN_WINDOW_MS,
  classifyAuthExit, classifyPostLoginCheck, readLogoutCode, rememberLoginAttempt,
} from '@/lib/auth/login-diagnostics';
import { AUTH_PAGES, isAuthPage } from '@/lib/auth/auth-pages';
import { MFA_REQUIRED_CODE, MFA_REQUIRED_MESSAGE } from '@/lib/auth/mfa/constants';
import { SessionStore, classifySessionError } from '@/lib/session/session-store';
import { unlockSessionStatus } from '@/lib/native/unlock-machine';
import { apiClient, __resetApiClientForTests } from '@/lib/api-client';
import { LOGIN_RESULT_LABEL, filterLoginEntries, loginRowTone } from '@/lib/admin/login-activity';
import { describeLoginActivity } from '@/services/admin/user-detail.service';

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

// ══════════════════════════════════════════════════════════════════════════
// #798 — CAUSE : quel appel déclenche la sortie, et pourquoi
// ══════════════════════════════════════════════════════════════════════════

describe('L115A-CAUSE — #798 : le motif de la sortie n’est plus déduit d’un état ancien', () => {
  const now = 10_000_000;
  const connexionRecente = { id: 'B77RTX8W3E', at: now - 3_000, ok: true };

  it('AVANT / APRÈS : refus sans code (aucun renouvellement tenté) n’est plus « session non conservée »', () => {
    // AVANT (règle remplacée, carte #798) : `refreshCode` vide + connexion
    // acceptée récente ⇒ `post_login_rejected`, dont le message AFFIRME que
    // l'appareil n'a pas conservé la session. Or le code est vide dès qu'aucun
    // renouvellement n'a été tenté : c'est le cas de TOUS les 403 (double
    // authentification exigée, droits, compte), qui ne passent jamais par
    // `/api/auth/refresh`.
    const avant = (code: string | null) =>
      !!connexionRecente.ok && (code === 'AUTH_REQUIRED' || code === 'MISSING_TOKEN' || (code ?? '') === '')
        ? 'post_login_rejected' : 'autre';
    expect(avant(null)).toBe('post_login_rejected');
    expect(avant('')).toBe('post_login_rejected');

    // APRÈS : seule une preuve ABSENTE peut le dire.
    expect(classifyAuthExit({ refreshCode: null, lastAttempt: connexionRecente, now })).toBe('post_login_refused');
    expect(classifyAuthExit({ refreshCode: '', lastAttempt: connexionRecente, now })).toBe('post_login_refused');
    expect(classifyAuthExit({ refreshCode: 'AUTH_REQUIRED', lastAttempt: connexionRecente, now })).toBe('post_login_rejected');
    expect(classifyAuthExit({ refreshCode: 'MISSING_TOKEN', lastAttempt: connexionRecente, now })).toBe('post_login_rejected');
    // Le message du nouveau motif n'affirme AUCUNE cause.
    expect(AUTH_EXIT_MESSAGES.post_login_refused).not.toMatch(/conservée sur cet appareil/);
    expect(AUTH_EXIT_MESSAGES.post_login_refused).toMatch(/premier accès a été refusé/);
  });

  it('un refus de double authentification a son propre motif, jamais « session expirée »', () => {
    expect(classifyAuthExit({ refreshCode: MFA_REQUIRED_CODE, lastAttempt: null, now })).toBe('mfa_required');
    expect(classifyAuthExit({ refreshCode: MFA_REQUIRED_CODE, lastAttempt: connexionRecente, now })).toBe('mfa_required');
  });

  it('hors de la fenêtre d’après connexion, les motifs historiques sont inchangés', () => {
    const vieux = { id: 'B77RTX8W3E', at: now - POST_LOGIN_WINDOW_MS - 1, ok: true };
    expect(classifyAuthExit({ refreshCode: 'AUTH_REQUIRED', lastAttempt: vieux, now })).toBe('no_session');
    expect(classifyAuthExit({ refreshCode: 'INVALID_TOKEN', lastAttempt: vieux, now })).toBe('session_expired');
    expect(classifyAuthExit({ refreshCode: 'SESSION_REVOKED', lastAttempt: null, now })).toBe('session_revoked');
    expect(classifyAuthExit({ refreshCode: 'ACCOUNT_SUSPENDED', lastAttempt: connexionRecente, now })).toBe('account_suspended');
  });
});

describe('L115A-POST-LOGIN — #798 : toutes les suites du premier appel authentifié sont classées', () => {
  it.each([
    // [statut, code, genre attendu, motif attendu]
    [401, 'AUTH_REQUIRED', 'stay', 'post_login_rejected'],
    [401, 'MISSING_TOKEN', 'stay', 'post_login_rejected'],
    // Jeton présenté mais refusé : la vue a bien transmis le cookie — ne pas
    // accuser l'appareil de l'avoir perdu.
    [401, 'INVALID_TOKEN', 'stay', 'post_login_refused'],
    [401, 'SESSION_REVOKED', 'stay', 'post_login_refused'],
    // LE cas avalé avant la carte : l'accueil s'ouvrait avec une session refusée.
    [403, 'MFA_REQUIRED', 'stay', 'mfa_required'],
    [403, 'ACCOUNT_SUSPENDED', 'stay', 'account_suspended'],
    [403, 'INSUFFICIENT_PERMISSIONS', 'stay', 'post_login_refused'],
    // Incidents TECHNIQUES : la vérification n'est pas un verrou.
    [503, 'SESSION_UNAVAILABLE', 'continue', null],
    [500, 'INTERNAL_ERROR', 'continue', null],
    [0, 'REQUEST_TIMEOUT', 'continue', null],
    [0, 'NETWORK_ERROR', 'continue', null],
    [426, 'APP_UPDATE_REQUIRED', 'continue', null],
    [429, 'RATE_LIMIT_EXCEEDED', 'continue', null],
  ] as const)('%i %s → %s %s', (status, code, kind, reason) => {
    const v = classifyPostLoginCheck({ status, code });
    expect(v.kind).toBe(kind);
    if (v.kind === 'stay') expect(v.reason).toBe(reason);
  });

  it('erreur sans statut ni code : on ne bloque pas et on n’invente pas de refus', () => {
    expect(classifyPostLoginCheck({ status: undefined, code: undefined }).kind).toBe('continue');
  });

  it('câblage de l’écran de connexion : plus de branche « seulement 401 »', () => {
    const page = read('src/app/(auth)/login/page.tsx');
    expect(page).toMatch(/apiClient\.get\('\/api\/users\/me', \{ onAuthFailure: 'silent'/);
    expect(page).toMatch(/classifyPostLoginCheck\(\{ status: e\?\.status, code: e\?\.code \}\)/);
    expect(page).toMatch(/POST_LOGIN_SESSION_MISSING/);
    // L'ancienne condition « if (status === 401) { … return; } » a disparu.
    expect(page).not.toMatch(/if \(status === 401\)/);
    // Aucune nouvelle tentative de connexion silencieuse, aucun effacement de
    // cookie, aucune réinstallation suggérée (garde-fous de la carte).
    expect(page).not.toMatch(/postLogin\([^)]*\)[\s\S]{0,200}postLogin\(/);
    expect(page).not.toMatch(/document\.cookie/);
    expect(page).not.toMatch(/réinstall/i);
  });
});

describe('L115A-PAGES — #798 : une seule liste fermée de pages d’authentification', () => {
  it('la seconde étape, l’enrôlement, la récupération et le retour social y sont', () => {
    for (const p of ['/login', '/signup', '/verification', '/securiser-mon-compte', '/recuperation', '/connexion-sociale', '/verify-email']) {
      expect(isAuthPage(p)).toBe(true);
    }
    expect(isAuthPage('/verification?returnUrl=/accueil')).toBe(true);
    expect(isAuthPage('/accueil')).toBe(false);
    expect(isAuthPage('/mes-biens/12')).toBe(false);
    expect(isAuthPage(null)).toBe(false);
    // Jamais un préfixe accidentel d'une page métier.
    expect(isAuthPage('/verification-des-biens')).toBe(false);
  });

  it('les trois décisions lisent CETTE liste (contexte de session, sortie, renvoi MFA, redirection)', () => {
    const ctx = read('src/contexts/SessionContext.tsx');
    expect(ctx).toMatch(/isAuthPage/);
    expect(ctx).not.toMatch(/const PAGES_SANS_SESSION = \[/);
    const client = read('src/lib/api-client.ts');
    expect(client).toMatch(/if \(isAuthPage\(path\)\) return Promise\.resolve\(\);/);
    expect(client).not.toMatch(/path\.startsWith\('\/login'\) \|\| path\.startsWith\('\/signup'\)/);
    expect(client).toMatch(/&& !isAuthPage\(window\.location\.pathname\)\)/);
    const redirect = read('src/lib/safe-redirect.ts');
    expect(redirect).toMatch(/isAuthPage\(path\) \? fallback : path/);
    // La liste est unique : aucune autre énumération locale de ces chemins.
    expect(AUTH_PAGES).toContain('/connexion-sociale');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// #798 — SÉQUENCE HORODATÉE, PILE WEBVIEW SIMULÉE
// ══════════════════════════════════════════════════════════════════════════

describe('L115A-SEQUENCE — #798 : reconstitution appel par appel (pile WebView simulée)', () => {
  let fenetre: {
    location: { pathname: string; search: string; href: string; origin: string; assign: (u: string) => void };
    localStorage: Storage; sessionStorage: Storage; dispatchEvent: () => boolean;
  };
  /** Journal des appels, dans l'ordre : l'équivalent des lignes `[auth.diag]`. */
  let sequence: { etape: string; statut: number; code: string | null; trigger?: string | null; refus?: string | null }[];

  beforeEach(() => {
    __resetApiClientForTests();
    sequence = [];
    fenetre = {
      location: {
        pathname: '/accueil', search: '', href: 'https://app.test/accueil', origin: 'https://app.test',
        // `window.location.assign` du renvoi MFA (le reste du client HTTP
        // écrit `href`) : la pile WebView simulée doit les rendre tous deux.
        assign(u: string) { fenetre.location.href = u; },
      },
      localStorage: memoire(),
      sessionStorage: memoire(),
      dispatchEvent: () => true,
    };
    vi.stubGlobal('window', fenetre);
    vi.stubGlobal('sessionStorage', fenetre.sessionStorage);
  });
  afterEach(() => { vi.unstubAllGlobals(); __resetApiClientForTests(); });

  it('403 MFA_REQUIRED après une connexion acceptée : AUCUNE déconnexion, AUCUN « session non conservée »', async () => {
    rememberLoginAttempt({ id: 'B77RTX8W3E', at: Date.now() - 3_000, ok: true }, fenetre.sessionStorage);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (url === '/api/auth/logout') {
        sequence.push({ etape: 'logout', statut: 200, code: null, trigger: h[LOGOUT_REASON_HEADER] ?? null, refus: h[LOGOUT_CODE_HEADER] ?? null });
        return json({ success: true, revocation: 'revoked' });
      }
      if (url === '/api/auth/refresh') { sequence.push({ etape: 'refresh', statut: 401, code: 'AUTH_REQUIRED' }); return json({ code: 'AUTH_REQUIRED' }, 401); }
      sequence.push({ etape: 'api_rejected', statut: 403, code: MFA_REQUIRED_CODE });
      return json({ error: 'Forbidden', code: MFA_REQUIRED_CODE, message: MFA_REQUIRED_MESSAGE, requestId: 'r-1' }, 403);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient.get('/api/home/summary', { dedupe: false }))
      .rejects.toMatchObject({ status: 403, code: MFA_REQUIRED_CODE });
    await new Promise((r) => setTimeout(r, 0));

    // Un refus VOLONTAIRE ne tente aucun renouvellement et ne ferme aucune session.
    expect(sequence.map((e) => e.etape)).toEqual(['api_rejected']);
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/auth/logout')).toBe(false);
    // L'utilisateur est mené à la reconnexion forte, pas à « session non conservée ».
    expect(fenetre.location.href).toContain('reason=mfa_required');
    expect(fenetre.location.href).not.toContain('post_login_rejected');
  });

  it('401 sans preuve présentée : sortie corrélée, motif exact et CODE du refus transmis au BO', async () => {
    rememberLoginAttempt({ id: 'B77RTX8W3E', at: Date.now() - 3_000, ok: true }, fenetre.sessionStorage);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (url === '/api/auth/refresh') return json({ code: 'AUTH_REQUIRED' }, 401);
      if (url === '/api/auth/logout') {
        sequence.push({ etape: 'logout', statut: 200, code: null, trigger: h[LOGOUT_REASON_HEADER] ?? null, refus: h[LOGOUT_CODE_HEADER] ?? null });
        return json({ success: true, revocation: 'revoked' });
      }
      return json({ code: 'MISSING_TOKEN' }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient.get('/api/home/summary', { dedupe: false })).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(fenetre.location.href).toMatch(/^\/login/));
    expect(fenetre.location.href).toContain('reason=post_login_rejected');
    expect(fenetre.location.href).toContain('diag=B77RTX8W3E');
    // Carte #799 : le BO pourra dire QUEL refus a fermé la session.
    expect(sequence.find((e) => e.etape === 'logout')).toMatchObject({ trigger: 'auth-failure', refus: 'AUTH_REQUIRED' });
  });

  it('le CODE RÉEL du refus est rendu à l’appelant (il était écrasé par « UNAUTHORIZED »)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') return json({ code: 'SESSION_REVOKED' }, 401);
      if (url === '/api/auth/logout') return json({ success: true });
      return json({ code: 'INVALID_TOKEN' }, 401);
    }));
    await expect(apiClient.get('/api/home/summary', { dedupe: false }))
      .rejects.toMatchObject({ status: 401, code: 'SESSION_REVOKED' });
  });

  it('depuis la SECONDE ÉTAPE de la double authentification, aucune sortie ne part (garde anti-boucle)', async () => {
    fenetre.location.pathname = '/verification';
    fenetre.location.href = 'https://app.test/verification';
    const fetchMock = vi.fn(async () => json({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
    await apiClient.handleAuthFailure({ code: 'AUTH_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fenetre.location.href).toBe('https://app.test/verification');
  });

  it('aucun jeton, mot de passe ni cookie dans la séquence tracée', () => {
    expect(JSON.stringify(sequence)).not.toMatch(/token=|password|cookie|Bearer/i);
  });
});

describe('L115A-PROTECTIONS — #798 : rien n’est relâché', () => {
  it('cookies de session : HttpOnly, Secure et SameSite inchangés', () => {
    const jetons = read('src/lib/auth/session-tokens.ts');
    expect(jetons).toMatch(/httpOnly: true, secure, sameSite: 'lax', maxAge: ACCESS_TOKEN_TTL_S/);
    expect(jetons).toMatch(/httpOnly: true, secure, sameSite: 'lax', maxAge: REFRESH_TOKEN_TTL_S/);
    expect(jetons).not.toMatch(/httpOnly: false|sameSite: 'none'/);
  });

  it('la garde serveur de la double authentification n’est pas touchée', () => {
    const errs = read('src/lib/auth/session-errors.ts');
    expect(errs).toMatch(/\[MFA_REQUIRED_CODE\]: \{ status: 403, code: MFA_REQUIRED_CODE/);
  });

  it('aucune session fantôme : une sortie purge l’identité, elle ne la masque pas', () => {
    const store = read('src/lib/session/session-store.ts');
    expect(store).toMatch(/status: 'unauthenticated', user: null/);
    expect(store).toMatch(/status: 'reauth-required', user: null/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// #793 — 403 MFA_REQUIRED : refus typé, reconnexion, aucune boucle
// ══════════════════════════════════════════════════════════════════════════

describe('L115A-MFA — #793 : un refus volontaire n’est plus une panne', () => {
  const err = (status: number, code: string, requestId = 'r-9') =>
    Object.assign(new Error(code), { status, code, requestId });

  it.each([
    [403, 'MFA_REQUIRED', 'reauth-required'],
    [401, 'AUTH_REQUIRED', 'unauthenticated'],
    [401, 'INVALID_TOKEN', 'unauthenticated'],
    [403, 'ACCOUNT_SUSPENDED', 'unauthenticated'],
    [503, 'SESSION_UNAVAILABLE', 'unavailable'],
    [0, 'REQUEST_TIMEOUT', 'unavailable'],
    [500, 'INTERNAL_ERROR', 'unavailable'],
  ] as const)('%i %s → %s', (status, code, kind) => {
    expect(classifySessionError(err(status, code)).kind).toBe(kind);
  });

  it('le refus MFA porte le message du serveur et son `requestId` (aucun secret)', () => {
    const e = classifySessionError(err(403, MFA_REQUIRED_CODE, 'req-42'));
    expect(e).toMatchObject({ kind: 'reauth-required', code: MFA_REQUIRED_CODE, status: 403, message: MFA_REQUIRED_MESSAGE, requestId: 'req-42' });
  });

  it('l’indisponibilité n’affirme plus ce qui n’est pas vérifiable', () => {
    const m = classifySessionError(err(503, 'SESSION_UNAVAILABLE')).message;
    expect(m).not.toMatch(/n’est pas en cause|données sont intactes/);
    expect(m).toMatch(/n’a pas abouti/);
  });

  it('le magasin passe en « reconnexion exigée » et purge l’identité affichée', async () => {
    let refus = false;
    const persistes: (unknown)[] = [];
    const store = new SessionStore({
      fetchMe: async () => {
        if (refus) throw err(403, MFA_REQUIRED_CODE);
        return { id: 7 } as never;
      },
      persist: (u) => persistes.push(u),
    });
    await store.refetch();
    expect(store.getSnapshot().status).toBe('authenticated');
    refus = true;
    await store.refetch();
    const snap = store.getSnapshot();
    expect(snap.status).toBe('reauth-required');
    // CA08 : aucune ancienne identité conservée comme preuve d'accès.
    expect(snap.user).toBeNull();
    expect(persistes.at(-1)).toBeNull();
  });

  it('le verrou natif conclut « reconnexion exigée » par les deux chemins', () => {
    expect(unlockSessionStatus('reauth-required')).toBe('reauth-required');
    expect(unlockSessionStatus('temporarily-unavailable', MFA_REQUIRED_CODE)).toBe('reauth-required');
    expect(unlockSessionStatus('temporarily-unavailable', 'REQUEST_TIMEOUT')).toBe('temporarily-unavailable');
    expect(unlockSessionStatus('unauthenticated')).toBe('unauthenticated');
  });

  it('coquille : écran dédié avec « Se reconnecter », sans aucun réessai', () => {
    const ecrans = read('src/components/shell/SessionStateScreen.tsx');
    expect(ecrans).toMatch(/export function SessionReauthRequiredScreen/);
    expect(ecrans).toMatch(/Se reconnecter/);
    // L'écran de reconnexion ne porte pas de bouton « Réessayer ».
    const debut = ecrans.indexOf('export function SessionReauthRequiredScreen');
    const bloc = ecrans.slice(debut, ecrans.indexOf('export function', debut + 10));
    expect(bloc).not.toMatch(/Réessayer/);
    const layout = read('src/components/DashboardLayout.tsx');
    expect(layout).toMatch(/sessionResult\.status === 'reauth-required'/);
    expect(layout).toMatch(/\/login\?reason=mfa_required&returnUrl=/);
    // La destination passe par le garde-fou de redirection (pas d'open redirect).
    expect(layout).toMatch(/safeReturnUrl\(`\$\{window\.location\.pathname\}\$\{window\.location\.search\}`\)/);
  });

  it('aucune relecture automatique en boucle : la reprise ne vise que l’indisponibilité', () => {
    const ctx = read('src/contexts/SessionContext.tsx');
    expect(ctx).toMatch(/if \(store\.getSnapshot\(\)\.status === 'temporarily-unavailable'\) void store\.refetch\(\);/);
    expect(ctx).not.toMatch(/'reauth-required'/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// #799 — BO : classification et diagnostic
// ══════════════════════════════════════════════════════════════════════════

describe('L115A-BO — #799 : déconnexion applicative ≠ révocation de sécurité', () => {
  const details = (o: Record<string, unknown>) => JSON.stringify(o);

  it('CA01 — `AUTH_LOGOUT trigger=auth-failure` : jamais « Déconnexion par précaution »', () => {
    const r = describeLoginActivity('AUTH_LOGOUT', details({
      trigger: 'auth-failure', loginAttemptId: 'B77RTX8W3E', client: 'IOS', refusalCode: 'AUTH_REQUIRED', sid: 's-1',
    }));
    expect(r.result).toBe('app_signed_out');
    expect(r.category).toBe('session_incident');
    expect(LOGIN_RESULT_LABEL[r.result]).toBe('Déconnexion après refus d’authentification');
    expect(LOGIN_RESULT_LABEL[r.result]).not.toBe(LOGIN_RESULT_LABEL.session_revoked);
    expect(r.attemptId).toBe('B77RTX8W3E');
    expect(r.refusalCode).toBe('AUTH_REQUIRED');
    expect(r.detail).toContain('refus initial : AUTH_REQUIRED');
    expect(r.detail).toContain('app iPhone');
    expect(r.detail).toContain('diagnostic B77RTX8W3E');
  });

  it('CA05 — refus non tracé : « non disponible », rien n’est reconstitué', () => {
    const r = describeLoginActivity('AUTH_LOGOUT', details({ trigger: 'auth-failure', loginAttemptId: 'B77RTX8W3E' }));
    expect(r.refusalCode).toBeNull();
    expect(r.detail).toContain('refus initial : non disponible');
    // Un code mal formé est ignoré, pas affiché.
    expect(describeLoginActivity('AUTH_LOGOUT', details({ trigger: 'auth-failure', refusalCode: 'a@b.fr' })).refusalCode).toBeNull();
  });

  it('CA02 — révocation de sécurité QUALIFIÉE : libellé et délai conservés', () => {
    const r = describeLoginActivity('AUTH_TOKEN_REUSE_DETECTED', details({ severity: 'security_incident', rotationAgeMs: 45_000, sessionsRevoked: true }));
    expect(r.result).toBe('session_revoked');
    expect(r.category).toBe('security');
    expect(LOGIN_RESULT_LABEL[r.result]).toBe('Déconnexion par précaution');
    expect(r.detail).toContain('45 s après son renouvellement');
  });

  it('CA02 — détection NON qualifiée : pas de qualification de sécurité à la place de la source', () => {
    const r = describeLoginActivity('AUTH_TOKEN_REUSE_DETECTED', details({ rotationAgeMs: 45_000 }));
    expect(r.result).toBe('app_signed_out');
    expect(r.category).toBe('session_incident');
    expect(r.detail).toContain('sévérité non qualifiée');
  });

  it('CA03 — succès, échec, anti-abus, sortie volontaire : résultats distincts', () => {
    expect(describeLoginActivity('LOGIN_SUCCESS', details({ loginAttemptId: 'B77RTX8W3E', client: 'IOS' })))
      .toMatchObject({ result: 'success', category: 'success', attemptId: 'B77RTX8W3E' });
    expect(describeLoginActivity('LOGIN_FAILED', details({ reason: 'invalid_password' })))
      .toMatchObject({ result: 'failure', category: 'failure' });
    expect(describeLoginActivity('AUTH_LOGIN_THROTTLED', details({ rule: 'origin', retryAfterSeconds: 600 })))
      .toMatchObject({ result: 'throttled', category: 'anti_abuse' });
    expect(describeLoginActivity('AUTH_LOGOUT', details({ trigger: 'user' })))
      .toMatchObject({ result: 'signed_out', category: 'signed_out' });
    // Les six résultats ont six libellés distincts.
    const labels = Object.values(LOGIN_RESULT_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('seules la sécurité et l’échec portent le ton d’alerte', () => {
    expect(loginRowTone({ result: 'session_revoked', category: 'security' })).toBe('text-destructive');
    expect(loginRowTone({ result: 'failure', category: 'failure' })).toBe('text-destructive');
    expect(loginRowTone({ result: 'app_signed_out', category: 'session_incident' })).toBe('');
    expect(loginRowTone({ result: 'success', category: 'success' })).toBe('');
    // Ligne servie par un code antérieur (catégorie absente) : déduite, sans
    // inventer de sévérité.
    expect(loginRowTone({ result: 'session_revoked' })).toBe('text-destructive');
    expect(loginRowTone({})).toBe('');
  });

  it('CA04 — la tentative se retrouve depuis son code de diagnostic, sans SQL', () => {
    const lignes = [
      { attemptId: 'B77RTX8W3E', detail: 'Connexion acceptée · app iPhone · diagnostic B77RTX8W3E' },
      { attemptId: null, detail: 'Mot de passe incorrect' },
      // Ancienne donnée : le code n'existe que dans le détail.
      { attemptId: null, detail: 'Session fermée par l’application · diagnostic B77RTX8W3E' },
    ];
    expect(filterLoginEntries(lignes, 'b77rtx8w3e')).toHaveLength(2);
    expect(filterLoginEntries(lignes, '  ')).toHaveLength(3);
    expect(filterLoginEntries(lignes, 'ZZZZ')).toHaveLength(0);
  });

  it('le code du refus arrive par un en-tête contrôlé (jamais une valeur libre)', () => {
    expect(readLogoutCode(new Headers({ [LOGOUT_CODE_HEADER]: 'mfa_required' }))).toBe('MFA_REQUIRED');
    expect(readLogoutCode(new Headers({ [LOGOUT_CODE_HEADER]: 'a@b.fr' }))).toBeNull();
    expect(readLogoutCode(new Headers({ [LOGOUT_CODE_HEADER]: 'x' }))).toBeNull();
    expect(readLogoutCode(new Headers({}))).toBeNull();
  });

  it('câblage : la route de déconnexion trace le code, le BO l’affiche et dit ce qui manque', () => {
    const route = read('src/app/api/auth/logout/route.ts');
    expect(route).toMatch(/const refusalCode = readLogoutCode\(request\.headers\);/);
    expect(route).toMatch(/\.\.\.\(refusalCode \? \{ refusalCode \} : \{\}\)/);
    // Aucun jeton ni cookie ajouté au journal d'activité.
    const bloc = route.slice(route.indexOf('const details'), route.indexOf('logUserActivity'));
    expect(bloc).not.toMatch(/refreshToken|access_token|cookie/);
    const page = read('src/app/admin/users/[id]/page.tsx');
    expect(page).toMatch(/refus initial/);
    expect(page).toMatch(/non disponible/);
    expect(page).toMatch(/filterLoginEntries/);
    expect(page).not.toMatch(/const LOGIN_RESULT_LABEL = \{/);
  });
});
