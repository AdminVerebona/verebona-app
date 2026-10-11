/**
 * Lot 37 — Sécurité des comptes, failles C1 à C5 (CDC 18 §19.3, §32, §33,
 * §40) — base PostgreSQL réelle : vraies routes, vraies tables
 * (`revoked_tokens.reason` 0312, `auth_rate_limits` 0313,
 * `user_session_revocations`).
 */
import { expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';

function post(path: string, init: { body?: unknown; cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN };
  if (init.cookie) headers.cookie = init.cookie;
  headers['x-forwarded-for'] = init.ip ?? `81.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.7`;
  return new NextRequest(`${ORIGIN}${path}`, { method: 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const cookie = (res: Response & { cookies?: { get(n: string): { value: string } | undefined } }, name: string) =>
  (res as unknown as { cookies: { get(n: string): { value: string } | undefined } }).cookies.get(name)?.value;

scenario('L37', 'Sécurité des comptes — C1 à C5', ({ sql, make }) => {
  async function compte(over: { isActive?: boolean; status?: string } = {}) {
    const email = `${uid('l37')}@test.invalid`;
    const owner = await make.user({ email });
    const hash = await bcrypt.hash(PASSWORD, 4);
    await sql`UPDATE users SET password_hash = ${hash}, is_active = ${over.isActive ?? true}, status = ${over.status ?? 'ACTIVE'}
              WHERE id = ${owner.id}`;
    await make.account({ owner });
    return { id: owner.id, email };
  }
  async function connexion(email: string, ip?: string) {
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(post('/api/auth/login', { body: { email, password: PASSWORD }, ip }));
    expect(res.status).toBe(200);
    return { access: cookie(res, 'access_token')!, refresh: cookie(res, 'refresh_token')! };
  }

  it('C1-E2E-01 une session réelle : le jeton de renouvellement n’ouvre ni l’API ni une route de session', async () => {
    const u = await compte();
    const { access, refresh } = await connexion(u.email);
    const { SessionService } = await import('@/lib/session-service');
    const { middleware } = await import('@/middleware');
    const req = (h: Record<string, string>) => new NextRequest(`${ORIGIN}/api/users/me`, { headers: { origin: ORIGIN, ...h } });

    expect((await SessionService.getSession(req({ cookie: `access_token=${access}` }))).userId).toBe(u.id);
    await expect(SessionService.getSession(req({ authorization: `Bearer ${refresh}` }))).rejects.toThrow('INVALID_TOKEN');
    await expect(SessionService.getSession(req({ cookie: `access_token=${refresh}` }))).rejects.toThrow('INVALID_TOKEN');
    expect((await middleware(req({ authorization: `Bearer ${refresh}` }))).status).toBe(401);

    // Et l'inverse : un jeton d'accès n'est pas un jeton de renouvellement.
    const { POST: refreshRoute } = await import('@/app/api/auth/refresh/route');
    expect((await refreshRoute(post('/api/auth/refresh', { cookie: `refresh_token=${access}` }))).status).toBe(401);
  });

  it('C2-E2E-01 rotation réelle et requêtes concurrentes : une seule paire émise, aucune déconnexion', async () => {
    const u = await compte();
    const { refresh } = await connexion(u.email);
    const { POST: refreshRoute } = await import('@/app/api/auth/refresh/route');
    const [a, b] = await Promise.all([
      refreshRoute(post('/api/auth/refresh', { cookie: `refresh_token=${refresh}` })),
      refreshRoute(post('/api/auth/refresh', { cookie: `refresh_token=${refresh}` })),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([cookie(a, 'refresh_token'), cookie(b, 'refresh_token')].filter(Boolean)).toHaveLength(1);
    const { hashToken } = await import('@/db');
    const [row] = await sql<{ reason: string }[]>`SELECT reason FROM revoked_tokens WHERE token_hash = ${await hashToken(refresh)}`;
    expect(row.reason).toBe('rotated');
    const [rev] = await sql`SELECT 1 FROM user_session_revocations WHERE user_id = ${u.id}`;
    expect(rev).toBeUndefined();
  });

  it('C2-E2E-02 réutilisation après la fenêtre de grâce : famille révoquée — successeur et jetons d’accès refusés', async () => {
    const u = await compte();
    const s = await connexion(u.email);
    const { POST: refreshRoute } = await import('@/app/api/auth/refresh/route');
    const r1 = await refreshRoute(post('/api/auth/refresh', { cookie: `refresh_token=${s.refresh}` }));
    expect(r1.status).toBe(200);
    const successeur = cookie(r1, 'refresh_token')!;
    const accesNeuf = cookie(r1, 'access_token')!;
    const { hashToken } = await import('@/db');
    // Le jeton a été tourné il y a 2 minutes (au-delà des 30 s de grâce).
    await sql`UPDATE revoked_tokens SET revoked_at = now() - interval '2 minutes' WHERE token_hash = ${await hashToken(s.refresh)}`;
    await new Promise((r) => setTimeout(r, 5));

    const rejeu = await refreshRoute(post('/api/auth/refresh', { cookie: `refresh_token=${s.refresh}` }));
    expect(rejeu.status).toBe(401);
    expect((await rejeu.json()).code).toBe('SESSION_REVOKED');
    expect(cookie(rejeu, 'refresh_token')).toBe('');
    const [rev] = await sql<{ reason: string }[]>`SELECT reason FROM user_session_revocations WHERE user_id = ${u.id}`;
    expect(rev.reason).toBe('REFRESH_TOKEN_REUSE');

    // Le successeur (possiblement volé) ne renouvelle plus ; les jetons d'accès émis avant sont refusés.
    expect((await refreshRoute(post('/api/auth/refresh', { cookie: `refresh_token=${successeur}` }))).status).toBe(401);
    const { SessionService } = await import('@/lib/session-service');
    const { serverCacheClear } = await import('@/lib/server-cache');
    serverCacheClear();
    await expect(SessionService.getSession(new NextRequest(`${ORIGIN}/api/users/me`, { headers: { cookie: `access_token=${accesNeuf}` } })))
      .rejects.toThrow('INVALID_TOKEN');
    const [journal] = await sql<{ details: string }[]>`
      SELECT details FROM user_activity_log WHERE user_id = ${u.id} AND activity_type = 'AUTH_TOKEN_REUSE_DETECTED' ORDER BY id DESC LIMIT 1`;
    expect(JSON.parse(journal.details)).toMatchObject({ severity: 'security_incident', sessionsRevoked: true });
    // Une nouvelle connexion reste possible.
    await connexion(u.email);
  });

  it('C2-E2E-03 jeton d’une session déconnectée : refus simple, aucune révocation globale', async () => {
    const u = await compte();
    const s = await connexion(u.email);
    const { POST: logout } = await import('@/app/api/auth/logout/route');
    expect((await (await logout(post('/api/auth/logout', { cookie: `refresh_token=${s.refresh}` }))).json()).revocation).toBe('revoked');
    const { POST: refreshRoute } = await import('@/app/api/auth/refresh/route');
    expect((await refreshRoute(post('/api/auth/refresh', { cookie: `refresh_token=${s.refresh}` }))).status).toBe(401);
    const [rev] = await sql`SELECT 1 FROM user_session_revocations WHERE user_id = ${u.id}`;
    expect(rev).toBeUndefined();
  });

  it('C3-E2E-01 connexion : adresse inconnue, mot de passe faux, compte non vérifié ou suspendu → réponse identique', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const actif = await compte();
    const nonVerifie = await compte({ isActive: false });
    const suspendu = await compte({ status: 'SUSPENDED' });
    const rep = async (email: string, password = 'Faux-123') => {
      const r = await POST(post('/api/auth/login', { body: { email, password } }));
      return { status: r.status, body: await r.json() };
    };
    const ref = await rep(`${uid('inconnu')}@test.invalid`);
    expect(ref.status).toBe(401);
    for (const e of [actif.email, nonVerifie.email, suspendu.email]) expect(await rep(e)).toEqual(ref);
    // Après preuve du mot de passe seulement : l'état utile est dit.
    expect((await rep(nonVerifie.email, PASSWORD)).body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('C3-E2E-02 mot de passe oublié et renvoi de vérification : réponse identique pour toute adresse', async () => {
    const { POST: forgot } = await import('@/app/api/auth/forgot-password/route');
    const { POST: resend } = await import('@/app/api/auth/resend-verification/route');
    const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
    const actif = await compte();
    const nonVerifie = await compte({ isActive: false });
    const inconnu = `${uid('inconnu')}@test.invalid`;
    for (const route of [forgot, resend]) {
      const reps = [];
      for (const email of [inconnu, actif.email, nonVerifie.email]) {
        const r = await route(post('/x', { body: { email } }));
        reps.push({ status: r.status, body: await r.json() });
      }
      expect(reps[0]).toEqual(reps[1]);
      expect(reps[1]).toEqual(reps[2]);
      expect(reps[0].status).toBe(200);
    }
    await settleDetachedAuthTasks();
  });

  it('C4-E2E-01 compteurs en base : verrou du compte après 5 échecs, partagé entre instances, clés pseudonymisées', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const u = await compte();
    for (let i = 0; i < 5; i++) {
      const r = await POST(post('/api/auth/login', { body: { email: u.email, password: 'Faux' }, ip: `82.1.${i}.9` }));
      expect(r.status).toBe(401);
    }
    const { limitKey, AUTH_LIMITS, AuthRateLimiter, PgAuthLimitStore } = await import('@/lib/auth/auth-rate-limit');
    const key = limitKey('login', 'acct', u.email);
    const [row] = await sql<{ locked_until: Date; lock_level: number }[]>`SELECT locked_until, lock_level FROM auth_rate_limits WHERE bucket_key = ${key}`;
    expect(new Date(row.locked_until).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(row.lock_level).toBe(1);
    const tout = await sql<{ bucket_key: string }[]>`SELECT bucket_key FROM auth_rate_limits`;
    expect(tout.some((r) => r.bucket_key.includes(u.email) || r.bucket_key.includes('82.1.'))).toBe(false);

    // Une AUTRE instance (autre limiteur, même base) voit le verrou.
    const autreInstance = new AuthRateLimiter(new PgAuthLimitStore());
    expect((await autreInstance.check([{ key, policy: AUTH_LIMITS.loginAccount }])).allowed).toBe(false);
    // Même le bon mot de passe, depuis une IP neuve, est refusé pendant le verrou.
    expect((await POST(post('/api/auth/login', { body: { email: u.email, password: PASSWORD }, ip: '82.9.9.9' }))).status).toBe(429);
  });

  it('C4-E2E-02 la connexion réussie d’un autre compte ne remet pas le compteur IP à zéro', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const cible = await compte();
    const autre = await compte();
    const ip = '83.4.5.6';
    for (let i = 0; i < 3; i++) await POST(post('/api/auth/login', { body: { email: cible.email, password: 'Faux' }, ip }));
    await connexion(autre.email, ip);
    const { limitKey } = await import('@/lib/auth/auth-rate-limit');
    const [r] = await sql<{ attempts: number }[]>`SELECT attempts FROM auth_rate_limits WHERE bucket_key = ${limitKey('login', 'ip', ip)}`;
    expect(r.attempts).toBe(3);
    const [c] = await sql<{ attempts: number }[]>`SELECT attempts FROM auth_rate_limits WHERE bucket_key = ${limitKey('login', 'acct', cible.email)}`;
    expect(c.attempts).toBe(3);
  });

  it('C4-E2E-03 purge par la tâche interne : lignes inactives supprimées, verrou en cours conservé', async () => {
    const vieux = `test:purge:${uid('v')}`;
    const verrou = `test:purge:${uid('l')}`;
    await sql`INSERT INTO auth_rate_limits (bucket_key, attempts, updated_at) VALUES (${vieux}, 1, now() - interval '3 days')`;
    await sql`INSERT INTO auth_rate_limits (bucket_key, attempts, locked_until, updated_at)
              VALUES (${verrou}, 0, now() + interval '1 hour', now() - interval '3 days')`;
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const t = SCHEDULED_TASKS.find((x) => x.code === 'auth-rate-limits-purge')!;
    const res = await t.run({ deadline: Date.now() + 60_000, trigger: 'manual' });
    expect(res?.note).toMatch(/compteur/);
    const restants = await sql<{ bucket_key: string }[]>`SELECT bucket_key FROM auth_rate_limits WHERE bucket_key IN (${vieux}, ${verrou})`;
    expect(restants.map((r) => r.bucket_key)).toEqual([verrou]);
  });

  it('C4-E2E-04 réinitialisation : 10 demandes par IP puis 429 ; des liens faux ne bloquent pas le compte depuis une autre IP', async () => {
    const u = await compte();
    const { POST: reset } = await import('@/app/api/auth/reset-password/route');
    const faux = Buffer.from(`${u.id}.${Date.now()}.signature-fausse`, 'utf8').toString('base64url');
    for (let i = 0; i < 10; i++) {
      const r = await reset(post('/api/auth/reset-password', { body: { token: faux, newPassword: 'NouveauMdp1!x' }, ip: '84.0.0.1' }));
      expect(r.status).toBe(400);
    }
    expect((await reset(post('/api/auth/reset-password', { body: { token: faux, newPassword: 'NouveauMdp1!x' }, ip: '84.0.0.1' }))).status).toBe(429);
    // Le titulaire, depuis son IP, n'est pas bloqué par les liens fabriqués d'un tiers.
    expect((await reset(post('/api/auth/reset-password', { body: { token: faux, newPassword: 'NouveauMdp1!x' }, ip: '84.7.7.7' }))).status).toBe(400);
  });

  it('C5-E2E-01 migrations 0312/0313 appliquées ; santé : secret et limiteur signalés', async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'revoked_tokens' AND column_name = 'reason'`;
    expect(cols).toHaveLength(1);
    const { buildHealthReport } = await import('@/lib/health/diagnostic');
    const { result } = await buildHealthReport({ detailed: true });
    expect(result.checks.jwtSecret?.status).toMatch(/ok|error/);
    expect(result.checks.authRateLimiter?.mode).toBe('shared');
  });
});
