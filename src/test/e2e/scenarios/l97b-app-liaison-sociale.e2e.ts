/**
 * Lot 97B — Mon compte › Sécurité DANS L'APPLICATION : associer Google / Apple
 * et confirmer son identité avec Google / Apple sans jamais faire l'OAuth dans
 * la vue de l'app (PO M1 ; CDC 18 §12.3, §18.2, §21.3). PostgreSQL réel,
 * vraies routes, faux fournisseur OIDC local (aucun réseau).
 *
 * Deux « navigateurs » : la VUE de l'app (cookies de session) et le
 * NAVIGATEUR SYSTÈME (aucun cookie de session).
 *
 *   E1  association depuis l'app : vue → adresse d'ouverture (ticket) →
 *       navigateur système → fournisseur → code d'échange vers l'app →
 *       échange PKCE dans la vue → identité liée à CE compte ; aucune
 *       nouvelle session ; ticket à usage unique ;
 *   E2  confirmation (réauth) Google depuis l'app → preuve 5 min pour la
 *       session de la vue, action reprise (`resume`) ;
 *   E3  refus : vérificateur faux, autre session / autre compte, identité
 *       déjà liée ailleurs, autre subject en réauth, ticket rejoué ou
 *       inconnu → retour à l'app avec une erreur, rien de modifié ;
 *   E4  préalables : réauthentification 5 min exigée pour associer ; défi
 *       invalide ; retour d'app non configuré ; parcours web inchangé.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { createFakeOidc, type FakeUser } from '../fake-oidc';
import { pkceChallenge, randomToken } from '@/lib/auth/oauth/crypto';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'MotDePasseL97b!s';
const APP_RETURN = 'fr.verebona.app.preprod:/oauth';
const fake = createFakeOidc();
const saved: Record<string, string | undefined> = {};
const env = { ...fake.env, APP_OAUTH_RETURN_URL: APP_RETURN };
for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }

type Provider = 'google' | 'apple';
type WithCookies = Response & { cookies: { getAll(): Array<{ name: string; value: string; maxAge?: number }> } };
const UA_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 VerebonaApp/1.4.0 (52; preprod)';
const UA_SYS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

class Browser {
  jar = new Map<string, string>();
  constructor(public ua: string, public ip = `98.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) {}
  req(path: string, init: { method?: string; body?: unknown; form?: Record<string, string>; noCookies?: boolean; origin?: string } = {}) {
    const headers: Record<string, string> = { origin: init.origin ?? ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': this.ua };
    if (!init.noCookies && this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (init.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(init.form).toString(); }
    else if (init.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.body); }
    return new NextRequest(path.startsWith('http') ? path : `${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body });
  }
  absorb<T extends Response>(res: T): T {
    for (const c of (res as unknown as WithCookies).cookies.getAll()) {
      if (!c.value || c.maxAge === 0) this.jar.delete(c.name); else this.jar.set(c.name, c.value);
    }
    return res;
  }
}

const loc = (res: Response) => res.headers.get('location') ?? '';
const p = (provider: string) => ({ params: Promise.resolve({ provider }) });
const appReturn = (res: Response) => {
  const l = loc(res);
  expect(l.startsWith(`${APP_RETURN}?`)).toBe(true);
  return new URL(l).searchParams;
};

scenario('L97B-APP', 'Mon compte › Sécurité dans l’app : Google / Apple par le navigateur système', ({ sql }) => {
  const R = async () => ({
    callback: await import('@/app/api/auth/oauth/[provider]/callback/route'),
    cont: await import('@/app/api/auth/oauth/app/continue/route'),
    exchange: await import('@/app/api/auth/oauth/app/exchange/route'),
    link: await import('@/app/api/users/me/auth-identities/[provider]/link/route'),
    reauth: await import('@/app/api/users/me/auth-identities/[provider]/reauth/route'),
    security: await import('@/app/api/users/me/security/reauth/route'),
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

  /** Compte local connecté DANS LA VUE de l'app, identité confirmée (mot de passe, 5 min). */
  async function appSession() {
    const r = await R();
    const email = `${uid('l97b')}@test.invalid`;
    const [u] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, status, is_active, first_name, last_name, created_at)
      VALUES (${email}, ${await bcrypt.hash(PASSWORD, 4)}, 'ACTIVE', true, 'App', 'Titulaire', now() - interval '30 days') RETURNING id`;
    const [a] = await sql<{ id: number }[]>`INSERT INTO accounts (name, owner_user_id) VALUES (${uid('compte')}, ${u.id}) RETURNING id`;
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${a.id}, ${u.id}, 'owner', 'active')`;
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status) VALUES (${a.id}, 'standard', 'active')`;
    const vue = new Browser(UA_APP);
    expect(vue.absorb(await r.login.POST(vue.req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } }))).status).toBe(200);
    await confirm(vue);
    return { vue, userId: u.id, email };
  }
  async function confirm(vue: Browser) {
    const r = await R();
    expect((await r.security.POST(vue.req('/api/users/me/security/reauth', { method: 'POST', body: { method: 'password', password: PASSWORD } }))).status).toBe(200);
  }
  const sessions = (userId: number) => sql`SELECT 1 FROM user_sessions WHERE user_id = ${userId} AND revoked_at IS NULL`;

  /** Vue : démarre ; navigateur système : ticket → fournisseur → retour → code d'échange pour l'app. */
  async function viaSystemBrowser(vue: Browser, provider: Provider, intent: 'link' | 'reauth', user: FakeUser, body: Record<string, unknown> = {}) {
    const r = await R();
    const verifier = randomToken(48);
    const route = intent === 'link' ? r.link : r.reauth;
    const startRes = vue.absorb(await route.POST(vue.req(`/api/users/me/auth-identities/${provider}/${intent}`, {
      method: 'POST', body: { client: 'app', appChallenge: pkceChallenge(verifier), ...body },
    }), p(provider)));
    expect(startRes.status).toBe(200);
    const { redirectUrl } = await startRes.json() as { redirectUrl: string };
    const open = new URL(redirectUrl);
    expect(open.pathname).toBe('/api/auth/oauth/app/continue');
    // Rien n'est confié à la vue pour le parcours (ni liaison, ni redirection fournisseur).
    expect(vue.jar.has('vb_oauth')).toBe(false);
    const sys = new Browser(UA_SYS, vue.ip);
    const cont = sys.absorb(await r.cont.GET(sys.req(`${open.pathname}${open.search}`)));
    expect(cont.status).toBe(302);
    expect(sys.jar.has('vb_oauth')).toBe(true);
    const providerUrl = loc(cont);
    const a = fake.authorize(providerUrl, user);
    let back: Response;
    if (provider === 'google') {
      back = sys.absorb(await r.callback.GET(sys.req(`/api/auth/oauth/google/callback?${new URLSearchParams({ state: a.state, code: a.code })}`), p('google')));
    } else {
      const post = await r.callback.POST(sys.req('/api/auth/oauth/apple/callback', { method: 'POST', form: { state: a.state, code: a.code }, noCookies: true, origin: 'https://appleid.apple.com' }), p('apple'));
      const resume = new URL(loc(post));
      back = sys.absorb(await r.callback.GET(sys.req(`${resume.pathname}${resume.search}`), p('apple')));
    }
    return { back, verifier, sys, redirectUrl, providerUrl };
  }
  async function exchange(vue: Browser, handoff: string, verifier: string) {
    const r = await R();
    const res = vue.absorb(await r.exchange.POST(vue.req('/api/auth/oauth/app/exchange', { method: 'POST', body: { handoff, verifier } })));
    return { status: res.status, body: await res.json() as Record<string, unknown>, res };
  }

  it('E1 association Google puis Apple depuis l’app : navigateur système, échange dans la vue, aucune nouvelle session', async () => {
    const s = await appSession();
    const before = (await sessions(s.userId)).length;
    const google: FakeUser = { sub: uid('e1-g'), email: `${uid('g')}@gmail.test` };
    const g = await viaSystemBrowser(s.vue, 'google', 'link', google);
    // Le navigateur système ne reçoit AUCUN effet : seulement un code pour l'app.
    const handoff = appReturn(g.back).get('handoff')!;
    expect(handoff).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(await sql`SELECT 1 FROM auth_identities WHERE subject = ${google.sub}`).toHaveLength(0);
    expect(g.sys.jar.has('access_token')).toBe(false);
    const ex = await exchange(s.vue, handoff, g.verifier);
    expect(ex.status).toBe(200);
    expect(ex.body).toMatchObject({ success: true, intent: 'link', provider: 'google', redirectTo: '/mon-compte/informations?securite=linked&provider=google#securite' });
    expect(ex.res.headers.get('set-cookie') ?? '').not.toMatch(/access_token=/);
    expect(await sql`SELECT user_id FROM auth_identities WHERE subject = ${google.sub}`).toEqual([{ user_id: s.userId }]);
    expect((await sessions(s.userId)).length).toBe(before);
    expect(await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${s.userId} AND event_type = 'AUTH_IDENTITY_LINKED'`).toHaveLength(1);
    // Code d'échange à usage unique.
    expect((await exchange(s.vue, handoff, g.verifier)).status).toBe(400);
    // Ticket à usage unique : rejoué → retour à l'app en erreur.
    const r = await R();
    const open = new URL(g.redirectUrl);
    const replay = await r.cont.GET(new Browser(UA_SYS).req(`${open.pathname}${open.search}`));
    expect(appReturn(replay).get('error')).toBe('OAUTH_STATE_INVALID');

    // Apple (form_post) : la preuve a été retirée par l'association (96A Q7) → nouvelle confirmation.
    await confirm(s.vue);
    const apple: FakeUser = { sub: uid('e1-a'), email: `${uid('rel')}@privaterelay.appleid.com`, privateRelay: true };
    const a = await viaSystemBrowser(s.vue, 'apple', 'link', apple);
    const exA = await exchange(s.vue, appReturn(a.back).get('handoff')!, a.verifier);
    expect(exA.body).toMatchObject({ success: true, provider: 'apple' });
    expect(await sql`SELECT provider FROM auth_identities WHERE user_id = ${s.userId} ORDER BY provider`).toEqual([{ provider: 'apple' }, { provider: 'google' }]);
  });

  it('E2 confirmation Google depuis l’app : preuve 5 min pour la session de la vue, action reprise', async () => {
    const s = await appSession();
    const google: FakeUser = { sub: uid('e2-g'), email: `${uid('g')}@gmail.test` };
    const l = await viaSystemBrowser(s.vue, 'google', 'link', google);
    await exchange(s.vue, appReturn(l.back).get('handoff')!, l.verifier);
    expect(await sql`SELECT 1 FROM reauth_proofs WHERE user_id = ${s.userId} AND consumed_at IS NULL`).toHaveLength(0);
    const re = await viaSystemBrowser(s.vue, 'google', 'reauth', google, { resume: 'unlink-google' });
    // Google : réauthentification récente exigée (prompt=login, P2).
    expect(new URL(re.providerUrl).searchParams.get('prompt')).toBe('login');
    const ex = await exchange(s.vue, appReturn(re.back).get('handoff')!, re.verifier);
    expect(ex.body).toMatchObject({ success: true, intent: 'reauth', redirectTo: '/mon-compte/informations?securite=reauth&provider=google&resume=unlink-google#securite' });
    expect(await sql`SELECT method FROM reauth_proofs WHERE user_id = ${s.userId} AND consumed_at IS NULL`).toEqual([{ method: 'google' }]);
    // La preuve sert à l'action sensible suivante (dissociation possible : il reste le mot de passe).
    const { DELETE } = await import('@/app/api/users/me/auth-identities/[provider]/route');
    expect((await DELETE(s.vue.req('/api/users/me/auth-identities/google', { method: 'DELETE', body: {} }), p('google'))).status).toBe(200);
  });

  it('E3 refus : vérificateur faux, autre session, identité liée ailleurs, autre subject — rien n’est modifié', async () => {
    const s = await appSession();
    const google: FakeUser = { sub: uid('e3-g'), email: `${uid('g')}@gmail.test` };
    // Vérificateur faux : refus, code consommé.
    const a = await viaSystemBrowser(s.vue, 'google', 'link', google);
    const h = appReturn(a.back).get('handoff')!;
    expect((await exchange(s.vue, h, randomToken(48))).status).toBe(400);
    expect((await exchange(s.vue, h, a.verifier)).status).toBe(400);
    expect(await sql`SELECT 1 FROM auth_identities WHERE subject = ${google.sub}`).toHaveLength(0);

    // Code présenté par une AUTRE session (autre compte) : refus SESSION_EXPIRED, rien n'est lié.
    await confirm(s.vue);
    const b = await viaSystemBrowser(s.vue, 'google', 'link', google);
    const autre = await appSession();
    const ex = await exchange(autre.vue, appReturn(b.back).get('handoff')!, b.verifier);
    expect(ex.status).toBe(401);
    expect(ex.body.code).toBe('SESSION_EXPIRED');
    expect(await sql`SELECT 1 FROM auth_identities WHERE subject = ${google.sub}`).toHaveLength(0);

    // Identité Google déjà liée à un AUTRE compte : refus explicite.
    const c = await viaSystemBrowser(autre.vue, 'google', 'link', google);
    expect((await exchange(autre.vue, appReturn(c.back).get('handoff')!, c.verifier)).body.success).toBe(true);
    await confirm(s.vue);
    const d = await viaSystemBrowser(s.vue, 'google', 'link', google);
    const refus = await exchange(s.vue, appReturn(d.back).get('handoff')!, d.verifier);
    expect(refus.status).toBe(409);
    expect(refus.body.code).toBe('OAUTH_IDENTITY_ALREADY_LINKED');
    expect(await sql`SELECT user_id FROM auth_identities WHERE subject = ${google.sub}`).toEqual([{ user_id: autre.userId }]);

    // Réauthentification avec un AUTRE compte Google que celui associé : refus, aucune preuve.
    const e = await viaSystemBrowser(autre.vue, 'google', 'reauth', { sub: uid('e3-intrus'), email: `${uid('x')}@gmail.test` });
    await sql`UPDATE reauth_proofs SET consumed_at = now() WHERE user_id = ${autre.userId}`;
    const mismatch = await exchange(autre.vue, appReturn(e.back).get('handoff')!, e.verifier);
    expect(mismatch.body.code).toBe('REAUTH_SUBJECT_MISMATCH');
    expect(await sql`SELECT 1 FROM reauth_proofs WHERE user_id = ${autre.userId} AND consumed_at IS NULL`).toHaveLength(0);

    // Ticket inconnu, annulation chez le fournisseur : retour à l'app avec une erreur.
    const r = await R();
    expect(appReturn(await r.cont.GET(new Browser(UA_SYS).req(`/api/auth/oauth/app/continue?ticket=${randomToken(32)}`))).get('error')).toBe('OAUTH_STATE_INVALID');
    await confirm(s.vue);
    const verifier = randomToken(48);
    const st = await r.link.POST(s.vue.req('/api/users/me/auth-identities/apple/link', { method: 'POST', body: { client: 'app', appChallenge: pkceChallenge(verifier) } }), p('apple'));
    const open = new URL((await st.json()).redirectUrl);
    const sys = new Browser(UA_SYS);
    const cont = sys.absorb(await r.cont.GET(sys.req(`${open.pathname}${open.search}`)));
    const state = new URL(loc(cont)).searchParams.get('state')!;
    const cancel = await r.callback.POST(sys.req('/api/auth/oauth/apple/callback', { method: 'POST', form: { state, error: 'user_cancelled_authorize' }, noCookies: true, origin: 'https://appleid.apple.com' }), p('apple'));
    expect(appReturn(cancel).get('error')).toBe('OAUTH_CANCELLED');
  });

  it('E4 préalables : confirmation exigée, défi invalide, retour non configuré ; parcours web inchangé', async () => {
    const r = await R();
    const s = await appSession();
    await sql`UPDATE reauth_proofs SET consumed_at = now() WHERE user_id = ${s.userId}`;
    const body = { client: 'app', appChallenge: pkceChallenge(randomToken(48)) };
    const sans = await r.link.POST(s.vue.req('/api/users/me/auth-identities/google/link', { method: 'POST', body }), p('google'));
    expect(sans.status).toBe(403);
    await confirm(s.vue);
    const defi = await r.link.POST(s.vue.req('/api/users/me/auth-identities/google/link', { method: 'POST', body: { client: 'app', appChallenge: 'court' } }), p('google'));
    expect(defi.status).toBe(400);
    expect((await defi.json()).code).toBe('APP_CHALLENGE_INVALID');
    delete process.env.APP_OAUTH_RETURN_URL;
    try {
      const nc = await r.link.POST(s.vue.req('/api/users/me/auth-identities/google/link', { method: 'POST', body }), p('google'));
      expect(nc.status).toBe(409);
      expect((await nc.json()).code).toBe('APP_RETURN_NOT_CONFIGURED');
    } finally {
      process.env.APP_OAUTH_RETURN_URL = APP_RETURN;
    }
    // Web (aucun `client: 'app'`) : redirection directe vers le fournisseur, liaison posée dans CE navigateur.
    const web = s.vue.absorb(await r.link.POST(s.vue.req('/api/users/me/auth-identities/google/link', { method: 'POST', body: {} }), p('google')));
    expect(web.status).toBe(200);
    expect(new URL((await web.json()).redirectUrl).pathname).not.toBe('/api/auth/oauth/app/continue');
    expect(s.vue.jar.has('vb_oauth')).toBe(true);
  });
});
