/**
 * Lot 92 — CDC 18 sous-lot A « socle » : registre des sessions (§20 ;
 * SESS-05..08, SEC-03, E2E-14 du §39) et preuve de réauthentification
 * (§18 ; REAUTH-01/02/06/07). PostgreSQL 16 réel (tables 0802 / 0803),
 * VRAIES routes (connexion, renouvellement, déconnexion, Mon compte ›
 * Sécurité, changement de mot de passe, clôture, BO).
 *
 *   L92-E2E-14   navigateurs A et B + application mobile → liste de 3 →
 *                « Déconnecter » B → B coupé immédiatement (accès ET
 *                renouvellement), A et mobile restent ;
 *   L92-Q5       session ouverte avant le registre : aucune déconnexion,
 *                inscrite au renouvellement suivant ;
 *   L92-SESS-08  « Déconnecter tous les autres appareils » : réauthentification
 *                exigée, toutes les autres coupées (y compris non inscrites),
 *                cet appareil continue ;
 *   L92-REAUTH   5 min, liée à la session, REAUTH_REQUIRED / _EXPIRED,
 *                changement de mot de passe et clôture sans redemander le mot
 *                de passe, preuve consommée ;
 *   L92-ISO      isolation entre comptes ; révocation globale reflétée ;
 *                BO (réglage AUTH_BO_SESSION_LIST) ; purge.
 */
import { expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
const UA_A = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const UA_B = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const INSTALLATION = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };
const cookieOf = (res: Response, name: string) => (res as WithCookies).cookies.get(name)?.value;

