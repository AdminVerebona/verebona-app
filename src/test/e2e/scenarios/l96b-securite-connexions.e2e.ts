/**
 * Lot 96B — CDC 18 sous-lot A « sécurité des connexions » : PostgreSQL réel,
 * VRAIES routes (connexion, renouvellement, Appareils connectés, mot de passe
 * oublié, réinitialisation). Matrice de recette PO §5 :
 *
 *   R06   nouveau navigateur : UNE alerte « nouvel appareil » ; reconnexions,
 *         renouvellement : aucun doublon ; e-mail de sécurité obligatoire ;
 *   P5    en-tête d'installation déclaré / cookie fabriqué : jamais
 *         « reconnu », alerte non supprimée, aucune session d'autrui remplacée ;
 *   R07   ancienne session non inscrite au registre : révoquée par
 *         « Déconnecter tous les autres appareils », session courante active ;
 *   P3    jetons d'accès (cookie ET en-tête Bearer) et de renouvellement
 *         révoqués : refusés ;
 *   R12   D1 à chaque seuil (A, B1, B2, B3), déblocage, attaque distribuée,
 *         aucun blocage global, titulaire sur appareil reconnu non pénalisé,
 *         message identique sans existence de compte ;
 *   R13   « Mot de passe oublié » pendant une pause : utilisable, ne lève
 *         rien par lui-même ; le lien reçu lève la pause (aucun blocage
 *         illimité).
 * La connexion Google / Apple (R03-R05, P2, accès social pendant une pause) :
 * `l96b-reauth-sociale.e2e.ts`.
 */
import { expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';

const PASSWORD = 'MotDePasseL96b!x';
const ORIGIN = 'http://localhost:3000';
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const UA_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const INSTALLATION = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };
const cookieOf = (res: Response, name: string) => (res as WithCookies).cookies.get(name)?.value;

let ipSeq = 1;
/** Adresse IP unique par appareil (compteurs D1 indépendants entre tests). */
const nextIp = () => `96.${Math.floor(ipSeq / 250) % 250}.${ipSeq++ % 250}.${Math.floor(Math.random() * 250)}`;

