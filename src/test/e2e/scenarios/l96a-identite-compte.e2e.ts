/**
 * Lot 96A — CDC 18 sous-lot « identité et compte » : PostgreSQL 16 réel,
 * vraies routes, faux fournisseur OIDC LOCAL pour Google (`../fake-oidc.ts`).
 *
 *   R01  inscription classique : lien vérifié ET mot de passe initial exigé ;
 *   R02  substitution d'inscription (faille Q9 reproduite sur le lot 93) :
 *        aucun lien d'un dossier A n'active B, reprise propre ;
 *        + anciens liens (avant 96A), tentatives limitées et journalisées ;
 *   R08 / P3  jetons d'accès ET de renouvellement révoqués refusés par les
 *        API, sessions héritées (antérieures au registre) incluses ;
 *   R09  preuve Q7 expirée / d'une autre session refusée ; jamais prolongée ;
 *        invalidée à la déconnexion, à la révocation et à tout changement
 *        d'identifiant ; suppression : intention explicite en plus ;
 *   R10  changement d'adresse : ancienne active avant confirmation ;
 *        confirmation → bascule, alertes aux deux adresses, autres sessions
 *        révoquées, session courante conservée (jetons réémis) ; lien à
 *        usage unique, expiré, collision non énumérante ;
 *   R11  biens, Duo, abonnement, identifiant Stripe et identités inchangés ;
 *        client Stripe existant mis à jour (jamais créé) ;
 *   R14  compte social-only : réauthentification Google fraîche exigée.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { createFakeOidc, type FakeUser } from '../fake-oidc';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'MotDePasse96a!x';
const fake = createFakeOidc();
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(fake.env)) { saved[k] = process.env[k]; process.env[k] = v; }

type WithCookies = Response & { cookies: { getAll(): Array<{ name: string; value: string; maxAge?: number }>; get(n: string): { value: string } | undefined } };
const jwtPayload = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

/** Un navigateur : cookies et IP propres. */
class Nav {
  jar = new Map<string, string>();
  ip = `96.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  constructor(public ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36') {}
  req(path: string, init: { method?: string; body?: unknown; form?: Record<string, string>; noCookies?: boolean; origin?: string } = {}) {
    const headers: Record<string, string> = { origin: init.origin ?? ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': this.ua };
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

scenario('L96A', 'Identité et compte — CDC 18 Q7, Q8, Q9 (R01, R02, R08-R11, R14, P3)', ({ sql, make }) => {
  const sent: Sent[] = [];
  const stripeCalls: Array<{ id: string; email: string }> = [];

  beforeAll(async () => {
    const { emailService } = await import('@/lib/email/email-service');
    vi.spyOn(emailService, 'send').mockImplementation(async (o) => {
      sent.push({ templateCode: o.templateCode, to: o.to, variables: (o.variables ?? {}) as Record<string, string> });
      return { success: true } as never;
    });
    const { __setStripeCustomerEmailUpdaterForTests } = await import('@/lib/stripe-customer');
    __setStripeCustomerEmailUpdaterForTests(async (id, email) => { stripeCalls.push({ id, email }); });
    const { setOAuthFetchForTests } = await import('@/lib/auth/oauth/providers');
    setOAuthFetchForTests(fake.fetchImpl);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    const { __setStripeCustomerEmailUpdaterForTests } = await import('@/lib/stripe-customer');
    __setStripeCustomerEmailUpdaterForTests(null);
    const { setOAuthFetchForTests } = await import('@/lib/auth/oauth/providers');
    setOAuthFetchForTests(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const R = async () => ({
    signup: await import('@/app/api/users/route'),
    verify: await import('@/app/api/auth/verify-email/route'),
    login: await import('@/app/api/auth/login/route'),
    logout: await import('@/app/api/auth/logout/route'),
    refresh: await import('@/app/api/auth/refresh/route'),
    sessions: await import('@/app/api/users/me/sessions/route'),
    revokeOthers: await import('@/app/api/users/me/sessions/revoke-others/route'),
    reauth: await import('@/app/api/users/me/security/reauth/route'),
    security: await import('@/app/api/users/me/security/route'),
    emailChange: await import('@/app/api/users/me/email-change/route'),
    emailConfirm: await import('@/app/api/users/me/email-change/confirm/route'),
    password: await import('@/app/api/users/me/password/route'),
    deletion: await import('@/app/api/users/me/deletion/route'),
    identity: await import('@/app/api/users/me/auth-identities/[provider]/route'),
    providerReauth: await import('@/app/api/users/me/auth-identities/[provider]/reauth/route'),
    oauthStart: await import('@/app/api/auth/oauth/[provider]/start/route'),
    oauthCallback: await import('@/app/api/auth/oauth/[provider]/callback/route'),
    oauthPending: await import('@/app/api/auth/oauth/pending/route'),
  });
  const settle = async () => (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();

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
  async function inscrire(email: string, password: string, firstName = 'Vic') {
    const r = await R();
    const n = new Nav();
    const res = await r.signup.POST(n.req('/api/users', { method: 'POST', body: { email, password, firstName, lastName: 'E2e', acceptedTerms: true, termsVersion: await cgvu() } }));
    await settle();
    return res.status;
  }
  const liens = (email: string) => sent.filter((m) => m.templateCode === 'EMAIL_VERIFICATION' && m.to === email).map((m) => m.variables.verificationUrl);
  async function ouvrirLien(url: string) {
    const r = await R();
    return r.verify.GET(new NextRequest(url));
  }
  async function activer(nav: Nav, token: string | null, password: string | undefined) {
    const r = await R();
    const res = nav.absorb(await r.verify.POST(nav.req('/api/auth/verify-email', { method: 'POST', body: { token, password } })));
    return { status: res.status, body: await res.json() as Record<string, any> };
  }
  const tokenDe = (res: Response) => loc(res).searchParams.get('token');
  async function journal(userId: number, type: string) {
    for (let i = 0; i < 40; i++) {
      const rows = await sql<{ details: string }[]>`SELECT details FROM user_activity_log WHERE user_id = ${userId} AND activity_type = ${type} ORDER BY id`;
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }

  /** Compte local actif avec compte métier (mot de passe PASSWORD). */
  async function compte(prefix = 'l96a') {
    const email = `${uid(prefix)}@test.invalid`;
    const owner = await make.user({ email });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE', first_name = 'Titulaire' WHERE id = ${owner.id}`;
    const acc = await make.account({ owner });
    return { id: owner.id, email, accountId: acc.id };
  }
  async function connecter(nav: Nav, email: string, password = PASSWORD) {
    const r = await R();
    const res = nav.absorb(await r.login.POST(nav.req('/api/auth/login', { method: 'POST', body: { email, password } })));
    return res.status;
  }
  async function api(nav: Nav) {
    const r = await R();
    return (await r.sessions.GET(nav.req('/api/users/me/sessions'))).status;
  }
  async function renouveler(nav: Nav) {
    const r = await R();
    return nav.absorb(await r.refresh.POST(nav.req('/api/auth/refresh', { method: 'POST' }))).status;
  }
  async function confirmerIdentite(nav: Nav, password = PASSWORD) {
    const r = await R();
    return (await r.reauth.POST(nav.req('/api/users/me/security/reauth', { method: 'POST', body: { method: 'password', password } }))).status;
  }
  async function demanderChangement(nav: Nav, newEmail: string) {
    const r = await R();
    const res = await r.emailChange.POST(nav.req('/api/users/me/email-change', { method: 'POST', body: { newEmail } }));
    return { status: res.status, body: await res.json() as Record<string, any> };
  }
  async function confirmerChangement(nav: Nav, token: string) {
    const r = await R();
    const res = nav.absorb(await r.emailConfirm.POST(nav.req('/api/users/me/email-change/confirm', { method: 'POST', body: { token } })));
    return { status: res.status, body: await res.json() as Record<string, any>, res };
  }
  const lienChangement = (to: string) => {
    const m = sent.filter((x) => x.templateCode === 'EMAIL_CHANGE_CONFIRMATION' && x.to === to).at(-1);
    return m ? new URL(m.variables.confirmUrl).searchParams.get('token') : null;
  };

  // ── Q9 / P1 ───────────────────────────────────────────────────────────────

  it('R01 inscription classique : le lien seul n’active rien ; mot de passe initial exigé ; mauvais mot de passe refusé ; bon → actif et session', async () => {
    const email = `${uid('r01')}@test.invalid`;
    expect(await inscrire(email, 'Inscrit1!xyz')).toBe(201);
    const [u] = await sql<{ id: number; signup_nonce: string | null; is_active: boolean }[]>`SELECT id, signup_nonce, is_active FROM users WHERE email = ${email}`;
    expect(u.signup_nonce).toBeTruthy(); // empreinte d'inscription posée (0828)
    const [url] = liens(email);
    const g = await ouvrirLien(url);
    expect(loc(g).pathname).toBe('/verify-email/activer');
    expect((g as unknown as WithCookies).cookies.get('access_token')).toBeUndefined();
    expect((await sql`SELECT is_active FROM users WHERE id = ${u.id}`)[0].is_active).toBe(false);

    const nav = new Nav();
    expect((await activer(nav, tokenDe(g), undefined)).body.code).toBe('PASSWORD_REQUIRED');
    const faux = await activer(nav, tokenDe(g), 'PasLeBon1!x');
    expect(faux.status).toBe(401);
    expect(faux.body).toMatchObject({ code: 'WRONG_SIGNUP_PASSWORD', restartUrl: '/signup' });
    expect(nav.jar.has('access_token')).toBe(false);
    expect((await sql`SELECT is_active FROM users WHERE id = ${u.id}`)[0].is_active).toBe(false);
    expect(await journal(u.id, 'ACCOUNT_ACTIVATION_FAILED')).toHaveLength(1);

    const ok = await activer(nav, tokenDe(g), 'Inscrit1!xyz');
    expect(ok.status).toBe(200);
    expect(ok.body.redirectTo).toMatch(/^\/verify-email\?status=success/);
    expect(nav.jar.has('access_token')).toBe(true);
    expect(await api(nav)).toBe(200);
    expect((await sql`SELECT is_active FROM users WHERE id = ${u.id}`)[0].is_active).toBe(true);
    expect(await journal(u.id, 'ACCOUNT_ACTIVATED')).toHaveLength(1);
    // Usage unique : le même lien n'ouvre plus rien.
    expect(loc(await ouvrirLien(url)).searchParams.get('status')).toBe('already_verified');
    expect((await activer(new Nav(), tokenDe(g), 'Inscrit1!xyz')).body.code).toBe('ALREADY_VERIFIED');
  });

  it('R02 substitution par un tiers (faille Q9 du lot 93) : aucun lien n’active l’inscription du tiers sans SON mot de passe ; reprise propre de la victime', async () => {
    const email = `${uid('r02')}@test.invalid`;
    expect(await inscrire(email, 'Victime1!xyz', 'Victime')).toBe(201);
    expect(await inscrire(email, 'Attaquant1!xyz', 'Tiers')).toBe(201); // même réponse neutre
    const [tiers] = await sql<{ id: number; first_name: string }[]>`SELECT id, first_name FROM users WHERE email = ${email}`;
    expect(tiers.first_name).toBe('Tiers');
    const [lienVictime, lienTiers] = liens(email);
    // Lien de l'inscription remplacée : refusé, reprise proposée.
    expect(loc(await ouvrirLien(lienVictime)).searchParams.get('error')).toBe('invalid_token');
    // Lien de l'inscription du tiers, reçu dans la boîte de la victime : AUCUNE activation sans le mot de passe du tiers.
    const g = await ouvrirLien(lienTiers);
    expect(loc(g).pathname).toBe('/verify-email/activer');
    const nav = new Nav();
    const r = await activer(nav, tokenDe(g), 'Victime1!xyz');
    expect(r.body.code).toBe('WRONG_SIGNUP_PASSWORD');
    expect(nav.jar.has('access_token')).toBe(false);
    expect((await sql`SELECT is_active FROM users WHERE id = ${tiers.id}`)[0].is_active).toBe(false);
    // Le tiers ne peut pas se connecter (compte jamais activé).
    expect(await connecter(new Nav(), email, 'Attaquant1!xyz')).not.toBe(200);

    // Reprise propre : la victime se réinscrit (même parcours neutre) → nouvelle inscription, la sienne.
    expect(await inscrire(email, 'Victime1!xyz', 'Victime')).toBe(201);
    const [v] = await sql<{ id: number; first_name: string }[]>`SELECT id, first_name FROM users WHERE email = ${email}`;
    expect(v.first_name).toBe('Victime');
    expect(v.id).not.toBe(tiers.id);
    // L'ancien lien du tiers n'active pas la nouvelle inscription (autre ligne, autre empreinte).
    expect(loc(await ouvrirLien(lienTiers)).searchParams.get('error')).toBe('invalid_token');
    const g2 = await ouvrirLien(liens(email).at(-1)!);
    expect((await activer(nav, tokenDe(g2), 'Victime1!xyz')).status).toBe(200);
    expect(await connecter(new Nav(), email, 'Victime1!xyz')).toBe(200);
    expect(await connecter(new Nav(), email, 'Attaquant1!xyz')).not.toBe(200);
  });

  it('R02-b même ligne réinscrite avec un autre mot de passe : nouvelle empreinte, l’ancien lien ne l’active pas', async () => {
    const email = `${uid('r02b')}@test.invalid`;
    await inscrire(email, 'Premier1!xyz');
    const [a] = await sql<{ id: number; signup_nonce: string }[]>`SELECT id, signup_nonce FROM users WHERE email = ${email}`;
    const { buildEmailVerificationUrl } = await import('@/services/auth/email-verification.service');
    // Inscription remplacée « sur place » (même identifiant, autre empreinte) : simulée en base.
    await sql`UPDATE users SET signup_nonce = 'autre-empreinte', password_hash = ${await bcrypt.hash('Second1!xyz', 4)} WHERE id = ${a.id}`;
    const vieux = buildEmailVerificationUrl(ORIGIN, { id: a.id, email, signupNonce: a.signup_nonce }, null);
    expect(loc(await ouvrirLien(vieux)).searchParams.get('error')).toBe('invalid_token');
    const nav = new Nav();
    expect((await activer(nav, new URL(vieux).searchParams.get('token'), 'Second1!xyz')).body.code).toBe('INVALID_TOKEN');
    expect((await sql`SELECT is_active FROM users WHERE id = ${a.id}`)[0].is_active).toBe(false);
  });

  it('P1 anciens liens (émis avant 96A, sans empreinte) : mènent à la page du mot de passe ; jamais suffisants seuls', async () => {
    const email = `${uid('ancien')}@test.invalid`;
    const [u] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, status, is_active, first_name, last_name)
      VALUES (${email}, ${await bcrypt.hash('Ancien1!xyz', 4)}, 'ACTIVE', false, 'Ancien', 'Lien') RETURNING id`;
    const { buildEmailVerificationUrl } = await import('@/services/auth/email-verification.service');
    const url = buildEmailVerificationUrl(ORIGIN, { id: u.id, email }, null); // format du lot 53A (aucune empreinte)
    const g = await ouvrirLien(url);
    expect(loc(g).pathname).toBe('/verify-email/activer');
    expect((g as unknown as WithCookies).cookies.get('access_token')).toBeUndefined();
    const nav = new Nav();
    expect((await activer(nav, tokenDe(g), 'Mauvais1!xyz')).body.code).toBe('WRONG_SIGNUP_PASSWORD');
    expect((await activer(nav, tokenDe(g), 'Ancien1!xyz')).status).toBe(200);
    // Lien au format base64(email:horodatage) (avant le lot 53A) : toujours refusé.
    const legacy = Buffer.from(`${email}:${Date.now()}`).toString('base64');
    expect(loc(await ouvrirLien(`${ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(legacy)}`)).searchParams.get('error')).toBe('link_outdated');
  });

  it('P1 tentatives limitées et journalisées (cohérent D1) : 5 échecs → pause, même avec le bon mot de passe', async () => {
    const email = `${uid('limite')}@test.invalid`;
    await inscrire(email, 'Limite1!xyz');
    const [u] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email}`;
    const tok = tokenDe(await ouvrirLien(liens(email)[0]));
    const nav = new Nav();
    for (let i = 0; i < 5; i++) expect((await activer(nav, tok, `Faux${i}!xyzab`)).status).toBe(401);
    const bloque = await activer(nav, tok, 'Limite1!xyz');
    expect(bloque.status).toBe(429);
    expect(JSON.stringify(bloque.body)).not.toMatch(/Limite1/);
    expect((await sql`SELECT is_active FROM users WHERE id = ${u.id}`)[0].is_active).toBe(false);
    expect(await journal(u.id, 'ACCOUNT_ACTIVATION_THROTTLED')).toHaveLength(1);
    expect((await journal(u.id, 'ACCOUNT_ACTIVATION_FAILED')).length).toBe(5);
    // Aucune valeur saisie au journal.
    const all = await sql<{ details: string }[]>`SELECT details FROM user_activity_log WHERE user_id = ${u.id}`;
    expect(JSON.stringify(all)).not.toMatch(/Faux\d|Limite1/);
  });

  // ── P3 / R08 ──────────────────────────────────────────────────────────────

  it('R08 / P3 déconnexion d’une session HÉRITÉE (antérieure au registre) : jeton d’accès ET de renouvellement refusés aussitôt', async () => {
    const u = await compte('p3');
    const ancienne = new Nav();
    expect(await connecter(ancienne, u.email)).toBe(200);
    const acces = ancienne.jar.get('access_token')!;
    const renouv = ancienne.jar.get('refresh_token')!;
    await sql`DELETE FROM user_sessions WHERE user_id = ${u.id}`; // session ouverte avant le déploiement du registre
    const r = await R();
    expect((await r.logout.POST(ancienne.req('/api/auth/logout', { method: 'POST' }))).status).toBe(200);
    // Un tiers qui aurait copié les deux jetons : refusés.
    const vol = new Nav();
    vol.jar.set('access_token', acces);
    expect(await api(vol)).toBe(401);
    const vol2 = new Nav();
    vol2.jar.set('refresh_token', renouv);
    expect(await renouveler(vol2)).toBe(401);
    // Les autres sessions de l'utilisateur ne sont pas touchées.
    const autre = new Nav();
    expect(await connecter(autre, u.email)).toBe(200);
    expect(await api(autre)).toBe(200);
  });

  // ── Q7 / R09 ──────────────────────────────────────────────────────────────

  it('R09 preuve Q7 : expirée ou d’une autre session refusée ; jamais prolongée par une action ; retirée à la déconnexion', async () => {
    const u = await compte('r09');
    const a = new Nav(); const b = new Nav('Mozilla/5.0 (Macintosh) Firefox/131.0');
    await connecter(a, u.email); await connecter(b, u.email);
    expect((await demanderChangement(a, `${uid('n')}@test.invalid`)).body.code).toBe('REAUTH_REQUIRED');
    expect(await confirmerIdentite(a)).toBe(200);
    const [p1] = await sql<{ expires_at: Date }[]>`SELECT expires_at FROM reauth_proofs WHERE user_id = ${u.id}`;
    // Une autre session n'en profite pas.
    expect((await demanderChangement(b, `${uid('n')}@test.invalid`)).body.code).toBe('REAUTH_REQUIRED');
    // Deux actions successives : échéance inchangée (jamais prolongée).
    expect((await demanderChangement(a, `${uid('n')}@test.invalid`)).status).toBe(200);
    expect((await demanderChangement(a, `${uid('n')}@test.invalid`)).status).toBe(200);
    const [p2] = await sql<{ expires_at: Date }[]>`SELECT expires_at FROM reauth_proofs WHERE user_id = ${u.id}`;
    expect(new Date(p2.expires_at).getTime()).toBe(new Date(p1.expires_at).getTime());
    // Expirée → refusée.
    await sql`UPDATE reauth_proofs SET expires_at = now() - interval '1 second' WHERE user_id = ${u.id}`;
    expect((await demanderChangement(a, `${uid('n')}@test.invalid`)).body.code).toBe('REAUTH_EXPIRED');
    // Déconnexion → preuve retirée, y compris pour une session absente du registre.
    expect(await confirmerIdentite(b)).toBe(200);
    await sql`DELETE FROM user_sessions WHERE user_id = ${u.id} AND sid = ${jwtPayload(b.jar.get('access_token')!).sid}`;
    const r = await R();
    await r.logout.POST(b.req('/api/auth/logout', { method: 'POST' }));
    expect(await sql`SELECT 1 FROM reauth_proofs WHERE sid = ${jwtPayload(b.jar.get('access_token')!).sid}`).toHaveLength(0);
  });

  it('R09 révocation d’une session et changement d’identifiant (dissociation Google) retirent les preuves', async () => {
    // Révocation d'une session : sa preuve disparaît.
    const u = await compte('r09r');
    const a = new Nav(); const b = new Nav('Mozilla/5.0 (Macintosh) Firefox/131.0');
    await connecter(a, u.email); await connecter(b, u.email);
    expect(await confirmerIdentite(b)).toBe(200);
    const r = await R();
    const liste = await (await r.sessions.GET(a.req('/api/users/me/sessions'))).json();
    const idB = liste.sessions.find((s: { current: boolean }) => !s.current).id;
    const { DELETE } = await import('@/app/api/users/me/sessions/[id]/route');
    expect((await DELETE(a.req(`/api/users/me/sessions/${idB}`, { method: 'DELETE' }), { params: Promise.resolve({ id: idB }) })).status).toBe(200);
    expect(await sql`SELECT 1 FROM reauth_proofs WHERE user_id = ${u.id}`).toHaveLength(0);

    // Dissociation d'un fournisseur : toutes les preuves de l'utilisateur retirées.
    const v = await compte('r09u');
    await sql`INSERT INTO auth_identities (user_id, provider, issuer, subject, linked_at) VALUES (${v.id}, 'google', 'https://accounts.google.com', ${uid('sub')}, now())`;
    const x = new Nav(); const y = new Nav('Mozilla/5.0 (Macintosh) Firefox/131.0');
    await connecter(x, v.email); await connecter(y, v.email);
    expect(await confirmerIdentite(x)).toBe(200);
    expect(await confirmerIdentite(y)).toBe(200);
    expect((await r.identity.DELETE(x.req('/api/users/me/auth-identities/google', { method: 'DELETE' }), p('google'))).status).toBe(200);
    expect(await sql`SELECT 1 FROM reauth_proofs WHERE user_id = ${v.id}`).toHaveLength(0);
  });

  it('R09 suppression du compte : même avec une preuve fraîche, l’intention explicite (« SUPPRIMER MON COMPTE ») est exigée', async () => {
    const u = await compte('r09d');
    const a = new Nav();
    await connecter(a, u.email);
    expect(await confirmerIdentite(a)).toBe(200);
    const r = await R();
    for (const confirmation of [undefined, 'supprimer', 'OUI']) {
      const res = await r.deletion.POST(a.req('/api/users/me/deletion', { method: 'POST', body: { confirmation } }));
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect((await sql`SELECT status FROM users WHERE id = ${u.id}`)[0].status).toBe('ACTIVE');
    expect(await sql`SELECT 1 FROM reauth_proofs WHERE user_id = ${u.id} AND consumed_at IS NULL`).toHaveLength(1);
  });

  // ── Q8 / R10 / R11 ────────────────────────────────────────────────────────

  it('R10 changement d’adresse : ancienne active avant confirmation ; confirmation → bascule, alertes aux deux, autres sessions (anciennes comprises) coupées, session courante conservée', async () => {
    const u = await compte('r10');
    const a = new Nav(); const b = new Nav('Mozilla/5.0 (Macintosh) Firefox/131.0'); const ancienne = new Nav('Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile');
    await connecter(ancienne, u.email);
    await sql`DELETE FROM user_sessions WHERE user_id = ${u.id}`; // session antérieure au registre
    await connecter(a, u.email); await connecter(b, u.email);
    const nouvelle = `${uid('nouvelle')}@test.invalid`;

    expect(await confirmerIdentite(a)).toBe(200);
    const d = await demanderChangement(a, nouvelle);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ success: true, pending: { newEmail: nouvelle } });
    // EMAIL-04 : l'ancienne reste principale et identifiant de connexion.
    expect((await sql`SELECT email FROM users WHERE id = ${u.id}`)[0].email).toBe(u.email);
    expect(await connecter(new Nav(), u.email)).toBe(200);
    expect(await connecter(new Nav(), nouvelle)).not.toBe(200);
    const token = lienChangement(nouvelle);
    expect(token).toBeTruthy();
    // Aucun lien en clair en base (empreinte seulement).
    expect(JSON.stringify(await sql`SELECT * FROM email_change_requests WHERE user_id = ${u.id}`)).not.toContain(token!);

    sent.length = 0;
    const c = await confirmerChangement(a, token!);
    expect(c.status).toBe(200);
    expect(c.body.email).toBe(nouvelle);
    expect((await sql`SELECT email, is_active FROM users WHERE id = ${u.id}`)[0]).toEqual({ email: nouvelle, is_active: true });
    // Notification aux DEUX adresses.
    expect(sent.filter((m) => m.templateCode === 'PRIMARY_EMAIL_CHANGED').map((m) => m.to).sort()).toEqual([u.email, nouvelle].sort());
    // Autres sessions coupées (accès ET renouvellement), y compris l'ancienne non inscrite.
    for (const x of [b, ancienne]) {
      expect(await api(x)).toBe(401);
      expect(await renouveler(x)).toBe(401);
    }
    // Session courante conservée, jetons réémis avec la nouvelle adresse.
    expect(await api(a)).toBe(200);
    expect(jwtPayload(a.jar.get('access_token')!).email).toBe(nouvelle);
    expect(await renouveler(a)).toBe(200);
    // Preuve Q7 invalidée par la bascule.
    expect(await sql`SELECT 1 FROM reauth_proofs WHERE user_id = ${u.id}`).toHaveLength(0);
    // Connexion : nouvelle adresse seulement.
    expect(await connecter(new Nav(), nouvelle)).toBe(200);
    expect(await connecter(new Nav(), u.email)).not.toBe(200);
    // Lien à usage unique.
    expect((await confirmerChangement(a, token!)).body.code).toBe('LINK_USED');
    expect(await journal(u.id, 'PRIMARY_EMAIL_CHANGED')).toHaveLength(1);
  });

  it('INT96 changement d’adresse : appareils connus toujours reconnus (pas d’alerte Q6, règle A de D1) ; adresse reprise sans appareil hérité ; push des autres appareils coupé, session héritée comprise', async () => {
    const { trustedDeviceForLogin } = await import('@/lib/auth/device-account');
    const { __legacyDeviceCookieValueForTests } = await import('@/lib/auth/device-trust');
    const { registerPushInstallation } = await import('@/lib/mobile/push-installations');
    const u = await compte('int96');
    // Compte créé hier : un cookie d'appareil HÉRITÉ (adresse, avant l'intégration) émis il y a une heure est le sien.
    await sql`UPDATE users SET created_at = now() - interval '1 day' WHERE id = ${u.id}`;
    const herite = __legacyDeviceCookieValueForTests(u.email.toLowerCase(), Date.now() - 3600_000);
    const a = new Nav(); const b = new Nav('Mozilla/5.0 (Macintosh) Firefox/131.0');
    expect(await connecter(b, u.email)).toBe(200);
    expect(await connecter(a, u.email)).toBe(200);
    const sidDe = (n: Nav) => jwtPayload(n.jar.get('access_token')!).sid as string;
    const telephone = async (sessionId: string | null) => {
      const installationId = crypto.randomUUID();
      await registerPushInstallation({ userId: u.id, accountId: u.accountId, sessionId, installationId, platform: 'android', appVersion: '1.0.0', build: '1', pushToken: `int96-${installationId}` });
      return installationId;
    };
    const instA = await telephone(sidDe(a));
    const instB = await telephone(sidDe(b));
    const instHeritee = await telephone(null); // session antérieure au registre
    const statut = async (id: string) => (await sql<{ status: string }[]>`SELECT status FROM mobile_push_installations WHERE installation_id = ${id}`)[0].status;
    const alertes = async (userId: number) => (await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${userId} AND event_type = 'NEW_DEVICE_LOGIN'`).length;

    const nouvelle = `${uid('int96n')}@test.invalid`;
    expect(await confirmerIdentite(a)).toBe(200);
    expect((await demanderChangement(a, nouvelle)).status).toBe(200);
    expect((await confirmerChangement(a, lienChangement(nouvelle)!)).status).toBe(200);

    // (c) Push : autres appareils coupés (session du registre ET session héritée), cet appareil conservé.
    expect(await statut(instB)).toBe('logged_out');
    expect(await statut(instHeritee)).toBe('logged_out');
    expect(await statut(instA)).toBe('active');

    // (a) B (déconnecté par la bascule) se reconnecte avec la NOUVELLE adresse : appareil reconnu.
    const n0 = await alertes(u.id);
    expect(await trustedDeviceForLogin(b.req('/api/auth/login', { method: 'POST' }), nouvelle, nouvelle)).toBeTruthy();
    expect(await connecter(b, nouvelle)).toBe(200);
    expect(await alertes(u.id)).toBe(n0); // aucune fausse alerte Q6
    // Cookie hérité (adresse d'origine) : toujours reconnu après le changement, pour CE compte.
    const h = new Nav(); h.jar.set('vb_device', herite.value);
    expect(await trustedDeviceForLogin(h.req('/api/auth/login', { method: 'POST' }), nouvelle, nouvelle)).toBe(herite.deviceId);

    // Usurpation : un AUTRE compte prend l'ancienne adresse — aucun appareil de U n'est reconnu pour lui.
    const v = await make.user({ email: u.email });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE' WHERE id = ${v.id}`;
    expect(await trustedDeviceForLogin(b.req('/api/auth/login', { method: 'POST' }), u.email, u.email)).toBeNull();
    expect(await trustedDeviceForLogin(h.req('/api/auth/login', { method: 'POST' }), u.email, u.email)).toBeNull();
  });

  it('R10 lien expiré, lien d’un autre compte, demande annulée : rien ne change', async () => {
    const u = await compte('r10x');
    const a = new Nav();
    await connecter(a, u.email);
    expect(await confirmerIdentite(a)).toBe(200);
    const n1 = `${uid('exp')}@test.invalid`;
    await demanderChangement(a, n1);
    const t1 = lienChangement(n1)!;
    await sql`UPDATE email_change_requests SET expires_at = now() - interval '1 second' WHERE user_id = ${u.id}`;
    expect((await confirmerChangement(a, t1)).body.code).toBe('LINK_EXPIRED');
    // Lien d'un autre compte.
    const v = await compte('r10y');
    const b = new Nav();
    await connecter(b, v.email);
    expect(await confirmerIdentite(a)).toBe(200);
    const n2 = `${uid('autre')}@test.invalid`;
    await demanderChangement(a, n2);
    const t2 = lienChangement(n2)!;
    expect((await confirmerChangement(b, t2)).body.code).toBe('WRONG_ACCOUNT');
    // Annulation : le lien ne fonctionne plus.
    const r = await R();
    expect((await r.emailChange.DELETE(a.req('/api/users/me/email-change', { method: 'DELETE' }))).status).toBe(200);
    expect((await confirmerChangement(a, t2)).body.code).toBe('LINK_USED');
    expect((await sql`SELECT email FROM users WHERE id = ${u.id}`)[0].email).toBe(u.email);
    expect((await sql`SELECT email FROM users WHERE id = ${v.id}`)[0].email).toBe(v.email);
  });

  it('R10 adresse déjà utilisée par un autre compte : réponse identique (non énumérable), aucun lien, information au titulaire, ni fusion ni transfert', async () => {
    const u = await compte('r10c');
    const autre = await compte('r10o');
    const a = new Nav();
    await connecter(a, u.email);
    expect(await confirmerIdentite(a)).toBe(200);
    const libre = await demanderChangement(a, `${uid('libre')}@test.invalid`);
    sent.length = 0;
    const prise = await demanderChangement(a, autre.email.toUpperCase());
    expect(prise.status).toBe(libre.status);
    expect(Object.keys(prise.body).sort()).toEqual(Object.keys(libre.body).sort());
    expect(prise.body.message).toBe(libre.body.message);
    expect(sent.filter((m) => m.templateCode === 'EMAIL_CHANGE_CONFIRMATION')).toHaveLength(0);
    expect(sent.filter((m) => m.templateCode === 'EMAIL_CHANGE_ADDRESS_IN_USE').map((m) => m.to)).toEqual([autre.email]);
    expect((await sql`SELECT email FROM users WHERE id = ${u.id}`)[0].email).toBe(u.email);

    // Adresse prise ENTRE la demande et la confirmation : refus, rien ne bouge.
    const cible = `${uid('course')}@test.invalid`;
    await demanderChangement(a, cible);
    const t = lienChangement(cible)!;
    await sql`UPDATE users SET email = ${cible} WHERE id = ${autre.id}`;
    expect((await confirmerChangement(a, t)).body.code).toBe('ADDRESS_UNAVAILABLE');
    expect((await sql`SELECT email FROM users WHERE id = ${u.id}`)[0].email).toBe(u.email);
    expect((await sql`SELECT email FROM users WHERE id = ${autre.id}`)[0].email).toBe(cible);
    expect(await api(a)).toBe(200);
  });

  it('R11 changement d’adresse : biens, Duo, abonnement, identifiant Stripe et identité Google inchangés ; client Stripe existant mis à jour, jamais créé', async () => {
    const acc = await make.account({ plan: 'premium_duo' });
    const email = `${uid('r11')}@test.invalid`;
    await sql`UPDATE users SET email = ${email}, password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE', first_name = 'Camille' WHERE id = ${acc.ownerUserId}`;
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    await applyPlanChange({
      accountId: acc.id, ownerUserId: acc.ownerUserId, oldPlanType: 'STANDARD', newPlanType: 'PREMIUM_DUO',
      newSubStatus: 'ACTIVE', newPremiumUntil: null, newMaxMembers: 2, source: 'e2e:l96a', sendEmails: false,
    });
    await make.asset(acc, { name: `R11-maison-${acc.id}` });
    const cus = `cus_e2e_${uid('c')}`;
    await sql`UPDATE accounts SET stripe_customer_id = ${cus} WHERE id = ${acc.id}`;
    await sql`UPDATE duo_accounts SET stripe_customer_id = ${cus} WHERE billing_owner_user_id = ${acc.ownerUserId}`;
    await sql`INSERT INTO auth_identities (user_id, provider, issuer, subject, linked_at) VALUES (${acc.ownerUserId}, 'google', 'https://accounts.google.com', ${uid('sub-r11')}, now())`;
    const photo = async () => ({
      assets: await sql`SELECT id, name, account_id FROM assets WHERE account_id = ${acc.id} ORDER BY id`,
      account: await sql`SELECT id, owner_user_id, stripe_customer_id, duo_account_id FROM accounts WHERE id = ${acc.id}`,
      subs: await sql`SELECT plan_code, status FROM account_subscriptions WHERE account_id = ${acc.id} ORDER BY id`,
      duo: await sql`SELECT id, stripe_customer_id, billing_owner_user_id FROM duo_accounts WHERE billing_owner_user_id = ${acc.ownerUserId}`,
      duoMembers: await sql`SELECT duo_id, user_id, status FROM duo_memberships WHERE user_id = ${acc.ownerUserId} ORDER BY duo_id`,
      memberships: await sql`SELECT account_id, role, status FROM account_memberships WHERE user_id = ${acc.ownerUserId} ORDER BY account_id`,
      identities: await sql`SELECT provider, issuer, subject FROM auth_identities WHERE user_id = ${acc.ownerUserId}`,
    });
    const avant = await photo();
    expect(avant.assets).toHaveLength(1);
    expect(avant.duo).toHaveLength(1);

    const a = new Nav();
    expect(await connecter(a, email)).toBe(200);
    expect(await confirmerIdentite(a)).toBe(200);
    const nouvelle = `${uid('r11n')}@test.invalid`;
    await demanderChangement(a, nouvelle);
    stripeCalls.length = 0;
    expect((await confirmerChangement(a, lienChangement(nouvelle)!)).status).toBe(200);
    expect(await photo()).toEqual(avant);
    expect(stripeCalls).toEqual([{ id: cus, email: nouvelle }]);
    expect(await sql`SELECT 1 FROM users WHERE email = ${nouvelle}`).toHaveLength(1); // aucun compte dupliqué
    expect(await sql`SELECT 1 FROM users WHERE email = ${email}`).toHaveLength(0);
  });

  // ── R14 : compte social-only ──────────────────────────────────────────────

  it('R14 compte social-only : pas de mot de passe à l’activation ni à la confirmation ; réauthentification Google fraîche exigée pour changer l’adresse', async () => {
    const r = await R();
    const b = new Nav();
    const user: FakeUser = { sub: uid('google-sub'), email: `${uid('soc')}@test.invalid`, givenName: 'Sam', familyName: 'Social' };
    const start = b.absorb(await r.oauthStart.GET(b.req(`/api/auth/oauth/google/start?intent=signup`), p('google')));
    const az = fake.authorize(start.headers.get('location')!, user);
    const cb = b.absorb(await r.oauthCallback.GET(b.req(`/api/auth/oauth/google/callback?${new URLSearchParams({ state: az.state, code: az.code })}`), p('google')));
    expect(loc(cb).pathname).toBe('/connexion-sociale');
    const done = b.absorb(await r.oauthPending.POST(b.req('/api/auth/oauth/pending', { method: 'POST', body: { action: 'signup', firstName: 'Sam', lastName: 'Social', email: user.email, acceptedTerms: true, termsVersion: await cgvu() } })));
    expect(done.status).toBe(200);
    const [u] = await sql<{ id: number; password_hash: string | null; is_active: boolean; signup_nonce: string | null }[]>`
      SELECT id, password_hash, is_active, signup_nonce FROM users WHERE email = ${user.email!}`;
    // Q9 : jamais concerné — actif d'emblée, aucune empreinte, aucun mot de passe.
    expect(u).toMatchObject({ password_hash: null, is_active: true, signup_nonce: null });
    expect(liens(user.email!)).toHaveLength(0);

    // Sans réauthentification : refus. Le mot de passe n'est pas une méthode pour ce compte.
    expect((await demanderChangement(b, `${uid('n')}@test.invalid`)).body.code).toBe('REAUTH_REQUIRED');
    expect(await confirmerIdentite(b, 'nimporte1!X')).not.toBe(200);
    // Réauthentification Google réelle (même subject) → preuve serveur → demande acceptée.
    const s = b.absorb(await r.providerReauth.POST(b.req('/api/users/me/auth-identities/google/reauth', { method: 'POST', body: { resume: 'change-email' } }), p('google')));
    expect(s.status).toBe(200);
    const az2 = fake.authorize((await s.json()).redirectUrl, user);
    const back = b.absorb(await r.oauthCallback.GET(b.req(`/api/auth/oauth/google/callback?${new URLSearchParams({ state: az2.state, code: az2.code })}`), p('google')));
    expect(loc(back).searchParams.get('securite')).toBe('reauth');
    expect(loc(back).searchParams.get('resume')).toBe('change-email');
    const nouvelle = `${uid('socn')}@test.invalid`;
    expect((await demanderChangement(b, nouvelle)).status).toBe(200);
    const c = await confirmerChangement(b, lienChangement(nouvelle)!);
    expect(c.status).toBe(200);
    // Identité Google conservée (identifiant stable), toujours aucun mot de passe.
    expect(await sql`SELECT provider, subject FROM auth_identities WHERE user_id = ${u.id}`).toEqual([{ provider: 'google', subject: user.sub }]);
    expect((await sql`SELECT email, password_hash FROM users WHERE id = ${u.id}`)[0]).toEqual({ email: nouvelle, password_hash: null });
  });
});