/** Un « appareil » : ses en-têtes et son pot de cookies. */
class Appareil {
  jar = new Map<string, string>();
  constructor(public headers: Record<string, string>, public ip: string) {}
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res: Response) {
    for (const n of ['access_token', 'refresh_token', 'vb_device']) {
      const v = cookieOf(res, n);
      if (v === undefined) continue;
      if (v === '') this.jar.delete(n); else this.jar.set(n, v);
    }
    return res;
  }
  req(path: string, method = 'GET', body?: unknown) {
    return new NextRequest(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': this.ip, ...this.headers, ...(this.jar.size ? { cookie: this.cookie() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

scenario('L92', 'Registre des sessions, Appareils connectés et réauthentification (CDC 18 §18, §20)', ({ sql, make }) => {
  async function compte(prefix = 'l92') {
    const email = `${uid(prefix)}@test.invalid`;
    const owner = await make.user({ email });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE' WHERE id = ${owner.id}`;
    await make.account({ owner });
    return { id: owner.id, email };
  }
  const ipSeq = { n: 10 };
  const nouvelleIp = () => `92.${ipSeq.n++ % 250}.${Math.floor(Math.random() * 250)}.9`;
  const navigateurA = () => new Appareil({ 'user-agent': UA_A }, nouvelleIp());
  const navigateurB = () => new Appareil({ 'user-agent': UA_B }, nouvelleIp());
  const mobile = () => new Appareil({ 'user-agent': UA_MOBILE, 'x-verebona-client': 'ios', 'x-verebona-app-version': '1.0.3', 'x-verebona-installation-id': INSTALLATION }, nouvelleIp());

  async function connecter(app: Appareil, email: string, password = PASSWORD) {
    const { POST } = await import('@/app/api/auth/login/route');
    const res = app.absorb(await POST(app.req('/api/auth/login', 'POST', { email, password })));
    expect(res.status).toBe(200);
    return res;
  }
  async function renouveler(app: Appareil) {
    const { POST } = await import('@/app/api/auth/refresh/route');
    return app.absorb(await POST(app.req('/api/auth/refresh', 'POST')));
  }
  async function sessions(app: Appareil) {
    const { GET } = await import('@/app/api/users/me/sessions/route');
    return GET(app.req('/api/users/me/sessions'));
  }
  async function deconnecterAppareil(app: Appareil, id: string) {
    const { DELETE } = await import('@/app/api/users/me/sessions/[id]/route');
    return DELETE(app.req(`/api/users/me/sessions/${id}`, 'DELETE'), { params: Promise.resolve({ id }) });
  }
  async function reauth(app: Appareil, password = PASSWORD) {
    const { POST } = await import('@/app/api/users/me/security/reauth/route');
    return POST(app.req('/api/users/me/security/reauth', 'POST', { method: 'password', password }));
  }
  async function autresAppareils(app: Appareil) {
    const { POST } = await import('@/app/api/users/me/sessions/revoke-others/route');
    return app.absorb(await POST(app.req('/api/users/me/sessions/revoke-others', 'POST', {})));
  }
  /** Journal écrit sans attente (`void logUserActivity`) : lecture après quelques essais. */
  async function journal(userId: number, type: string) {
    for (let i = 0; i < 40; i++) {
      const rows = await sql<{ details: string }[]>`SELECT details FROM user_activity_log WHERE user_id = ${userId} AND activity_type = ${type} ORDER BY id`;
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }
  const lignes = (userId: number) => sql<{ sid: string; client_type: string; device_label: string; browser_label: string; revoked_at: Date | null; revocation_reason: string | null; registered_via: string; device_key: string | null; app_version: string | null }[]>`
    SELECT * FROM user_sessions WHERE user_id = ${userId} ORDER BY created_at`;

  it('L92-E2E-14 A / B / mobile → liste de 3 → « Déconnecter » B → B coupé, A et mobile restent (SESS-05/06/07, SEC-03)', async () => {
    const u = await compte();
    const a = navigateurA(); const b = navigateurB(); const m = mobile();
    await connecter(a, u.email); await connecter(b, u.email); await connecter(m, u.email);

    // SESS-05 : trois sessions au registre, appareil décrit, aucune IP en clair.
    const rows = await lignes(u.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.client_type, r.device_label, r.browser_label])).toEqual([
      ['WEB', 'PC Windows', 'Chrome'], ['WEB', 'Mac', 'Firefox'], ['IOS', 'iPhone', 'Application Verebona'],
    ]);
    expect(rows[2].app_version).toBe('1.0.3');
    expect(rows.every((r) => r.device_key && !r.device_key.includes(INSTALLATION))).toBe(true);

    // SESS-06 : liste vue de A — badge « Cet appareil », aucun sid, aucune IP.
    const vueA = await (await sessions(a)).json();
    expect(vueA.sessions).toHaveLength(3);
    expect(vueA.sessions[0]).toMatchObject({ current: true, deviceLabel: 'PC Windows', browserLabel: 'Chrome' });
    expect(JSON.stringify(vueA)).not.toMatch(/92\.\d+\.\d+\.9|"sid"/);
    const idB = vueA.sessions.find((s: { browserLabel: string }) => s.browserLabel === 'Firefox').id;

    // SESS-07 : A déconnecte B.
    const del = await deconnecterAppareil(a, idB);
    expect(del.status).toBe(200);
    // B coupé IMMÉDIATEMENT : son jeton d'accès (encore valide 15 min) est refusé…
    expect((await sessions(b)).status).toBe(401);
    // … et son renouvellement aussi, cookies effacés.
    const rb = await renouveler(b);
    expect(rb.status).toBe(401);
    expect((await rb.json()).code).toBe('SESSION_REVOKED');
    expect(b.jar.has('refresh_token')).toBe(false);
    // A et le mobile restent connectés, renouvellement compris.
    expect((await sessions(m)).status).toBe(200);
    expect((await renouveler(a)).status).toBe(200);
    expect((await renouveler(m)).status).toBe(200);
    const apres = await (await sessions(a)).json();
    expect(apres.sessions.map((s: { deviceLabel: string }) => s.deviceLabel).sort()).toEqual(['PC Windows', 'iPhone']);
    // La session courante ne se « déconnecte » pas par cette route.
    expect((await deconnecterAppareil(a, apres.sessions.find((s: { current: boolean }) => s.current).id)).status).toBe(409);
    // Journal §23.1.
    const [j] = await journal(u.id, 'SESSION_REVOKED');
    expect(JSON.parse(j.details)).toMatchObject({ scope: 'single', by: 'user', reason: 'USER_REVOKED' });
    expect(await journal(u.id, 'SESSION_CREATED')).toHaveLength(3);
  });

  it('L92-Q5 session ouverte avant le registre : aucune déconnexion, inscrite au prochain renouvellement', async () => {
    const u = await compte();
    const a = navigateurA();
    await connecter(a, u.email);
    // Simule une session antérieure au déploiement : aucune ligne au registre.
    await sql`DELETE FROM user_sessions WHERE user_id = ${u.id}`;
    expect((await sessions(a)).status).toBe(200);
    expect((await renouveler(a)).status).toBe(200);
    const rows = await lignes(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ registered_via: 'REFRESH', revoked_at: null, device_label: 'PC Windows' });
    expect((await (await sessions(a)).json()).currentListed).toBe(true);
  });

  it('L92-ROT rotation et rejeu inchangés : version suivante au registre, rejeu → incident et registre révoqué', async () => {
    const u = await compte();
    const a = navigateurA();
    await connecter(a, u.email);
    const ancien = a.jar.get('refresh_token')!;
    expect((await renouveler(a)).status).toBe(200);
    const [r1] = await lignes(u.id);
    expect(Number((await sql`SELECT refresh_version FROM user_sessions WHERE sid = ${r1.sid}`)[0].refresh_version)).toBe(2);
    // Rejeu de l'ancien jeton au-delà de la fenêtre de grâce (lot 37) : révocation globale reflétée.
    const { hashToken } = await import('@/db');
    await sql`UPDATE revoked_tokens SET revoked_at = revoked_at - interval '60 seconds' WHERE token_hash = ${await hashToken(ancien)}`;
    const { POST } = await import('@/app/api/auth/refresh/route');
    const rejeu = await POST(new NextRequest(`${ORIGIN}/api/auth/refresh`, { method: 'POST', headers: { cookie: `refresh_token=${ancien}`, origin: ORIGIN } }));
    expect(rejeu.status).toBe(401);
    expect((await lignes(u.id))[0]).toMatchObject({ revocation_reason: 'REFRESH_TOKEN_REUSE' });
    expect((await sessions(a)).status).toBe(401);
  });

  it('L92-SESS-08 « Déconnecter tous les autres appareils » après réauthentification ; cet appareil continue', async () => {
    const u = await compte();
    const a = navigateurA(); const b = navigateurB(); const m = mobile(); const ancienne = navigateurB();
    await connecter(ancienne, u.email);
    await sql`DELETE FROM user_sessions WHERE user_id = ${u.id}`; // session antérieure au registre, jamais renouvelée
    await connecter(a, u.email); await connecter(b, u.email); await connecter(m, u.email);

    const sans = await autresAppareils(a);
    expect(sans.status).toBe(403);
    expect((await sans.json()).code).toBe('REAUTH_REQUIRED');

    const faux = await reauth(a, 'pas-le-bon');
    expect(faux.status).toBe(401);
    expect((await faux.json()).code).toBe('INVALID_CURRENT_PASSWORD');
    expect(await journal(u.id, 'REAUTH_FAILED')).toHaveLength(1);
    const ok = await reauth(a);
    expect(ok.status).toBe(200);
    expect(new Date((await ok.json()).freshUntil).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    const res = await autresAppareils(a);
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(2);
    for (const x of [b, m, ancienne]) {
      expect((await sessions(x)).status).toBe(401);
      expect((await renouveler(x)).status).toBe(401);
    }
    // Cet appareil : session neuve, même appareil, toujours connecté ; la confirmation suit (non prolongée).
    expect((await sessions(a)).status).toBe(200);
    expect((await renouveler(a)).status).toBe(200);
    const vue = await (await sessions(a)).json();
    expect(vue.sessions).toHaveLength(1);
    expect(vue.sessions[0]).toMatchObject({ current: true, deviceLabel: 'PC Windows' });
    expect((await autresAppareils(a)).status).toBe(200);
    const reasons = (await lignes(u.id)).map((r) => r.revocation_reason);
    expect(reasons).toEqual(expect.arrayContaining(['USER_REVOKED_OTHERS', 'SESSION_REPLACED']));
  });

  it('L92-REAUTH-01/02/06 cinq minutes, liée à la session, refusée au submit après expiration', async () => {
    const u = await compte();
    const a = navigateurA(); const b = navigateurB();
    await connecter(a, u.email); await connecter(b, u.email);
    expect((await reauth(a)).status).toBe(200);
    const { GET } = await import('@/app/api/users/me/security/route');
    expect((await (await GET(a.req('/api/users/me/security'))).json()).reauth).toMatchObject({ fresh: true, methods: [expect.objectContaining({ id: 'password' })] });
    // REAUTH-02 : la preuve de A ne vaut pas pour B (même utilisateur).
    expect((await (await GET(b.req('/api/users/me/security'))).json()).reauth.fresh).toBe(false);
    const { POST: changer } = await import('@/app/api/users/me/change-password/route');
    const viaB = await changer(b.req('/api/users/me/change-password', 'POST', { newPassword: 'NouveauMdp9!x' }));
    expect(viaB.status).toBe(403);
    expect((await viaB.json()).code).toBe('REAUTH_REQUIRED');
    // REAUTH-01 / -06 : 5 minutes écoulées → REAUTH_EXPIRED au submit.
    await sql`UPDATE reauth_proofs SET expires_at = now() - interval '1 second' WHERE user_id = ${u.id}`;
    const expire = await changer(a.req('/api/users/me/change-password', 'POST', { newPassword: 'NouveauMdp9!x' }));
    expect(expire.status).toBe(403);
    expect((await expire.json()).code).toBe('REAUTH_EXPIRED');
    expect(await bcrypt.compare(PASSWORD, (await sql`SELECT password_hash FROM users WHERE id = ${u.id}`)[0].password_hash)).toBe(true);
  });

  it('L92-REAUTH-07 changement de mot de passe sans redemander le mot de passe : preuve consommée, autres appareils coupés, limiteur intact', async () => {
    const u = await compte();
    const a = navigateurA(); const b = navigateurB();
    await connecter(a, u.email); await connecter(b, u.email);
    expect((await reauth(a)).status).toBe(200);
    const { POST: changer } = await import('@/app/api/users/me/change-password/route');
    const res = a.absorb(await changer(a.req('/api/users/me/change-password', 'POST', { newPassword: 'NouveauMdp9!x', keepCurrentSession: true })));
    expect(res.status).toBe(200);
    expect(await sql`SELECT 1 FROM reauth_proofs WHERE user_id = ${u.id} AND consumed_at IS NULL AND expires_at > now()`).toHaveLength(0);
    expect((await sessions(b)).status).toBe(401);
    expect((await sessions(a)).status).toBe(200);
    expect((await (await sessions(a)).json()).sessions).toHaveLength(1);
    // Ancien parcours (mot de passe dans la requête) toujours accepté, limiteur partagé conservé.
    for (let i = 0; i < 5; i++) expect((await reauth(a, 'faux')).status).toBe(401);
    expect((await reauth(a, 'NouveauMdp9!x')).status).toBe(429);
  });

  it('L92-REAUTH-07 suppression du compte : texte + identité confirmée, sans mot de passe dans la requête', async () => {
    const u = await compte();
    const a = navigateurA(); const b = navigateurB();
    await connecter(a, u.email); await connecter(b, u.email);
    const { POST: clore } = await import('@/app/api/users/me/deletion/route');
    const sans = await clore(a.req('/api/users/me/deletion', 'POST', { confirmation: 'SUPPRIMER MON COMPTE' }));
    expect(sans.status).toBe(403);
    expect((await sans.json()).code).toBe('REAUTH_REQUIRED');
    expect((await reauth(a)).status).toBe(200);
    const res = a.absorb(await clore(a.req('/api/users/me/deletion', 'POST', { confirmation: 'SUPPRIMER MON COMPTE' })));
    expect(res.status).toBe(200);
    expect((await sql`SELECT status FROM users WHERE id = ${u.id}`)[0].status).toBe('PENDING_DELETION');
    const [p] = await sql<{ consumed_for: string | null }[]>`SELECT consumed_for FROM reauth_proofs WHERE user_id = ${u.id} ORDER BY created_at DESC LIMIT 1`;
    expect(p?.consumed_for ?? 'supprimée').toMatch(/account_deletion|supprimée/);
    expect((await sessions(b)).status).toBe(401);
  });

  it('L92-ISO isolation entre comptes, révocation globale reflétée, réglage BO, purge', async () => {
    const u1 = await compte(); const u2 = await compte();
    const a1 = navigateurA(); const a2 = navigateurA();
    await connecter(a1, u1.email); await connecter(a2, u2.email);
    const id1 = (await (await sessions(a1)).json()).sessions[0].id;
    // u2 ne voit ni ne déconnecte la session de u1.
    expect((await (await sessions(a2)).json()).sessions.map((s: { id: string }) => s.id)).not.toContain(id1);
    expect((await deconnecterAppareil(a2, id1)).status).toBe(404);
    expect((await sessions(a1)).status).toBe(200);

    // BO : liste désactivée par défaut (USR-D03) ; activée par AUTH_BO_SESSION_LIST.
    const admin = await make.user({ email: `${uid('l92adm')}@test.invalid` });
    await sql`UPDATE users SET role = 'ADMIN', status = 'ACTIVE', is_active = true WHERE id = ${admin.id}`;
    const { generateAccessToken } = await import('@/lib/jwt');
    const tok = await generateAccessToken({ id: admin.id, email: 'adm@test.invalid', role: 'ADMIN' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never });
    const bo = (path: string, method = 'GET') => new NextRequest(`${ORIGIN}${path}`, { method, headers: { cookie: `access_token=${tok}`, origin: ORIGIN } });
    const { GET: boList } = await import('@/app/api/admin/users/[id]/sessions/route');
    const { DELETE: boDel } = await import('@/app/api/admin/users/[id]/sessions/[sessionId]/route');
    const prev = process.env.AUTH_BO_SESSION_LIST;
    try {
      delete process.env.AUTH_BO_SESSION_LIST;
      expect(await (await boList(bo(`/api/admin/users/${u1.id}/sessions`), { params: Promise.resolve({ id: String(u1.id) }) })).json()).toEqual({ enabled: false, sessions: [] });
      process.env.AUTH_BO_SESSION_LIST = 'on';
      const l = await (await boList(bo(`/api/admin/users/${u1.id}/sessions`), { params: Promise.resolve({ id: String(u1.id) }) })).json();
      expect(l.sessions).toHaveLength(1);
      expect(JSON.stringify(l)).not.toMatch(/"sid"|"current"/);
      const d = await boDel(bo(`/api/admin/users/${u1.id}/sessions/${l.sessions[0].id}`, 'DELETE'), { params: Promise.resolve({ id: String(u1.id), sessionId: l.sessions[0].id }) });
      expect(d.status).toBe(200);
      expect(await sql`SELECT 1 FROM admin_audit_log WHERE action_type = 'USER_SESSION_REVOKE' AND target_id = ${u1.id}`).toHaveLength(1);
      expect((await sessions(a1)).status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.AUTH_BO_SESSION_LIST; else process.env.AUTH_BO_SESSION_LIST = prev;
    }

    // Révocation globale (BO « forcer la déconnexion », mot de passe…) reflétée au registre.
    const { forceLogoutUser } = await import('@/services/admin/user-admin.service');
    await forceLogoutUser(u2.id);
    expect((await lignes(u2.id)).every((r) => r.revocation_reason === 'ADMIN_FORCE_LOGOUT')).toBe(true);
    expect((await sessions(a2)).status).toBe(401);

    // Purge : lignes terminées depuis plus de 90 jours.
    await sql`UPDATE user_sessions SET revoked_at = now() - interval '91 days' WHERE user_id = ${u2.id}`;
    const { purgeSessionRegistry } = await import('@/lib/auth/session-registry');
    expect(await purgeSessionRegistry()).toBeGreaterThanOrEqual(1);
    expect(await lignes(u2.id)).toHaveLength(0);
  });

  it('L92-DEL suppression du compte : les deux tables portent `user_id` entier, purgé par le contrôle des orphelins de la suppression', async () => {
    const cols = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name = 'user_id' AND data_type = 'integer'
         AND table_name IN ('user_sessions', 'reauth_proofs')`;
    expect(cols.map((c) => c.table_name).sort()).toEqual(['reauth_proofs', 'user_sessions']);
  });
});
