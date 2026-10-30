/**
 * Lot 100D — décisions PO A2, A3, A5 du 27/10/2026, sur PostgreSQL 16 réel et
 * VRAIES routes (connexion, réauthentification, Appareils connectés).
 *
 *   A2-1  « Déconnecter tous les autres appareils » avec 2 autres appareils :
 *         sessions révoquées = 2, UNE notification OTHER_SESSIONS_REVOKED
 *         (e-mail obligatoire), journal SESSION_REVOKED cohérent ; rejeu :
 *         rien révoqué, aucun e-mail de plus ;
 *   A2-2  rien d'autre de connecté : aucun e-mail ; « Déconnecter » un seul
 *         appareil : aucun e-mail ; déconnexion forcée du BO : aucun e-mail ;
 *         gabarit 0878 en base ;
 *   A3-1  changement d'adresse confirmé il y a 40 jours : la purge supprime la
 *         demande (30 jours), garde l'étiquette (jamais l'adresse) ; appareil
 *         HÉRITÉ et appareil `uid` toujours reconnus, connexion sans fausse
 *         alerte ; adresse reprise par un autre compte : rien d'hérité ;
 *   A3-2  demande confirmée il y a 20 jours conservée ; étiquette expirée
 *         supprimée ;
 *   A5    toute première session (Google, Apple, activation) : aucune alerte ;
 *         session suivante depuis un appareil inconnu : une alerte
 *         (parcours complets Google / Apple : `l96b-reauth-sociale` R03).
 */
import { expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';

const PASSWORD = 'MotDePasseL100d!x';
const ORIGIN = 'http://localhost:3000';
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const UA_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };
const cookieOf = (res: Response, name: string) => (res as WithCookies).cookies.get(name)?.value;
let ipSeq = 1;
const nextIp = () => `100.${Math.floor(ipSeq / 250) % 250}.${ipSeq++ % 250}.${Math.floor(Math.random() * 250)}`;

