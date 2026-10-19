/**
 * Lot 65A — e-mail au membre qui QUITTE lui-même un Premium Duo, verrouillage
 * BO des e-mails de fin d'accès (décisions PO du 16/10), sur PostgreSQL 16
 * réel (migrations 0459 + 0462, file durable 0405), transport Resend SIMULÉ.
 *
 * L65-MAIL-E2E-01 « Quitter le Duo » (route /api/duo/leave) : UNE demande
 *                 DUO_MEMBERSHIP_LEFT (destinataire = membre, émetteur = le
 *                 membre), aucune DUO_MEMBERSHIP_ENDED ; envoyée par la reprise
 *                 planifiée ; prénom du titulaire, jamais son adresse ; rien
 *                 au titulaire ; journal BO.
 * L65-MAIL-E2E-02 Idempotence : départ rejoué → aucune seconde demande ni
 *                 e-mail ; nouvelle adhésion puis nouveau départ → nouvel e-mail.
 * L65-MAIL-E2E-03 Suppression de son propre compte : départ du Duo SANS e-mail
 *                 de départ (l'e-mail de suppression est programmé) — ni à la
 *                 clôture, ni au balayage.
 * L65-MAIL-E2E-04 Ancienne route POST /api/duos/:id/leave : même confirmation,
 *                 une seule fois ; jamais bloquant (type refusé par la base →
 *                 départ fait quand même).
 * L65-LOCK-E2E-01 BO › Communications : désactivation de DUO_MEMBERSHIP_ENDED /
 *                 DUO_MEMBERSHIP_LEFT refusée (409 CHANNEL_LOCKED, journalisée),
 *                 vue « toujours actif » ; une ligne « désactivé » héritée en
 *                 base n'empêche pas l'envoi.
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_65';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return { calls: [] as Array<{ to: string; subject: string; html: string }> };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject: string; html: string }) => {
        etat.calls.push(p);
        return { data: { id: `em_65_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

const MIN = 60_000;
const SUJET_DEPART = 'Vous avez quitté l\'espace Premium Duo';

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test' };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

scenario('L65-MAIL', 'Duo : confirmation au membre qui quitte, pas de doublon à la suppression de compte, e-mails verrouillés', ({ sql, make }) => {
  beforeEach(async () => {
    process.env.RESEND_API_KEY = 're_e2e_simule_65';
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    await sql`UPDATE transactional_email_jobs SET status = 'cancelled' WHERE status IN ('pending', 'sending')`;
  });

  async function jeton(userId: number, email: string, role: 'ADMIN' | 'USER') {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({ id: userId, email, role: role as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true });
  }

  /** Titulaire Premium Duo + second utilisateur actif (avec son propre compte Standard). */
  async function duoAvecMembre() {
    const ownerEmail = `titulaire-${uid('l65')}@test.invalid`;
    const owner = await make.user({ email: ownerEmail, planType: 'PREMIUM_DUO' });
    await sql`UPDATE users SET first_name = 'Claire', last_name = 'Titulaire' WHERE id = ${owner.id}`;
    const acc = await make.account({ owner, plan: 'premium_duo' });
    const [{ id: duoId }] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, duo_subscription_started_at, activated_at)
      VALUES (${owner.id}, 'ACTIVE', now() - interval '2 days', now())
      RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duoId} WHERE id = ${acc.id}`;
    const membre = await make.user({ planType: 'PREMIUM_DUO' });
    await sql`UPDATE users SET first_name = 'Marc' WHERE id = ${membre.id}`;
    await make.account({ owner: membre, plan: 'standard' });
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at)
              VALUES (${duoId}, ${owner.id}, 'ACTIVE', 0, now()), (${duoId}, ${membre.id}, 'ACTIVE', 1, now())`;
    const [{ id: membershipId }] = await sql<{ id: number }[]>`SELECT id FROM duo_memberships WHERE duo_id = ${duoId} AND user_id = ${membre.id}`;
    return { ...acc, ownerEmail, duoId, membre, membershipId };
  }

  const jobsOf = async (userId: number, kind = 'DUO_MEMBERSHIP_LEFT') => sql<{
    id: number; status: string; user_id: number | null; duo_id: number | null; triggered_by_user_id: number | null;
    recipient_email: string; context: Record<string, unknown>; last_error: string | null; attempts: number; dedupe_key: string | null;
  }[]>`SELECT id, status, user_id, duo_id, triggered_by_user_id, recipient_email, context, last_error, attempts, dedupe_key
         FROM transactional_email_jobs WHERE kind = ${kind} AND user_id = ${userId} ORDER BY id`;
  const membershipStatus = async (id: number) => (await sql<{ status: string }[]>`SELECT status FROM duo_memberships WHERE id = ${id}`)[0]?.status;
  const retry = async (at = new Date(Date.now() + 1_000)) => (await import('@/services/email/transactional-email-jobs.service'))
    .runTransactionalEmailRetry({ now: () => at, deadline: Date.now() + 30_000 });
  const mailsTo = (email: string) => etat.calls.filter((c) => c.to === email);

  it('L65-MAIL-E2E-01 — « Quitter le Duo » : une confirmation au membre, discrète, rien au titulaire', async () => {
    const c = await duoAvecMembre();
    const { POST } = await import('@/app/api/duo/leave/route');
    const tok = await jeton(c.membre.id, c.membre.email, 'USER');
    const res = await POST(req('/api/duo/leave', { body: {}, cookie: `access_token=${tok}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, status: 'LEFT' });
    expect(await membershipStatus(c.membershipId)).toBe('LEFT');

    const [j, ...autres] = await jobsOf(c.membre.id);
    expect(autres).toHaveLength(0);
    expect(j).toMatchObject({
      status: 'pending', user_id: c.membre.id, duo_id: null, triggered_by_user_id: c.membre.id, recipient_email: c.membre.email,
      context: { duoId: c.duoId, membershipId: c.membershipId, ownerFirstName: 'Claire' },
    });
    expect(j.dedupe_key).toMatch(new RegExp(`^duo-membership-left:${c.membershipId}:\\d+(\\.\\d+)?$`));
    expect(JSON.stringify(j.context)).not.toContain(c.ownerEmail);
    expect(await jobsOf(c.membre.id, 'DUO_MEMBERSHIP_ENDED')).toHaveLength(0);
    expect(mailsTo(c.membre.email)).toHaveLength(0); // aucun appel au fournisseur pendant la sortie

    await retry();
    expect(mailsTo(c.membre.email)).toHaveLength(1);
    const [m] = mailsTo(c.membre.email);
    expect(m.subject).toBe(SUJET_DEPART);
    expect(m.html).toContain('Bonjour Marc');
    expect(m.html).toContain('partagiez avec Claire');
    expect(m.html).toContain(`${APP}/mon-compte`);
    expect(m.html).toContain(`${APP}/mon-compte/offres`);
    expect(m.html).not.toContain(c.ownerEmail);
    expect(m.html).not.toMatch(/Titulaire|rétract|impay/);
    expect(mailsTo(c.ownerEmail)).toHaveLength(0);

    const [log] = await sql<{ recipient_user_id: number; triggered_by_user_id: number; status: string }[]>`
      SELECT recipient_user_id, triggered_by_user_id, status FROM email_logs
       WHERE template_code = 'DUO_MEMBERSHIP_LEFT' AND email_job_id = ${j.id}`;
    expect(log).toMatchObject({ recipient_user_id: c.membre.id, triggered_by_user_id: c.membre.id, status: 'sent' });
    expect((await jobsOf(c.membre.id))[0].status).toBe('accepted');
  });

  it('L65-MAIL-E2E-02 — idempotence par départ ; nouvelle adhésion puis nouveau départ → nouvel e-mail', async () => {
    const c = await duoAvecMembre();
    const { endMembership, leaveDuo } = await import('@/services/duo/duo-exit.service');
    expect(await leaveDuo(c.membre.id)).toMatchObject({ ok: true, status: 'LEFT' });
    expect(await leaveDuo(c.membre.id)).toMatchObject({ ok: false, error: 'NOT_A_DUO_MEMBER' });
    await endMembership({ duoId: c.duoId, membershipId: c.membershipId, memberUserId: c.membre.id, status: 'LEFT' });
    await endMembership({ duoId: c.duoId, membershipId: c.membershipId, memberUserId: c.membre.id, status: 'REMOVED' });
    expect(await jobsOf(c.membre.id)).toHaveLength(1);
    expect(await jobsOf(c.membre.id, 'DUO_MEMBERSHIP_ENDED')).toHaveLength(0);
    await retry();
    await retry(new Date(Date.now() + 10 * MIN));
    expect(mailsTo(c.membre.email)).toHaveLength(1);

    await sql`UPDATE duo_memberships SET status = 'ACTIVE', slot = 1, joined_at = now() + interval '1 second', left_at = NULL WHERE id = ${c.membershipId}`;
    await leaveDuo(c.membre.id);
    const jobs = await jobsOf(c.membre.id);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].dedupe_key).not.toBe(jobs[1].dedupe_key);
    await retry();
    expect(mailsTo(c.membre.email).map((m) => m.subject)).toEqual([SUJET_DEPART, SUJET_DEPART]);
  });

  it('L65-MAIL-E2E-03 — suppression de son propre compte : départ du Duo sans e-mail de départ, e-mail de suppression programmé', async () => {
    const c = await duoAvecMembre();
    const vd = await import('@/services/account/voluntary-deletion.service');
    const deps = { ...vd.defaultDeps, verifyPassword: async () => true, billing: { stopRenewal: async () => [], cancelNow: async () => [] } };
    const r = await vd.closeAccountForDeletion({ userId: c.membre.id, password: 'x', confirmation: vd.ACCOUNT_DELETION_CONFIRMATION }, deps);
    expect(r).toMatchObject({ ok: true, sharing: 'duo_member' });
    expect(await membershipStatus(c.membershipId)).toBe('LEFT');
    expect(await jobsOf(c.membre.id)).toHaveLength(0);
    expect(await jobsOf(c.membre.id, 'DUO_MEMBERSHIP_ENDED')).toHaveLength(0);
    // L'e-mail de suppression (confirmation de clôture) est bien programmé.
    const notif = await sql`SELECT 1 FROM notification_outbox
                              WHERE event_type = 'ACCOUNT_DELETION_SCHEDULED' AND recipient_user_id = ${c.membre.id}`;
    expect(notif.length).toBeGreaterThan(0);
    await retry();
    expect(mailsTo(c.membre.email).filter((m) => m.subject === SUJET_DEPART)).toHaveLength(0);
  });

  it('L65-MAIL-E2E-04 — ancienne route /api/duos/:id/leave : même confirmation, une fois ; jamais bloquant', async () => {
    const c = await duoAvecMembre();
    const { POST } = await import('@/app/api/duos/[id]/leave/route');
    const tok = await jeton(c.membre.id, c.membre.email, 'USER');
    const appel = () => POST(req(`/api/duos/${c.duoId}/leave`, { body: {}, cookie: `access_token=${tok}` }), { params: Promise.resolve({ id: String(c.duoId) }) });
    expect((await appel()).status).toBe(200);
    expect(await membershipStatus(c.membershipId)).toBe('LEFT');
    expect(await jobsOf(c.membre.id)).toHaveLength(1);
    await retry();
    expect(mailsTo(c.membre.email).map((m) => m.subject)).toEqual([SUJET_DEPART]);

    // Base qui refuse le type (migration 0462 non passée) : le départ se fait quand même.
    const d = await duoAvecMembre();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sql`ALTER TABLE transactional_email_jobs DROP CONSTRAINT transactional_email_jobs_kind_check`;
    await sql`ALTER TABLE transactional_email_jobs ADD CONSTRAINT transactional_email_jobs_kind_check CHECK (kind IN ('EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED')) NOT VALID`;
    try {
      const { leaveDuo } = await import('@/services/duo/duo-exit.service');
      expect(await leaveDuo(d.membre.id)).toMatchObject({ ok: true, status: 'LEFT' });
    } finally {
      await sql`ALTER TABLE transactional_email_jobs DROP CONSTRAINT transactional_email_jobs_kind_check`;
      await sql`ALTER TABLE transactional_email_jobs ADD CONSTRAINT transactional_email_jobs_kind_check CHECK (kind IN ('EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT', 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER'))`;
      err.mockRestore();
    }
    expect(await membershipStatus(d.membershipId)).toBe('LEFT');
    expect(await jobsOf(d.membre.id)).toHaveLength(0);
  });

  it('L65-LOCK-E2E-01 — BO : désactivation refusée et journalisée ; une désactivation héritée n’empêche pas l’envoi', async () => {
    const admin = await make.user({ email: `${uid('adm65')}@verebona.test`, role: 'ADMIN' });
    await sql`UPDATE users SET role = 'ADMIN', is_active = true, status = 'ACTIVE' WHERE id = ${admin.id}`;
    const tokAdmin = await jeton(admin.id, `${admin.id}@a`, 'ADMIN');
    const { PATCH } = await import('@/app/api/admin/communications/channels/route');
    for (const code of ['DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT', 'DUO_INVITATION']) {
      const r = await PATCH(req('/api/admin/communications/channels', {
        method: 'PATCH', cookie: `access_token=${tokAdmin}`,
        body: { eventCode: `email:${code}`, channel: 'email', isActive: false, confirmed: true },
      }));
      expect(r.status, code).toBe(409);
      expect((await r.json()).code, code).toBe('CHANNEL_LOCKED');
    }
    const audits = await sql<{ result: string }[]>`
      SELECT result FROM admin_audit_log WHERE admin_user_id = ${admin.id} ORDER BY id`;
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(audits.every((a) => a.result !== 'SUCCESS')).toBe(true);

    const { getCommunicationsOverview } = await import('@/services/admin/communications.service');
    const events = (await getCommunicationsOverview()).flatMap((g) => g.events);
    for (const code of ['email:DUO_MEMBERSHIP_ENDED', 'email:DUO_MEMBERSHIP_LEFT']) {
      expect(events.find((e) => e.code === code)?.channels[0], code).toMatchObject({ locked: true, active: true });
    }

    // Désactivation inscrite en base AVANT le verrou (lot 64 la permettait) : ignorée.
    await sql`INSERT INTO communication_channel_settings (event_code, channel, is_active)
              VALUES ('email:DUO_MEMBERSHIP_ENDED', 'email', false), ('email:DUO_MEMBERSHIP_LEFT', 'email', false)
              ON CONFLICT (event_code, channel) DO UPDATE SET is_active = false`;
    try {
      const a = await duoAvecMembre();
      const b = await duoAvecMembre();
      const { leaveDuo, removeDuoMember } = await import('@/services/duo/duo-exit.service');
      await leaveDuo(a.membre.id);
      await removeDuoMember(b.ownerUserId);
      await retry();
      expect(mailsTo(a.membre.email).map((m) => m.subject)).toEqual([SUJET_DEPART]);
      expect(mailsTo(b.membre.email)).toHaveLength(1);
      expect((await jobsOf(a.membre.id))[0].status).toBe('accepted');
      expect((await jobsOf(b.membre.id, 'DUO_MEMBERSHIP_ENDED'))[0].status).toBe('accepted');
    } finally {
      await sql`DELETE FROM communication_channel_settings WHERE event_code IN ('email:DUO_MEMBERSHIP_ENDED', 'email:DUO_MEMBERSHIP_LEFT')`;
    }
  });
});
