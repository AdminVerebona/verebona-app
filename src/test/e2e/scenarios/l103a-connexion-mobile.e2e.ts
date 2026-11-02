/**
 * Lot 103A — connexion de l'application iOS / Android (recette du 31/10/2026 :
 * « Votre session a expiré » après une saisie correcte). PostgreSQL 16 réel,
 * VRAIES routes (connexion, identité, déconnexion, liens légaux), middleware
 * réel, journal d'activité et historique BO réels.
 *
 *   L103A-E01 iPhone (agent `VerebonaApp/`, en-têtes IOS) : connexion 200,
 *             cookies HttpOnly SameSite=Lax sans Domain, premier appel
 *             authentifié IMMÉDIAT → 200 (session utilisable), journal
 *             `[auth.diag]` corrélé sans e-mail ni mot de passe ;
 *   L103A-E02 identifiants faux / compte suspendu → refus DISTINCTS, jamais
 *             « session expirée » ; identifiant de tentative au journal ;
 *   L103A-E03 appel d'API sans cookie juste après une connexion → 401
 *             MISSING_TOKEN corrélé au journal (diagnostic « cookie non
 *             transmis ») ;
 *   L103A-E04 sortie « auth-failure » corrélée → historique BO lisible
 *             (plateforme, code de diagnostic, sortie de l'app) ;
 *   L103A-E05 Android : même parcours ; Web : inchangé (aucun en-tête).
 *   L103A-E06 liens légaux : origines admises exposées (liste blanche).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { LOGIN_ATTEMPT_HEADER, LOGOUT_REASON_HEADER, SESSION_EXPIRED_MESSAGE, loginFailureMessage } from '@/lib/auth/login-diagnostics';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
const UA_IOS_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 VerebonaApp/1.0.4 (12; preprod)';
const UA_ANDROID_APP = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 VerebonaApp/1.0.4 (12; preprod)';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };

class Appareil {
  jar = new Map<string, string>();
  constructor(public headers: Record<string, string>, public ip: string) {}
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res: Response) {
    for (const n of ['access_token', 'refresh_token', 'vb_device']) {
      const v = (res as WithCookies).cookies.get(n)?.value;
      if (v === undefined) continue;
      if (v === '') this.jar.delete(n); else this.jar.set(n, v);
    }
    return res;
  }
  req(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}, withCookies = true) {
    return new NextRequest(`${ORIGIN}${path}`, {
      method,
      headers: {
        'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': this.ip, ...this.headers, ...extra,
        ...(withCookies && this.jar.size ? { cookie: this.cookie() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

scenario('L103A', 'Connexion mobile : session utilisable, refus distincts, diagnostic corrélé', ({ sql, make }) => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function compte(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
    const email = `${uid('l103a')}@test.invalid`;
    const owner = await make.user({ email });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = ${status} WHERE id = ${owner.id}`;
    await make.account({ owner });
    return { id: owner.id, email };
  }
  let ipN = 20;
  const ip = () => `103.${ipN++ % 250}.${Math.floor(Math.random() * 250)}.7`;
  const iphone = () => new Appareil({ 'user-agent': UA_IOS_APP, 'x-verebona-client': 'ios', 'x-verebona-app-version': '1.0.4', 'x-verebona-app-build': '12' }, ip());
  const android = () => new Appareil({ 'user-agent': UA_ANDROID_APP, 'x-verebona-client': 'android', 'x-verebona-app-version': '1.0.4', 'x-verebona-app-build': '12' }, ip());
  const web = () => new Appareil({ 'user-agent': UA_WEB, 'x-verebona-client': 'web' }, ip());

  async function connecter(app: Appareil, email: string, password: string, attemptId: string | null) {
    const { POST } = await import('@/app/api/auth/login/route');
    return app.absorb(await POST(app.req('/api/auth/login', 'POST', { email, password }, attemptId ? { [LOGIN_ATTEMPT_HEADER]: attemptId } : {})));
  }
  async function moi(app: Appareil, extra: Record<string, string> = {}) {
    const { GET } = await import('@/app/api/users/me/route');
    return GET(app.req('/api/users/me', 'GET', undefined, extra));
  }
  async function journal(userId: number, type: string) {
    for (let i = 0; i < 40; i++) {
      const rows = await sql<{ details: string | null }[]>`SELECT details FROM user_activity_log WHERE user_id = ${userId} AND activity_type = ${type} ORDER BY id`;
      if (rows.length > 0) return rows.map((r) => JSON.parse(r.details ?? '{}') as Record<string, unknown>);
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }
  const diagLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[auth.diag] ')).map((l) => JSON.parse(l.slice(12)) as Record<string, unknown>);

  it('L103A-E01 iPhone : connexion → premier appel authentifié immédiat 200 ; cookies compatibles WebView ; journal corrélé sans secret', async () => {
    const u = await compte();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const app = iphone();
    const res = await connecter(app, u.email, PASSWORD, 'K7M2Q9X4PA');
    expect(res.status).toBe(200);

    // Cookies : HttpOnly, SameSite=Lax, chemin /, aucun Domain (hôte de la vue = hôte de l'API).
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/access_token=[^;]+;[^\n]*HttpOnly/i);
    expect(setCookie).toMatch(/refresh_token=[^;]+;[^\n]*SameSite=lax/i);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(app.jar.has('access_token') && app.jar.has('refresh_token')).toBe(true);

    // Critère 2 : appel d'API immédiatement après la connexion → authentifié.
    const me = await moi(app, { [LOGIN_ATTEMPT_HEADER]: 'K7M2Q9X4PA' });
    expect(me.status).toBe(200);
    expect((await me.json()).id).toBe(u.id);

    const lignes = diagLines(info);
    expect(lignes).toContainEqual(expect.objectContaining({ step: 'login', attemptId: 'K7M2Q9X4PA', status: 200, client: 'IOS', appVersion: '1.0.4', build: '12' }));
    expect(JSON.stringify(lignes)).not.toContain(u.email);
    expect(JSON.stringify(lignes)).not.toContain(PASSWORD);

    const succes = await journal(u.id, 'LOGIN_SUCCESS');
    expect(succes.at(-1)).toMatchObject({ loginMethod: 'email_password', loginAttemptId: 'K7M2Q9X4PA', client: 'IOS' });
  });

  it('L103A-E02 identifiants faux / compte suspendu : refus distincts, jamais « session expirée »', async () => {
    const actif = await compte();
    const suspendu = await compte('SUSPENDED');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const faux = await connecter(iphone(), actif.email, 'MauvaisMotDePasse1!', 'BADPW23456');
    expect(faux.status).toBe(401);
    const fauxBody = await faux.json();
    expect(fauxBody.code).toBe('INVALID_CREDENTIALS');
    const m1 = loginFailureMessage(401, fauxBody);
    expect(m1.message).toMatch(/Identifiants incorrects/);

    const susp = await connecter(iphone(), suspendu.email, PASSWORD, 'SUSPND2345');
    expect(susp.status).toBe(403);
    const suspBody = await susp.json();
    const m2 = loginFailureMessage(403, suspBody);
    expect(m2.message).toMatch(/suspendu/);
    expect([m1.message, m2.message]).not.toContain(SESSION_EXPIRED_MESSAGE);
    expect(m1.message).not.toBe(m2.message);

    expect(diagLines(warn)).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'login', attemptId: 'BADPW23456', status: 401, code: 'INVALID_CREDENTIALS', client: 'IOS' }),
      expect.objectContaining({ step: 'login', attemptId: 'SUSPND2345', status: 403, code: 'ACCOUNT_SUSPENDED' }),
    ]));
    const echecs = await journal(actif.id, 'LOGIN_FAILED');
    expect(echecs.at(-1)).toMatchObject({ reason: 'invalid_password', loginAttemptId: 'BADPW23456', client: 'IOS' });
  });

  it('L103A-E03 appel sans cookie juste après la connexion : 401 MISSING_TOKEN corrélé (cookie non transmis par la vue)', async () => {
    const u = await compte();
    const app = iphone();
    expect((await connecter(app, u.email, PASSWORD, 'NOCOOKIE23')).status).toBe(200);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { middleware } = await import('@/middleware');
    const res = await middleware(app.req('/api/users/me', 'GET', undefined, { [LOGIN_ATTEMPT_HEADER]: 'NOCOOKIE23' }, false));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('MISSING_TOKEN');
    expect(diagLines(warn)).toContainEqual(expect.objectContaining({ step: 'api_rejected', attemptId: 'NOCOOKIE23', status: 401, code: 'MISSING_TOKEN', client: 'IOS', path: '/api/users/me' }));
    // Sans identifiant de tentative : aucun bruit au journal.
    warn.mockClear();
    await middleware(app.req('/api/users/me', 'GET', undefined, {}, false));
    expect(diagLines(warn)).toEqual([]);
  });

  it('L103A-E04 sortie « auth-failure » corrélée : historique BO lisible (plateforme, code, sortie de l’app)', async () => {
    const u = await compte();
    const app = iphone();
    expect((await connecter(app, u.email, PASSWORD, 'HISTO23456')).status).toBe(200);
    const { POST } = await import('@/app/api/auth/logout/route');
    const out = app.absorb(await POST(app.req('/api/auth/logout', 'POST', {}, { [LOGIN_ATTEMPT_HEADER]: 'HISTO23456', [LOGOUT_REASON_HEADER]: 'auth-failure' })));
    expect(out.status).toBe(200);
    const sorties = await journal(u.id, 'AUTH_LOGOUT');
    expect(sorties.at(-1)).toMatchObject({ trigger: 'auth-failure', loginAttemptId: 'HISTO23456' });

    const { loadLoginHistory } = await import('@/services/admin/user-detail.service');
    let h: Awaited<ReturnType<typeof loadLoginHistory>> = [];
    for (let i = 0; i < 40 && h.length < 2; i++) { h = await loadLoginHistory(u.id); await new Promise((r) => setTimeout(r, 25)); }
    const details = h.map((e) => e.detail ?? '');
    expect(details.some((d) => /Session fermée par l’application/.test(d) && /diagnostic HISTO23456/.test(d))).toBe(true);
    expect(details.some((d) => /app iPhone/.test(d) && /diagnostic HISTO23456/.test(d))).toBe(true);
    // Déconnexion volontaire : absente de l'historique des connexions (inchangé).
    const app2 = iphone();
    await connecter(app2, u.email, PASSWORD, null);
    await POST(app2.req('/api/auth/logout', 'POST', {}, { [LOGOUT_REASON_HEADER]: 'user' }));
    const h2 = await loadLoginHistory(u.id);
    expect(h2.filter((e) => /Session fermée/.test(e.detail ?? ''))).toHaveLength(1);
  });

  it('L103A-E05 Android : même parcours ; Web : inchangé', async () => {
    const u = await compte();
    const a = android();
    expect((await connecter(a, u.email, PASSWORD, 'ANDRO23456')).status).toBe(200);
    expect((await moi(a)).status).toBe(200);
    const w = web();
    expect((await connecter(w, u.email, PASSWORD, null)).status).toBe(200);
    expect((await moi(w)).status).toBe(200);
    const succes = await journal(u.id, 'LOGIN_SUCCESS');
    expect(succes.some((d) => d.client === 'ANDROID' && d.loginAttemptId === 'ANDRO23456')).toBe(true);
    expect(succes.some((d) => !('loginAttemptId' in d))).toBe(true);
  });

  it('L103A-E06 liens légaux : origines juridiques admises exposées à la liste blanche', async () => {
    const { GET } = await import('@/app/api/legal/links/route');
    const body = await (await GET()).json() as { links: Record<string, string>; allowedOrigins: string[] };
    expect(Array.isArray(body.allowedOrigins)).toBe(true);
    for (const href of Object.values(body.links)) expect(body.allowedOrigins).toContain(new URL(href).origin);
  });
});
