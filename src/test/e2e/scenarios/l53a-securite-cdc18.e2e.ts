/**
 * Lot 53A — retour PO D1 (anti-force brute sans blocage du titulaire) et Q21
 * (CDC 18 : inscription non énumérable, jeton d'accès 15 min, réauthentification
 * limitée) — base PostgreSQL réelle, vraies routes, vraies tables
 * (`auth_rate_limits`, `user_activity_log`, `email_templates` 0342,
 * `email_logs`).
 */
import { expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { activerParLien } from '../activation';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';

type Init = { body?: unknown; cookie?: string; ip?: string; method?: string };
function req(path: string, init: Init = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN };
  if (init.cookie) headers.cookie = init.cookie;
  headers['x-forwarded-for'] = init.ip ?? `91.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.7`;
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
type WithCookies = Response & { cookies: { get(n: string): { value: string; maxAge?: number; path?: string; httpOnly?: boolean } | undefined } };
const jar = (res: Response) => (res as WithCookies).cookies;
const jwtPayload = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

scenario('L53A', 'Sécurité CDC 18 — D1 anti-force brute, Q21 inscription et jetons', ({ sql, make }) => {
  async function compte() {
    const email = `${uid('l53a')}@test.invalid`;
    const owner = await make.user({ email });
    const hash = await bcrypt.hash(PASSWORD, 4);
    await sql`UPDATE users SET password_hash = ${hash}, is_active = true, status = 'ACTIVE', first_name = 'Titulaire' WHERE id = ${owner.id}`;
    await make.account({ owner });
    return { id: owner.id, email };
  }
  async function cgvuCourantes(): Promise<string> {
    const [cur] = await sql<{ version_code: string }[]>`
      SELECT version_code FROM legal_document_versions WHERE document_type = 'CGVU' AND status = 'CURRENT' LIMIT 1`;
    if (cur) return cur.version_code;
    const code = `E2E-${uid('cgvu')}`;
    await sql`INSERT INTO legal_document_versions
      (document_type, version_code, title, status, change_summary, published_at, effective_at, html_content, sha256, permalink, html_storage_key)
      VALUES ('CGVU', ${code}, 'CGVU e2e', 'CURRENT', 'e2e', now(), now(), '<p>CGVU</p>', ${'0'.repeat(64)}, ${`/cgvu/${code}`}, ${`legal/${code}.html`})`;
    return code;
  }
  async function inscription(email: string, over: Record<string, unknown> = {}, ip?: string) {
    const { POST } = await import('@/app/api/users/route');
    const termsVersion = await cgvuCourantes();
    const res = await POST(req('/api/users', {
      ip,
      body: { email, password: 'NouveauMdp1!x', firstName: 'Nouvel', lastName: 'Inscrit', acceptedTerms: true, termsVersion, ...over },
    }));
    return { status: res.status, body: await res.json() };
  }
  async function login(email: string, password: string, ip: string, cookie?: string) {
    const { POST } = await import('@/app/api/auth/login/route');
    return POST(req('/api/auth/login', { body: { email, password }, ip, cookie }));
  }

  // ── Q21 : inscription non énumérable ─────────────────────────────────────

  it('PO-Q21-E2E-01 inscription : même réponse pour une adresse libre et une adresse déjà inscrite ; rien créé ; e-mail « compte existant » (gabarit 0342), un par heure', async () => {
    const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
    const existant = await compte();
    const [avant] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${existant.id}`;
    const libre = `${uid('libre')}@test.invalid`;

    const a = await inscription(libre);
    const b = await inscription(existant.email);
    expect(a.status).toBe(201);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).not.toMatch(/déjà|DUPLICATE|exist/i);

    // Adresse déjà inscrite : aucun compte créé, mot de passe inchangé.
    const lignes = await sql<{ id: number; password_hash: string }[]>`SELECT id, password_hash FROM users WHERE email = ${existant.email}`;
    expect(lignes).toHaveLength(1);
    expect(lignes[0].password_hash).toBe(avant.password_hash);
    // Adresse libre : compte non vérifié créé.
    const [cree] = await sql<{ is_active: boolean }[]>`SELECT is_active FROM users WHERE email = ${libre}`;
    expect(cree.is_active).toBe(false);

    await inscription(existant.email); // deuxième demande dans l'heure : e-mail non renvoyé
    await settleDetachedAuthTasks();
    const [gabarit] = await sql<{ subject: string }[]>`SELECT subject FROM email_templates WHERE type = 'SIGNUP_EXISTING_ACCOUNT'`;
    expect(gabarit.subject).toMatch(/déjà un compte/);
    const mails = await sql<{ metadata: string | null }[]>`
      SELECT metadata FROM email_logs WHERE template_code = 'SIGNUP_EXISTING_ACCOUNT' AND recipient_user_id = ${existant.id}`;
    expect(mails).toHaveLength(1);
    expect(Object.keys(JSON.parse(mails[0].metadata ?? '{}')).sort()).toEqual(['firstName', 'forgotPasswordUrl', 'loginUrl', 'requestDate']);
    const verif = await sql`SELECT 1 FROM email_logs WHERE template_code = 'EMAIL_VERIFICATION' AND recipient_email = ${libre}`;
    expect(verif).toHaveLength(1);
    const [trace] = await sql<{ details: string }[]>`
      SELECT details FROM user_activity_log WHERE user_id = ${existant.id} AND activity_type = 'SIGNUP_EXISTING_EMAIL' ORDER BY id DESC LIMIT 1`;
    expect(JSON.parse(trace.details)).toMatchObject({ accountCreated: false });
  });

  it('PO-Q21-E2E-02 les refus de l’inscription ne dépendent pas de l’existence du compte (nom d’utilisateur pris, mot de passe faible, invitation invalide)', async () => {
    const existant = await compte();
    const pris = uid('pseudo');
    await sql`UPDATE users SET username = ${pris} WHERE id = ${existant.id}`;
    const libre = () => `${uid('libre')}@test.invalid`;
    const autre = await compte();
    for (const over of [{ username: pris }, { password: 'faible' }, { inviteToken: 'jeton-inconnu' }]) {
      const x = await inscription(libre(), over);
      const y = await inscription(autre.email, over);
      expect(y).toEqual(x);
      expect(x.status).toBeGreaterThanOrEqual(400);
    }
    expect((await inscription(libre(), { password: 'faible' })).body.code).toBe('WEAK_PASSWORD');
  });

  it('PO-Q21-E2E-03 activation par le lien reçu : session ouverte avec accès 15 min, renouvellement 30 j, appareil reconnu ; lien à usage unique', async () => {
    const email = `${uid('activ')}@test.invalid`;
    expect((await inscription(email)).status).toBe(201);
    const [u] = await sql<{ id: number; email: string }[]>`SELECT id, email FROM users WHERE email = ${email}`;
    const { buildEmailVerificationUrl } = await import('@/services/auth/email-verification.service');
    const [n] = await sql<{ signup_nonce: string | null }[]>`SELECT signup_nonce FROM users WHERE id = ${u.id}`;
    const url = new URL(buildEmailVerificationUrl(ORIGIN, { id: u.id, email: u.email, signupNonce: n.signup_nonce }, null));
    const { GET } = await import('@/app/api/auth/verify-email/route');
    // Lot 96A (Q9) : le lien seul n'ouvre plus de session — page du mot de passe de l'inscription.
    const r0 = await GET(new NextRequest(url.toString()));
    expect(r0.headers.get('location')).toMatch(/\/verify-email\/activer\?token=/);
    expect(jar(r0).get('access_token')).toBeUndefined();
    const r1 = await activerParLien(url.toString(), 'NouveauMdp1!x');
    expect(r1.status).toBe(307);
    const c = jar(r1);
    expect(c.get('access_token')?.maxAge).toBe(900);
    expect(c.get('refresh_token')?.maxAge).toBe(30 * 24 * 3600);
    expect(jwtPayload(c.get('access_token')!.value).exp - jwtPayload(c.get('access_token')!.value).iat).toBe(900);
    expect(c.get('vb_device')).toMatchObject({ path: '/api/auth', httpOnly: true });
    const r2 = await GET(new NextRequest(url.toString()));
    expect(r2.headers.get('location')).toMatch(/already_verified/);
    expect(jar(r2).get('access_token')).toBeUndefined();
  });

  // ── Q21 : jetons ─────────────────────────────────────────────────────────

  it('PO-Q21-E2E-04 connexion et renouvellement réels : jeton d’accès 15 min (JWT et cookie), renouvellement 30 j rotatif, même famille de session', async () => {
    const u = await compte();
    const res = await login(u.email, PASSWORD, '92.0.0.1');
    expect(res.status).toBe(200);
    const acc = jar(res).get('access_token')!;
    const ref = jar(res).get('refresh_token')!;
    expect([acc.maxAge, ref.maxAge]).toEqual([900, 30 * 24 * 3600]);
    expect(jwtPayload(acc.value).exp - jwtPayload(acc.value).iat).toBe(900);
    expect(jwtPayload(ref.value).exp - jwtPayload(ref.value).iat).toBe(30 * 24 * 3600);
    const { POST: refresh } = await import('@/app/api/auth/refresh/route');
    const r = await refresh(req('/api/auth/refresh', { cookie: `refresh_token=${ref.value}` }));
    expect(r.status).toBe(200);
    const acc2 = jar(r).get('access_token')!;
    expect(acc2.maxAge).toBe(900);
    expect(jwtPayload(acc2.value).exp - jwtPayload(acc2.value).iat).toBe(900);
    expect(jwtPayload(jar(r).get('refresh_token')!.value).sid).toBe(jwtPayload(ref.value).sid);
    // Le nouveau jeton d'accès ouvre l'API.
    const { SessionService } = await import('@/lib/session-service');
    const s = await SessionService.getSession(new NextRequest(`${ORIGIN}/api/users/me`, { headers: { cookie: `access_token=${acc2.value}` } }));
    expect(s.userId).toBe(u.id);
  });

  // ── D1 : anti-force brute ────────────────────────────────────────────────

  it('PO-D1-E2E-01 attaque distribuée réelle : appareils non reconnus en pause, titulaire accepté sur son appareil ; journal et BO', async () => {
    const u = await compte();
    const premiere = await login(u.email, PASSWORD, '93.0.0.1');
    expect(premiere.status).toBe(200);
    const appareil = jar(premiere).get('vb_device')!.value;

    for (let i = 0; i < 10; i++) expect((await login(u.email, 'Faux-123!', `93.1.${i}.1`)).status).toBe(401);
    const refus = await login(u.email, PASSWORD, '93.2.0.1');
    expect(refus.status).toBe(429);
    expect((await refus.json()).message).toMatch(/Mot de passe oublié/);
    // Le titulaire, sur son appareil reconnu, depuis une IP quelconque.
    expect((await login(u.email, PASSWORD, '93.2.0.2', `vb_device=${appareil}`)).status).toBe(200);

    // Compteurs pseudonymisés en base.
    const { limitKey } = await import('@/lib/auth/auth-rate-limit');
    const [row] = await sql<{ lock_level: number; locked_until: Date }[]>`
      SELECT lock_level, locked_until FROM auth_rate_limits WHERE bucket_key = ${limitKey('login', 'acctu', u.email)}`;
    expect(row.lock_level).toBe(1);
    expect(new Date(row.locked_until).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    const tout = await sql<{ bucket_key: string }[]>`SELECT bucket_key FROM auth_rate_limits`;
    expect(tout.some((r) => r.bucket_key.includes(u.email) || r.bucket_key.includes('93.1.'))).toBe(false);

    // Traçabilité : échecs et pause visibles dans BO › Utilisateurs › fiche.
    const { loadLoginHistory } = await import('@/services/admin/user-detail.service');
    const h = await loadLoginHistory(u.id);
    expect(h.filter((e) => e.result === 'failure')).toHaveLength(10);
    expect(h.find((e) => e.result === 'throttled')?.detail).toMatch(/appareils non reconnus/);
    expect(h.filter((e) => e.result === 'success').length).toBeGreaterThanOrEqual(2);
  });

  it('PO-D1-E2E-02 réinitialisation (preuve e-mail) pendant une attaque : pause levée, navigateur reconnu, connexion acceptée', async () => {
    const u = await compte();
    for (let i = 0; i < 10; i++) await login(u.email, 'Faux-123!', `94.1.${i}.1`);
    expect((await login(u.email, PASSWORD, '94.2.0.1')).status).toBe(429);

    const [{ password_hash }] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${u.id}`;
    const { createPasswordResetToken } = await import('@/services/auth/password-reset.service');
    const token = createPasswordResetToken({ id: u.id, email: u.email, passwordHash: password_hash });
    const { POST: reset } = await import('@/app/api/auth/reset-password/route');
    const r = await reset(req('/api/auth/reset-password', { body: { token, newPassword: 'NouveauMdp2!x' }, ip: '94.3.0.1' }));
    expect(r.status).toBe(200);
    const appareil = jar(r).get('vb_device')!.value;
    // Navigateur de la réinitialisation : reconnu.
    expect((await login(u.email, 'NouveauMdp2!x', '94.3.0.1', `vb_device=${appareil}`)).status).toBe(200);
    // Autre appareil (application mobile) : la pause de l'adresse est levée.
    expect((await login(u.email, 'NouveauMdp2!x', '94.4.0.1')).status).toBe(200);
  });

  it('PO-D1-E2E-03 adresse inexistante : mêmes compteurs et même refus qu’une adresse inscrite (aucune énumération)', async () => {
    const u = await compte();
    const inconnue = `${uid('inconnue')}@test.invalid`;
    for (let i = 0; i < 10; i++) {
      await login(u.email, 'Faux-123!', `95.1.${i}.1`);
      await login(inconnue, 'Faux-123!', `95.2.${i}.1`);
    }
    const a = await login(u.email, 'Faux-123!', '95.3.0.1');
    const b = await login(inconnue, 'Faux-123!', '95.3.0.2');
    expect([a.status, b.status]).toEqual([429, 429]);
    expect(await a.json()).toEqual(await b.json());
    expect(a.headers.get('retry-after')).toBe(b.headers.get('retry-after'));
  });

  // ── Q21 : réauthentification ─────────────────────────────────────────────

  it('PO-Q21-REAUTH-01 changement de mot de passe : 5 mots de passe actuels faux → pause (compteur partagé, par utilisateur) ; un autre utilisateur n’est pas touché', async () => {
    const u = await compte();
    const v = await compte();
    const session = async (x: { email: string }, ip: string) => jar(await login(x.email, PASSWORD, ip)).get('access_token')!.value;
    const au = await session(u, '96.0.0.1');
    const av = await session(v, '96.0.0.2');
    const { POST: change } = await import('@/app/api/users/me/change-password/route');
    const essai = (acces: string, currentPassword: string, ip: string) =>
      change(req('/api/users/me/change-password', { cookie: `access_token=${acces}`, ip, body: { currentPassword, newPassword: 'NouveauMdp3!x' } }));
    for (let i = 0; i < 5; i++) expect((await essai(au, 'Faux-123!', `96.1.${i}.1`)).status).toBe(401);
    expect((await essai(au, PASSWORD, '96.1.9.1')).status).toBe(429);
    const [trace] = await sql`SELECT 1 FROM user_activity_log WHERE user_id = ${u.id} AND activity_type = 'AUTH_REAUTH_THROTTLED'`;
    expect(trace).toBeDefined();
    expect((await essai(av, PASSWORD, '96.2.0.1')).status).toBe(200);
  });
});