class Appareil {
  jar = new Map<string, string>();
  constructor(public headers: Record<string, string> = { 'user-agent': UA_CHROME }, public ip = nextIp()) {}
  absorb(res: Response) {
    for (const n of ['access_token', 'refresh_token', 'vb_device']) {
      const v = cookieOf(res, n);
      if (v === undefined) continue;
      if (v === '') this.jar.delete(n); else this.jar.set(n, v);
    }
    return res;
  }
  req(path: string, method = 'GET', body?: unknown) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    return new NextRequest(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': this.ip, ...this.headers, ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

scenario('L100D', 'Sécurité des appareils — e-mail « autres appareils », conservation 30 j, première session (A2, A3, A5)', ({ sql, make }) => {
  async function compte(prefix = 'l100d', createdDaysAgo = 30) {
    const email = `${uid(prefix)}@test.invalid`;
    const owner = await make.user({ email });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE',
      created_at = now() - make_interval(days => ${createdDaysAgo}::int) WHERE id = ${owner.id}`;
    await make.account({ owner });
    return { id: owner.id, email };
  }
  async function connecter(app: Appareil, email: string) {
    const { POST } = await import('@/app/api/auth/login/route');
    return app.absorb(await POST(app.req('/api/auth/login', 'POST', { email, password: PASSWORD })));
  }
  async function sessions(app: Appareil) {
    const { GET } = await import('@/app/api/users/me/sessions/route');
    return GET(app.req('/api/users/me/sessions'));
  }
  async function reauth(app: Appareil) {
    const { POST } = await import('@/app/api/users/me/security/reauth/route');
    expect((await POST(app.req('/api/users/me/security/reauth', 'POST', { method: 'password', password: PASSWORD }))).status).toBe(200);
  }
  async function autres(app: Appareil) {
    const { POST } = await import('@/app/api/users/me/sessions/revoke-others/route');
    const r = app.absorb(await POST(app.req('/api/users/me/sessions/revoke-others', 'POST', {})));
    expect(r.status).toBe(200);
    return r.json() as Promise<{ revoked: number; securityEmail: boolean }>;
  }
  const confirmations = (userId: number) => sql<{ payload_json: Record<string, unknown>; mandatory_email: boolean; dedupe_key: string }[]>`
    SELECT payload_json, mandatory_email, dedupe_key FROM notification_outbox
     WHERE recipient_user_id = ${userId} AND event_type = 'OTHER_SESSIONS_REVOKED' ORDER BY id`;
  const alertes = async (userId: number) => (await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${userId} AND event_type = 'NEW_DEVICE_LOGIN'`).length;
  async function journal(userId: number, type: string, n = 1) {
    for (let i = 0; i < 60; i++) {
      const rows = await sql<{ details: unknown }[]>`SELECT details FROM user_activity_log WHERE user_id = ${userId} AND activity_type = ${type} ORDER BY id`;
      if (rows.length >= n) return rows.map((r) => (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) as Record<string, unknown>);
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }

  // ── A2 ────────────────────────────────────────────────────────────────────

  it('A2-1 deux autres appareils : 2 sessions révoquées, UNE confirmation obligatoire, journal cohérent ; rejeu : aucune de plus', async () => {
    const u = await compte();
    const ici = new Appareil();
    const b = new Appareil({ 'user-agent': UA_FIREFOX });
    const c = new Appareil({ 'user-agent': UA_IPHONE });
    for (const a of [b, c, ici]) expect((await connecter(a, u.email)).status).toBe(200);
    await reauth(ici);
    const r = await autres(ici);
    expect(r).toMatchObject({ revoked: 2, securityEmail: true });
    // Sessions réellement révoquées.
    expect((await sessions(b)).status).toBe(401);
    expect((await sessions(c)).status).toBe(401);
    expect((await sessions(ici)).status).toBe(200);
    const rows = await confirmations(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].mandatory_email).toBe(true);
    expect(rows[0].payload_json).toMatchObject({ count: 2, deviceLabel: 'PC Windows', browserLabel: 'Chrome' });
    const brut = JSON.stringify(rows[0]);
    for (const secret of [ici.ip, ici.jar.get('access_token')!, ici.jar.get('refresh_token')!]) expect(brut).not.toContain(secret);
    expect(rows[0].dedupe_key).toMatch(/^security:other-sessions-revoked:\d+:[A-Za-z0-9_-]{22}:u\d+$/);
    // Journal : événement de sécurité = sessions révoquées = un e-mail.
    const j = await journal(u.id, 'SESSION_REVOKED');
    expect(j.find((d) => d.scope === 'others')).toMatchObject({ by: 'user', count: 2, securityEmail: 'queued' });
    // Rendu réel de l'e-mail (gabarit 0878) : sobre, sans secret.
    const { getCatalogEntry } = await import('@/lib/notifications/catalog');
    const rendu = getCatalogEntry('OTHER_SESSIONS_REVOKED')!.render(rows[0].payload_json);
    expect(rendu.bellBody).toContain('2 autres appareils ont été déconnectés');

    // Rejeu (double clic) : rien d'autre à révoquer → aucun e-mail.
    await reauth(ici);
    expect(await autres(ici)).toMatchObject({ revoked: 0, securityEmail: false });
    expect(await confirmations(u.id)).toHaveLength(1);
    const j2 = await journal(u.id, 'SESSION_REVOKED', 2);
    expect(j2.filter((d) => d.scope === 'others').at(-1)).toMatchObject({ count: 0, securityEmail: 'none_revoked' });
  });

  it('A2-2 aucun autre appareil, appareil seul, déconnexion forcée du BO : aucun e-mail ; gabarit en base', async () => {
    const u = await compte();
    const ici = new Appareil();
    await connecter(ici, u.email);
    await reauth(ici);
    expect(await autres(ici)).toMatchObject({ revoked: 0, securityEmail: false });
    expect(await confirmations(u.id)).toHaveLength(0);

    // « Déconnecter » UN appareil.
    const b = new Appareil({ 'user-agent': UA_FIREFOX });
    await connecter(b, u.email);
    const liste = (await (await sessions(ici)).json()).sessions as Array<{ id: string; current: boolean }>;
    const cible = liste.find((s) => !s.current)!;
    await reauth(ici);
    const { DELETE } = await import('@/app/api/users/me/sessions/[id]/route');
    expect((await DELETE(ici.req(`/api/users/me/sessions/${cible.id}`, 'DELETE'), { params: Promise.resolve({ id: cible.id }) })).status).toBe(200);
    expect((await sessions(b)).status).toBe(401);
    expect(await confirmations(u.id)).toHaveLength(0);

    // Déconnexion forcée par le BO (révocation globale) : aucun e-mail.
    const c = new Appareil({ 'user-agent': UA_IPHONE });
    await connecter(c, u.email);
    const { forceLogoutUser } = await import('@/services/admin/user-admin.service');
    await forceLogoutUser(u.id);
    expect((await sessions(c)).status).toBe(401);
    expect(await confirmations(u.id)).toHaveLength(0);

    expect(await sql`SELECT subject FROM email_templates WHERE type = 'notif_other_sessions_revoked'`)
      .toEqual([{ subject: 'Verebona : vos autres appareils ont été déconnectés' }]);
  });

  // ── A3 ────────────────────────────────────────────────────────────────────

  it('A3-1 changement d’adresse confirmé il y a 40 jours : purge à 30 jours, appareils toujours reconnus, aucune fausse alerte', async () => {
    const { __legacyDeviceCookieValueForTests } = await import('@/lib/auth/device-trust');
    const { trustedDeviceForLogin } = await import('@/lib/auth/device-account');
    const { purgeEmailChangeRequests } = await import('@/services/auth/email-change.service');
    const u = await compte('l100d-a3', 120);
    const origine = u.email.toLowerCase();
    // Appareil HÉRITÉ (cookie lié à l'adresse, émis avant l'intégration 96, il y a 60 jours).
    const herite = __legacyDeviceCookieValueForTests(origine, Date.now() - 60 * 24 * 3600_000);
    // Appareil moderne (entrée `uid`), reconnu par une vraie connexion.
    const moderne = new Appareil({ 'user-agent': UA_FIREFOX });
    expect((await connecter(moderne, u.email)).status).toBe(200);

    // Changement d'adresse confirmé il y a 40 jours.
    const nouvelle = `${uid('l100d-nouv')}@test.invalid`;
    await sql`UPDATE users SET email = ${nouvelle} WHERE id = ${u.id}`;
    await sql`INSERT INTO email_change_requests (user_id, old_email, new_email, token_hash, created_at, expires_at, consumed_at)
      VALUES (${u.id}, ${u.email}, ${nouvelle}, ${uid('h')}, now() - interval '41 days', now() - interval '40 days', now() - interval '40 days')`;

    const vieux = new Appareil(); vieux.jar.set('vb_device', herite.value);
    expect(await trustedDeviceForLogin(vieux.req('/api/auth/login', 'POST'), nouvelle, nouvelle)).toBe(herite.deviceId);

    expect(await purgeEmailChangeRequests()).toBeGreaterThanOrEqual(1);
    expect(await sql`SELECT 1 FROM email_change_requests WHERE user_id = ${u.id}`).toHaveLength(0);
    const [garde] = await sql<{ legacy_tag: string; expires_at: Date }[]>`SELECT legacy_tag, expires_at FROM device_trust_legacy_accounts WHERE user_id = ${u.id}`;
    expect(garde.legacy_tag).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(JSON.stringify(garde)).not.toContain(origine.split('@')[0]);
    expect(new Date(garde.expires_at).getTime()).toBeGreaterThan(Date.now() + 170 * 24 * 3600_000);

    // Après la purge : appareils hérité ET moderne toujours reconnus, connexions sans alerte.
    expect(await trustedDeviceForLogin(vieux.req('/api/auth/login', 'POST'), nouvelle, nouvelle)).toBe(herite.deviceId);
    const n0 = await alertes(u.id);
    expect((await connecter(vieux, nouvelle)).status).toBe(200);
    expect((await connecter(moderne, nouvelle)).status).toBe(200);
    expect(await alertes(u.id)).toBe(n0);
    // Un vrai nouvel appareil alerte toujours.
    expect((await connecter(new Appareil({ 'user-agent': UA_IPHONE }), nouvelle)).status).toBe(200);
    expect(await alertes(u.id)).toBe(n0 + 1);

    // Usurpation : un autre compte reprend l'ancienne adresse — aucun appareil hérité.
    const v = await make.user({ email: u.email });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE' WHERE id = ${v.id}`;
    const autreVieux = new Appareil(); autreVieux.jar.set('vb_device', herite.value);
    expect(await trustedDeviceForLogin(autreVieux.req('/api/auth/login', 'POST'), u.email, u.email)).toBeNull();
  });

  it('A3-2 demande confirmée récente conservée ; demande annulée ancienne purgée ; étiquette expirée supprimée', async () => {
    const { purgeEmailChangeRequests } = await import('@/services/auth/email-change.service');
    const u = await compte('l100d-a3b');
    await sql`INSERT INTO email_change_requests (user_id, old_email, new_email, token_hash, created_at, expires_at, consumed_at)
      VALUES (${u.id}, ${u.email}, ${`${uid('n')}@test.invalid`}, ${uid('h')}, now() - interval '21 days', now() - interval '20 days', now() - interval '20 days')`;
    await sql`INSERT INTO email_change_requests (user_id, old_email, new_email, token_hash, created_at, expires_at, cancelled_at)
      VALUES (${u.id}, ${u.email}, ${`${uid('n')}@test.invalid`}, ${uid('h')}, now() - interval '41 days', now() - interval '40 days', now() - interval '40 days')`;
    const w = await compte('l100d-a3c');
    await sql`INSERT INTO device_trust_legacy_accounts (user_id, legacy_tag, created_at, expires_at)
      VALUES (${w.id}, 'AAAAAAAAAAAAAAAA', now() - interval '181 days', now() - interval '1 day')`;
    await purgeEmailChangeRequests();
    expect(await sql`SELECT consumed_at IS NOT NULL AS confirmee FROM email_change_requests WHERE user_id = ${u.id}`).toEqual([{ confirmee: true }]);
    expect(await sql`SELECT 1 FROM device_trust_legacy_accounts WHERE user_id = ${u.id}`).toHaveLength(0); // rien supprimé : rien gardé
    expect(await sql`SELECT 1 FROM device_trust_legacy_accounts WHERE user_id = ${w.id}`).toHaveLength(0);
  });

  // ── A5 ────────────────────────────────────────────────────────────────────

  it('A5 toute première session (Google, Apple, activation) : aucune alerte ; session suivante depuis un appareil inconnu : une alerte', async () => {
    const { processNewDeviceAlert } = await import('@/lib/auth/new-device-alert');
    const { recordSession } = await import('@/lib/auth/session-registry');
    const client = (deviceKey: string) => ({ deviceKey, deviceSource: 'cookie', clientType: 'WEB', appVersion: null, deviceLabel: 'PC Windows', browserLabel: 'Chrome' }) as never;
    const vide = new NextRequest(`${ORIGIN}/api/auth/login`, { method: 'POST' });
    for (const method of ['google', 'apple', 'email_link']) {
      const u = await compte(`l100d-a5-${method.replace('_', '')}`, 0);
      await sql`UPDATE users SET created_at = now() WHERE id = ${u.id}`;
      const s1 = uid('sid1');
      expect(await processNewDeviceAlert(vide, { userId: u.id, sid: s1, method, client: client(uid('k')) })).toBe('account_creation');
      expect(await alertes(u.id)).toBe(0);
      await recordSession({ sid: s1, userId: u.id, client: client(uid('k')), authMethod: method, registeredVia: 'LOGIN', refreshTokenHash: 'x', expiresAt: new Date(Date.now() + 3600_000), now: new Date() });
      const suivante = method === 'email_link' ? 'password' : method;
      expect(await processNewDeviceAlert(vide, { userId: u.id, sid: uid('sid2'), method: suivante, client: client(uid('k')) })).toBe('sent');
      expect(await alertes(u.id)).toBe(1);
    }
  });
});
