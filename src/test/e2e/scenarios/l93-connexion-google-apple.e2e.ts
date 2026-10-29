/**
 * Lot 93 — connexion Google / Apple (CDC 18 sous-lot B) : PostgreSQL réel,
 * vraies routes, faux fournisseur OIDC LOCAL (`../fake-oidc.ts`, aucun appel
 * réseau). Scénarios §39 : E2E-06 à E2E-13, E2E-19 à E2E-23, plus conflits
 * §8.3, statuts §9.4, code d'adresse §37, journal §23 et activation.
 *
 * Le « navigateur » garde ses cookies (jar) et son adresse IP ; le retour
 * Apple `form_post` est rejoué SANS cookie (requête inter-sites), puis repris
 * en GET avec les cookies, comme dans un vrai navigateur (SameSite=Lax).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { createFakeOidc, type FakeUser } from '../fake-oidc';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'MotDePasseL93!x';
const fake = createFakeOidc();
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(fake.env)) { saved[k] = process.env[k]; process.env[k] = v; }

type Provider = 'google' | 'apple';
type WithCookies = Response & { cookies: { getAll(): Array<{ name: string; value: string; maxAge?: number }>; get(n: string): { value: string } | undefined } };

class Browser {
  jar = new Map<string, string>();
  ip = `93.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  req(path: string, init: { method?: string; body?: unknown; form?: Record<string, string>; noCookies?: boolean; origin?: string } = {}) {
    const headers: Record<string, string> = { origin: init.origin ?? ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': 'Mozilla/5.0 e2e' };
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
const setCookie = (res: Response, name: string) => (res as unknown as WithCookies).cookies.get(name)?.value;
const p = (provider: string) => ({ params: Promise.resolve({ provider }) });

scenario('L93', 'Connexion Google / Apple — CDC 18 §7.2, §8, §9, §10.2, §12, §25, §39', ({ sql }) => {
  const R = async () => ({
    start: await import('@/app/api/auth/oauth/[provider]/start/route'),
    callback: await import('@/app/api/auth/oauth/[provider]/callback/route'),
    pending: await import('@/app/api/auth/oauth/pending/route'),
    providers: await import('@/app/api/auth/oauth/providers/route'),
    identities: await import('@/app/api/users/me/auth-identities/route'),
    identity: await import('@/app/api/users/me/auth-identities/[provider]/route'),
    link: await import('@/app/api/users/me/auth-identities/[provider]/link/route'),
    reauth: await import('@/app/api/users/me/auth-identities/[provider]/reauth/route'),
    password: await import('@/app/api/users/me/password/route'),
    login: await import('@/app/api/auth/login/route'),
    forgot: await import('@/app/api/auth/forgot-password/route'),
    deletion: await import('@/app/api/users/me/deletion/route'),
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

  /** Compte local (mot de passe) avec compte métier. */
  async function localAccount(email = `${uid('loc')}@test.invalid`) {
    const [u] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, status, is_active, first_name, last_name)
      VALUES (${email}, ${await bcrypt.hash(PASSWORD, 4)}, 'ACTIVE', true, 'Local', 'Titulaire') RETURNING id`;
    const [a] = await sql<{ id: number }[]>`INSERT INTO accounts (name, owner_user_id) VALUES (${uid('compte')}, ${u.id}) RETURNING id`;
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${a.id}, ${u.id}, 'owner', 'active')`;
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status) VALUES (${a.id}, 'standard', 'active')`;
    return { id: u.id, email, accountId: a.id };
  }

  /** Parcours fournisseur complet depuis /start (login / inscription). Rend la réponse finale du retour. */
  async function social(b: Browser, provider: Provider, user: FakeUser, query: Record<string, string> = {}) {
    const r = await R();
    const q = new URLSearchParams({ intent: 'login', ...query });
    const start = b.absorb(await r.start.GET(b.req(`/api/auth/oauth/${provider}/start?${q}`), p(provider)));
    expect(start.status).toBe(302);
    return providerReturn(b, provider, start.headers.get('location')!, user);
  }

  /** Page du fournisseur puis retour vers Verebona (Apple : form_post sans cookie, puis GET). */
  async function providerReturn(b: Browser, provider: Provider, providerUrl: string, user: FakeUser, extra: Record<string, string> = {}) {
    const r = await R();
    const a = fake.authorize(providerUrl, user);
    expect(a.redirectUri).toBe(`${ORIGIN}/api/auth/oauth/${provider}/callback`);
    if (provider === 'google') {
      const q = new URLSearchParams({ state: a.state, code: a.code, ...extra });
      return b.absorb(await r.callback.GET(b.req(`/api/auth/oauth/google/callback?${q}`), p('google')));
    }
    const form: Record<string, string> = { state: a.state, code: a.code, ...extra };
    if (a.appleUser) form.user = a.appleUser;
    const post = await r.callback.POST(b.req('/api/auth/oauth/apple/callback', { method: 'POST', form, noCookies: true, origin: 'https://appleid.apple.com' }), p('apple'));
    expect(post.status).toBe(303);
    const resume = loc(post);
    if (resume.pathname !== '/api/auth/oauth/apple/callback') return post;
    return b.absorb(await r.callback.GET(b.req(`${resume.pathname}${resume.search}`), p('apple')));
  }

  async function pending(b: Browser, body?: Record<string, unknown>) {
    const r = await R();
    const res = b.absorb(body
      ? await r.pending.POST(b.req('/api/auth/oauth/pending', { method: 'POST', body }))
      : await r.pending.GET(b.req('/api/auth/oauth/pending')));
    return { res, status: res.status, body: await res.json() as Record<string, any> };
  }

  /** Compte « social-only » créé par le vrai parcours d'inscription. */
  async function socialOnly(provider: Provider, over: Partial<FakeUser> = {}) {
    const b = new Browser();
    const email = provider === 'apple' && over.privateRelay ? `${uid('rel')}@privaterelay.appleid.com` : `${uid(provider)}@test.invalid`;
    const user: FakeUser = { sub: uid(`${provider}-sub`), email, givenName: 'Sam', familyName: 'Social', appleName: { firstName: 'Sam', lastName: 'Social' }, ...over };
    const cb = await social(b, provider, user, { intent: 'signup' });
    expect(loc(cb).pathname).toBe('/connexion-sociale');
    const done = await pending(b, { action: 'signup', firstName: 'Sam', lastName: 'Social', email: user.email, acceptedTerms: true, termsVersion: await cgvu() });
    expect(done.status).toBe(200);
    const [u] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${user.email!}`;
    return { b, user, userId: u.id, email: user.email! };
  }

  async function localSession(email: string) {
    const r = await R();
    const b = new Browser();
    const res = b.absorb(await r.login.POST(b.req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } })));
    expect(res.status).toBe(200);
    return b;
  }

  /** Réauthentification par un fournisseur lié (Mon compte › Sécurité). */
  async function providerReauth(b: Browser, provider: Provider, user: FakeUser) {
    const r = await R();
    const s = b.absorb(await r.reauth.POST(b.req(`/api/users/me/auth-identities/${provider}/reauth`, { method: 'POST', body: { resume: 'add-password' } }), p(provider)));
    expect(s.status).toBe(200);
    const { redirectUrl } = await s.json();
    return providerReturn(b, provider, redirectUrl, user);
  }

  // ── Activation ────────────────────────────────────────────────────────────

  it('L93-ACT boutons et routes : actifs avec les variables, 404 et boutons masqués sans elles', async () => {
    const r = await R();
    expect(await (await r.providers.GET()).json()).toEqual({ google: true, apple: true });
    const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    try {
      expect(await (await r.providers.GET()).json()).toEqual({ google: false, apple: true });
      const b = new Browser();
      expect((await r.start.GET(b.req('/api/auth/oauth/google/start'), p('google'))).status).toBe(404);
      expect((await r.callback.GET(b.req('/api/auth/oauth/google/callback?state=x&code=y'), p('google'))).status).toBe(404);
      expect((await r.start.GET(b.req('/api/auth/oauth/facebook/start'), p('facebook'))).status).toBe(404);
    } finally {
      process.env.GOOGLE_OAUTH_CLIENT_ID = id;
    }
  });

  // ── E2E-06 ────────────────────────────────────────────────────────────────

  it('E2E-06 inscription Google : choix compte existant / nouveau → profil + CGSU → compte social-only + identité + session ; rien avant la validation', async () => {
    const b = new Browser();
    const email = `${uid('g06')}@test.invalid`;
    const user = { sub: uid('g06-sub'), email, givenName: 'Gaspard', familyName: 'Nouveau' };
    const cb = await social(b, 'google', user, { intent: 'signup', ref: 'NOPE42' });
    expect(loc(cb).pathname).toBe('/connexion-sociale');
    expect(setCookie(cb, 'access_token')).toBeUndefined();
    expect(await sql`SELECT 1 FROM users WHERE email = ${email}`).toHaveLength(0); // SIGN-02
    const st = await pending(b);
    expect(st.body).toMatchObject({ provider: 'google', stage: 'choice', firstName: 'Gaspard', lastName: 'Nouveau', providerEmail: email, referralCode: 'NOPE42' });

    const refus = await pending(b, { action: 'signup', firstName: 'Gaspard', lastName: 'Nouveau', email, acceptedTerms: false });
    expect(refus.body.code).toBe('TERMS_NOT_ACCEPTED');
    const termsVersion = await cgvu();
    const done = await pending(b, { action: 'signup', firstName: 'Gaspard', lastName: 'Modifié', email, acceptedTerms: true, termsVersion });
    expect(done.status).toBe(200);
    expect(done.body.redirectTo).toBe('/accueil');
    expect(setCookie(done.res, 'access_token')).toBeTruthy();
    expect(setCookie(done.res, 'refresh_token')).toBeTruthy();

    const [u] = await sql<{ id: number; password_hash: string | null; is_active: boolean; terms_version: string; last_name: string }[]>`
      SELECT id, password_hash, is_active, terms_version, last_name FROM users WHERE email = ${email}`;
    expect(u).toMatchObject({ password_hash: null, is_active: true, terms_version: termsVersion, last_name: 'Modifié' }); // SEC-01, SIGN-03/04
    const ids = await sql`SELECT provider, issuer, subject, email_verified FROM auth_identities WHERE user_id = ${u.id}`;
    expect(ids).toEqual([{ provider: 'google', issuer: 'https://accounts.google.com', subject: user.sub, email_verified: true }]);
    expect(await sql`SELECT 1 FROM accounts WHERE owner_user_id = ${u.id}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM legal_acceptances WHERE user_id = ${u.id}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM trial_grants WHERE email_normalized = ${email}`).toHaveLength(1);
    // Rejouer l'étape terminée : rien (usage unique).
    expect((await pending(b)).status).toBe(410);

    // LOGIN-02 : connexion Google suivante, sans 2FA, même utilisateur.
    const b2 = new Browser();
    const again = await social(b2, 'google', user);
    expect(loc(again).pathname).toBe('/accueil');
    expect(setCookie(again, 'access_token')).toBeTruthy();
    const [{ last_login_at }] = await sql<{ last_login_at: Date | null }[]>`SELECT last_login_at FROM users WHERE id = ${u.id}`;
    expect(last_login_at).not.toBeNull();
  });

  // ── E2E-07 ────────────────────────────────────────────────────────────────

  it('E2E-07 Google avec l’adresse d’un compte local : création interdite, aucun rattachement automatique, authentification complète puis association', async () => {
    const local = await localAccount();
    const b = new Browser();
    const user = { sub: uid('g07'), email: local.email };
    const cb = await social(b, 'google', user, { intent: 'signup' });
    expect(loc(cb).pathname).toBe('/connexion-sociale');
    expect(await sql`SELECT 1 FROM auth_identities WHERE subject = ${user.sub}`).toHaveLength(0); // LOGIN-04
    expect((await pending(b)).body.stage).toBe('existing_email');
    const dup = await pending(b, { action: 'signup', firstName: 'X', lastName: 'Y', email: local.email, acceptedTerms: true });
    expect(dup).toMatchObject({ status: 409, body: { code: 'ACCOUNT_ALREADY_EXISTS' } }); // SIGN-06
    expect(await sql`SELECT 1 FROM users WHERE email = ${local.email}`).toHaveLength(1);
    const bad = await pending(b, { action: 'link-password', email: local.email, password: 'mauvais' });
    expect(bad).toMatchObject({ status: 401, body: { code: 'INVALID_CREDENTIALS' } });
    const ok = await pending(b, { action: 'link-password', email: local.email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(setCookie(ok.res, 'access_token')).toBeTruthy();
    expect(await sql`SELECT user_id FROM auth_identities WHERE subject = ${user.sub}`).toEqual([{ user_id: local.id }]);
    expect(await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${local.id} AND event_type = 'AUTH_IDENTITY_LINKED'`).toHaveLength(1); // NOTIF-01
    const login = await social(new Browser(), 'google', user);
    expect(loc(login).pathname).toBe('/accueil');
  });

  // ── E2E-08 ────────────────────────────────────────────────────────────────

  it('E2E-08 Apple Hide My Email + compte existant avec une autre adresse : « J’ai déjà un compte » → association ; l’adresse relais ne devient pas l’adresse principale', async () => {
    const local = await localAccount();
    const b = new Browser();
    const relay = `${uid('hme')}@privaterelay.appleid.com`;
    const user: FakeUser = { sub: uid('a08'), email: relay, privateRelay: true, appleName: { firstName: 'Léa', lastName: 'Martin' } };
    const cb = await social(b, 'apple', user, { intent: 'login' });
    expect(loc(cb).pathname).toBe('/connexion-sociale');
    const st = await pending(b);
    expect(st.body).toMatchObject({ provider: 'apple', stage: 'choice', isPrivateRelay: true, firstName: 'Léa' });
    const ok = await pending(b, { action: 'link-password', email: local.email, password: PASSWORD });
    expect(ok.status).toBe(200);
    const [id] = await sql<{ user_id: number; is_private_relay: boolean }[]>`SELECT user_id, is_private_relay FROM auth_identities WHERE subject = ${user.sub}`;
    expect(id).toEqual({ user_id: local.id, is_private_relay: true });
    expect(await sql`SELECT email FROM users WHERE id = ${local.id}`).toEqual([{ email: local.email }]); // SIGN-10
    // Jeton Apple conservé CHIFFRÉ (révocation), jamais en clair.
    const [{ c }] = await sql<{ c: string }[]>`SELECT refresh_token_ciphertext AS c FROM auth_identities WHERE subject = ${user.sub}`;
    expect(c).toMatch(/^v1\./);
    expect(c).not.toContain('apple-rt-');
  });

  // ── E2E-09 ────────────────────────────────────────────────────────────────

  it('E2E-09 compte social-only : Sécurité → réauthentification Google (même subject) → ajout du mot de passe → connexion locale', async () => {
    const r = await R();
    const s = await socialOnly('google');
    const before = await r.password.POST(s.b.req('/api/users/me/password', { method: 'POST', body: { newPassword: 'NouveauMdp93!' } }));
    expect(before.status).toBe(403);
    expect((await before.json()).code).toBe('REAUTH_REQUIRED');

    // Un autre compte Google ne vaut pas réauthentification (REAUTH-04).
    const wrong = await providerReauth(s.b, 'google', { sub: uid('autre'), email: s.email });
    expect(loc(wrong).searchParams.get('code')).toBe('REAUTH_SUBJECT_MISMATCH');
    // Preuve SERVEUR du lot 92 (`reauth_proofs`), jamais un cookie.
    expect(await sql`SELECT 1 FROM reauth_proofs WHERE user_id = ${s.userId}`).toHaveLength(0);

    const back = await providerReauth(s.b, 'google', s.user);
    expect(loc(back).pathname).toBe('/mon-compte/informations');
    expect(loc(back).searchParams.get('securite')).toBe('reauth');
    expect(await sql`SELECT method FROM reauth_proofs WHERE user_id = ${s.userId} AND consumed_at IS NULL`).toEqual([{ method: 'google' }]);
    const summary = await (await r.identities.GET(s.b.req('/api/users/me/auth-identities'))).json();
    expect(summary).toMatchObject({ password: { configured: false }, reauth: { fresh: true, method: 'google' }, providers: { google: { linked: true, canUnlink: false } } });

    const weak = await r.password.POST(s.b.req('/api/users/me/password', { method: 'POST', body: { newPassword: 'faible' } }));
    expect(weak.status).toBe(400);
    const ok = await r.password.POST(s.b.req('/api/users/me/password', { method: 'POST', body: { newPassword: 'NouveauMdp93!' } }));
    expect(ok.status).toBe(200);
    const twice = await r.password.POST(s.b.req('/api/users/me/password', { method: 'POST', body: { newPassword: 'AutreMdp93!x' } }));
    expect(twice.status).toBe(409); // PWD-04 : il se modifie, ne se recrée pas
    const login = await r.login.POST(new Browser().req('/api/auth/login', { method: 'POST', body: { email: s.email, password: 'NouveauMdp93!' } }));
    expect(login.status).toBe(200);
    expect(await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${s.userId} AND event_type = 'PASSWORD_CHANGED'`).toHaveLength(1);
  });

  // ── E2E-10 ────────────────────────────────────────────────────────────────

  it('E2E-10 mot de passe oublié d’un compte social-only : écran neutre, e-mail « connectez-vous avec Google », aucun mot de passe créé ; le BO non plus', async () => {
    const r = await R();
    const s = await socialOnly('google');
    const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
    const res = await r.forgot.POST(new Browser().req('/api/auth/forgot-password', { method: 'POST', body: { email: s.email } }));
    const neutral = await r.forgot.POST(new Browser().req('/api/auth/forgot-password', { method: 'POST', body: { email: `${uid('inconnu')}@test.invalid` } }));
    expect(await res.json()).toEqual(await neutral.json()); // PWD-06
    await settleDetachedAuthTasks();
    const mails = await sql<{ template_code: string; metadata: string }[]>`SELECT template_code, metadata FROM email_logs WHERE recipient_user_id = ${s.userId} AND template_code LIKE 'PASSWORD_RESET%'`;
    expect(mails.map((m) => m.template_code)).toEqual(['PASSWORD_RESET_SOCIAL_ONLY']);
    expect(JSON.parse(mails[0].metadata)).toMatchObject({ providers: 'Google' });
    expect(await sql`SELECT password_hash FROM users WHERE id = ${s.userId}`).toEqual([{ password_hash: null }]); // PWD-07
    const { startPasswordResetForUser } = await import('@/services/auth/password-reset.service');
    expect(await startPasswordResetForUser(s.userId)).toMatchObject({ status: 'no_local_password' }); // INT-07
  });

  // ── E2E-11 ────────────────────────────────────────────────────────────────

  it('E2E-11 dissociation de la dernière méthode : refus LAST_LOGIN_METHOD côté serveur, identité conservée', async () => {
    const r = await R();
    const s = await socialOnly('google');
    const noProof = await r.identity.DELETE(s.b.req('/api/users/me/auth-identities/google', { method: 'DELETE', body: {} }), p('google'));
    expect(noProof.status).toBe(403);
    await providerReauth(s.b, 'google', s.user);
    const res = await r.identity.DELETE(s.b.req('/api/users/me/auth-identities/google', { method: 'DELETE', body: {} }), p('google'));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('LAST_LOGIN_METHOD');
    expect(await sql`SELECT 1 FROM auth_identities WHERE user_id = ${s.userId}`).toHaveLength(1);
  });

  // ── E2E-12 ────────────────────────────────────────────────────────────────

  it('E2E-12 multi-fournisseurs : compte local → lier Google (mot de passe) puis Apple (preuve 5 min) → connexion par chacun = même utilisateur ; dissociation Apple révoquée chez Apple', async () => {
    const r = await R();
    const local = await localAccount();
    const b = await localSession(local.email);
    const noProof = await r.link.POST(b.req('/api/users/me/auth-identities/google/link', { method: 'POST', body: {} }), p('google'));
    expect(noProof.status).toBe(403);
    const badPwd = await r.link.POST(b.req('/api/users/me/auth-identities/google/link', { method: 'POST', body: { currentPassword: 'faux' } }), p('google'));
    expect(badPwd.status).toBe(401);
    const g = b.absorb(await r.link.POST(b.req('/api/users/me/auth-identities/google/link', { method: 'POST', body: { currentPassword: PASSWORD } }), p('google')));
    expect(g.status).toBe(200);
    const google: FakeUser = { sub: uid('g12'), email: `${uid('perso')}@test.invalid` };
    const gBack = await providerReturn(b, 'google', (await g.json()).redirectUrl, google);
    expect(loc(gBack).searchParams.get('securite')).toBe('linked');

    // Lot 96A (Q7) : l'association de Google est un changement d'identifiant — la preuve
    // émise par le mot de passe est retirée ; une nouvelle confirmation est exigée.
    const sansPreuve = await r.link.POST(b.req('/api/users/me/auth-identities/apple/link', { method: 'POST', body: {} }), p('apple'));
    expect(sansPreuve.status).toBe(403);
    const a = b.absorb(await r.link.POST(b.req('/api/users/me/auth-identities/apple/link', { method: 'POST', body: { currentPassword: PASSWORD } }), p('apple')));
    expect(a.status).toBe(200);
    const apple: FakeUser = { sub: uid('a12'), email: `${uid('rel')}@privaterelay.appleid.com`, privateRelay: true };
    const aBack = await providerReturn(b, 'apple', (await a.json()).redirectUrl, apple);
    expect(loc(aBack).searchParams.get('securite')).toBe('linked');

    expect(await sql`SELECT provider FROM auth_identities WHERE user_id = ${local.id} ORDER BY provider`).toEqual([{ provider: 'apple' }, { provider: 'google' }]);
    for (const [prov, u] of [['google', google], ['apple', apple]] as const) {
      const lb = new Browser();
      const res = await social(lb, prov, u);
      expect(loc(res).pathname).toBe('/accueil');
      const { verifyAccessToken } = await import('@/lib/jwt');
      expect((await verifyAccessToken(lb.jar.get('access_token')!))?.userId).toBe(local.id);
    }
    expect(await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${local.id} AND event_type = 'AUTH_IDENTITY_LINKED'`).toHaveLength(2);

    const un = await r.identity.DELETE(b.req('/api/users/me/auth-identities/apple', { method: 'DELETE', body: { currentPassword: PASSWORD } }), p('apple'));
    expect(un.status).toBe(200);
    const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
    await settleDetachedAuthTasks();
    expect(fake.revoked).toContain(`apple-rt-${apple.sub}`);
    expect(await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${local.id} AND event_type = 'AUTH_IDENTITY_UNLINKED'`).toHaveLength(1);
  });

  // ── E2E-13 (partiel) ──────────────────────────────────────────────────────

  it('E2E-13 changement de l’adresse principale : Google reste lié (subject stable), connexion locale avec la nouvelle adresse', async () => {
    // Le parcours de changement d'adresse (§11.3) est livré par le sous-lot 92 ;
    // la bascule est simulée ici par sa conséquence en base.
    const local = await localAccount();
    const b = await localSession(local.email);
    const r = await R();
    const g = b.absorb(await r.link.POST(b.req('/api/users/me/auth-identities/google/link', { method: 'POST', body: { currentPassword: PASSWORD } }), p('google')));
    const google: FakeUser = { sub: uid('g13'), email: `${uid('g13m')}@test.invalid` };
    await providerReturn(b, 'google', (await g.json()).redirectUrl, google);
    const nouvelle = `${uid('nouvelle')}@test.invalid`;
    await sql`UPDATE users SET email = ${nouvelle} WHERE id = ${local.id}`;
    const login = await social(new Browser(), 'google', { ...google, email: `${uid('change-chez-google')}@test.invalid` });
    expect(loc(login).pathname).toBe('/accueil'); // §9.4 adresse fournisseur changée : même compte
    expect((await r.login.POST(new Browser().req('/api/auth/login', { method: 'POST', body: { email: nouvelle, password: PASSWORD } }))).status).toBe(200);
  });

  // ── §8.3 ──────────────────────────────────────────────────────────────────

  it('§8.3 identité déjà liée à un autre utilisateur : refus, rien n’est déplacé', async () => {
    const s = await socialOnly('google');
    const autre = await localAccount();
    const b = await localSession(autre.email);
    const r = await R();
    const g = b.absorb(await r.link.POST(b.req('/api/users/me/auth-identities/google/link', { method: 'POST', body: { currentPassword: PASSWORD } }), p('google')));
    const back = await providerReturn(b, 'google', (await g.json()).redirectUrl, s.user);
    expect(loc(back).searchParams.get('code')).toBe('OAUTH_IDENTITY_ALREADY_LINKED');
    expect(await sql`SELECT user_id FROM auth_identities WHERE subject = ${s.user.sub}`).toEqual([{ user_id: s.userId }]);
    expect(await sql`SELECT 1 FROM auth_identities WHERE user_id = ${autre.id}`).toHaveLength(0);
  });

  // ── E2E-19 ────────────────────────────────────────────────────────────────

  it('E2E-19 invitation + Google : contexte conservé côté serveur, adhésion au compte partagé, ni compte personnel ni essai ; autre adresse refusée', async () => {
    const owner = await localAccount();
    const invited = `${uid('invite')}@test.invalid`;
    const token = uid('invtok');
    await sql`INSERT INTO account_memberships (account_id, role, status, invited_email, invite_token, invite_token_expires_at)
              VALUES (${owner.accountId}, 'member', 'pending', ${invited}, ${token}, now() + interval '7 days')`;
    // Adresse différente de l'invitation : refus (§24, §37).
    const bad = new Browser();
    await social(bad, 'google', { sub: uid('g19x'), email: `${uid('autre')}@test.invalid` }, { intent: 'signup', inviteToken: token });
    const refus = await pending(bad, { action: 'signup', firstName: 'I', lastName: 'X', email: `${uid('autre')}@test.invalid`, acceptedTerms: true });
    expect([403, 200]).toContain(refus.status);
    if (refus.status === 200) expect(refus.body.stage).toBe('email_code');

    const b = new Browser();
    const user = { sub: uid('g19'), email: invited };
    const cb = await social(b, 'google', user, { intent: 'signup', inviteToken: token });
    expect(loc(cb).pathname).toBe('/connexion-sociale');
    expect((await pending(b)).body.context).toBe('invitation');
    const done = await pending(b, { action: 'signup', firstName: 'Ines', lastName: 'Invitee', email: invited, acceptedTerms: true, termsVersion: await cgvu() });
    expect(done.status).toBe(200);
    const [u] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${invited}`;
    expect(await sql`SELECT status FROM account_memberships WHERE invite_token IS NULL AND user_id = ${u.id} AND account_id = ${owner.accountId}`).toEqual([{ status: 'active' }]);
    expect(await sql`SELECT 1 FROM accounts WHERE owner_user_id = ${u.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM trial_grants WHERE email_normalized = ${invited}`).toHaveLength(0);
  });

  // ── E2E-20 ────────────────────────────────────────────────────────────────

  it('E2E-20 transmission + Apple (pré-lancement) : inscription fermée sans jeton ; avec le jeton de transmission, compte créé et transmission intacte, à accepter après la session', async () => {
    const prev = process.env.SIGNUP_MODE;
    process.env.SIGNUP_MODE = 'prelaunch';
    try {
      const closed = new Browser();
      const relay = `${uid('a20')}@test.invalid`;
      await social(closed, 'apple', { sub: uid('a20x'), email: relay }, { intent: 'signup' });
      const refus = await pending(closed, { action: 'signup', firstName: 'T', lastName: 'R', email: relay, acceptedTerms: true });
      expect(refus).toMatchObject({ status: 403, body: { code: 'SIGNUP_CLOSED' } });

      const owner = await localAccount();
      const [asset] = await sql<{ id: number }[]>`INSERT INTO assets (user_id, account_id, category, name) VALUES (${owner.id}, ${owner.accountId}, 'VEHICULE', 'Voiture transmise') RETURNING id`;
      const recipient = `${uid('dest')}@test.invalid`;
      const token = uid('trtok');
      await sql`INSERT INTO asset_transmissions (asset_id, account_id, initiator_user_id, recipient_email, token, status)
                VALUES (${asset.id}, ${owner.accountId}, ${owner.id}, ${recipient}, ${token}, 'pending')`;
      const b = new Browser();
      const user: FakeUser = { sub: uid('a20'), email: recipient, appleName: { firstName: 'Tom', lastName: 'Receveur' } };
      await social(b, 'apple', user, { intent: 'signup', transmissionToken: token });
      expect((await pending(b)).body).toMatchObject({ context: 'transmission', firstName: 'Tom' });
      const done = await pending(b, { action: 'signup', firstName: 'Tom', lastName: 'Receveur', email: recipient, acceptedTerms: true, termsVersion: await cgvu() });
      expect(done.status).toBe(200);
      expect(setCookie(done.res, 'access_token')).toBeTruthy();
      const [u] = await sql<{ id: number; is_active: boolean }[]>`SELECT id, is_active FROM users WHERE email = ${recipient}`;
      expect(u.is_active).toBe(true);
      expect(await sql`SELECT provider FROM auth_identities WHERE user_id = ${u.id}`).toEqual([{ provider: 'apple' }]);
      // Transmission intacte : elle est acceptée après la première session par le
      // mécanisme existant (page de transmission / accueil, jeton conservé par
      // le navigateur avant le départ vers Apple) — jamais consommée par l'inscription.
      expect(await sql`SELECT status FROM asset_transmissions WHERE token = ${token}`).toEqual([{ status: 'pending' }]);
    } finally {
      if (prev === undefined) delete process.env.SIGNUP_MODE; else process.env.SIGNUP_MODE = prev;
    }
  });

  // ── E2E-21 / statuts §9.4 ─────────────────────────────────────────────────

  it('E2E-21 compte en suppression via Google : écran restreint uniquement ; suspendu : refus sans session', async () => {
    const s = await socialOnly('google');
    await sql`UPDATE users SET status = 'PENDING_DELETION' WHERE id = ${s.userId}`;
    const res = await social(new Browser(), 'google', s.user);
    expect(loc(res).pathname).toBe('/compte-en-suppression');
    expect(setCookie(res, 'access_token')).toBeTruthy();

    await sql`UPDATE users SET status = 'SUSPENDED' WHERE id = ${s.userId}`;
    const sus = await social(new Browser(), 'google', s.user);
    expect(loc(sus).searchParams.get('social_error')).toBe('ACCOUNT_SUSPENDED');
    expect(setCookie(sus, 'access_token')).toBeUndefined();
  });

  // ── E2E-22 ────────────────────────────────────────────────────────────────

  it('E2E-22 suppression d’un compte social-only : réauthentification Apple + texte de confirmation → clôture, autres sessions révoquées, autorisation Apple révoquée', async () => {
    const r = await R();
    const s = await socialOnly('apple', { privateRelay: true });
    const other = new Browser();
    await social(other, 'apple', s.user); // une seconde session
    const conf = 'SUPPRIMER MON COMPTE';
    const noProof = await r.deletion.POST(s.b.req('/api/users/me/deletion', { method: 'POST', body: { confirmation: conf } }));
    expect(noProof.status).toBe(403);
    expect((await noProof.json()).error).toBe('REAUTH_REQUIRED');
    await providerReauth(s.b, 'apple', s.user);
    const ok = s.b.absorb(await r.deletion.POST(s.b.req('/api/users/me/deletion', { method: 'POST', body: { confirmation: conf } })));
    expect(ok.status).toBe(200);
    expect(await sql`SELECT status FROM users WHERE id = ${s.userId}`).toEqual([{ status: 'PENDING_DELETION' }]);
    const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
    await settleDetachedAuthTasks();
    expect(fake.revoked).toContain(`apple-rt-${s.user.sub}`);
    expect(await sql`SELECT refresh_token_ciphertext FROM auth_identities WHERE user_id = ${s.userId}`).toEqual([{ refresh_token_ciphertext: null }]);
    const { SessionService } = await import('@/lib/session-service');
    await expect(SessionService.getSession(other.req('/api/users/me'))).rejects.toThrow();
  });

  // ── E2E-23 et sécurité du retour ──────────────────────────────────────────

  it('E2E-23 retour rejoué, autre navigateur, annulation, nonce faux : refus sans session ni création', async () => {
    const r = await R();
    const s = await socialOnly('google');
    const b = new Browser();
    const start = b.absorb(await r.start.GET(b.req('/api/auth/oauth/google/start?intent=login'), p('google')));
    const a = fake.authorize(start.headers.get('location')!, s.user);
    const url = `/api/auth/oauth/google/callback?${new URLSearchParams({ state: a.state, code: a.code })}`;
    const first = b.absorb(await r.callback.GET(b.req(url), p('google')));
    expect(loc(first).pathname).toBe('/accueil');
    b.jar.delete('access_token');
    const replay = await r.callback.GET(b.req(url), p('google'));
    expect(loc(replay).searchParams.get('social_error')).toBe('OAUTH_STATE_INVALID');
    expect(setCookie(replay, 'access_token')).toBeUndefined();

    // Retour présenté par un AUTRE navigateur (liaison absente) : refus, et la transaction est brûlée.
    const victim = new Browser();
    const st2 = victim.absorb(await r.start.GET(victim.req('/api/auth/oauth/google/start?intent=login'), p('google')));
    const a2 = fake.authorize(st2.headers.get('location')!, s.user);
    const url2 = `/api/auth/oauth/google/callback?${new URLSearchParams({ state: a2.state, code: a2.code })}`;
    const attacker = await r.callback.GET(new Browser().req(url2), p('google'));
    expect(loc(attacker).searchParams.get('social_error')).toBe('OAUTH_STATE_INVALID');
    expect(loc(await r.callback.GET(victim.req(url2), p('google'))).searchParams.get('social_error')).toBe('OAUTH_STATE_INVALID');

    // Annulation chez le fournisseur : rien de créé (SIGN-11).
    const c = new Browser();
    const st3 = c.absorb(await r.start.GET(c.req('/api/auth/oauth/google/start?intent=signup'), p('google')));
    const a3 = fake.authorize(st3.headers.get('location')!, { sub: uid('annule'), email: `${uid('annule')}@test.invalid` });
    const cancelled = await r.callback.GET(c.req(`/api/auth/oauth/google/callback?${new URLSearchParams({ state: a3.state, error: 'access_denied' })}`), p('google'));
    expect(loc(cancelled).pathname).toBe('/signup');
    expect(loc(cancelled).searchParams.get('social_error')).toBe('OAUTH_CANCELLED');

    // Nonce faux (jeton rejoué d'un autre parcours) : refus.
    const n = await social(new Browser(), 'google', { ...s.user, nonceOverride: 'autre-nonce' });
    expect(loc(n).searchParams.get('social_error')).toBe('OAUTH_PROVIDER_ERROR');

    // Apple : form_post rejoué → refus.
    const ap = await socialOnly('apple');
    const ab = new Browser();
    const st4 = ab.absorb(await r.start.GET(ab.req('/api/auth/oauth/apple/start?intent=login'), p('apple')));
    const a4 = fake.authorize(st4.headers.get('location')!, ap.user);
    const form = { state: a4.state, code: a4.code };
    const p1 = await r.callback.POST(ab.req('/api/auth/oauth/apple/callback', { method: 'POST', form, noCookies: true, origin: 'https://appleid.apple.com' }), p('apple'));
    expect(loc(p1).pathname).toBe('/api/auth/oauth/apple/callback');
    const p2 = await r.callback.POST(ab.req('/api/auth/oauth/apple/callback', { method: 'POST', form, noCookies: true, origin: 'https://appleid.apple.com' }), p('apple'));
    expect(loc(p2).searchParams.get('social_error')).toBe('OAUTH_STATE_INVALID');
    // La reprise GET sans le cookie de liaison est refusée, puis le vrai navigateur aussi (transaction brûlée).
    expect(loc(await r.callback.GET(new Browser().req(`${loc(p1).pathname}${loc(p1).search}`), p('apple'))).searchParams.get('social_error')).toBe('OAUTH_STATE_INVALID');
  });

  // ── §37 : autre adresse que celle du fournisseur ──────────────────────────

  it('§37 adresse principale différente : code à 6 chiffres (masqué au journal), mauvais code refusé, bon code → compte ; adresse déjà inscrite : même réponse, aucun code valable', async () => {
    const { emailService } = await import('@/lib/email/email-service');
    const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
    const sent: Array<{ templateCode: string; to: string; variables: Record<string, string> }> = [];
    const spy = vi.spyOn(emailService, 'send');
    spy.mockImplementation(async (o) => { sent.push({ templateCode: o.templateCode, to: o.to, variables: o.variables }); return { success: true } as never; });
    try {
      const b = new Browser();
      const relay = `${uid('rel37')}@privaterelay.appleid.com`;
      await social(b, 'apple', { sub: uid('a37'), email: relay, privateRelay: true, appleName: { firstName: 'Ana', lastName: 'Code' } }, { intent: 'signup' });
      const choisie = `${uid('vraie')}@test.invalid`;
      const termsVersion = await cgvu();
      const step = await pending(b, { action: 'signup', firstName: 'Ana', lastName: 'Code', email: choisie, acceptedTerms: true, termsVersion });
      expect(step.body).toMatchObject({ stage: 'email_code', email: choisie });
      expect(await sql`SELECT 1 FROM users WHERE email = ${choisie}`).toHaveLength(0);
      await settleDetachedAuthTasks();
      const mail = sent.find((m) => m.templateCode === 'SOCIAL_SIGNUP_EMAIL_CODE' && m.to === choisie)!;
      expect(mail.variables.code).toMatch(/^\d{6}$/);
      const wrong = await pending(b, { action: 'verify-code', code: mail.variables.code === '000000' ? '111111' : '000000' });
      expect(wrong.status).toBe(400);
      const ok = await pending(b, { action: 'verify-code', code: mail.variables.code });
      expect(ok.status).toBe(200);
      expect(await sql`SELECT is_active, password_hash FROM users WHERE email = ${choisie}`).toEqual([{ is_active: true, password_hash: null }]);

      const local = await localAccount();
      const b2 = new Browser();
      await social(b2, 'google', { sub: uid('g37'), email: `${uid('g37m')}@test.invalid` }, { intent: 'signup' });
      const same = await pending(b2, { action: 'signup', firstName: 'X', lastName: 'Y', email: local.email, acceptedTerms: true, termsVersion });
      expect(same.body).toEqual({ success: true, stage: 'email_code', email: local.email });
      await settleDetachedAuthTasks();
      expect(sent.some((m) => m.templateCode === 'SOCIAL_SIGNUP_EMAIL_CODE' && m.to === local.email)).toBe(false);
      for (const code of ['123456', '654321']) expect((await pending(b2, { action: 'verify-code', code })).status).toBe(400);
      expect(await sql`SELECT 1 FROM auth_identities WHERE user_id = ${local.id}`).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
    // Journal réel des e-mails : le code n'y figure jamais en clair.
    const { redactActionLinks } = await import('@/lib/email/email-service');
    expect(redactActionLinks({ code: '123456' }).code).toBe('[masqué]');
  });

  // ── §23 journal ───────────────────────────────────────────────────────────

  it('§23.1 journal : OAUTH_START, OAUTH_CALLBACK_SUCCESS / FAILED, IDENTITY_LINKED, REAUTH_SUCCESS — sans aucun jeton ni code', async () => {
    const rows = await sql<{ activity_type: string; details: string | null }[]>`
      SELECT activity_type, details FROM user_activity_log
       WHERE activity_type IN ('OAUTH_START', 'OAUTH_CALLBACK_SUCCESS', 'OAUTH_CALLBACK_FAILED', 'IDENTITY_LINKED', 'IDENTITY_UNLINKED', 'REAUTH_SUCCESS', 'SOCIAL_SIGNUP')`;
    const types = new Set(rows.map((r) => r.activity_type));
    for (const t of ['OAUTH_START', 'OAUTH_CALLBACK_SUCCESS', 'OAUTH_CALLBACK_FAILED', 'IDENTITY_LINKED', 'IDENTITY_UNLINKED', 'REAUTH_SUCCESS', 'SOCIAL_SIGNUP']) expect(types).toContain(t);
    const all = rows.map((r) => r.details ?? '').join('\n');
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|code-(google|apple)-|apple-rt-/);
    const tx = await sql<{ code_verifier: string }[]>`SELECT code_verifier FROM auth_transactions WHERE status IN ('consumed', 'failed') LIMIT 50`;
    expect(tx.every((t) => t.code_verifier === '')).toBe(true);
  });
});
