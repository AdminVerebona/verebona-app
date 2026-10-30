/**
 * Lot 101B — ticket P1 « Notifications de sécurité — supprimer les affichages
 * in-app redondants avec les e-mails » (décision PO du 30/10/2026), sur
 * PostgreSQL 16 réel : VRAIES routes (connexion, renouvellement, Appareils
 * connectés, mot de passe, changement d'adresse, notifications), vrai moteur
 * (outbox, dispatcher, livraisons), vrai service d'e-mail (prestataire
 * simulé, journal `email_logs`), push natif par un fournisseur SIMULÉ.
 *
 * Tableau de recette du ticket (autour des scénarios 96B / 100D) :
 *   R01  connexion depuis un nouvel appareil : e-mail envoyé, aucune cloche,
 *        aucune notification servie (donc aucun toast) ;
 *   R02  appareil connu : aucun nouveau message ;
 *   R03  première connexion après création du compte : exception conservée ;
 *   R04  modification du mot de passe : e-mail conservé, rien dans l'application ;
 *   R05  modification de l'adresse e-mail : e-mails de sécurité conservés ;
 *   R06  association / dissociation Google et Apple : e-mail seul ;
 *   R07  révocation d'une session : effective, réponse de l'action conservée
 *        (« Appareil déconnecté ») ; « autres appareils » : e-mail seul ;
 *   R08  reconnexion après expiration : refus fonctionnel conservé (401) ;
 *   R09  ancien événement en attente / ancienne cloche non lue / réémission :
 *        rien n'est affiché, les preuves restent en base ;
 *   R10  actualisation de l'accueil : aucun message de sécurité ne réapparaît,
 *        les autres catégories restent affichées (toast obligatoire compris) ;
 *   R11  application mobile native : même règle, aucun push FCM de sécurité ;
 *   R12  échec d'envoi d'e-mail : échec tracé et repris, sans cloche ;
 *        supervision : canal retiré compté « ignoré », jamais « échec ».
 */
import { afterAll, beforeEach, expect, it } from 'vitest';
import { vi } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';

const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule';
  return {
    mails: [] as Array<{ to: string | string[]; subject?: string }>,
    pushes: [] as Array<{ token: string; data: Record<string, string> }>,
    /** Adresses dont le prestataire refuse l'envoi (R12). */
    refus: new Set<string>(),
    n: 0,
  };
});
afterAll(async () => {
  delete process.env.RESEND_API_KEY;
  const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
  setMobilePushProviderForTests(undefined);
});
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string | string[]; subject?: string }) => {
        const dest = Array.isArray(p.to) ? p.to : [p.to];
        if (dest.some((d) => etat.refus.has(d))) return { data: null, error: { name: 'simulated', message: 'refus simulé' } };
        etat.mails.push(p);
        etat.n += 1;
        return { data: { id: `em_l101b_${etat.n}` }, error: null };
      },
    };
  },
}));
const fournisseurPush = {
  name: 'fake-l101b',
  async send(m: { token: string; data: Record<string, string> }) {
    etat.pushes.push({ token: m.token, data: m.data });
    return { ok: true as const, messageId: `projects/e2e/messages/${etat.pushes.length}` };
  },
};

const PASSWORD = 'MotDePasseL101b!x';
const NEW_PASSWORD = 'NouveauMotDePasse101b!y';
const ORIGIN = 'http://localhost:3000';
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const UA_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const SECURITY_TYPES = [
  'AUTH_IDENTITY_LINKED', 'AUTH_IDENTITY_UNLINKED', 'EMAIL_CHANGED', 'EMAIL_CHANGE_REQUESTED',
  'NEW_DEVICE_LOGIN', 'OTHER_SESSIONS_REVOKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET_COMPLETED',
];

type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };
const cookieOf = (res: Response, name: string) => (res as WithCookies).cookies.get(name)?.value;
let ipSeq = 1;
const nextIp = () => `101.${Math.floor(ipSeq / 250) % 250}.${ipSeq++ % 250}.${Math.floor(Math.random() * 250)}`;

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