/** Un « appareil » : en-têtes, adresse IP et pot de cookies. */
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
  req(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    return new NextRequest(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': this.ip, ...this.headers, ...(cookie ? { cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

scenario('L96B', 'Sécurité des connexions — alertes, reconnaissance d’appareil, révocations, D1 (CDC 18 lot A)', ({ sql, make }) => {
  async function compte(prefix = 'l96b') {
    const email = `${uid(prefix)}@test.invalid`;
    const owner = await make.user({ email });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE',
      created_at = now() - interval '30 days' WHERE id = ${owner.id}`;
    await make.account({ owner });
    return { id: owner.id, email };
  }
  async function connecter(app: Appareil, email: string, password = PASSWORD) {
    const { POST } = await import('@/app/api/auth/login/route');
    return app.absorb(await POST(app.req('/api/auth/login', 'POST', { email, password })));
  }
  async function renouveler(app: Appareil) {
    const { POST } = await import('@/app/api/auth/refresh/route');
    return app.absorb(await POST(app.req('/api/auth/refresh', 'POST')));
  }
  async function sessions(app: Appareil, extra: Record<string, string> = {}) {
    const { GET } = await import('@/app/api/users/me/sessions/route');
    return GET(app.req('/api/users/me/sessions', 'GET', undefined, extra));
  }
  async function alertes(userId: number) {
    return sql<{ payload_json: Record<string, string>; dedupe_key: string; mandatory_email: boolean }[]>`
      SELECT payload_json, dedupe_key, mandatory_email FROM notification_outbox
       WHERE recipient_user_id = ${userId} AND event_type = 'NEW_DEVICE_LOGIN' ORDER BY created_at`;
  }
  /**
   * Journal d'activité (écrit en tâche de fond, sans bloquer la connexion). Lot 100A : attend
   * `attendues` lignes — rendre dès la PREMIÈRE ligne laissait la dernière écriture encore en
   * vol sur une machine chargée (4 lignes lues au lieu de 5). L'assertion compare ensuite le contenu exact.
   */
  async function journal(userId: number, type: string, attendues = 1) {
    let rows: { details: Record<string, unknown> }[] = [];
    for (let i = 0; i < 200; i++) {
      rows = await sql<{ details: Record<string, unknown> }[]>`
        SELECT details FROM user_activity_log WHERE user_id = ${userId} AND activity_type = ${type} ORDER BY id`;
      if (rows.length >= attendues) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return rows;
  }
  const parse = (d: unknown) => (typeof d === 'string' ? JSON.parse(d) : d) as Record<string, unknown>;

  // ── Q6 / R06 ──────────────────────────────────────────────────────────────

  it('R06 nouveau navigateur : une alerte ; reconnexions et renouvellement : aucun doublon ; un 2e navigateur : une 2e alerte', async () => {
    const u = await compte();
    const a = new Appareil();
    expect((await connecter(a, u.email)).status).toBe(200);
    let rows = await alertes(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].mandatory_email).toBe(true);
    expect(rows[0].payload_json).toMatchObject({ deviceLabel: 'PC Windows', browserLabel: 'Chrome', clientType: 'WEB' });
    expect(Date.parse(rows[0].payload_json.at)).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.stringify(rows[0].payload_json)).not.toContain(a.ip);

    for (let i = 0; i < 3; i++) expect((await connecter(a, u.email)).status).toBe(200);
    expect((await renouveler(a)).status).toBe(200);
    expect((await renouveler(a)).status).toBe(200);
    expect(await alertes(u.id)).toHaveLength(1);

    const b = new Appareil({ 'user-agent': UA_FIREFOX });
    expect((await connecter(b, u.email)).status).toBe(200);
    rows = await alertes(u.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => `${x.payload_json.deviceLabel} · ${x.payload_json.browserLabel}`).sort()).toEqual(['Mac · Firefox', 'PC Windows · Chrome']);

    // Journal : la décision est tracée, sans IP.
    const created = (await journal(u.id, 'SESSION_CREATED', 5)).map((r) => parse(r.details));
    expect(created.map((d) => d.newDeviceAlert)).toEqual(['sent', 'known_device', 'known_device', 'known_device', 'sent']);

    // Notification de sécurité OBLIGATOIRE : l'e-mail part même si l'utilisateur coupe les e-mails « sécurité ».
    const { applyPreferenceChanges } = await import('@/lib/notifications/preference-matrix');
    expect(await applyPreferenceChanges(u.id, [{ category: 'security', channel: 'email', enabled: false }]))
      .toEqual({ ok: false, error: 'EMAIL_MANDATORY:security' });
    // Même une ancienne préférence « e-mails sécurité coupés » n'empêche pas l'envoi.
    await sql`INSERT INTO notification_preferences (user_id, category, delivery_mode, channel, enabled)
      VALUES (${u.id}, 'security', 'immediate', 'email', false) ON CONFLICT DO NOTHING`;
    const { resolveChannels } = await import('@/lib/notifications');
    const { getCatalogEntry } = await import('@/lib/notifications/catalog');
    expect((await resolveChannels(u.id, getCatalogEntry('NEW_DEVICE_LOGIN')!)).email).toBe(true);
    // Gabarit (migration 0832) en base.
    expect(await sql`SELECT subject FROM email_templates WHERE type = 'notif_new_device_login'`).toEqual([{ subject: 'Verebona : connexion depuis un nouvel appareil' }]);
  });

  it('P5 en-tête d’installation DÉCLARÉ et cookie fabriqué : jamais reconnu, alerte maintenue, la session du titulaire n’est pas remplacée', async () => {
    const u = await compte();
    const natif = { 'user-agent': UA_IPHONE, 'x-verebona-client': 'ios', 'x-verebona-app-version': '1.0.3', 'x-verebona-installation-id': INSTALLATION };
    const titulaire = new Appareil({ ...natif });
    expect((await connecter(titulaire, u.email)).status).toBe(200);
    expect(await alertes(u.id)).toHaveLength(1);
    const [ligne] = await sql<{ device_source: string; client_type: string; browser_label: string }[]>`
      SELECT device_source, client_type, browser_label FROM user_sessions WHERE user_id = ${u.id}`;
    // Application : appareil identifié par le cookie signé de sa vue, jamais par l'en-tête d'installation.
    expect(ligne).toMatchObject({ device_source: 'cookie', client_type: 'IOS', browser_label: 'Application Verebona' });

    // Un tiers qui connaît le mot de passe ET recopie l'identifiant d'installation + l'identifiant d'appareil.
    const deviceId = titulaire.jar.get('vb_device')!.split('.')[1];
    const tiers = new Appareil({ ...natif });
    tiers.jar.set('vb_device', `d1.${deviceId}.`);
    expect((await connecter(tiers, u.email)).status).toBe(200);
    expect(await alertes(u.id)).toHaveLength(2); // alerte NON supprimée
    expect(tiers.jar.get('vb_device')!.split('.')[1]).not.toBe(deviceId); // identifiant neuf
    // La session du titulaire n'a pas été « remplacée » par le tiers.
    expect((await sessions(titulaire)).status).toBe(200);
    expect((await (await sessions(titulaire)).json()).sessions).toHaveLength(2);
  });

  // ── Q5 / R07 / P3 ─────────────────────────────────────────────────────────

  it('R07 / P3 ancienne session non inscrite : révoquée par « autres appareils » sans déconnecter celui-ci ; jetons révoqués refusés (cookie, Bearer, renouvellement)', async () => {
    const u = await compte();
    const ancienne = new Appareil({ 'user-agent': UA_FIREFOX });
    await connecter(ancienne, u.email);
    await sql`DELETE FROM user_sessions WHERE user_id = ${u.id}`; // ouverte avant le registre, jamais renouvelée
    const ancienAcces = ancienne.jar.get('access_token')!;
    const ici = new Appareil();
    await connecter(ici, u.email);
    // Rien n'est montré de l'ancienne session (Q5 : pas de promesse d'affichage immédiat).
    expect((await (await sessions(ici)).json()).sessions).toHaveLength(1);

    const { POST: reauth } = await import('@/app/api/users/me/security/reauth/route');
    expect((await reauth(ici.req('/api/users/me/security/reauth', 'POST', { method: 'password', password: PASSWORD }))).status).toBe(200);
    const { POST: autres } = await import('@/app/api/users/me/sessions/revoke-others/route');
    const r = ici.absorb(await autres(ici.req('/api/users/me/sessions/revoke-others', 'POST', {})));
    expect(r.status).toBe(200);

    // Ancienne session : accès refusé (cookie ET Bearer), renouvellement refusé.
    expect((await sessions(ancienne)).status).toBe(401);
    const bearer = new Appareil();
    expect((await sessions(bearer, { authorization: `Bearer ${ancienAcces}` })).status).toBe(401);
    expect((await renouveler(ancienne)).status).toBe(401);
    // Cet appareil reste connecté (session neuve), aucune déconnexion générale.
    expect((await sessions(ici)).status).toBe(200);
    expect((await renouveler(ici)).status).toBe(200);
    expect((await sessions(ici, { authorization: `Bearer ${ici.jar.get('access_token')}` })).status).toBe(200);
    // Session neuve de CET appareil : aucune alerte « nouvel appareil ».
    expect(await alertes(u.id)).toHaveLength(2); // les deux connexions initiales seulement
    // Aucun e-mail pour cette action (décision PO : retiré au lot 79C, non redemandé).
    expect(await sql`SELECT 1 FROM email_logs WHERE recipient_user_id = ${u.id} AND template_code = 'SECURITY_SESSIONS_REVOKED'`).toHaveLength(0);
  });

  it('P3 « Déconnecter » un appareil : son jeton d’accès encore valable est refusé immédiatement (Bearer compris)', async () => {
    const u = await compte();
    const a = new Appareil(); const b = new Appareil({ 'user-agent': UA_FIREFOX });
    await connecter(a, u.email); await connecter(b, u.email);
    const liste = (await (await sessions(a)).json()).sessions as Array<{ id: string; current: boolean }>;
    const cible = liste.find((s) => !s.current)!;
    const { DELETE } = await import('@/app/api/users/me/sessions/[id]/route');
    expect((await DELETE(a.req(`/api/users/me/sessions/${cible.id}`, 'DELETE'), { params: Promise.resolve({ id: cible.id }) })).status).toBe(200);
    expect((await sessions(new Appareil(), { authorization: `Bearer ${b.jar.get('access_token')}` })).status).toBe(401);
    expect((await renouveler(b)).status).toBe(401);
    expect((await sessions(a)).status).toBe(200);
  });

  // ── Q10 / Q11 / R12 ───────────────────────────────────────────────────────

  /** Clé pseudonymisée d'un compteur (mêmes règles que le limiteur). */
  async function limitKeyAsync(scope: 'login', kind: 'dev' | 'pair' | 'acctu', value: string) {
    return (await import('@/lib/auth/auth-rate-limit')).limitKey(scope, kind, value);
  }
  /** Déblocage : la pause de la clé est considérée comme écoulée. */
  async function pauseEcoulee(key: string) {
    await sql`UPDATE auth_rate_limits SET locked_until = now() - interval '1 second' WHERE bucket_key = ${key}`;
  }

  it('R12 B2 même IP et même adresse : 5 échecs → ralentissement (même avec le bon mot de passe) ; autre IP libre ; déblocage', async () => {
    const u = await compte();
    const att = new Appareil();
    for (let i = 0; i < 5; i++) expect((await connecter(att, u.email, 'Faux-123!')).status).toBe(401);
    const r = await connecter(att, u.email);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect((await connecter(new Appareil(), u.email)).status).toBe(200);
    const { originBucket } = await import('@/lib/auth/login-throttle');
    await pauseEcoulee(await limitKeyAsync('login', 'pair', `${originBucket(att.ip)}|${u.email}`));
    expect((await connecter(att, u.email)).status).toBe(200);
  });

  it('R12 B1 même IP, 20 adresses (pulvérisation) : pause de cette IP ; autres IP et titulaire reconnu derrière cette IP non bloqués (aucun blocage global)', async () => {
    const u = await compte();
    const maison = new Appareil();
    await connecter(maison, u.email); // appareil du titulaire, reconnu
    const ip = nextIp();
    const att = new Appareil({ 'user-agent': UA_FIREFOX }, ip);
    for (let i = 0; i < 20; i++) expect((await connecter(att, `${uid('spray')}@test.invalid`, 'Faux-123!')).status).toBe(401);
    const bloque = await connecter(att, `${uid('spray')}@test.invalid`, 'Faux-123!');
    expect(bloque.status).toBe(429);
    expect(Number(bloque.headers.get('retry-after'))).toBeGreaterThan(14 * 60);
    // Un nouvel appareil derrière la même IP est en pause aussi (règle d'origine)…
    expect((await connecter(new Appareil({ 'user-agent': UA_CHROME }, ip), u.email)).status).toBe(429);
    // …mais le titulaire sur son appareil reconnu, derrière cette même IP, passe.
    maison.ip = ip;
    expect((await connecter(maison, u.email)).status).toBe(200);
    // Ailleurs : personne n'est bloqué.
    expect((await connecter(new Appareil(), u.email)).status).toBe(200);
  });

  it('R12 B3 attaque distribuée (10 IP) : pause des appareils NON reconnus pour l’adresse ; le titulaire reconnu passe ; déblocage', async () => {
    const u = await compte();
    const maison = new Appareil();
    await connecter(maison, u.email);
    for (let i = 0; i < 10; i++) expect((await connecter(new Appareil(), u.email, 'Faux-123!')).status).toBe(401);
    const refus = await connecter(new Appareil(), u.email);
    expect(refus.status).toBe(429);
    expect(Number(refus.headers.get('retry-after'))).toBeGreaterThan(14 * 60);
    maison.ip = nextIp();
    expect((await connecter(maison, u.email)).status).toBe(200);
    // Pause bornée (plafond 60 min) puis levée.
    const [row] = await sql<{ locked_until: Date }[]>`SELECT locked_until FROM auth_rate_limits WHERE bucket_key = ${await limitKeyAsync('login', 'acctu', u.email)}`;
    expect(new Date(row.locked_until).getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 5_000);
    await pauseEcoulee(await limitKeyAsync('login', 'acctu', u.email));
    expect((await connecter(new Appareil(), u.email)).status).toBe(200);
    const journalPause = (await journal(u.id, 'AUTH_LOGIN_THROTTLED')).map((r) => parse(r.details));
    expect(journalPause[0]).toMatchObject({ rule: 'identifier_untrusted', trustedDevice: false });
  });

  it('R12 A appareil reconnu : son propre compteur (10 échecs → 1 min), sans effet sur les autres appareils ; déblocage', async () => {
    const u = await compte();
    const maison = new Appareil();
    await connecter(maison, u.email);
    for (let i = 0; i < 10; i++) expect((await connecter(maison, u.email, 'Faux-123!')).status).toBe(401);
    const r = await connecter(maison, u.email);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    // Un autre appareil (non reconnu) n'est pas pénalisé par ces échecs.
    expect((await connecter(new Appareil(), u.email)).status).toBe(200);
    const deviceId = maison.jar.get('vb_device')!.split('.')[1];
    await pauseEcoulee(await limitKeyAsync('login', 'dev', `${deviceId}|${u.email}`));
    expect((await connecter(maison, u.email)).status).toBe(200);
  });

  it('R12 message de pause : identique pour une adresse inscrite et inconnue, compréhensible, sans seuil', async () => {
    const u = await compte();
    const inconnue = `${uid('inconnue')}@test.invalid`;
    for (let i = 0; i < 10; i++) {
      await connecter(new Appareil(), u.email, 'Faux-123!');
      await connecter(new Appareil(), inconnue, 'Faux-123!');
    }
    const a = await connecter(new Appareil(), u.email, 'Faux-123!');
    const b = await connecter(new Appareil(), inconnue, 'Faux-123!');
    expect([a.status, b.status]).toEqual([429, 429]);
    const [ja, jb] = [await a.json(), await b.json()];
    expect(ja).toEqual(jb);
    expect(ja.message).toMatch(/^Trop de tentatives de connexion\. Réessayez dans \d+ minutes?, ou utilisez « Mot de passe oublié \? »/);
    expect(ja.message).not.toMatch(/compte|existe|inconnu|seuil|échec/i);
  });

  // ── Q11 / R13 ─────────────────────────────────────────────────────────────

  it('R13 « Mot de passe oublié » pendant une pause : demande acceptée et e-mail envoyé ; la demande seule ne lève rien ; le lien reçu lève la pause et reconnaît le navigateur', async () => {
    const u = await compte();
    for (let i = 0; i < 10; i++) await connecter(new Appareil(), u.email, 'Faux-123!');
    const titulaire = new Appareil();
    expect((await connecter(titulaire, u.email)).status).toBe(429);

    // Gabarit livré par le seed (absent de la base de test) : celui du code.
    const { DEFAULT_EMAIL_TEMPLATES } = await import('@/lib/email-defaults');
    await sql`INSERT INTO email_templates (type, subject, body, updated_at)
      VALUES ('PASSWORD_RESET', ${DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET.subject}, ${DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET.body}, now())
      ON CONFLICT (type) DO NOTHING`;
    const { POST: forgot } = await import('@/app/api/auth/forgot-password/route');
    const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
    const f = await forgot(titulaire.req('/api/auth/forgot-password', 'POST', { email: u.email }));
    expect(f.status).toBe(200);
    await settleDetachedAuthTasks();
    // E-mail produit (gabarit trouvé, lien signé) ; l'envoi réel dépend du prestataire, absent en test.
    const envois = await sql<{ error_message: string | null }[]>`SELECT error_message FROM email_logs WHERE recipient_user_id = ${u.id} AND template_code = 'PASSWORD_RESET'`;
    expect(envois).toHaveLength(1);
    expect(envois[0].error_message ?? '').not.toMatch(/Template .* not found/);
    // Pas un contournement : la demande seule ne lève pas la pause (même pour l'attaquant).
    expect((await connecter(titulaire, u.email)).status).toBe(429);
    // Des demandes répétées sont limitées (aucune inondation de la boîte) — réponse neutre identique.
    for (let i = 0; i < 4; i++) expect((await forgot(new Appareil().req('/api/auth/forgot-password', 'POST', { email: u.email }))).status).toBe(200);
    await settleDetachedAuthTasks();
    expect((await sql`SELECT 1 FROM email_logs WHERE recipient_user_id = ${u.id} AND template_code = 'PASSWORD_RESET'`).length).toBeLessThanOrEqual(3);

    // Le lien reçu (preuve de la boîte) : pause levée, navigateur reconnu.
    const [{ password_hash }] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${u.id}`;
    const { createPasswordResetToken } = await import('@/services/auth/password-reset.service');
    const token = createPasswordResetToken({ id: u.id, email: u.email, passwordHash: password_hash });
    const { POST: reset } = await import('@/app/api/auth/reset-password/route');
    const r = titulaire.absorb(await reset(titulaire.req('/api/auth/reset-password', 'POST', { token, newPassword: 'NouveauMdp96!x' })));
    expect(r.status).toBe(200);
    // Un jeton fabriqué ne lève rien (aucun contournement sans la boîte e-mail).
    expect((await reset(new Appareil().req('/api/auth/reset-password', 'POST', { token: `${token}x`, newPassword: 'Autre96!xx' }))).status).toBeGreaterThanOrEqual(400);
    expect((await connecter(titulaire, u.email, 'NouveauMdp96!x')).status).toBe(200);
    // L'attaque reprend : le titulaire, désormais reconnu, n'est plus pénalisé (aucun blocage illimité).
    for (let i = 0; i < 12; i++) await connecter(new Appareil(), u.email, 'Faux-123!');
    expect((await connecter(new Appareil(), u.email, 'NouveauMdp96!x')).status).toBe(429);
    expect((await connecter(titulaire, u.email, 'NouveauMdp96!x')).status).toBe(200);
  });
});
