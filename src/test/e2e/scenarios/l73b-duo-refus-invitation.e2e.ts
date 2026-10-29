/**
 * Lot 73 (73B) — décision PO du 20/10/2026, point 4 : « Refuser
 * l'invitation » Premium Duo. PostgreSQL 16 réel, VRAIES routes (inscription,
 * vérification d'adresse, invitation, refus, acceptation, réinvitation).
 * Seule l'activation de l'offre Duo du titulaire passe par `applyPlanChange`
 * (chemin réel du BO et des webhooks Stripe) : Stripe n'est pas joignable.
 *
 * Identifiants L73B-xx :
 *   01 invité NON INSCRIT (lien de l'e-mail) : refus sans compte créé, jeton
 *      invalidé (rejoindre, s'inscrire, revoir le lien) ;
 *   02 titulaire prévenu : cloche (service de notifications) + e-mail
 *      DUO_INVITATION_DECLINED (file durable, gabarit en base) ; rien à l'invité ;
 *   03 refus idempotent (rejeu, double clic) : un seul effet, une seule
 *      notification, un seul e-mail ;
 *   04 anti-énumération : jeton inconnu, déjà accepté, expiré → même réponse,
 *      aucun effet, aucune adhésion touchée ;
 *   05 invité DÉJÀ CONNECTÉ (page d'invitation) : refus, son espace intact,
 *      rejoindre ensuite refusé (DECLINED_TOKEN) ;
 *   06 écran « sans espace » : refus de l'invitation adressée à l'adresse
 *      vérifiée de la session ; sans session → 401 ;
 *   07 titulaire : statut « Refusée » dans le panneau, « Réinviter » la même
 *      adresse sans erreur, nouveau lien fonctionnel jusqu'à l'adhésion ;
 *   08 refus et acceptation simultanés : jamais les deux ;
 *   09 migration 0530 rejouable, gabarit personnalisé jamais écrasé (garde
 *      0483), gabarit éditable dans le BO (variables déclarées).
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { activerParLien } from '../activation';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return { calls: [] as Array<{ to: string; html: string; subject?: string; text?: string }>, n: 0 };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; html: string; subject?: string }) => {
        etat.calls.push(p);
        etat.n += 1;
        return { data: { id: `em_l73b_${etat.n}` }, error: null };
      },
    };
  },
}));

const PASSWORD = 'MembreDuo1!x';
const SUJET_REFUS = 'Votre invitation Premium Duo a été refusée';
type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test',
    'x-forwarded-for': `95.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.8`,
  };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const ck = (access?: string) => (access ? `access_token=${access}` : undefined);

scenario('L73B', 'Premium Duo — refuser l’invitation', ({ sql, make }) => {
  beforeEach(async () => {
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    // Lot 79C (migration 0620) : l'e-mail DUO_INVITATION_DECLINED est désactivé
    // par défaut ; ce scénario porte sur son envoi une fois ACTIVÉ au BO
    // (activation facultative, mécanisme existant COM-011).
    await sql`INSERT INTO communication_channel_settings (event_code, channel, is_active, updated_at)
              VALUES ('email:DUO_INVITATION_DECLINED', 'email', true, now())
              ON CONFLICT (event_code, channel) DO UPDATE SET is_active = true`;
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

  // ── Parcours réels ────────────────────────────────────────────────────
  async function inscrire(email: string, inviteToken?: string) {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(req('/api/users', {
      body: { email, password: PASSWORD, firstName: 'Inès', lastName: 'Invitée', acceptedTerms: true, termsVersion: await cgvu(), inviteToken },
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }
  async function activer(email: string) {
    await (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();
    const mail = etat.calls.filter((c) => c.to === email && /verify-email\?token=/.test(c.html)).at(-1);
    const m = /href="([^"]*\/api\/auth\/verify-email\?token=[^"]+)"/.exec(mail?.html ?? '');
    expect(m, `e-mail de vérification reçu par ${email}`).toBeTruthy();
    // Lot 96A (Q9) : le lien mène à la page qui exige le mot de passe de l'inscription.
    const res = await activerParLien(m![1].replace(/&amp;/g, '&'), PASSWORD);
    await (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();
    return { location: res.headers.get('location') ?? '', access: (res as WithCookies).cookies.get('access_token')?.value };
  }
  async function rejoindre(access: string | undefined, body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/duo/join/route');
    const res = await POST(req('/api/duo/join', { body, cookie: ck(access) }));
    return { status: res.status, body: await res.clone().json().catch(() => ({})) as Record<string, unknown> };
  }
  async function verifierLien(token: string) {
    const { GET } = await import('@/app/api/duo/join/route');
    const res = await GET(req(`/api/duo/join?token=${encodeURIComponent(token)}`));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }
  async function refuser(body: Record<string, unknown>, access?: string) {
    const { POST } = await import('@/app/api/duo/decline/route');
    const res = await POST(req('/api/duo/decline', { body, cookie: ck(access) }));
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  }
  async function etatInvitation(tok: string) {
    const { GET } = await import('@/app/api/duo/invitation/route');
    const res = await GET(req('/api/duo/invitation', { cookie: ck(tok) }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }
  async function jeton(user: { id: number; email: string }, accountId: number | null) {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({
      id: user.id, email: user.email, role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never,
      ...(accountId ? { currentAccountId: accountId } : {}), hasActiveAccount: true,
    });
  }
  async function duoActif(m = 'DUO') {
    const owner = await make.user({ email: `${uid('titulaire')}@proton.me` });
    await sql`UPDATE users SET first_name = 'Camille', last_name = 'Durand', is_active = true WHERE id = ${owner.id}`;
    const acc = await make.account({ owner, plan: 'premium_duo', name: `Compte de Camille Durand ${m}` });
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    await applyPlanChange({
      accountId: acc.id, ownerUserId: owner.id, oldPlanType: 'STANDARD', newPlanType: 'PREMIUM_DUO',
      newSubStatus: 'ACTIVE', newPremiumUntil: null, newMaxMembers: 2, source: 'e2e:l73b', sendEmails: false,
    });
    const [{ duo_account_id: duoId }] = await sql<{ duo_account_id: number }[]>`SELECT duo_account_id FROM accounts WHERE id = ${acc.id}`;
    return { owner, acc, duoId, tok: await jeton(owner, acc.id) };
  }
  async function inviterDuo(tokTitulaire: string, email: string, duoId: number) {
    const { POST } = await import('@/app/api/duo/invitation/route');
    const res = await POST(req('/api/duo/invitation', { body: { email }, cookie: ck(tokTitulaire) }));
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await sql<{ t: string }[]>`SELECT pending_invite_token AS t FROM duo_accounts WHERE id = ${duoId}`;
    return row.t;
  }
  const retry = async (at = new Date(Date.now() + 1_000)) => (await import('@/services/email/transactional-email-jobs.service'))
    .runTransactionalEmailRetry({ now: () => at, deadline: Date.now() + 30_000 });
  const dispatch = async () => (await import('@/lib/notifications/dispatcher')).processPending(200);
  const outbox = (ownerId: number) => sql<{ recipient_user_id: number; account_id: number | null; payload_json: Record<string, unknown> }[]>`
    SELECT recipient_user_id, account_id, payload_json FROM notification_outbox WHERE event_type = 'DUO_INVITATION_DECLINED' AND recipient_user_id = ${ownerId}`;
  const jobs = (ownerId: number) => sql<{ id: number; status: string; recipient_email: string; dedupe_key: string | null; last_error: string | null }[]>`
    SELECT id, status, recipient_email, dedupe_key, last_error FROM transactional_email_jobs WHERE kind = 'DUO_INVITATION_DECLINED' AND user_id = ${ownerId} ORDER BY id`;
  const duoRow = async (duoId: number) => (await sql<{
    pending_invite_token: string | null; pending_invite_email: string | null; last_declined_invite_email: string | null;
    last_declined_at: Date | null; last_declined_invite_token_hash: string | null;
  }[]>`SELECT pending_invite_token, pending_invite_email, last_declined_invite_email, last_declined_at, last_declined_invite_token_hash
         FROM duo_accounts WHERE id = ${duoId}`)[0];
  const mailsTo = (email: string) => etat.calls.filter((c) => c.to === email);

  // ── L73B-01 ────────────────────────────────────────────────────────────
  it('L73B-01 — invité non inscrit : refus depuis le lien de l’e-mail, sans compte, jeton invalidé', async () => {
    const d = await duoActif('NONINSCRIT');
    const email = `${uid('refus')}@proton.me`;
    const token = await inviterDuo(d.tok, email, d.duoId);
    expect((await verifierLien(token)).status).toBe(200);

    const r = await refuser({ token });
    expect(r).toEqual({ status: 200, body: { success: true } });

    // Aucun compte, aucune identité créée pour l'adresse invitée.
    expect(await sql`SELECT 1 FROM users WHERE lower(email) = ${email}`).toHaveLength(0);
    // Jeton invalidé : plus d'invitation en attente, refus mémorisé (empreinte, jamais le jeton).
    const row = await duoRow(d.duoId);
    expect(row.pending_invite_token).toBeNull();
    expect(row.pending_invite_email).toBeNull();
    expect(row.last_declined_invite_email).toBe(email);
    expect(row.last_declined_at).toBeTruthy();
    expect(row.last_declined_invite_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.last_declined_invite_token_hash).not.toBe(token);
    // Le lien ne vaut plus rien : page d'invitation, inscription, rattachement.
    expect(await verifierLien(token)).toEqual({ status: 410, body: { error: 'DECLINED_TOKEN' } });
    const s = await inscrire(email, token);
    expect(s.status).toBe(400);
    expect(s.body.code).toBe('INVALID_INVITE_TOKEN');
    const { describeSignupInvitation } = await import('@/lib/prelaunch-invitations');
    expect(await describeSignupInvitation(token)).toEqual({ kind: 'duo', state: 'declined' });
  });

  // ── L73B-02 ────────────────────────────────────────────────────────────
  it('L73B-02 — titulaire prévenu : cloche + e-mail DUO_INVITATION_DECLINED ; rien à l’invité', async () => {
    const d = await duoActif('PREVENU');
    const email = `${uid('refus<b>')}@proton.me`.replace('<b>', '');
    const token = await inviterDuo(d.tok, email, d.duoId);
    await retry(); // e-mail d'invitation expédié
    const avant = mailsTo(email).length;

    expect((await refuser({ token })).status).toBe(200);

    // Service de notifications (outbox durable, enregistrée dans la transaction du refus).
    const ob = await outbox(d.owner.id);
    expect(ob).toHaveLength(1);
    expect(ob[0].account_id).toBe(d.acc.id);
    expect(ob[0].payload_json).toMatchObject({ inviteEmail: email });
    await dispatch();
    const [cloche] = await sql<{ title: string; body: string; href: string | null }[]>`
      SELECT title, body, href FROM notifications WHERE user_id = ${d.owner.id} AND type = 'DUO_INVITATION_DECLINED'`;
    expect(cloche.title).toBe('Invitation refusée');
    expect(cloche.body).toContain(email);
    expect(cloche.href).toMatch(/^\/mon-compte(\?space=\d+)?#duo-invitation$/);
    // Aucun push / e-mail générique en double par le canal e-mail des notifications.
    expect(await sql`SELECT 1 FROM email_logs WHERE recipient_email = ${d.owner.email} AND template_code ILIKE 'notif_%'`).toHaveLength(0);

    // E-mail transactionnel durable au titulaire.
    const [j, ...autres] = await jobs(d.owner.id);
    expect(autres).toHaveLength(0);
    expect(j).toMatchObject({ status: 'pending', recipient_email: d.owner.email });
    expect(j.dedupe_key).toMatch(new RegExp(`^duo-invitation-declined:${d.duoId}:[0-9a-f]{64}$`));
    await retry();
    const [m, ...m2] = mailsTo(d.owner.email);
    expect(m2).toHaveLength(0);
    expect(m.subject).toBe(SUJET_REFUS);
    expect(m.html).toContain('Bonjour Camille');
    expect(m.html).toContain(email);
    expect(m.html).toContain(`${APP}/mon-compte#duo-invitation`);
    expect((await jobs(d.owner.id))[0].status).toBe('accepted');
    // L'invité ne reçoit rien de plus (ni confirmation ni relance d'invitation).
    await retry(new Date(Date.now() + 60 * 60_000));
    expect(mailsTo(email)).toHaveLength(avant);
  });

  // ── L73B-03 ────────────────────────────────────────────────────────────
  it('L73B-03 — refus idempotent : rejeu et double clic sans second effet', async () => {
    const d = await duoActif('IDEMPOTENT');
    const email = `${uid('refus')}@proton.me`;
    const token = await inviterDuo(d.tok, email, d.duoId);
    const [a, b] = await Promise.all([refuser({ token }), refuser({ token })]);
    expect(a).toEqual({ status: 200, body: { success: true } });
    expect(b).toEqual(a);
    const premier = (await duoRow(d.duoId)).last_declined_at;
    expect(await refuser({ token })).toEqual(a);
    expect((await duoRow(d.duoId)).last_declined_at).toEqual(premier);
    expect(await outbox(d.owner.id)).toHaveLength(1);
    expect(await jobs(d.owner.id)).toHaveLength(1);
  });

  // ── L73B-04 ────────────────────────────────────────────────────────────
  it('L73B-04 — anti-énumération : inconnu, accepté, expiré → même réponse, aucun effet', async () => {
    const d = await duoActif('ENUM');
    const attendu = { status: 200, body: { success: true } };
    // Jeton inconnu (bien formé).
    expect(await refuser({ token: 'a'.repeat(64) })).toEqual(attendu);
    // Jeton déjà ACCEPTÉ : l'adhésion n'est pas touchée.
    const email = `${uid('membre')}@proton.me`;
    const token = await inviterDuo(d.tok, email, d.duoId);
    expect((await inscrire(email, token)).status).toBe(201);
    const v = await activer(email);
    expect((await rejoindre(v.access, { token })).status).toBe(200);
    expect(await refuser({ token })).toEqual(attendu);
    const [u] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email}`;
    expect((await sql<{ status: string }[]>`SELECT status FROM account_memberships WHERE account_id = ${d.acc.id} AND user_id = ${u.id}`)[0].status).toBe('active');
    expect((await duoRow(d.duoId)).last_declined_at).toBeNull();
    // Jeton EXPIRÉ : même réponse, rien n'est écrit (l'invitation reste « expirée » chez le titulaire).
    const d2 = await duoActif('ENUM-EXPIRE');
    const expire = await inviterDuo(d2.tok, `${uid('expire')}@proton.me`, d2.duoId);
    await sql`UPDATE duo_accounts SET pending_invite_token_expires_at = now() - interval '1 day' WHERE id = ${d2.duoId}`;
    expect(await refuser({ token: expire })).toEqual(attendu);
    expect((await duoRow(d2.duoId)).pending_invite_token).toBe(expire);
    expect((await duoRow(d2.duoId)).last_declined_at).toBeNull();
    expect((await etatInvitation(d2.tok)).body).toMatchObject({ status: 'EXPIRED' });
    expect(await outbox(d2.owner.id)).toHaveLength(0);
    // Le refus ne dit jamais à qui l'invitation était adressée ni qui l'a envoyée.
    expect(JSON.stringify(await refuser({ token: 'b'.repeat(64) }))).not.toMatch(/@|Camille|Durand/);
    // Requête mal formée : refusée sans rien lire.
    expect((await refuser({})).status).toBe(400);
    expect((await refuser({ token: 'x'.repeat(5000) })).status).toBe(400);
    expect(await outbox(d.owner.id)).toHaveLength(0);
    expect(await jobs(d.owner.id)).toHaveLength(0);
  });

  // ── L73B-05 ────────────────────────────────────────────────────────────
  it('L73B-05 — invité déjà connecté : refus depuis la page d’invitation, son espace intact', async () => {
    const d = await duoActif('CONNECTE');
    const existant = await make.account({ plan: 'standard' });
    await sql`UPDATE users SET is_active = true WHERE id = ${existant.owner.id}`;
    const token = await inviterDuo(d.tok, existant.owner.email, d.duoId);
    const tokInvite = await jeton(existant.owner, existant.id);
    expect(await refuser({ token }, tokInvite)).toEqual({ status: 200, body: { success: true } });
    expect(await sql`SELECT 1 FROM account_memberships WHERE account_id = ${d.acc.id} AND user_id = ${existant.owner.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM duo_memberships WHERE duo_id = ${d.duoId} AND user_id = ${existant.owner.id}`).toHaveLength(0);
    expect((await sql<{ status: string; role: string }[]>`SELECT status, role FROM account_memberships WHERE account_id = ${existant.id} AND user_id = ${existant.owner.id}`)[0])
      .toEqual({ status: 'active', role: 'owner' });
    // Rejoindre ensuite avec ce lien : refusé, motif explicite.
    expect(await rejoindre(tokInvite, { token })).toEqual({ status: 410, body: { error: 'DECLINED_TOKEN' } });
    expect(await outbox(d.owner.id)).toHaveLength(1);
  });

  // ── L73B-06 ────────────────────────────────────────────────────────────
  it('L73B-06 — écran « sans espace » : refus de l’invitation adressée à l’adresse vérifiée', async () => {
    const d = await duoActif('SANSESPACE');
    const email = `${uid('sans')}@proton.me`;
    const token = await inviterDuo(d.tok, email, d.duoId);
    expect((await inscrire(email, token)).status).toBe(201);
    const v = await activer(email);
    const { GET } = await import('@/app/api/accounts/route');
    const options = async () => (await (await GET(req('/api/accounts', { cookie: ck(v.access) }))).json()).options;
    expect(await options()).toMatchObject({ pendingDuoInvitation: true });
    // Sans session, « l'invitation de mon adresse » n'a pas de sens.
    expect((await refuser({ invitedEmail: true })).status).toBe(401);
    expect(await outbox(d.owner.id)).toHaveLength(0);
    expect(await refuser({ invitedEmail: true }, v.access)).toEqual({ status: 200, body: { success: true } });
    expect(await options()).toMatchObject({ pendingDuoInvitation: false });
    expect((await duoRow(d.duoId)).last_declined_invite_email).toBe(email);
    expect(await outbox(d.owner.id)).toHaveLength(1);
    // Rien à refuser ensuite : même réponse, aucun effet.
    expect(await refuser({ invitedEmail: true }, v.access)).toEqual({ status: 200, body: { success: true } });
    expect(await outbox(d.owner.id)).toHaveLength(1);
    // Aucun espace créé par le refus.
    expect(await sql`SELECT 1 FROM account_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`).toHaveLength(0);
  });

  // ── L73B-07 ────────────────────────────────────────────────────────────
  it('L73B-07 — titulaire : statut « Refusée », « Réinviter » la même adresse sans erreur, nouveau lien valable', async () => {
    const d = await duoActif('REINVITER');
    const email = `${uid('refus')}@proton.me`;
    const ancien = await inviterDuo(d.tok, email, d.duoId);
    await refuser({ token: ancien });

    const e1 = await etatInvitation(d.tok);
    expect(e1.status).toBe(200);
    expect(e1.body).toMatchObject({ status: 'DECLINED', inviteEmail: email });
    expect(typeof e1.body.declinedAt).toBe('string');
    expect(e1.body.inviteLink).toBeUndefined();

    // Réinviter (même adresse, comme le bouton du panneau).
    const { POST } = await import('@/app/api/duo/invitation/route');
    const r = await POST(req('/api/duo/invitation', { body: { email }, cookie: ck(d.tok) }));
    expect(r.status, await r.clone().text()).toBe(200);
    const nouveau = (await duoRow(d.duoId)).pending_invite_token!;
    expect(nouveau).toBeTruthy();
    expect(nouveau).not.toBe(ancien);
    expect((await etatInvitation(d.tok)).body).toMatchObject({ status: 'PENDING', inviteEmail: email });
    await retry();
    expect(mailsTo(email).filter((c) => c.html.includes(`/duo/join/${nouveau}`))).toHaveLength(1);
    // L'ancien lien reste refusé ; le nouveau mène jusqu'à l'adhésion.
    expect((await verifierLien(ancien)).body).toEqual({ error: 'DECLINED_TOKEN' });
    expect((await verifierLien(nouveau)).status).toBe(200);
    expect((await inscrire(email, nouveau)).status).toBe(201);
    const v = await activer(email);
    expect((await rejoindre(v.access, { token: nouveau })).status).toBe(200);
    expect((await etatInvitation(d.tok)).body).toMatchObject({ status: 'ACTIVE_MEMBER', memberEmail: email });
    // Un second refus de la même adresse plus tard repart d'un état propre.
    expect(await outbox(d.owner.id)).toHaveLength(1);
  });

  // ── L73B-08 ────────────────────────────────────────────────────────────
  it('L73B-08 — refus et acceptation simultanés : jamais les deux', async () => {
    for (let i = 0; i < 3; i += 1) {
      const d = await duoActif(`COURSE${i}`);
      const email = `${uid('course')}@proton.me`;
      const token = await inviterDuo(d.tok, email, d.duoId);
      expect((await inscrire(email, token)).status).toBe(201);
      const v = await activer(email);
      const [j, r] = await Promise.all([rejoindre(v.access, { token }), refuser({ token })]);
      expect(r.status).toBe(200);
      const [u] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email}`;
      const membre = (await sql`SELECT 1 FROM account_memberships WHERE account_id = ${d.acc.id} AND user_id = ${u.id} AND status = 'active'`).length === 1;
      const refuse = !!(await duoRow(d.duoId)).last_declined_at;
      expect(membre !== refuse, `rejoindre=${j.status} membre=${membre} refusé=${refuse}`).toBe(true);
      expect(j.status === 200).toBe(membre);
      expect((await outbox(d.owner.id)).length).toBe(refuse ? 1 : 0);
    }
  });

  // ── L73B-09 ────────────────────────────────────────────────────────────
  it('L73B-09 — migration 0530 rejouable ; gabarit personnalisé jamais écrasé (garde 0483) ; éditable dans le BO', async () => {
    const fichier = readFileSync(join(process.cwd(), 'src/db/migrations/0530_l73b_duo_invitation_refus.sql'), 'utf8');
    await sql.unsafe(fichier);
    await sql.unsafe(fichier);
    const tpl = async () => (await sql<{ subject: string; body: string; is_customized: boolean; shipped_body: string | null }[]>`
      SELECT subject, body, is_customized, shipped_body FROM email_templates WHERE upper(type) = 'DUO_INVITATION_DECLINED'`);
    const [livre, ...doublons] = await tpl();
    expect(doublons).toHaveLength(0);
    expect(livre.subject).toBe(SUJET_REFUS);
    expect(livre.is_customized).toBe(false);
    expect(livre.shipped_body).toBe(livre.body);

    // Personnalisation par l'éditeur du BO, puis migration rejouée : texte conservé.
    const { getEditorState, saveTemplate } = await import('@/services/admin/email-template-editor.service');
    const st = await getEditorState('DUO_INVITATION_DECLINED');
    expect(st.ok).toBe(true);
    const state = (st as { ok: true; state: { baseHash: string; declaredVariables: boolean; channelLock: string | null; variables: { name: string }[] } }).state;
    expect(state.declaredVariables).toBe(true);
    expect(state.channelLock).toBeNull(); // désactivable dans le BO (information, pas une obligation légale)
    expect(state.variables.map((x) => x.name)).toEqual(expect.arrayContaining(['firstName', 'inviteEmail', 'declinedAt', 'invitationUrl']));
    const admin = await make.user({ role: 'ADMIN' });
    const perso = `${livre.body}\n\nMessage personnalisé par l’équipe.`;
    const saved = await saveTemplate({ code: 'DUO_INVITATION_DECLINED', subject: livre.subject, body: perso, baseHash: state.baseHash, admin: { id: admin.id, email: admin.email } } as never);
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    // Lien de gestion obligatoire : son retrait est refusé.
    const st2 = (await getEditorState('DUO_INVITATION_DECLINED')) as { ok: true; state: { baseHash: string } };
    const sansLien = await saveTemplate({ code: 'DUO_INVITATION_DECLINED', subject: livre.subject, body: 'Bonjour {{firstName}}', baseHash: st2.state.baseHash, admin: { id: admin.id, email: admin.email } } as never);
    expect(sansLien.ok).toBe(false);
    await sql.unsafe(fichier);
    const [apres] = await tpl();
    expect(apres.is_customized).toBe(true);
    expect(apres.body).toBe(perso);
    // Contrainte de type de la file : le nouveau type est admis, les anciens aussi.
    const [{ def }] = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'transactional_email_jobs_kind_check'`;
    for (const k of ['EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT', 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', 'DUO_INVITATION_DECLINED']) {
      expect(def).toContain(`'${k}'`);
    }
  });
});