interface NotifView { id: number; type: string; mustDeliver: boolean; readAt: string | null }

scenario('L101B', 'Sécurité : e-mail obligatoire seul, aucun affichage dans l’application (Web et mobile)', ({ sql, make }) => {
  beforeEach(async () => {
    etat.refus.clear();
    delete process.env.MOBILE_FEATURES_OFF;
    const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
    setMobilePushProviderForTests(fournisseurPush as never);
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@verebona.com', 'support@verebona.com')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
  });

  async function compte(prefix = 'l101b', createdDaysAgo = 30) {
    const email = `${uid(prefix)}@test.invalid`;
    const owner = await make.user({ email });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE',
      created_at = now() - make_interval(days => ${createdDaysAgo}::int) WHERE id = ${owner.id}`;
    const acc = await make.account({ owner });
    return { id: owner.id, email, accountId: acc.id };
  }
  /** Téléphone de l'application mobile (lot 97) + ancienne préférence « push sécurité » activée. */
  async function telephone(u: { id: number; accountId: number }) {
    const jeton = `l101b-${u.id}-${'x'.repeat(30)}`;
    const { registerPushInstallation } = await import('@/lib/mobile/push-installations');
    await registerPushInstallation({ userId: u.id, accountId: u.accountId, sessionId: null, installationId: crypto.randomUUID(),
      platform: 'ios', appVersion: '1.0.0', build: '1', pushToken: jeton });
    await sql`INSERT INTO notification_preferences (user_id, category, delivery_mode, channel, enabled)
              VALUES (${u.id}, 'security', 'immediate', 'push', true) ON CONFLICT DO NOTHING`;
    return jeton;
  }
  async function connecter(app: Appareil, email: string, password = PASSWORD) {
    const { POST } = await import('@/app/api/auth/login/route');
    return app.absorb(await POST(app.req('/api/auth/login', 'POST', { email, password })));
  }
  async function reauth(app: Appareil) {
    const { POST } = await import('@/app/api/users/me/security/reauth/route');
    expect((await POST(app.req('/api/users/me/security/reauth', 'POST', { method: 'password', password: PASSWORD }))).status).toBe(200);
  }
  async function sessions(app: Appareil) {
    const { GET } = await import('@/app/api/users/me/sessions/route');
    return GET(app.req('/api/users/me/sessions'));
  }
  /** Ce que la cloche (Web et application) reçoit : liste ET pastille. */
  async function cloche(app: Appareil) {
    const { GET } = await import('@/app/api/notifications/route');
    const res = await GET(app.req('/api/notifications?limit=100'));
    return { status: res.status, body: res.status === 200 ? await res.json() as { notifications: NotifView[]; unreadCount: number } : null };
  }
  /** Distribue la file jusqu'à ce que les événements `type` du destinataire soient traités. */
  async function distribuer(userId: number, type: string, attendus = 1) {
    const { processPending } = await import('@/lib/notifications');
    let rows: Array<{ id: string; status: string; outcome_reason: string | null }> = [];
    for (let i = 0; i < 200; i++) {
      await processPending(100);
      rows = await sql`SELECT id, status, outcome_reason FROM notification_outbox
        WHERE recipient_user_id = ${userId} AND event_type = ${type} ORDER BY created_at`;
      if (rows.length >= attendus && rows.every((r) => r.status !== 'pending' && r.status !== 'processing')) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return rows;
  }
  const livraisons = (outboxId: string) => sql<{ channel: string; status: string; last_error_code: string | null }[]>`
    SELECT channel, status, last_error_code FROM notification_deliveries WHERE outbox_id = ${outboxId}::uuid ORDER BY channel, id`;
  const cloches = (userId: number) => sql<{ type: string }[]>`SELECT type FROM notifications WHERE user_id = ${userId} ORDER BY id`;
  const mailsA = (email: string) => etat.mails.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(email));
  const pushesA = (jeton: string) => etat.pushes.filter((p) => p.token === jeton);

  /** Contrôle commun : e-mail envoyé, cloche et push retirés (ni envoi ni échec). */
  async function emailSeul(outboxId: string, push: 'retire' | 'absent' = 'absent') {
    expect(await livraisons(outboxId)).toEqual([
      { channel: 'bell', status: 'skipped_unavailable', last_error_code: 'channel_retired' },
      { channel: 'email', status: 'sent', last_error_code: null },
      ...(push === 'retire' ? [{ channel: 'push', status: 'skipped_unavailable', last_error_code: 'channel_retired' }] : []),
    ]);
  }

  it('R01 / R02 / R10 nouvel appareil : e-mail envoyé, aucune cloche ni toast ; appareil connu : rien ; accueil actualisé : rien ne réapparaît', async () => {
    const u = await compte();
    const a = new Appareil();
    expect((await connecter(a, u.email)).status).toBe(200);
    const [alerte] = await distribuer(u.id, 'NEW_DEVICE_LOGIN');
    expect(alerte.status).toBe('sent');
    await emailSeul(alerte.id);
    expect(mailsA(u.email).map((m) => m.subject)).toContain('Verebona : connexion depuis un nouvel appareil');
    // Journal des envois (historique) conservé.
    expect(await sql`SELECT status FROM email_logs WHERE recipient_email = ${u.email} AND template_code = 'notif_new_device_login'`).toEqual([{ status: 'sent' }]);
    // Aucune ligne de cloche, rien servi au client (ni liste, ni pastille) → aucun toast possible.
    expect(await cloches(u.id)).toEqual([]);
    expect((await cloche(a)).body).toEqual({ notifications: [], unreadCount: 0 });

    // R02 : appareil connu (reconnexions, renouvellement) — aucun nouveau message.
    for (let i = 0; i < 2; i++) expect((await connecter(a, u.email)).status).toBe(200);
    const { POST: refresh } = await import('@/app/api/auth/refresh/route');
    expect(a.absorb(await refresh(a.req('/api/auth/refresh', 'POST'))).status).toBe(200);
    expect(await distribuer(u.id, 'NEW_DEVICE_LOGIN')).toHaveLength(1);
    expect(mailsA(u.email)).toHaveLength(1);

    // R10 : chargements successifs de l'accueil (sondage de la cloche) — toujours rien.
    for (let i = 0; i < 3; i++) expect((await cloche(a)).body).toEqual({ notifications: [], unreadCount: 0 });
  });

  it('R03 première connexion après création du compte : exception conservée (aucun message)', async () => {
    const u = await compte('l101b-r03', 0);
    expect((await connecter(new Appareil(), u.email)).status).toBe(200);
    // Détection inchangée : la session qui crée le compte n'est pas « un nouvel appareil ».
    await new Promise((r) => setTimeout(r, 100));
    expect(await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${u.id} AND event_type = 'NEW_DEVICE_LOGIN'`).toHaveLength(0);
    expect(mailsA(u.email)).toHaveLength(0);
    expect(await cloches(u.id)).toEqual([]);
  });

  it('R04 modification du mot de passe : e-mail « mot de passe modifié » conservé, rien dans l’application', async () => {
    const u = await compte('l101b-r04');
    const a = new Appareil();
    await connecter(a, u.email);
    await distribuer(u.id, 'NEW_DEVICE_LOGIN');
    const { POST } = await import('@/app/api/users/me/change-password/route');
    const res = a.absorb(await POST(a.req('/api/users/me/change-password', 'POST', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, keepCurrentSession: true })));
    expect(res.status).toBe(200);
    const [ev] = await distribuer(u.id, 'PASSWORD_CHANGED');
    expect(ev.status).toBe('sent');
    await emailSeul(ev.id);
    expect(mailsA(u.email).length).toBe(2); // nouvel appareil + mot de passe modifié
    expect(await cloches(u.id)).toEqual([]);
    expect((await cloche(a)).body?.notifications).toEqual([]);
  });

  it('R05 modification de l’adresse e-mail : e-mails de sécurité aux deux adresses conservés, rien dans l’application', async () => {
    const u = await compte('l101b-r05');
    const a = new Appareil();
    await connecter(a, u.email);
    await distribuer(u.id, 'NEW_DEVICE_LOGIN');
    await reauth(a);
    const nouvelle = `${uid('l101b-nouv')}@test.invalid`;
    const { POST: demander } = await import('@/app/api/users/me/email-change/route');
    expect((await demander(a.req('/api/users/me/email-change', 'POST', { newEmail: nouvelle }))).status).toBe(200);
    const [lien] = await sql<{ id: number }[]>`SELECT id FROM email_change_requests WHERE user_id = ${u.id}`;
    expect(lien).toBeTruthy();
    // Lien de confirmation envoyé à la nouvelle adresse (e-mail transactionnel, inchangé).
    expect(mailsA(nouvelle).length).toBe(1);
    // Confirmation par le service (le lien en clair n'est jamais en base) : on rejoue la bascule réelle.
    const { notifyEmailChanged } = await import('@/services/auth/email-change.service');
    const r = await notifyEmailChanged({ userId: u.id, oldEmail: u.email, newEmail: nouvelle });
    expect(r.notified.sort()).toEqual([u.email, nouvelle].sort());
    expect(await cloches(u.id)).toEqual([]);
    expect((await cloche(a)).body?.unreadCount).toBe(0);
  });

  it('R06 association / dissociation Google et Apple : e-mail seul, aucune cloche', async () => {
    const u = await compte('l101b-r06');
    const a = new Appareil();
    await connecter(a, u.email);
    await distribuer(u.id, 'NEW_DEVICE_LOGIN');
    const { notifyIdentityChange } = await import('@/lib/auth/oauth/flow');
    for (const provider of ['google', 'apple'] as const) {
      await notifyIdentityChange(a.req('/api/users/me/auth-identities'), u.id, u.email, provider, 'linked', 'e2e');
      await notifyIdentityChange(a.req('/api/users/me/auth-identities'), u.id, u.email, provider, 'unlinked', 'e2e');
    }
    for (const type of ['AUTH_IDENTITY_LINKED', 'AUTH_IDENTITY_UNLINKED']) {
      const rows = await distribuer(u.id, type, 2);
      expect(rows).toHaveLength(2);
      for (const r of rows) { expect(r.status).toBe('sent'); await emailSeul(r.id); }
    }
    expect(mailsA(u.email).length).toBe(5);
    expect(await cloches(u.id)).toEqual([]);
  });

  it('R07 / R08 révocation : effective, réponse de l’action conservée ; « autres appareils » : e-mail seul ; appareil révoqué : refus de reconnexion', async () => {
    const u = await compte('l101b-r07');
    const ici = new Appareil();
    const b = new Appareil({ 'user-agent': UA_FIREFOX });
    const c = new Appareil({ 'user-agent': UA_IPHONE });
    for (const x of [ici, b, c]) await connecter(x, u.email);
    await distribuer(u.id, 'NEW_DEVICE_LOGIN', 3);

    // « Déconnecter » UN appareil : effectif, réponse à l'écran (« … est déconnecté. »), aucun message de sécurité.
    await reauth(ici);
    const liste = (await (await sessions(ici)).json()).sessions as Array<{ id: string; current: boolean; browserLabel?: string }>;
    const cible = liste.find((s) => !s.current && s.browserLabel === 'Firefox')!;
    const { DELETE } = await import('@/app/api/users/me/sessions/[id]/route');
    const del = await DELETE(ici.req(`/api/users/me/sessions/${cible.id}`, 'DELETE'), { params: Promise.resolve({ id: cible.id }) });
    expect(del.status).toBe(200);
    expect((await sessions(b)).status).toBe(401);
    // R08 : l'appareil révoqué reçoit un refus fonctionnel (reconnexion), pas une notification.
    expect((await cloche(b)).status).toBe(401);
    const { POST: refresh } = await import('@/app/api/auth/refresh/route');
    expect((await refresh(b.req('/api/auth/refresh', 'POST'))).status).toBe(401);

    // « Déconnecter tous les autres appareils » : e-mail obligatoire, pas de cloche.
    await reauth(ici);
    const { POST } = await import('@/app/api/users/me/sessions/revoke-others/route');
    const r = ici.absorb(await POST(ici.req('/api/users/me/sessions/revoke-others', 'POST', {})));
    expect(await r.json()).toMatchObject({ success: true, revoked: 1, securityEmail: true });
    expect((await sessions(c)).status).toBe(401);
    const [conf] = await distribuer(u.id, 'OTHER_SESSIONS_REVOKED');
    expect(conf.status).toBe('sent');
    await emailSeul(conf.id);
    expect(mailsA(u.email).map((m) => m.subject)).toContain('Verebona : vos autres appareils ont été déconnectés');
    expect(await cloches(u.id)).toEqual([]);
    expect((await cloche(ici)).body).toEqual({ notifications: [], unreadCount: 0 });
  });

  it('R09 / R10 historique : ancien événement en attente, anciennes cloches non lues, réémission — rien n’est affiché, preuves conservées', async () => {
    const u = await compte('l101b-r09');
    const jeton = await telephone(u);
    const a = new Appareil();
    await connecter(a, u.email);
    await distribuer(u.id, 'NEW_DEVICE_LOGIN');

    // 1) Ligne mise en file AVANT le déploiement (drapeau « cloche obligatoire » de l'ancienne version).
    const [ancienne] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, category, recipient_user_id, entity_type, entity_id, payload_json, priority,
                                       mandatory_bell, mandatory_email, dedupe_key, status, created_at)
      VALUES ('NEW_DEVICE_LOGIN', 'security', ${u.id}, 'user', ${String(u.id)},
              ${JSON.stringify({ at: '2026-10-29T07:00:00.000Z', deviceLabel: 'PC Windows', browserLabel: 'Edge' })}::jsonb,
              'high', true, true, ${`security:new-device:${u.id}:ancien:u${u.id}`}, 'pending', now() - interval '1 day')
      RETURNING id`;
    await distribuer(u.id, 'NEW_DEVICE_LOGIN', 2);
    expect((await sql`SELECT status FROM notification_outbox WHERE id = ${ancienne.id}::uuid`)[0].status).toBe('sent');
    await emailSeul(ancienne.id, 'retire');
    expect(pushesA(jeton)).toHaveLength(0);

    // 2) Anciennes cloches de sécurité déjà persistées, non lues (« toast » au prochain chargement avant le lot 101B),
    //    et une cloche obligatoire d'une AUTRE catégorie (inchangée).
    for (const type of ['NEW_DEVICE_LOGIN', 'OTHER_SESSIONS_REVOKED', 'PASSWORD_CHANGED', 'AUTH_IDENTITY_LINKED']) {
      await sql`INSERT INTO notifications (user_id, type, payload_json, dedupe_key, must_deliver, title, body, category, created_at)
                VALUES (${u.id}, ${type}, '{}', ${`hist:${type}:${u.id}`}, true, 'Ancien titre', 'Ancien texte', 'security', now() - interval '2 hours')`;
    }
    await sql`INSERT INTO notifications (user_id, type, payload_json, dedupe_key, must_deliver, title, body, category, created_at)
              VALUES (${u.id}, 'PAYMENT_FAILED', '{}', ${`hist:pay:${u.id}`}, true, 'Paiement refusé', 'Un paiement a échoué.', 'account', now() - interval '1 hour')`;
    for (let i = 0; i < 2; i++) { // R10 : accueil chargé, puis actualisé
      const vue = (await cloche(a)).body!;
      expect(vue.notifications.map((n) => n.type)).toEqual(['PAYMENT_FAILED']);
      expect(vue.notifications[0]).toMatchObject({ mustDeliver: true, readAt: null }); // toast obligatoire des autres catégories conservé
      expect(vue.unreadCount).toBe(1);
      const nonLues = await (await import('@/app/api/notifications/route')).GET(a.req('/api/notifications?unread=true'));
      expect(((await nonLues.json()) as { notifications: NotifView[] }).notifications.map((n) => n.type)).toEqual(['PAYMENT_FAILED']);
    }
    // « Tout lu » : seule la cloche visible change ; les lignes de sécurité restent intactes (audit).
    const { PATCH } = await import('@/app/api/notifications/route');
    expect((await PATCH(a.req('/api/notifications', 'PATCH', { markAllRead: true }))).status).toBe(200);
    const restes = await sql<{ type: string; read_at: Date | null }[]>`SELECT type, read_at FROM notifications WHERE user_id = ${u.id} ORDER BY id`;
    expect(restes.filter((r) => r.type !== 'PAYMENT_FAILED').map((r) => [r.type, r.read_at])).toEqual([
      ['NEW_DEVICE_LOGIN', null], ['OTHER_SESSIONS_REVOKED', null], ['PASSWORD_CHANGED', null], ['AUTH_IDENTITY_LINKED', null],
    ]);
    expect(restes.find((r) => r.type === 'PAYMENT_FAILED')!.read_at).not.toBeNull();

    // 3) Réémission BO d'un ancien échec (cloche ET e-mail en échec) : e-mail seul.
    const [origine] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, category, recipient_user_id, payload_json, priority, mandatory_bell, mandatory_email,
                                       dedupe_key, status, processed_at, created_at)
      VALUES ('PASSWORD_CHANGED', 'security', ${u.id}, '{}'::jsonb, 'high', true, true, ${`security:password-changed:${u.id}:ancien:u${u.id}`},
              'failed', now() - interval '1 day', now() - interval '1 day') RETURNING id`;
    await sql`INSERT INTO notification_deliveries (outbox_id, user_id, channel, status, last_error_code, attempt_count)
              VALUES (${origine.id}::uuid, ${u.id}, 'bell', 'failed', 'bell_insert_error', 1),
                     (${origine.id}::uuid, ${u.id}, 'email', 'failed', 'email_send_error', 1)`;
    const admin = await make.user({ role: 'ADMIN' });
    const { reemettreNotification } = await import('@/services/notifications/notification-reemission.service');
    const re = await reemettreNotification({ actorEmail: admin.email, actorUserId: admin.id, outboxId: origine.id, confirme: true });
    expect(re.canaux).toEqual(['email']);
    const rows = await distribuer(u.id, 'PASSWORD_CHANGED', 2);
    const nouvelle = rows.find((r) => r.id === re.nouvelleId)!;
    expect(nouvelle.status).toBe('sent');
    expect(await livraisons(re.nouvelleId)).toEqual([{ channel: 'email', status: 'sent', last_error_code: null }]);
    expect((await cloche(a)).body?.notifications.map((n) => n.type)).toEqual(['PAYMENT_FAILED']);
    // Aucune preuve détruite : outbox, livraisons et anciennes cloches toujours en base.
    expect((await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${u.id} AND type = ANY(${SECURITY_TYPES})`)[0].n).toBe(4);
  });

  it('R11 application mobile native : même règle — aucune cloche, aucun push FCM de sécurité ; les autres push restent', async () => {
    const u = await compte('l101b-r11');
    const jeton = await telephone(u);
    const app = new Appareil({ 'user-agent': UA_IPHONE, 'x-verebona-client': 'ios', 'x-verebona-app-version': '1.0.0' });
    expect((await connecter(app, u.email)).status).toBe(200);
    const [alerte] = await distribuer(u.id, 'NEW_DEVICE_LOGIN');
    expect(alerte.status).toBe('sent');
    await emailSeul(alerte.id, 'retire');
    expect(pushesA(jeton)).toHaveLength(0);
    expect((await cloche(app)).body).toEqual({ notifications: [], unreadCount: 0 });
    // Push mobile des AUTRES catégories inchangé (échéance J-7).
    const { emit } = await import('@/lib/notifications');
    await emit({ type: 'DEADLINE_DUE_IN_7_DAYS', recipientUserIds: [u.id], payload: { count: 1, date: '2026-11-06' }, dedupeKey: `l101b-j7-${u.id}` });
    const [j7] = await distribuer(u.id, 'DEADLINE_DUE_IN_7_DAYS');
    expect(j7.status).toBe('sent');
    expect(pushesA(jeton)).toHaveLength(1);
    expect((await cloche(app)).body?.notifications.map((n) => n.type)).toEqual(['DEADLINE_DUE_IN_7_DAYS']);
  });

  it('R12 échec d’envoi d’e-mail : échec tracé puis repris, jamais de cloche ; supervision : canal retiré ≠ échec', async () => {
    const u = await compte('l101b-r12');
    etat.refus.add(u.email);
    const a = new Appareil();
    await connecter(a, u.email);
    const [alerte] = await distribuer(u.id, 'NEW_DEVICE_LOGIN');
    expect(alerte.status).toBe('failed');
    expect(await livraisons(alerte.id)).toEqual([
      { channel: 'bell', status: 'skipped_unavailable', last_error_code: 'channel_retired' },
      { channel: 'email', status: 'failed', last_error_code: 'email_send_error' },
    ]);
    expect(await cloches(u.id)).toEqual([]);
    expect((await cloche(a)).body?.notifications).toEqual([]);

    // Supervision : la cloche retirée est « ignorée », jamais un échec ; l'e-mail en échec est compté.
    const { getNotificationHealth } = await import('@/services/notifications/notification-health.service');
    const sante = await getNotificationHealth(24);
    const bell = sante.livraisonsParCanal.find((c) => c.canal === 'bell');
    expect(bell?.ignorees ?? 0).toBeGreaterThan(0);
    const [{ n: bellEchecs }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification_deliveries d
      JOIN notification_outbox o ON o.id = d.outbox_id WHERE o.category = 'security' AND d.channel = 'bell' AND d.status = 'failed'
      AND o.created_at > now() - interval '1 hour'`;
    expect(bellEchecs).toBe(0);
    // Échec d'e-mail tracé (journal des envois) et visible en supervision.
    expect(await sql`SELECT status FROM email_logs WHERE recipient_email = ${u.email} AND template_code = 'notif_new_device_login'`).toEqual([{ status: 'failed' }]);
    expect(sante.emailsEnEchec.find((e) => e.gabarit === 'notif_new_device_login')?.total ?? 0).toBeGreaterThan(0);

    // Reprise (mécanisme existant : réémission BO des canaux en échec) : l'e-mail part, toujours sans cloche.
    etat.refus.clear();
    const admin = await make.user({ role: 'ADMIN' });
    const { reemettreNotification } = await import('@/services/notifications/notification-reemission.service');
    const re = await reemettreNotification({ actorEmail: admin.email, actorUserId: admin.id, outboxId: alerte.id, confirme: true });
    expect(re.canaux).toEqual(['email']);
    await distribuer(u.id, 'NEW_DEVICE_LOGIN', 2);
    expect(await livraisons(re.nouvelleId)).toEqual([{ channel: 'email', status: 'sent', last_error_code: null }]);
    expect(mailsA(u.email).map((m) => m.subject)).toContain('Verebona : connexion depuis un nouvel appareil');
    expect(await cloches(u.id)).toEqual([]);
  });
});
