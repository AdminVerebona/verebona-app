/**
 * Lot 113H (#707) — fiabilisation du contrôle des e-mails jetables (109F) :
 * PostgreSQL 16 réel, vraies routes, faux fournisseur OIDC local.
 *
 *   H01  Google ET Apple, « Créer un nouveau compte » avec l'adresse ATTESTÉE
 *        jetable : inconnue vs déjà inscrite → même écran (étape, champs),
 *        même HTTP 400 / code / message / champ ; rien créé, compte ancien intact ;
 *   H02  adresse CHOISIE jetable (fournisseur Gmail) : inconnue vs inscrite → identique ;
 *   H03  étape `existing_email` (adresse attestée NON jetable déjà inscrite) :
 *        inscription avec une adresse jetable → refus « jetable » (pas
 *        « compte existant ») ; sinon SIGN-06 inchangé (409) ;
 *   H04  compte préexistant sur domaine désormais bloqué : liaison Google
 *        (mot de passe) et Apple (autre fournisseur déjà lié), puis connexion
 *        Google / Apple ; aucun compte modifié ; limiteur de connexion intact ;
 *   H05  référentiel : BO › Exploitation (santé détaillée + compteurs 1125)
 *        et Supervision (> 90 jours, indisponible → anomalie ; retour → résolue) ;
 *   H06  `npm run disposable-domains:verify` : référentiel livré conforme ;
 *        copie invalide (tronquée, métadonnées, licence absente) → échec.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { createFakeOidc, type FakeUser } from '../fake-oidc';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'MotDePasse113h!x';
const MESSAGE = 'Les adresses e-mail temporaires ne sont pas acceptées. Utilisez une adresse e-mail que vous conservez.';
const REFUS = { status: 400, body: { error: MESSAGE, message: MESSAGE, code: 'DISPOSABLE_EMAIL_NOT_ALLOWED', field: 'email' } };
const fake = createFakeOidc();
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(fake.env)) { saved[k] = process.env[k]; process.env[k] = v; }

type Provider = 'google' | 'apple';
type WithCookies = Response & { cookies: { getAll(): Array<{ name: string; value: string; maxAge?: number }> } };

class Nav {
  jar = new Map<string, string>();
  ip = `113.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  req(path: string, init: { method?: string; body?: unknown; form?: Record<string, string>; noCookies?: boolean; origin?: string } = {}) {
    const headers: Record<string, string> = { origin: init.origin ?? ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': 'Mozilla/5.0 e2e l113h' };
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

scenario('L113H', 'E-mails jetables — anti-énumération OAuth, supervision et intégrité du référentiel', ({ sql }) => {
  const sent: Array<{ templateCode: string; to: string }> = [];

  beforeAll(async () => {
    const { emailService } = await import('@/lib/email/email-service');
    vi.spyOn(emailService, 'send').mockImplementation(async (o) => {
      sent.push({ templateCode: o.templateCode, to: o.to });
      return { success: true } as never;
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { setOAuthFetchForTests } = await import('@/lib/auth/oauth/providers');
    setOAuthFetchForTests(fake.fetchImpl);
  });
  afterEach(async () => {
    delete process.env.DISPOSABLE_EMAIL_ALLOWLIST;
    delete process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST;
    (await import('@/lib/auth/disposable-email')).setDisposableListForTests(undefined);
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

  /** Compte local ACTIF inscrit avant le lot (éventuellement sur un domaine devenu interdit). */
  async function compteExistant(email: string) {
    const [u] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, status, is_active, first_name, last_name, username)
      VALUES (${email}, ${await bcrypt.hash(PASSWORD, 4)}, 'ACTIVE', true, 'Ancien', 'Compte', 'Ancien') RETURNING id`;
    const [a] = await sql<{ id: number }[]>`INSERT INTO accounts (name, owner_user_id) VALUES (${uid('compte')}, ${u.id}) RETURNING id`;
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${a.id}, ${u.id}, 'owner', 'active')`;
    return { id: u.id, email, accountId: a.id };
  }
  const empreinte = async (id: number) =>
    (await sql`SELECT email, is_active, status, password_hash, updated_at FROM users WHERE id = ${id}`)[0];

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
  /** État affiché, sans ce qui dépend de l'adresse ou de l'instant. */
  const ecran = (s: Record<string, any>) => {
    const { providerEmail: _e, expiresAt: _x, firstName: _f, suggestedDisplayName: _s, ...rest } = s;
    void _e; void _x; void _f; void _s;
    return rest;
  };
  const creer = async (b: Nav, email: string) =>
    pending(b, { action: 'signup', username: 'Jet', email, acceptedTerms: true, termsVersion: await cgvu() })
      .then((r) => ({ status: r.status, body: r.body }));

  // ── H01 ────────────────────────────────────────────────────────────────────

  for (const provider of ['google', 'apple'] as const) {
    it(`H01 ${provider} — adresse attestée jetable inconnue vs déjà inscrite : même écran, même refus 400 sous le champ e-mail ; rien créé ; compte ancien intact`, async () => {
      const inconnue = `${uid(`h01n-${provider}`)}@yopmail.com`;
      const ancien = await compteExistant(`${uid(`h01e-${provider}`)}@yopmail.com`);
      const avant = await empreinte(ancien.id);
      const parcours = async (email: string) => {
        const b = new Nav();
        const user: FakeUser = { sub: uid(`h01-${provider}-sub`), email, emailVerified: true, givenName: 'Jet', appleName: { firstName: 'Jet', lastName: 'X' } };
        expect(loc(await social(b, provider, user)).pathname).toBe('/connexion-sociale');
        const etat = await pending(b);
        sent.length = 0;
        const refus = await creer(b, email);
        expect(await sql`SELECT 1 FROM auth_identities WHERE subject = ${user.sub}`).toHaveLength(0);
        return { etat: ecran(etat.body), refus, mails: sent.length };
      };
      const a = await parcours(inconnue);
      const b = await parcours(ancien.email);
      expect(a.etat.stage).toBe('choice');
      expect(b.etat).toEqual(a.etat);
      expect(a.refus).toEqual(REFUS);
      expect(b.refus).toEqual(a.refus);
      expect([a.mails, b.mails]).toEqual([0, 0]); // ni code, ni « vous avez déjà un compte »
      expect(await sql`SELECT 1 FROM users WHERE email = ${inconnue}`).toHaveLength(0);
      expect(await sql`SELECT count(*)::int AS n FROM users WHERE email = ${ancien.email}`).toEqual([{ n: 1 }]);
      expect(await empreinte(ancien.id)).toEqual(avant);
    });
  }

  // ── H02 ────────────────────────────────────────────────────────────────────

  it('H02 adresse CHOISIE jetable (fournisseur Gmail) : inconnue vs déjà inscrite → réponse identique, aucun code, aucun e-mail', async () => {
    const ancien = await compteExistant(`${uid('h02e')}@mailinator.com`);
    const essai = async (email: string) => {
      const b = new Nav();
      await social(b, 'google', { sub: uid('h02-sub'), email: `${uid('h02g')}@gmail.com`, givenName: 'Paul' });
      sent.length = 0;
      const r = await creer(b, email);
      expect((await pending(b)).body.stage).toBe('choice');
      return { r, mails: sent.length };
    };
    const inconnue = await essai(`${uid('h02n')}@mailinator.com`);
    const inscrite = await essai(ancien.email);
    expect(inconnue).toEqual({ r: REFUS, mails: 0 });
    expect(inscrite).toEqual(inconnue);
  });

  // ── H03 ────────────────────────────────────────────────────────────────────

  it('H03 étape existing_email (adresse attestée NON jetable déjà inscrite) : adresse jetable → refus « jetable » ; sinon SIGN-06 inchangé', async () => {
    const local = await compteExistant(`${uid('h03')}@test.invalid`);
    const b = new Nav();
    await social(b, 'google', { sub: uid('h03-sub'), email: local.email });
    expect((await pending(b)).body.stage).toBe('existing_email');
    expect(await creer(b, `${uid('h03j')}@yopmail.com`)).toEqual(REFUS);
    expect(await creer(b, local.email)).toMatchObject({ status: 409, body: { code: 'ACCOUNT_ALREADY_EXISTS' } });
    expect(await sql`SELECT 1 FROM auth_identities WHERE user_id = ${local.id}`).toHaveLength(0);
    const ok = await pending(b, { action: 'link-password', email: local.email, password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  // ── H04 ────────────────────────────────────────────────────────────────────

  it('H04 compte préexistant sur domaine bloqué : liaison Google par mot de passe, liaison Apple via Google déjà lié, connexions ; limiteur intact', async () => {
    const ancien = await compteExistant(`${uid('h04')}@yopmail.com`);
    const avant = (await sql`SELECT email, is_active, status FROM users WHERE id = ${ancien.id}`)[0];
    const g: FakeUser = { sub: uid('h04-g'), email: ancien.email };
    const b = new Nav();
    expect(loc(await social(b, 'google', g)).pathname).toBe('/connexion-sociale');
    expect((await pending(b)).body.stage).toBe('choice');
    // Mauvais mot de passe : réponse de connexion inchangée.
    expect(await pending(b, { action: 'link-password', email: ancien.email, password: 'mauvais' })).toMatchObject({ status: 401, body: { code: 'INVALID_CREDENTIALS' } });
    expect((await pending(b, { action: 'link-password', email: ancien.email, password: PASSWORD })).status).toBe(200);
    expect(await sql`SELECT user_id FROM auth_identities WHERE subject = ${g.sub}`).toEqual([{ user_id: ancien.id }]);
    expect(loc(await social(new Nav(), 'google', g, { intent: 'login' })).pathname).toBe('/accueil');

    // Apple avec la même adresse jetable : choix, puis « via Google » (déjà lié) → liaison Apple.
    const a: FakeUser = { sub: uid('h04-a'), email: ancien.email, appleName: { firstName: 'Ancien', lastName: 'Compte' } };
    const b2 = new Nav();
    expect(loc(await social(b2, 'apple', a)).pathname).toBe('/connexion-sociale');
    expect((await pending(b2)).body).toMatchObject({ stage: 'choice', otherProviders: expect.arrayContaining(['google']) });
    const viaGoogle = await social(b2, 'google', g, { intent: 'login', link_pending: '1' });
    expect(loc(viaGoogle).pathname).not.toBe('/connexion-sociale');
    expect(await sql`SELECT user_id FROM auth_identities WHERE subject = ${a.sub}`).toEqual([{ user_id: ancien.id }]);
    expect(loc(await social(new Nav(), 'apple', { ...a, appleName: null }, { intent: 'login' })).pathname).toBe('/accueil');
    expect((await sql`SELECT email, is_active, status FROM users WHERE id = ${ancien.id}`)[0]).toEqual(avant);
  });

  // ── H05 ────────────────────────────────────────────────────────────────────

  it('H05 référentiel : BO › Exploitation (état, version, date, compteurs 1125) ; Supervision : > 90 jours et indisponible → anomalies actionnables, retour → résolues', async () => {
    const { getAdminHealth } = await import('@/services/admin/ops/health-admin.service');
    const h = await getAdminHealth();
    const st = h.health.checks.disposableEmailList!;
    const source = JSON.parse(readFileSync(join(process.cwd(), 'src/lib/auth/disposable-email/data/source.json'), 'utf8'));
    expect(st).toMatchObject({ version: source.version, fetchedAt: source.fetchedAt, count: source.count, expectedCount: source.count, available: true, integrity: 'ok' });
    expect(JSON.stringify(st)).not.toMatch(/yopmail|mailinator/);
    // Compteurs agrégés de la migration 1125 (refus de H01/H02 ci-dessus).
    expect(h.disposableRefusals).toMatchObject({ table: true, error: null });
    expect(h.disposableRefusals!.total).toBeGreaterThanOrEqual(4);
    expect(h.disposableRefusals!.byChannel.map((c) => c.channel)).toContain('social_signup');

    const { disposableListStatus, setDisposableListForTests } = await import('@/lib/auth/disposable-email');
    const { syncDisposableListAnomalies } = await import('@/services/admin/disposable-list-supervision');
    const open = async () => (await sql<{ fingerprint: string; title: string; technical_detail: Record<string, unknown> }[]>`
      SELECT fingerprint, title, technical_detail FROM admin_anomalies
       WHERE status = 'open' AND fingerprint LIKE 'other:disposable-email-list:%' ORDER BY fingerprint`);
    // Point de départ : référentiel livré conforme → aucune anomalie ouverte (base e2e réutilisée).
    expect((await syncDisposableListAnomalies()).conditions).toEqual([]);
    expect(await open()).toEqual([]);
    const vieux = disposableListStatus(new Date(Date.parse(source.fetchedAt) + 120 * 86_400_000));
    expect((await syncDisposableListAnomalies(vieux)).reported).toEqual(['stale']);
    const [stale] = await open();
    expect(stale.title).toContain('référentiel périmé (120 jours > 90');
    expect(stale.technical_detail).toMatchObject({ version: source.version, fetchedAt: source.fetchedAt, ageDays: 120 });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    setDisposableListForTests(null);
    expect((await syncDisposableListAnomalies()).reported).toEqual(['unavailable']);
    // Date réelle (référentiel récent) : « périmé » résolu ; « indisponible » seul ouvert (pas de doublon « incohérent »).
    expect((await open()).map((a) => a.fingerprint)).toEqual(['other:disposable-email-list:unavailable']);
    // Repli 109F conservé : pas de panne d'inscription, listes d'urgence appliquées.
    process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST = 'yopmail.com';
    expect((await import('@/lib/auth/disposable-email')).isDisposableEmailDomain('x@yopmail.com')).toBe(true);

    setDisposableListForTests(undefined);
    expect((await syncDisposableListAnomalies()).resolved).toEqual(['unavailable']);
    expect(await open()).toEqual([]);
  });

  // ── H06 ────────────────────────────────────────────────────────────────────

  it('H06 npm run disposable-domains:verify : référentiel livré conforme ; copie tronquée / métadonnées incohérentes / licence absente → échec (code 1)', () => {
    const script = join(process.cwd(), 'scripts/update-disposable-domains.mjs');
    const run = (dir?: string) => {
      try {
        const out = execFileSync(process.execPath, [script, '--verify', ...(dir ? ['--dir', dir] : [])], { encoding: 'utf8', stdio: 'pipe' });
        return { code: 0, out };
      } catch (e) {
        const err = e as { status: number; stderr: string };
        return { code: err.status, out: err.stderr };
      }
    };
    expect(run()).toMatchObject({ code: 0, out: expect.stringContaining('référentiel embarqué conforme') });
    const data = join(process.cwd(), 'src/lib/auth/disposable-email/data');
    const copie = (mutate: (dir: string) => void) => {
      const dir = mkdtempSync(join(tmpdir(), 'l113h-'));
      cpSync(data, dir, { recursive: true });
      mutate(dir);
      try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    const liste = (dir: string) => JSON.parse(readFileSync(join(dir, 'disposable-domains.json'), 'utf8')) as string[];
    expect(copie((d) => writeFileSync(join(d, 'disposable-domains.json'), '[]'))).toMatchObject({ code: 1, out: expect.stringContaining('VIDE') });
    expect(copie((d) => writeFileSync(join(d, 'disposable-domains.json'), JSON.stringify(liste(d).slice(0, 999))))).toMatchObject({ code: 1, out: expect.stringContaining('tronquée') });
    expect(copie((d) => {
      const s = JSON.parse(readFileSync(join(d, 'source.json'), 'utf8'));
      writeFileSync(join(d, 'source.json'), JSON.stringify({ ...s, sha256: 'f'.repeat(64) }));
    })).toMatchObject({ code: 1, out: expect.stringContaining('sha256') });
    expect(copie((d) => rmSync(join(d, 'LICENSE-disposable-email-domains.txt')))).toMatchObject({ code: 1, out: expect.stringContaining('licence absent') });
  });
});
