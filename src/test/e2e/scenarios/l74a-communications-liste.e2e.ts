/**
 * Lot 74A (points 2 et 3) — LISTE BO › Communications : ancienne
 * prévisualisation (`GET /api/admin/communications/preview`) et bouton
 * « E-mail de test » (`POST /api/admin/communications/test`), sur PostgreSQL 16
 * réel (toutes les migrations), routes appelées avec un vrai jeton, transport
 * Resend SIMULÉ.
 *
 * L74A-PREV-E2E-01 Aperçu e-mail : valeur piégée du compte de l'administrateur
 *                  (prénom) neutralisée comme à l'envoi réel (variable-safety),
 *                  objet sur une ligne ; rendu = enveloppe de l'envoi réel.
 * L74A-PREV-E2E-02 Aperçu e-mail d'une notification (notif_*) : message RÉEL
 *                  de l'événement de la ligne, sans « [donnée indisponible] ».
 * L74A-TEST-E2E-01 E-mail de test d'une notification : message réel de
 *                  l'événement (comme l'éditeur 73A), envoyé à l'admin seul,
 *                  identique à l'aperçu ; lien d'action absolu.
 * L74A-TEST-E2E-02 E-mail de test d'un e-mail transactionnel : inchangé
 *                  (admin seul, valeur piégée neutralisée par l'envoi).
 * L74A-PREV-E2E-03 Push / in-app : inchangés (titre et message du catalogue).
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_74a';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return { calls: [] as Array<{ to: string; subject: string; html: string; text?: string }> };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject: string; html: string; text?: string }) => {
        etat.calls.push(p);
        return { data: { id: `em_74a_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

const SUB_SUBJECT = 'Votre abonnement Verebona';
const SUB_BODY = '{{body}}\n\nAccéder à Verebona : {{actionUrl}}';
const WELCOME_SUBJECT = 'Bienvenue {{firstName}} sur Verebona';
const PIEGE = '<a href="https://pirate.example/login">Ada</a>\nCliquez : https://pirate.example/x';

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test' };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? 'POST', headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

scenario('L74A-COM-LISTE', 'Liste BO › Communications : aperçu neutralisé et e-mail de test des notifications', ({ sql, make }) => {
  const asEditor = (fn: (tx: typeof sql) => Promise<unknown>) =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('verebona.email_template_edit', 'on', true)`;
      await fn(tx as unknown as typeof sql);
    });

  let welcomeAvant: { subject: string; body: string; shipped_subject: string | null; shipped_body: string | null } | null | undefined;

  beforeEach(async () => {
    etat.calls.length = 0;
    if (welcomeAvant === undefined) {
      welcomeAvant = (await sql<{ subject: string; body: string; shipped_subject: string | null; shipped_body: string | null }[]>`
        SELECT subject, body, shipped_subject, shipped_body FROM email_templates WHERE type = 'WELCOME'`)[0] ?? null;
    }
    const { WELCOME_HTML } = await import('@/lib/email/email-html-templates');
    process.env.RESEND_API_KEY = 're_e2e_simule_74a';
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    await asEditor(async (tx) => {
      await tx`INSERT INTO email_templates (type, subject, body, updated_at, is_customized, shipped_subject, shipped_body)
               VALUES ('notif_subscription', ${SUB_SUBJECT}, ${SUB_BODY}, now(), false, ${SUB_SUBJECT}, ${SUB_BODY})
               ON CONFLICT (type) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, is_customized = false,
                 customized_at = NULL, updated_by = NULL, shipped_subject = EXCLUDED.subject, shipped_body = EXCLUDED.body,
                 shipped_updated_at = NULL`;
      // Objet avec variable : la valeur piégée ne doit pas casser l'en-tête.
      await tx`INSERT INTO email_templates (type, subject, body, updated_at, is_customized, shipped_subject, shipped_body)
               VALUES ('WELCOME', ${WELCOME_SUBJECT}, ${WELCOME_HTML}, now(), false, ${WELCOME_SUBJECT}, ${WELCOME_HTML})
               ON CONFLICT (type) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, is_customized = false,
                 customized_at = NULL, updated_by = NULL, shipped_subject = EXCLUDED.subject, shipped_body = EXCLUDED.body,
                 shipped_updated_at = NULL`;
    });
  });

  afterAll(async () => {
    // Remise en état du gabarit WELCOME pour les scénarios suivants.
    await asEditor(async (tx) => {
      if (welcomeAvant) {
        await tx`UPDATE email_templates SET subject = ${welcomeAvant.subject}, body = ${welcomeAvant.body},
                   shipped_subject = ${welcomeAvant.shipped_subject}, shipped_body = ${welcomeAvant.shipped_body}, shipped_updated_at = NULL
                 WHERE type = 'WELCOME'`;
      } else if (welcomeAvant === null) {
        await tx`DELETE FROM email_templates WHERE type = 'WELCOME'`;
      }
    });
  });

  async function jeton(user: { id: number; email: string }, role = 'USER') {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({
      id: user.id, email: user.email, role: role as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true,
    });
  }
  async function admin(firstName = 'Ada') {
    const u = await make.user({ email: `${uid('admin74a')}@verebona.test`, role: 'ADMIN' });
    await sql`UPDATE users SET role = 'ADMIN', is_active = true, status = 'ACTIVE', first_name = ${firstName}, last_name = 'Admin' WHERE id = ${u.id}`;
    return { ...u, cookie: `access_token=${await jeton(u, 'ADMIN')}` };
  }
  async function apercu(cookie: string, eventCode: string, channel = 'email') {
    const { GET } = await import('@/app/api/admin/communications/preview/route');
    const qs = new URLSearchParams({ eventCode, channel });
    const res = await GET(req(`/api/admin/communications/preview?${qs}`, { method: 'GET', cookie }));
    return { status: res.status, body: await res.json() };
  }
  async function test(cookie: string, eventCode: string) {
    const { POST } = await import('@/app/api/admin/communications/test/route');
    const res = await POST(req('/api/admin/communications/test', { cookie, body: { eventCode } }));
    return { status: res.status, body: await res.json() };
  }
  const welcomeEvent = async () => (await import('@/lib/notifications/channel-activation')).transactionalEventCode('WELCOME');

  it('L74A-PREV-E2E-01 — aperçu : valeur piégée neutralisée comme à l’envoi réel', async () => {
    const a = await admin(PIEGE);
    const p = await apercu(a.cookie, await welcomeEvent());
    expect(p.status).toBe(200);
    expect(p.body.available).toBe(true);
    expect(p.body.isHtml).toBe(true);
    expect(p.body.body).not.toMatch(/<a href="https:\/\/pirate|https?:\/\/pirate|pirate\.example/);
    expect(p.body.body).toContain('Ada');
    expect(p.body.subject).not.toMatch(/[\r\n]/);
    // Même rendu que l'envoi de test (même chemin renderTemplate).
    const t = await test(a.cookie, await welcomeEvent());
    expect(t.status).toBe(200);
    expect(etat.calls).toHaveLength(1);
    expect(etat.calls[0].subject).toBe(p.body.subject);
    expect(`${etat.calls[0].html}\n${etat.calls[0].text}`).not.toMatch(/https?:\/\/pirate|pirate\.example/);
  });

  it('L74A-PREV-E2E-02 — aperçu d’une notification : message réel de l’événement', async () => {
    const a = await admin();
    const p = await apercu(a.cookie, 'SUBSCRIPTION_CANCELLED');
    expect(p.status).toBe(200);
    expect(p.body.available).toBe(true);
    expect(p.body.body).toContain('Votre abonnement a été résilié.');
    expect(p.body.body).not.toContain('[donnée indisponible]');
    expect(p.body.body).toMatch(/href="https:\/\/app\.e2e\.verebona\.test\/[^"]*"/);
    expect(p.body.incomplete).toBe(false);
  });

  it('L74A-TEST-E2E-01 — e-mail de test d’une notification : message réel, admin seul', async () => {
    const a = await admin();
    const t = await test(a.cookie, 'SUBSCRIPTION_CANCELLED');
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ success: true, to: a.email, incomplete: false });
    expect(etat.calls).toHaveLength(1);
    const mail = etat.calls[0];
    expect(mail.to).toBe(a.email);
    expect(mail.subject).toBe(SUB_SUBJECT);
    expect(mail.html).toContain('Votre abonnement a été résilié.');
    expect(`${mail.html}\n${mail.text}`).not.toContain('[donnée indisponible]');
    expect(mail.html).toMatch(/href="https:\/\/app\.e2e\.verebona\.test\/[^"]*"/);
    expect(mail.text).toMatch(/^Accéder à Verebona : https:\/\/app\.e2e\.verebona\.test\/\S*$/m);
    // Un autre événement du même gabarit : son propre message.
    etat.calls.length = 0;
    await test(a.cookie, 'SUBSCRIPTION_RENEWED');
    expect(etat.calls[0].html).not.toContain('Votre abonnement a été résilié.');
    expect(etat.calls[0].html).not.toContain('[donnée indisponible]');
  });

  it('L74A-TEST-E2E-02 — e-mail de test transactionnel : inchangé, admin seul', async () => {
    const a = await admin();
    const t = await test(a.cookie, await welcomeEvent());
    expect(t.status).toBe(200);
    expect(etat.calls).toHaveLength(1);
    expect(etat.calls[0].to).toBe(a.email);
    expect(etat.calls[0].html).toContain('Ada');
    // Utilisateur non administrateur : refusé, rien envoyé.
    const u = await make.user({ email: `${uid('user74a')}@verebona.test` });
    const r = await test(`access_token=${await jeton(u)}`, await welcomeEvent());
    expect([401, 403]).toContain(r.status);
    expect(etat.calls).toHaveLength(1);
  });

  it('L74A-PREV-E2E-03 — push / in-app inchangés', async () => {
    const a = await admin();
    const p = await apercu(a.cookie, 'SUBSCRIPTION_CANCELLED', 'in_app');
    expect(p.status).toBe(200);
    expect(p.body.available).toBe(true);
    expect(p.body.title).toBe('Abonnement résilié');
    expect(p.body.body).toBe('Votre abonnement a été résilié.');
  });
});
