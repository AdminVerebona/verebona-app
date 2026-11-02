/**
 * Lot 103B — « Prénom ou pseudo » (décision PO du 31/10/2026) : un seul nom
 * obligatoire à l'inscription, `users.username` NON unique en base ET en
 * code, prénom / nom civils facultatifs jamais fabriqués, « Compte de
 * Sophie », anciens clients compatibles, Google / Apple avec un seul champ,
 * profil modifiable partiellement. PostgreSQL réel, vraies routes, faux
 * fournisseur OIDC local (`../fake-oidc.ts`).
 *
 * Recette du ticket (§8) couverte ici : deux « Sophie » (création, activation,
 * connexion indépendantes, aucune 409 / erreur SQL), deux comptes existants
 * prenant le même pseudo, pseudo absent / vide / espaces / trop long /
 * Unicode / HTML, inscription sans civils, ancien payload mobile, Google /
 * Apple avec et sans prénom, profil partiel sans perte des civils, schéma
 * (contrainte username absente, unicité e-mail présente, migration 0935
 * rejouable).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { activerParLien } from '../activation';
import { createFakeOidc, type FakeUser } from '../fake-oidc';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'NouveauMdp1!x';
const fake = createFakeOidc();
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(fake.env)) { saved[k] = process.env[k]; process.env[k] = v; }

type Provider = 'google' | 'apple';
type WithCookies = Response & { cookies: { getAll(): Array<{ name: string; value: string; maxAge?: number }>; get(n: string): { value: string } | undefined } };

class Browser {
  jar = new Map<string, string>();
  ip = `103.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
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
const p = (provider: string) => ({ params: Promise.resolve({ provider }) });

scenario('L103B', 'Inscription « Prénom ou pseudo » non unique — lot 103B', ({ sql }) => {
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

  /** Inscription telle que l'envoie le NOUVEAU formulaire (aucun champ civil). */
  async function inscription(body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/users/route');
    const b = new Browser();
    const res = await POST(b.req('/api/users', {
      method: 'POST',
      body: { password: PASSWORD, acceptedTerms: true, termsVersion: await cgvu(), planType: 'STANDARD', ...body },
    }));
    return { status: res.status, body: await res.json() as Record<string, any> };
  }

  async function activer(email: string) {
    const [u] = await sql<{ id: number; email: string; signup_nonce: string | null }[]>`SELECT id, email, signup_nonce FROM users WHERE email = ${email}`;
    const { buildEmailVerificationUrl } = await import('@/services/auth/email-verification.service');
    const url = buildEmailVerificationUrl(ORIGIN, { id: u.id, email: u.email, signupNonce: u.signup_nonce }, null);
    return activerParLien(url, PASSWORD);
  }

  async function connexion(email: string) {
    const { POST } = await import('@/app/api/auth/login/route');
    const b = new Browser();
    const res = b.absorb(await POST(b.req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } })));
    return { res, b };
  }

  async function profil(b: Browser, body: Record<string, unknown>) {
    const { PUT } = await import('@/app/api/users/me/route');
    const res = await PUT(b.req('/api/users/me', { method: 'PUT', body }));
    return { status: res.status, body: await res.json() as Record<string, any> };
  }

  // ── Schéma ───────────────────────────────────────────────────────────────

  it('L103B-DB-01 aucune contrainte / index UNIQUE sur users.username ; unicité de l’e-mail conservée ; migration 0935 rejouable', async () => {
    const uniquesSur = async (col: string) => sql<{ name: string }[]>`
      SELECT i.relname AS name FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(x.indkey)
       WHERE t.relname = 'users' AND x.indisunique AND a.attname = ${col}`;
    expect(await uniquesSur('username')).toEqual([]);
    expect((await uniquesSur('email')).length).toBeGreaterThanOrEqual(1);
    const cons = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'u'`;
    expect(cons.map((c) => c.conname)).not.toContain('users_username_unique');
    expect(cons.map((c) => c.conname)).toContain('users_email_unique');

    // Base déployée d'avant le lot : contrainte présente, + un index unique manuel → la migration les retire, deux fois de suite sans erreur.
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0935_l103b_pseudo_non_unique.sql'), 'utf8');
    await sql`UPDATE users SET username = NULL WHERE username IS NOT NULL`;
    await sql.unsafe('ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username)');
    await sql.unsafe('CREATE UNIQUE INDEX users_username_lower_e2e ON users (lower(username))');
    expect((await uniquesSur('username')).length).toBe(1); // l'index d'expression n'apparaît pas dans indkey
    await sql.begin(async (tx) => { await tx.unsafe(migration); });
    await sql.begin(async (tx) => { await tx.unsafe(migration); });
    expect(await uniquesSur('username')).toEqual([]);
    expect(await sql`SELECT 1 FROM pg_class WHERE relname = 'users_username_lower_e2e'`).toHaveLength(0);
    expect((await uniquesSur('email')).length).toBeGreaterThanOrEqual(1);
  });

  // ── Deux « Sophie » ──────────────────────────────────────────────────────

  it('L103B-E2E-01 deux nouveaux utilisateurs « Sophie » (adresses distinctes) : créations, activations et connexions indépendantes, aucune 409', async () => {
    const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
    const e1 = `${uid('sophie1')}@test.invalid`;
    const e2 = `${uid('sophie2')}@test.invalid`;
    const a = await inscription({ email: e1, username: 'Sophie' });
    const b = await inscription({ email: e2, username: '  Sophie  ' });
    expect(a.status).toBe(201);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).not.toMatch(/DUPLICATE|déjà/i);

    const rows = await sql<{ id: number; username: string; first_name: string; last_name: string }[]>`
      SELECT id, username, first_name, last_name FROM users WHERE email IN (${e1}, ${e2}) ORDER BY id`;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ username: 'Sophie', first_name: '', last_name: '' }); // aucun civil fabriqué
    const comptes = await sql<{ name: string }[]>`
      SELECT a.name FROM accounts a WHERE a.owner_user_id IN (${rows[0].id}, ${rows[1].id})`;
    expect(comptes.map((c) => c.name)).toEqual(['Compte de Sophie', 'Compte de Sophie']);
    expect(await sql`SELECT 1 FROM trial_grants WHERE email_normalized IN (${e1}, ${e2})`).toHaveLength(2);
    expect(await sql`SELECT 1 FROM legal_acceptances WHERE user_id IN (${rows[0].id}, ${rows[1].id})`).toHaveLength(2);

    // E-mail de vérification : salutation par le pseudo.
    await settleDetachedAuthTasks();
    const mails = await sql<{ metadata: string | null }[]>`
      SELECT metadata FROM email_logs WHERE template_code = 'EMAIL_VERIFICATION' AND recipient_email IN (${e1}, ${e2})`;
    expect(mails).toHaveLength(2);
    for (const m of mails) expect(JSON.parse(m.metadata ?? '{}').firstName).toBe('Sophie');

    for (const e of [e1, e2]) {
      const act = await activer(e);
      expect(act.headers.get('location')).not.toMatch(/refus|error/);
      const { res } = await connexion(e);
      expect(res.status).toBe(200);
    }
    // /api/users/me : chacun voit SON compte, même pseudo.
    const ids = new Set<number>();
    for (const e of [e1, e2]) {
      const { b: br } = await connexion(e);
      const { GET } = await import('@/app/api/users/me/route');
      const me = await (await GET(br.req('/api/users/me'))).json();
      expect(me).toMatchObject({ email: e, username: 'Sophie', firstName: '', lastName: '' });
      ids.add(me.id);
    }
    expect(ids.size).toBe(2);
  });

  // ── Validations ──────────────────────────────────────────────────────────

  it('L103B-E2E-02 pseudo absent, vide, espaces, invisible, trop long, contrôle : 400 cohérents, rien créé ; Unicode et HTML acceptés comme texte', async () => {
    const cas: Array<[Record<string, unknown>, string]> = [
      [{}, 'MISSING_DISPLAY_NAME'],
      [{ username: '' }, 'MISSING_DISPLAY_NAME'],
      [{ username: '    ' }, 'MISSING_DISPLAY_NAME'],
      [{ username: '\u200b\u200b' }, 'MISSING_DISPLAY_NAME'],
      [{ username: 'S'.repeat(61) }, 'DISPLAY_NAME_TOO_LONG'],
      [{ username: 'So\u0000phie' }, 'INVALID_DISPLAY_NAME'],
    ];
    for (const [over, code] of cas) {
      const email = `${uid('refus')}@test.invalid`;
      const r = await inscription({ email, ...over });
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(r.body.code).toBe(code);
      expect(await sql`SELECT 1 FROM users WHERE email = ${email}`).toHaveLength(0);
    }
    const ok: Array<[string, string]> = [
      ['S'.repeat(60), 'S'.repeat(60)],
      ['  Zoé-Ånne   Lê 李  ', 'Zoé-Ånne Lê 李'],
      ['<b>Sophie</b> & "Cie"', '<b>Sophie</b> & "Cie"'],
      ['👩\u200d👩\u200d👧 Famille', '👩\u200d👩\u200d👧 Famille'],
    ];
    for (const [saisi, attendu] of ok) {
      const email = `${uid('ok')}@test.invalid`;
      expect((await inscription({ email, username: saisi })).status).toBe(201);
      const [u] = await sql<{ username: string; id: number }[]>`SELECT id, username FROM users WHERE email = ${email}`;
      expect(u.username).toBe(attendu);
      const [acc] = await sql<{ name: string }[]>`SELECT name FROM accounts WHERE owner_user_id = ${u.id}`;
      expect(acc.name).toBe(`Compte de ${attendu}`);
    }
  });

  it('L103B-E2E-03 anciens clients (prénom + nom, sans username ou username vide) : acceptés, le prénom devient le nom d’affichage, civils conservés', async () => {
    const e1 = `${uid('ancien')}@test.invalid`;
    expect((await inscription({ email: e1, firstName: 'Claire', lastName: 'Martin' })).status).toBe(201);
    const e2 = `${uid('ancien')}@test.invalid`;
    expect((await inscription({ email: e2, firstName: 'Paul', lastName: 'Durand', username: '' })).status).toBe(201);
    const e3 = `${uid('ancien')}@test.invalid`;
    expect((await inscription({ email: e3, firstName: 'Paul', lastName: 'Durand', username: 'Polo' })).status).toBe(201);
    const rows = await sql<{ email: string; username: string; first_name: string; last_name: string; name: string }[]>`
      SELECT u.email, u.username, u.first_name, u.last_name, a.name FROM users u JOIN accounts a ON a.owner_user_id = u.id
       WHERE u.email IN (${e1}, ${e2}, ${e3})`;
    const by = Object.fromEntries(rows.map((r) => [r.email, r]));
    expect(by[e1]).toMatchObject({ username: 'Claire', first_name: 'Claire', last_name: 'Martin', name: 'Compte de Claire' });
    expect(by[e2]).toMatchObject({ username: 'Paul', first_name: 'Paul', last_name: 'Durand' });
    expect(by[e3]).toMatchObject({ username: 'Polo', first_name: 'Paul', last_name: 'Durand', name: 'Compte de Polo' });
  });

  // ── Profil ───────────────────────────────────────────────────────────────

  it('L103B-E2E-04 profil : pseudo seul modifiable sans civils, mise à jour partielle sans effacement, deux comptes existants prennent le même pseudo', async () => {
    const e1 = `${uid('prof1')}@test.invalid`;
    const e2 = `${uid('prof2')}@test.invalid`;
    await inscription({ email: e1, firstName: 'Jeanne', lastName: 'Historique', username: 'Jeannot' });
    await inscription({ email: e2, username: 'Marc' });
    for (const e of [e1, e2]) await activer(e);
    const s1 = (await connexion(e1)).b;
    const s2 = (await connexion(e2)).b;

    // Pseudo seul : plus de « Le prénom et le nom sont requis » ; civils historiques intacts.
    expect(await profil(s1, { username: 'Sophie' })).toEqual({ status: 200, body: { success: true } });
    expect(await profil(s2, { username: 'Sophie' })).toEqual({ status: 200, body: { success: true } });
    const rows = await sql<{ email: string; username: string; first_name: string; last_name: string }[]>`
      SELECT email, username, first_name, last_name FROM users WHERE email IN (${e1}, ${e2})`;
    const by = Object.fromEntries(rows.map((r) => [r.email, r]));
    expect(by[e1]).toMatchObject({ username: 'Sophie', first_name: 'Jeanne', last_name: 'Historique' });
    expect(by[e2]).toMatchObject({ username: 'Sophie', first_name: '', last_name: '' });

    // Civils seuls : le pseudo n'est pas touché ; nom civil facultatif ajouté.
    expect((await profil(s2, { firstName: '  Marc ', lastName: 'Leroy' })).status).toBe(200);
    const [m] = await sql<{ username: string; first_name: string; last_name: string }[]>`SELECT username, first_name, last_name FROM users WHERE email = ${e2}`;
    expect(m).toEqual({ username: 'Sophie', first_name: 'Marc', last_name: 'Leroy' });

    // Refus cohérents avec l'inscription ; rien n'est modifié.
    expect((await profil(s1, { username: '   ' })).body.code).toBe('MISSING_DISPLAY_NAME');
    expect((await profil(s1, { username: 'x'.repeat(61) })).body.code).toBe('DISPLAY_NAME_TOO_LONG');
    const [j] = await sql<{ username: string }[]>`SELECT username FROM users WHERE email = ${e1}`;
    expect(j.username).toBe('Sophie');

    // Lecture immédiate (cache serveur invalidé) : le nouveau pseudo est visible.
    const { GET } = await import('@/app/api/users/me/route');
    await GET(s1.req('/api/users/me'));
    await profil(s1, { username: 'Sophie B.' });
    const me = await (await GET(s1.req('/api/users/me'))).json();
    expect(me.username).toBe('Sophie B.');
  });

  // ── Google / Apple ───────────────────────────────────────────────────────

  async function socialStart(b: Browser, provider: Provider, user: FakeUser, query: Record<string, string> = {}) {
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
  async function pending(b: Browser, body?: Record<string, unknown>) {
    const route = await import('@/app/api/auth/oauth/pending/route');
    const res = b.absorb(body
      ? await route.POST(b.req('/api/auth/oauth/pending', { method: 'POST', body }))
      : await route.GET(b.req('/api/auth/oauth/pending')));
    return { res, status: res.status, body: await res.json() as Record<string, any> };
  }

  it('L103B-E2E-05 Google avec prénom : un seul champ prérempli et modifiable ; compte social-only « Compte de <pseudo> », civils non recopiés ; deux « Sophie » Google', async () => {
    const termsVersion = await cgvu();
    const users: number[] = [];
    for (const n of [1, 2]) {
      const b = new Browser();
      const email = `${uid(`g-sophie${n}`)}@test.invalid`;
      const cb = await socialStart(b, 'google', { sub: uid('g103'), email, givenName: 'Sophie', familyName: 'Fournisseur' }, { ref: 'PARRAIN1' });
      expect(loc(cb).pathname).toBe('/connexion-sociale');
      const st = await pending(b);
      expect(st.body).toMatchObject({ suggestedDisplayName: 'Sophie', referralCode: 'PARRAIN1' });
      // Pseudo vide refusé, rien créé.
      const vide = await pending(b, { action: 'signup', username: '  ', email, acceptedTerms: true, termsVersion });
      expect(vide.status).toBe(400);
      expect(vide.body.code).toBe('MISSING_DISPLAY_NAME');
      expect(await sql`SELECT 1 FROM users WHERE email = ${email}`).toHaveLength(0);
      const done = await pending(b, { action: 'signup', username: 'Sophie', email, acceptedTerms: true, termsVersion });
      expect(done.status).toBe(200);
      const [u] = await sql<{ id: number; username: string; first_name: string; last_name: string; password_hash: string | null }[]>`
        SELECT id, username, first_name, last_name, password_hash FROM users WHERE email = ${email}`;
      expect(u).toMatchObject({ username: 'Sophie', first_name: '', last_name: '', password_hash: null });
      const [acc] = await sql<{ name: string }[]>`SELECT name FROM accounts WHERE owner_user_id = ${u.id}`;
      expect(acc.name).toBe('Compte de Sophie');
      users.push(u.id);
    }
    expect(new Set(users).size).toBe(2);
  });

  it('L103B-E2E-06 Apple sans nom transmis (autorisation suivante, adresse relais) : champ vide à remplir avant création ; ancien formulaire (prénom + nom) toujours accepté', async () => {
    const termsVersion = await cgvu();
    const b = new Browser();
    const relay = `${uid('rel103')}@privaterelay.appleid.com`;
    const cb = await socialStart(b, 'apple', { sub: uid('a103'), email: relay, privateRelay: true, appleName: null });
    expect(loc(cb).pathname).toBe('/connexion-sociale');
    const st = await pending(b);
    expect(st.body.suggestedDisplayName ?? null).toBeNull();
    expect((await pending(b, { action: 'signup', email: relay, acceptedTerms: true, termsVersion })).body.code).toBe('MISSING_DISPLAY_NAME');
    expect((await pending(b, { action: 'signup', username: 'Zoé', email: relay, acceptedTerms: true, termsVersion })).status).toBe(200);
    const [u] = await sql<{ username: string; first_name: string }[]>`SELECT username, first_name FROM users WHERE email = ${relay}`;
    expect(u).toEqual({ username: 'Zoé', first_name: '' });

    // Ancienne page en cache : prénom + nom saisis par l'utilisateur.
    const b2 = new Browser();
    const email = `${uid('a103old')}@test.invalid`;
    await socialStart(b2, 'apple', { sub: uid('a103o'), email, appleName: { firstName: 'Léa', lastName: 'Martin' } });
    expect((await pending(b2)).body.suggestedDisplayName).toBe('Léa');
    expect((await pending(b2, { action: 'signup', firstName: 'Léa', lastName: 'Martin', email, acceptedTerms: true, termsVersion })).status).toBe(200);
    const [v] = await sql<{ username: string; first_name: string; last_name: string }[]>`SELECT username, first_name, last_name FROM users WHERE email = ${email}`;
    expect(v).toEqual({ username: 'Léa', first_name: 'Léa', last_name: 'Martin' });
  });
});
