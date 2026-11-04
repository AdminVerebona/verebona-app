/**
 * Lot 109F — e-mails jetables : PostgreSQL 16 réel, vraies routes, faux
 * fournisseur OIDC local (Google / Apple, `../fake-oidc.ts`). Ticket §6 :
 *
 *   J01  POST /api/users, domaine jetable : refus AVANT compte, compte
 *        partagé, invitation consommée, essai et e-mail ; réponse identique
 *        que l'adresse ait un compte ou non ; casse / espaces ;
 *   J02  Gmail (alias +), Outlook, domaine professionnel / personnalisé,
 *        relais Apple : inscription possible ; anti-énumération 53A inchangée ;
 *        liste d'autorisation d'exploitation (faux positif) ;
 *   J03  Google, adresse jetable attestée : refus de création ; connexion
 *        (Google et « J'ai déjà un compte ») à un compte existant inchangée ;
 *   J04  Google, autre adresse jetable : aucun code ; domaine bloqué entre
 *        saisie et confirmation : refus final (et au renvoi du code) ;
 *   J05  Apple relais @privaterelay.appleid.com : création et connexion ;
 *   J06  changement d'adresse : refus à la demande ET à la confirmation,
 *        adresse initiale conservée, non énumérable ;
 *   J07  compte existant sur un domaine désormais bloqué : connexion,
 *        renouvellement de session et mot de passe oublié inchangés ;
 *   J08  métriques agrégées sans adresse ; migration 1125 rejouable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { createFakeOidc, type FakeUser } from '../fake-oidc';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'MotDePasse109f!x';
const MESSAGE = 'Les adresses e-mail temporaires ne sont pas acceptées. Utilisez une adresse e-mail que vous conservez.';
const fake = createFakeOidc();
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(fake.env)) { saved[k] = process.env[k]; process.env[k] = v; }

type Provider = 'google' | 'apple';
type WithCookies = Response & { cookies: { getAll(): Array<{ name: string; value: string; maxAge?: number }> } };

class Nav {
  jar = new Map<string, string>();
  ip = `109.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  req(path: string, init: { method?: string; body?: unknown; form?: Record<string, string>; noCookies?: boolean; origin?: string } = {}) {
    const headers: Record<string, string> = { origin: init.origin ?? ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': 'Mozilla/5.0 e2e l109f' };
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

interface Sent { templateCode: string; to: string; variables: Record<string, string> }

scenario('L109F', 'E-mails jetables — inscription, Google / Apple, changement d’adresse', ({ sql }) => {
  const sent: Sent[] = [];

  beforeAll(async () => {
    const { emailService } = await import('@/lib/email/email-service');
    vi.spyOn(emailService, 'send').mockImplementation(async (o) => {
      sent.push({ templateCode: o.templateCode, to: o.to, variables: (o.variables ?? {}) as Record<string, string> });
      return { success: true } as never;
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { setOAuthFetchForTests } = await import('@/lib/auth/oauth/providers');
    setOAuthFetchForTests(fake.fetchImpl);
  });
  afterEach(() => {
    delete process.env.DISPOSABLE_EMAIL_ALLOWLIST;
    delete process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    const { setOAuthFetchForTests } = await import('@/lib/auth/oauth/providers');
    setOAuthFetchForTests(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const settle = async () => (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();

  async function cgvu(): Promise<string> {
    const [cur] = await sql<{ version_code: string }[]>`
      SELECT version_code FROM legal_document_versions WHERE document_type = 'CGVU' AND status = 'CURRENT' LIMIT 1`;
    if (cur) return cur.version_code;
    const code = `E2E-${uid('cgvu')}`;
    await sql`INSERT INTO legal_document_versions
      (document_type, version_code, title, status, change_summary, published_at, effective_at, html_content, sha256, permalink, html_storage_key, source)
      VALUES ('CGVU', ${code}, 'CGVU e2e', 'CURRENT', 'e2e', now(), now(), '<p>CGVU</p>', ${'0'.repeat(64)}, ${`/cgvu/${code}`}, ${`legal/${code}.html`}, 'PUBLIC_SITE')`;
    return code;
  }

  async function inscription(body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(new Nav().req('/api/users', {
      method: 'POST',
      body: { password: PASSWORD, username: 'Jet', acceptedTerms: true, termsVersion: await cgvu(), planType: 'STANDARD', ...body },
    }));
    const out = { status: res.status, body: await res.json() as Record<string, any> };
    await settle();
    return out;
  }

  /** Compte local ACTIF (inscrit avant le lot, éventuellement sur un domaine devenu interdit). */
  async function compteExistant(email: string) {
    const [u] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, status, is_active, first_name, last_name, username)
      VALUES (${email}, ${await bcrypt.hash(PASSWORD, 4)}, 'ACTIVE', true, 'Ancien', 'Compte', 'Ancien') RETURNING id`;
    const [a] = await sql<{ id: number }[]>`INSERT INTO accounts (name, owner_user_id) VALUES (${uid('compte')}, ${u.id}) RETURNING id`;
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${a.id}, ${u.id}, 'owner', 'active')`;
    return { id: u.id, email, accountId: a.id };
  }
  async function connexion(nav: Nav, email: string) {
    const { POST } = await import('@/app/api/auth/login/route');
    return nav.absorb(await POST(nav.req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } }))).status;
  }
  const refusals = async (channel: string) => sql<{ domain: string; reason: string; list_version: string; refusals: number }[]>`
    SELECT domain, reason, list_version, refusals FROM disposable_email_refusals WHERE channel = ${channel} ORDER BY domain`;

  // ── Google / Apple ─────────────────────────────────────────────────────────
  async function social(b: Nav, provider: Provider, user: FakeUser, query: Record<string, string> = {}) {
    const start = await import('@/app/api/auth/oauth/[provider]/start/route');
    const callback = await import('@/app/api/auth/oauth/[provider]/callback/route');
    const q = new URLSearchParams({ intent: 'signup', ...query });
    const s = b.absorb(await start.GET(b.req(`/api/auth/oauth/${provider}/start?${q}`), p(provider)));
    expect(s.status).toBe(302);
    const a = fake.authorize(s.headers.get('location')!, user);
    if (provider === 'google') {
      return b.absorb(await callback.GET(b.req(`/api/auth/oauth/google/callback?${new URLSearchParams({ state: a.state, code: a.code })}`), p('google')));
    }
    const form: Record<string, string> = { state: a.state, code: a.code };
    if (a.appleUser) form.user = a.appleUser;
    const post = await callback.POST(b.req('/api/auth/oauth/apple/callback', { method: 'POST', form, noCookies: true, origin: 'https://appleid.apple.com' }), p('apple'));
    const resume = loc(post);
    if (resume.pathname !== '/api/auth/oauth/apple/callback') return post;
    return b.absorb(await callback.GET(b.req(`${resume.pathname}${resume.search}`), p('apple')));
  }
  async function pending(b: Nav, body?: Record<string, unknown>) {
    const route = await import('@/app/api/auth/oauth/pending/route');
    const res = b.absorb(body
      ? await route.POST(b.req('/api/auth/oauth/pending', { method: 'POST', body }))
      : await route.GET(b.req('/api/auth/oauth/pending')));
    const out = { res, status: res.status, body: await res.json() as Record<string, any> };
    await settle();
    return out;
  }

  // ── J01 ────────────────────────────────────────────────────────────────────

  it('J01 POST /api/users, domaine jetable : refus 400 DISPOSABLE_EMAIL_NOT_ALLOWED avant toute écriture ; réponse identique avec ou sans compte ; invitation intacte', async () => {
    sent.length = 0;
    const neuve = `${uid('j01')}@yopmail.com`;
    const r = await inscription({ email: `  ${neuve.toUpperCase()} ` });
    expect(r).toEqual({ status: 400, body: { error: MESSAGE, message: MESSAGE, code: 'DISPOSABLE_EMAIL_NOT_ALLOWED', field: 'email' } });
    expect(await sql`SELECT 1 FROM users WHERE email = ${neuve}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM trial_grants WHERE email_normalized = ${neuve}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM transactional_email_jobs WHERE recipient_email = ${neuve}`).toHaveLength(0);
    expect(sent).toHaveLength(0);

    // Sous-domaine d'un domaine listé.
    expect((await inscription({ email: `${uid('j01s')}@mail.mailinator.com` })).body.code).toBe('DISPOSABLE_EMAIL_NOT_ALLOWED');

    // Adresse jetable DÉJÀ inscrite (compte d'avant le lot) : même statut, même corps, aucun e-mail « déjà un compte ».
    const ancienne = await compteExistant(`${uid('j01e')}@yopmail.com`);
    const r2 = await inscription({ email: ancienne.email });
    expect(r2).toEqual(r);
    await settle();
    expect(sent).toHaveLength(0);
    expect(await sql`SELECT 1 FROM user_activity_log WHERE user_id = ${ancienne.id} AND activity_type = 'SIGNUP_EXISTING_EMAIL'`).toHaveLength(0);

    // Invitation à un compte partagé destinée à une adresse jetable : jamais consommée.
    const titulaire = await compteExistant(`${uid('j01t')}@test.invalid`);
    const invitee = `${uid('j01i')}@yopmail.fr`;
    const token = uid('invite-j01');
    await sql`INSERT INTO account_memberships (account_id, role, status, invited_email, invite_token, invite_token_expires_at)
              VALUES (${titulaire.accountId}, 'member', 'pending', ${invitee}, ${token}, now() + interval '7 days')`;
    expect((await inscription({ email: invitee, inviteToken: token })).body.code).toBe('DISPOSABLE_EMAIL_NOT_ALLOWED');
    expect(await sql`SELECT user_id, status, invite_token FROM account_memberships WHERE invite_token = ${token}`)
      .toEqual([{ user_id: null, status: 'pending', invite_token: token }]);
    expect(await sql`SELECT 1 FROM users WHERE email = ${invitee}`).toHaveLength(0);

    // Garde CGUV 108L conservée et APPLIQUÉE AVANT : CGUV non acceptées → refus CGUV, pas « jetable ».
    expect((await inscription({ email: `${uid('j01c')}@yopmail.com`, acceptedTerms: false })).body.code).toBe('TERMS_NOT_ACCEPTED');
  });

  // ── J02 ────────────────────────────────────────────────────────────────────

  it('J02 Gmail (alias +), Outlook, professionnel, personnalisé, relais Apple : inscription possible ; anti-énumération inchangée ; faux positif débloqué par la liste d’autorisation', async () => {
    const tag = uid('j02');
    for (const email of [`jean+${tag}@gmail.com`, `${tag}@outlook.fr`, `${tag}@cabinet-durand-avocats.fr`, `${tag}@famille-martin.eu`, `${tag}@privaterelay.appleid.com`]) {
      const r = await inscription({ email });
      expect(r, email).toEqual({ status: 201, body: { success: true, code: 'SIGNUP_ACCEPTED', message: expect.any(String) } });
      expect(await sql`SELECT is_active FROM users WHERE email = ${email}`, email).toEqual([{ is_active: false }]);
    }
    // Anti-énumération 53A : adresse déjà inscrite (non jetable) → même réponse que l'adresse libre.
    const existant = await compteExistant(`${uid('j02e')}@gmail.com`);
    const libre = await inscription({ email: `${uid('j02l')}@gmail.com` });
    const prise = await inscription({ email: existant.email });
    expect(prise).toEqual(libre);

    // Faux positif : DISPOSABLE_EMAIL_ALLOWLIST (Scalingo) débloque CE domaine seulement.
    process.env.DISPOSABLE_EMAIL_ALLOWLIST = 'yopmail.fr';
    expect((await inscription({ email: `${uid('j02a')}@yopmail.fr` })).status).toBe(201);
    expect((await inscription({ email: `${uid('j02b')}@yopmail.com` })).body.code).toBe('DISPOSABLE_EMAIL_NOT_ALLOWED');
  });

  // ── J03 ────────────────────────────────────────────────────────────────────

  it('J03 Google, adresse jetable attestée : refus de création (rien créé) ; compte existant : connexion Google et « J’ai déjà un compte » inchangées', async () => {
    const termsVersion = await cgvu();
    const b = new Nav();
    const jetable = `${uid('j03')}@mailinator.com`;
    const user = { sub: uid('j03-sub'), email: jetable, emailVerified: true, givenName: 'Jet' };
    expect(loc(await social(b, 'google', user)).pathname).toBe('/connexion-sociale');
    const r = await pending(b, { action: 'signup', username: 'Jet', email: jetable, acceptedTerms: true, termsVersion });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: MESSAGE, message: MESSAGE, code: 'DISPOSABLE_EMAIL_NOT_ALLOWED', field: 'email' });
    expect(await sql`SELECT 1 FROM users WHERE email = ${jetable}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM auth_identities WHERE subject = ${user.sub}`).toHaveLength(0);
    expect((await pending(b)).status).toBe(200); // l'étape reste ouverte : l'utilisateur peut choisir une autre adresse

    // Compte existant (d'avant le lot) sur un domaine jetable : « J'ai déjà un compte » puis connexion Google.
    const ancien = await compteExistant(`${uid('j03e')}@yopmail.com`);
    const b2 = new Nav();
    const u2 = { sub: uid('j03e-sub'), email: ancien.email };
    expect(loc(await social(b2, 'google', u2)).pathname).toBe('/connexion-sociale');
    expect((await pending(b2)).body.stage).toBe('existing_email');
    const lien = await pending(b2, { action: 'link-password', email: ancien.email, password: PASSWORD });
    expect(lien.status).toBe(200);
    expect(await sql`SELECT user_id FROM auth_identities WHERE subject = ${u2.sub}`).toEqual([{ user_id: ancien.id }]);
    expect(loc(await social(new Nav(), 'google', u2, { intent: 'login' })).pathname).toBe('/accueil');
  });

  // ── J04 ────────────────────────────────────────────────────────────────────

  it('J04 Google, autre adresse jetable : aucun code envoyé ; domaine bloqué entre saisie et confirmation : renvoi et confirmation refusés, aucun compte', async () => {
    const termsVersion = await cgvu();
    const b = new Nav();
    const user = { sub: uid('j04-sub'), email: `${uid('j04g')}@gmail.com`, givenName: 'Paul' };
    await social(b, 'google', user);
    sent.length = 0;
    const jetable = `${uid('j04')}@guerrillamail.com`;
    const r = await pending(b, { action: 'signup', username: 'Paul', email: jetable, acceptedTerms: true, termsVersion });
    expect(r.body.code).toBe('DISPOSABLE_EMAIL_NOT_ALLOWED');
    expect(sent.filter((m) => m.templateCode === 'SOCIAL_SIGNUP_EMAIL_CODE')).toHaveLength(0);
    expect((await pending(b)).body.stage).toBe('choice');

    // Autre adresse, non classée : code envoyé.
    const domaine = `${uid('bientot')}.example`;
    const autre = `paul@${domaine}`;
    const ok = await pending(b, { action: 'signup', username: 'Paul', email: autre, acceptedTerms: true, termsVersion });
    expect(ok.body).toMatchObject({ success: true, stage: 'email_code', email: autre });
    const code = sent.find((m) => m.templateCode === 'SOCIAL_SIGNUP_EMAIL_CODE' && m.to === autre)!.variables.code;
    expect(code).toMatch(/^\d{6}$/);

    // Le domaine devient jetable (blocage d'urgence) avant la confirmation.
    process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST = domaine;
    await sql`UPDATE auth_transactions SET email_code_sent_at = now() - interval '10 minutes' WHERE pending_email = ${autre}`;
    sent.length = 0;
    expect((await pending(b, { action: 'resend-code' })).body.code).toBe('DISPOSABLE_EMAIL_NOT_ALLOWED');
    expect(sent).toHaveLength(0);
    const fin = await pending(b, { action: 'verify-code', code });
    expect(fin.status).toBe(400);
    expect(fin.body.code).toBe('DISPOSABLE_EMAIL_NOT_ALLOWED');
    expect(await sql`SELECT 1 FROM users WHERE email = ${autre}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM auth_identities WHERE subject = ${user.sub}`).toHaveLength(0);
    expect((await refusals('social_final')).map((x) => [x.domain, x.reason])).toContainEqual([domaine, 'extra_blocklist']);
  });

  // ── J05 ────────────────────────────────────────────────────────────────────

  it('J05 Apple relais @privaterelay.appleid.com : création puis connexion (non-régression OAuth)', async () => {
    const termsVersion = await cgvu();
    const relay = `${uid('j05')}@privaterelay.appleid.com`;
    const user = { sub: uid('j05-sub'), email: relay, privateRelay: true, appleName: { firstName: 'Zoé', lastName: 'Relais' } };
    const b = new Nav();
    expect(loc(await social(b, 'apple', user)).pathname).toBe('/connexion-sociale');
    const done = await pending(b, { action: 'signup', username: 'Zoé', email: relay, acceptedTerms: true, termsVersion });
    expect(done.status).toBe(200);
    expect(await sql`SELECT is_active FROM users WHERE email = ${relay}`).toEqual([{ is_active: true }]);
    expect(loc(await social(new Nav(), 'apple', { ...user, appleName: null }, { intent: 'login' })).pathname).toBe('/accueil');
  });

  // ── J06 ────────────────────────────────────────────────────────────────────

  it('J06 changement d’adresse vers un domaine jetable : refus à la demande et à la confirmation, adresse initiale conservée, non énumérable', async () => {
    const R = {
      reauth: await import('@/app/api/users/me/security/reauth/route'),
      emailChange: await import('@/app/api/users/me/email-change/route'),
      emailConfirm: await import('@/app/api/users/me/email-change/confirm/route'),
    };
    const u = await compteExistant(`${uid('j06')}@test.invalid`);
    const a = new Nav();
    expect(await connexion(a, u.email)).toBe(200);
    expect((await R.reauth.POST(a.req('/api/users/me/security/reauth', { method: 'POST', body: { method: 'password', password: PASSWORD } }))).status).toBe(200);
    const demander = async (newEmail: string) => {
      const res = await R.emailChange.POST(a.req('/api/users/me/email-change', { method: 'POST', body: { newEmail } }));
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
    sent.length = 0;
    const libre = await demander(`${uid('j06n')}@yopmail.com`);
    expect(libre).toEqual({ status: 400, body: { error: 'DISPOSABLE_EMAIL_NOT_ALLOWED', code: 'DISPOSABLE_EMAIL_NOT_ALLOWED', message: MESSAGE } });
    // Adresse jetable déjà portée par un autre compte : réponse identique, aucun e-mail au titulaire.
    const autre = await compteExistant(`${uid('j06o')}@yopmail.com`);
    expect(await demander(autre.email)).toEqual(libre);
    expect(sent).toHaveLength(0);
    expect(await sql`SELECT 1 FROM email_change_requests WHERE user_id = ${u.id}`).toHaveLength(0);

    // Demande vers un domaine accepté, devenu jetable avant la confirmation.
    const domaine = `${uid('j06d')}.example`;
    const cible = `moi@${domaine}`;
    expect((await demander(cible)).status).toBe(200);
    const m = sent.find((x) => x.templateCode === 'EMAIL_CHANGE_CONFIRMATION' && x.to === cible)!;
    const token = new URL(m.variables.confirmUrl).searchParams.get('token')!;
    process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST = domaine;
    const res = await R.emailConfirm.POST(a.req('/api/users/me/email-change/confirm', { method: 'POST', body: { token } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'DISPOSABLE_EMAIL_NOT_ALLOWED', message: MESSAGE });
    expect((await sql`SELECT email FROM users WHERE id = ${u.id}`)[0].email).toBe(u.email);
    expect(await sql`SELECT cancel_reason, consumed_at FROM email_change_requests WHERE user_id = ${u.id} AND new_email = ${cible}`)
      .toEqual([{ cancel_reason: 'DISPOSABLE_EMAIL', consumed_at: null }]);
    expect(await connexion(new Nav(), u.email)).toBe(200);
  });

  // ── J07 ────────────────────────────────────────────────────────────────────

  it('J07 compte existant sur un domaine désormais bloqué : connexion, renouvellement et mot de passe oublié inchangés ; aucun compte suspendu', async () => {
    const ancien = await compteExistant(`${uid('j07')}@yopmail.com`);
    const a = new Nav();
    expect(await connexion(a, ancien.email)).toBe(200);
    const { POST: refresh } = await import('@/app/api/auth/refresh/route');
    expect(a.absorb(await refresh(a.req('/api/auth/refresh', { method: 'POST' }))).status).toBe(200);
    sent.length = 0;
    const { POST: forgot } = await import('@/app/api/auth/forgot-password/route');
    const f = await forgot(new Nav().req('/api/auth/forgot-password', { method: 'POST', body: { email: ancien.email } }));
    expect(f.status).toBe(200);
    await settle();
    for (let i = 0; i < 40 && !sent.some((m) => m.templateCode === 'PASSWORD_RESET'); i++) await new Promise((r) => setTimeout(r, 25));
    expect(sent.filter((m) => m.templateCode === 'PASSWORD_RESET').map((m) => m.to)).toEqual([ancien.email]);
    expect(await sql`SELECT is_active, status FROM users WHERE id = ${ancien.id}`).toEqual([{ is_active: true, status: 'ACTIVE' }]);
  });

  // ── J08 ────────────────────────────────────────────────────────────────────

  it('J08 métriques agrégées (voie, domaine de liste, motif, version) sans adresse ; migration 1125 rejouable', async () => {
    const signup = await refusals('signup');
    expect(signup.map((x) => x.domain)).toEqual(expect.arrayContaining(['yopmail.com', 'mailinator.com', 'yopmail.fr']));
    const { disposableListStatus } = await import('@/lib/auth/disposable-email');
    const version = disposableListStatus().version;
    expect(signup.find((x) => x.domain === 'yopmail.com')).toMatchObject({ reason: 'blocklist', list_version: version });
    expect(signup.find((x) => x.domain === 'yopmail.com')!.refusals).toBeGreaterThanOrEqual(2);
    for (const ch of ['social_signup', 'social_email_code', 'email_change_request', 'email_change_confirm']) {
      expect((await refusals(ch)).length, ch).toBeGreaterThanOrEqual(1);
    }
    const all = JSON.stringify(await sql`SELECT * FROM disposable_email_refusals`);
    expect(all).not.toContain('@');
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/1125_l109f_refus_emails_jetables.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(migration); });
    await sql.begin(async (tx) => { await tx.unsafe(migration); });
    await expect(sql`INSERT INTO disposable_email_refusals (day, channel, domain, reason, list_version) VALUES (current_date, 'signup', 'a@b.fr', 'blocklist', 'v')`).rejects.toThrow();
  });
});
