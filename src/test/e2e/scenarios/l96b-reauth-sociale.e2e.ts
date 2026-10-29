/**
 * Lot 96B — Google / Apple sous les règles du lot A (CDC 18 ; décisions PO
 * Q1, Q6, Q11, P2) : PostgreSQL réel, vraies routes, faux fournisseur OIDC
 * local (`../fake-oidc.ts`, aucun réseau). Matrice de recette PO §5 :
 *
 *   R03   inscription Google puis Apple sans mot de passe Verebona ; la
 *         session qui crée le compte n'alerte pas ;
 *   R04   adresse déjà connue : aucune fusion ni rattachement automatique ;
 *   R05   rattachement explicite puis suppression du dernier moyen : refus ;
 *   P2    réauthentification : Google `prompt=login` + `max_age`, `auth_time`
 *         récent exigé (Google et Apple) ; session fournisseur silencieuse ou
 *         sans `auth_time` → refus, aucune preuve ; même subject exigé ;
 *   Q6    connexion Google depuis un nouveau navigateur : une alerte ;
 *   Q11   adresse en pause D1 : la connexion Google déjà liée reste possible.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { createFakeOidc, type FakeUser } from '../fake-oidc';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'MotDePasseL96b!s';
const fake = createFakeOidc();
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(fake.env)) { saved[k] = process.env[k]; process.env[k] = v; }

type Provider = 'google' | 'apple';
type WithCookies = Response & { cookies: { getAll(): Array<{ name: string; value: string; maxAge?: number }> } };

class Browser {
  jar = new Map<string, string>();
  ip = `97.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  req(path: string, init: { method?: string; body?: unknown; form?: Record<string, string>; noCookies?: boolean; origin?: string } = {}) {
    const headers: Record<string, string> = { origin: init.origin ?? ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36' };
    if (!init.noCookies && this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (init.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(init.form).toString(); }
    else if (init.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.body); }
    return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body });
  }
  absorb<T extends Response>(res: T): T {
    for (const c of (res as unknown as WithCookies).cookies.getAll()) {
      if (!c.value || c.maxAge === 0) this.jar.delete(c.name); else this.jar.set(c.name, c.value);
    }
    return res;
  }
}

const loc = (res: Response) => new URL(res.headers.get('location') ?? 'http://none/', ORIGIN);
const p = (provider: string) => ({ params: Promise.resolve({ provider }) });

scenario('L96B-SOC', 'Google / Apple : réauthentification récente, alertes, D1 (CDC 18 lot A, P2)', ({ sql }) => {
  const R = async () => ({
    start: await import('@/app/api/auth/oauth/[provider]/start/route'),
    callback: await import('@/app/api/auth/oauth/[provider]/callback/route'),
    pending: await import('@/app/api/auth/oauth/pending/route'),
    identity: await import('@/app/api/users/me/auth-identities/[provider]/route'),
    link: await import('@/app/api/users/me/auth-identities/[provider]/link/route'),
    reauth: await import('@/app/api/users/me/auth-identities/[provider]/reauth/route'),
    login: await import('@/app/api/auth/login/route'),
  });

  beforeAll(async () => {
    const { setOAuthFetchForTests } = await import('@/lib/auth/oauth/providers');
    setOAuthFetchForTests(fake.fetchImpl);
  });
  afterAll(async () => {
    const { setOAuthFetchForTests } = await import('@/lib/auth/oauth/providers');
    setOAuthFetchForTests(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  async function cgvu(): Promise<string> {
    const [cur] = await sql<{ version_code: string }[]>`
      SELECT version_code FROM legal_document_versions WHERE document_type = 'CGVU' AND status = 'CURRENT' LIMIT 1`;
    if (cur) return cur.version_code;
    const code = `E2E-${uid('cgvu')}`;
    await sql`INSERT INTO legal_document_versions
      (document_type, version_code, title, status, change_summary, published_at, effective_at, html_content, sha256, permalink, html_storage_key)
      VALUES ('CGVU', ${code}, 'CGVU e2e', 'CURRENT', 'e2e', now(), now(), '<p>CGVU</p>', ${'0'.repeat(64)}, ${`/cgvu/${code}`}, ${`legal/${code}.html`})`;
    return code;
  }

  async function localAccount() {
    const email = `${uid('loc96')}@test.invalid`;
    const [u] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, status, is_active, first_name, last_name, created_at)
      VALUES (${email}, ${await bcrypt.hash(PASSWORD, 4)}, 'ACTIVE', true, 'Local', 'Titulaire', now() - interval '30 days') RETURNING id`;
    const [a] = await sql<{ id: number }[]>`INSERT INTO accounts (name, owner_user_id) VALUES (${uid('compte')}, ${u.id}) RETURNING id`;
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${a.id}, ${u.id}, 'owner', 'active')`;
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status) VALUES (${a.id}, 'standard', 'active')`;
    return { id: u.id, email };
  }

  let lastAuthorize: ReturnType<typeof fake.authorize> | null = null;
  async function providerReturn(b: Browser, provider: Provider, providerUrl: string, user: FakeUser) {
    const r = await R();
    const a = fake.authorize(providerUrl, user);
    lastAuthorize = a;
    if (provider === 'google') {
      const q = new URLSearchParams({ state: a.state, code: a.code });
      return b.absorb(await r.callback.GET(b.req(`/api/auth/oauth/google/callback?${q}`), p('google')));
    }
    const form: Record<string, string> = { state: a.state, code: a.code };
    if (a.appleUser) form.user = a.appleUser;
    const post = await r.callback.POST(b.req('/api/auth/oauth/apple/callback', { method: 'POST', form, noCookies: true, origin: 'https://appleid.apple.com' }), p('apple'));
    const resume = loc(post);
    if (resume.pathname !== '/api/auth/oauth/apple/callback') return post;
    return b.absorb(await r.callback.GET(b.req(`${resume.pathname}${resume.search}`), p('apple')));
  }
  async function social(b: Browser, provider: Provider, user: FakeUser, intent = 'login') {
    const r = await R();
    const start = b.absorb(await r.start.GET(b.req(`/api/auth/oauth/${provider}/start?intent=${intent}`), p(provider)));
    expect(start.status).toBe(302);
    return providerReturn(b, provider, start.headers.get('location')!, user);
  }
  async function pending(b: Browser, body?: Record<string, unknown>) {
    const r = await R();
    const res = b.absorb(body ? await r.pending.POST(b.req('/api/auth/oauth/pending', { method: 'POST', body })) : await r.pending.GET(b.req('/api/auth/oauth/pending')));
    return { res, status: res.status, body: await res.json() as Record<string, any> };
  }
  async function socialOnly(provider: Provider) {
    const b = new Browser();
    const email = `${uid(`${provider}96`)}@test.invalid`;
    const user: FakeUser = { sub: uid(`${provider}-sub96`), email, givenName: 'Sam', familyName: 'Social', appleName: { firstName: 'Sam', lastName: 'Social' } };
    expect(loc(await social(b, provider, user, 'signup')).pathname).toBe('/connexion-sociale');
    const done = await pending(b, { action: 'signup', firstName: 'Sam', lastName: 'Social', email, acceptedTerms: true, termsVersion: await cgvu() });
    expect(done.status).toBe(200);
    const [u] = await sql<{ id: number; password_hash: string | null }[]>`SELECT id, password_hash FROM users WHERE email = ${email}`;
    return { b, user, userId: u.id, email, passwordHash: u.password_hash };
  }
  async function providerReauth(b: Browser, provider: Provider, user: FakeUser) {
    const r = await R();
    const s = b.absorb(await r.reauth.POST(b.req(`/api/users/me/auth-identities/${provider}/reauth`, { method: 'POST', body: { resume: 'add-password' } }), p(provider)));
    expect(s.status).toBe(200);
    return providerReturn(b, provider, (await s.json()).redirectUrl, user);
  }
  const proofs = (userId: number) => sql<{ method: string }[]>`SELECT method FROM reauth_proofs WHERE user_id = ${userId} AND consumed_at IS NULL`;
  const alertes = (userId: number) => sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${userId} AND event_type = 'NEW_DEVICE_LOGIN'`;

  // ── R03 / R04 / R05 ───────────────────────────────────────────────────────

  it('R03 inscription Google puis Apple sans mot de passe Verebona ; la session de création n’envoie pas d’alerte « nouvel appareil »', async () => {
    const g = await socialOnly('google');
    const a = await socialOnly('apple');
    expect([g.passwordHash, a.passwordHash]).toEqual([null, null]);
    expect(await sql`SELECT provider FROM auth_identities WHERE user_id IN (${g.userId}, ${a.userId}) ORDER BY provider`).toEqual([{ provider: 'apple' }, { provider: 'google' }]);
    expect(await alertes(g.userId)).toHaveLength(0);
    expect(await alertes(a.userId)).toHaveLength(0);
    // Q6 : connexion Google suivante depuis un AUTRE navigateur → une alerte ; même navigateur ensuite → aucune.
    const autre = new Browser();
    expect(loc(await social(autre, 'google', g.user)).pathname).toBe('/accueil');
    expect(await alertes(g.userId)).toHaveLength(1);
    expect(loc(await social(autre, 'google', g.user)).pathname).toBe('/accueil');
    expect(await alertes(g.userId)).toHaveLength(1);
  });

  it('R04 adresse déjà connue : ni fusion ni rattachement automatique Google / Apple', async () => {
    const local = await localAccount();
    for (const provider of ['google', 'apple'] as const) {
      const b = new Browser();
      const user: FakeUser = { sub: uid(`r04-${provider}`), email: local.email };
      expect(loc(await social(b, provider, user)).pathname).toBe('/connexion-sociale');
      expect((await pending(b)).body.stage).toBe('existing_email');
      expect(await sql`SELECT 1 FROM auth_identities WHERE subject = ${user.sub}`).toHaveLength(0);
    }
    expect(await sql`SELECT 1 FROM users WHERE email = ${local.email}`).toHaveLength(1);
  });

  it('R05 rattachement explicite (Apple ajouté à un compte Google) puis suppression du dernier moyen : refus LAST_LOGIN_METHOD', async () => {
    const r = await R();
    const s = await socialOnly('google');
    await providerReauth(s.b, 'google', s.user);
    const a = s.b.absorb(await r.link.POST(s.b.req('/api/users/me/auth-identities/apple/link', { method: 'POST', body: {} }), p('apple')));
    expect(a.status).toBe(200);
    const apple: FakeUser = { sub: uid('r05-apple'), email: `${uid('rel')}@privaterelay.appleid.com`, privateRelay: true };
    expect(loc(await providerReturn(s.b, 'apple', (await a.json()).redirectUrl, apple)).searchParams.get('securite')).toBe('linked');
    // Intégration 96A (Q7) : tout changement d'identifiant (ici l'association d'Apple) retire la
    // preuve — nouvelle réauthentification fraîche avant chaque action sensible.
    await providerReauth(s.b, 'google', s.user);
    // Apple retiré : il reste Google.
    expect((await r.identity.DELETE(s.b.req('/api/users/me/auth-identities/apple', { method: 'DELETE', body: {} }), p('apple'))).status).toBe(200);
    // Google : dernier moyen de connexion → refus, identité conservée.
    await providerReauth(s.b, 'google', s.user);
    const last = await r.identity.DELETE(s.b.req('/api/users/me/auth-identities/google', { method: 'DELETE', body: {} }), p('google'));
    expect(last.status).toBe(409);
    expect((await last.json()).code).toBe('LAST_LOGIN_METHOD');
    expect(await sql`SELECT provider FROM auth_identities WHERE user_id = ${s.userId}`).toEqual([{ provider: 'google' }]);
  });

  // ── P2 ────────────────────────────────────────────────────────────────────

  it('P2 Google : prompt=login + max_age ; session Google silencieuse (auth_time ancien ou absent) → REAUTH_NOT_RECENT, aucune preuve ; authentification récente → preuve', async () => {
    const s = await socialOnly('google');
    for (const authAgeS of [3600, null]) {
      const back = await providerReauth(s.b, 'google', { ...s.user, authAgeS });
      expect(lastAuthorize).toMatchObject({ prompt: 'login', maxAge: '300' });
      expect(loc(back).searchParams.get('code')).toBe('REAUTH_NOT_RECENT');
      expect(await proofs(s.userId)).toHaveLength(0);
    }
    const ok = await providerReauth(s.b, 'google', { ...s.user, authAgeS: 20 });
    expect(loc(ok).searchParams.get('securite')).toBe('reauth');
    expect(await proofs(s.userId)).toEqual([{ method: 'google' }]);
    const failed = await sql<{ details: string | Record<string, unknown> }[]>`
      SELECT details FROM user_activity_log WHERE user_id = ${s.userId} AND activity_type = 'REAUTH_FAILED'`;
    expect(failed.map((f) => (typeof f.details === 'string' ? JSON.parse(f.details) : f.details).reason)).toContain('not_recent');
  });

  it('P2 Apple : auth_time récent exigé (pas d’équivalent prompt=login) ; ancien ou absent → refus ; autre subject → refus', async () => {
    const s = await socialOnly('apple');
    for (const authAgeS of [900, null]) {
      const back = await providerReauth(s.b, 'apple', { ...s.user, authAgeS });
      expect(loc(back).searchParams.get('code')).toBe('REAUTH_NOT_RECENT');
    }
    expect(await proofs(s.userId)).toHaveLength(0);
    const wrong = await providerReauth(s.b, 'apple', { sub: uid('autre-apple'), email: s.email });
    expect(loc(wrong).searchParams.get('code')).toBe('REAUTH_SUBJECT_MISMATCH');
    expect(await proofs(s.userId)).toHaveLength(0);
    const ok = await providerReauth(s.b, 'apple', { ...s.user, authAgeS: 5 });
    expect(loc(ok).searchParams.get('securite')).toBe('reauth');
    expect(await proofs(s.userId)).toEqual([{ method: 'apple' }]);
  });

  it('P2 la connexion (hors réauthentification) n’exige pas auth_time : une session Google existante suffit pour SE CONNECTER', async () => {
    const s = await socialOnly('google');
    expect(loc(await social(new Browser(), 'google', { ...s.user, authAgeS: 86_400 })).pathname).toBe('/accueil');
    expect(lastAuthorize).toMatchObject({ prompt: 'select_account', maxAge: null });
  });

  // ── Q11 ───────────────────────────────────────────────────────────────────

  it('Q11 adresse en pause D1 (attaque distribuée) : la connexion Google déjà liée reste possible', async () => {
    const r = await R();
    const local = await localAccount();
    const b = new Browser();
    expect(b.absorb(await r.login.POST(b.req('/api/auth/login', { method: 'POST', body: { email: local.email, password: PASSWORD } }))).status).toBe(200);
    const g = b.absorb(await r.link.POST(b.req('/api/users/me/auth-identities/google/link', { method: 'POST', body: { currentPassword: PASSWORD } }), p('google')));
    const google: FakeUser = { sub: uid('q11'), email: `${uid('perso')}@test.invalid` };
    expect(loc(await providerReturn(b, 'google', (await g.json()).redirectUrl, google)).searchParams.get('securite')).toBe('linked');

    for (let i = 0; i < 10; i++) await r.login.POST(new Browser().req('/api/auth/login', { method: 'POST', body: { email: local.email, password: 'Faux-123!' } }));
    const nouvel = new Browser();
    expect((await r.login.POST(nouvel.req('/api/auth/login', { method: 'POST', body: { email: local.email, password: PASSWORD } }))).status).toBe(429);
    expect(loc(await social(nouvel, 'google', google)).pathname).toBe('/accueil');
    expect(nouvel.jar.get('access_token')).toBeTruthy();
  });
});
