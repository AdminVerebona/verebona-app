/**
 * Lot 34I — parrainage sur PostgreSQL réel.
 *
 *   7. « Mail parrainage KO » : l'invitation passe par le service e-mail
 *      commun (gabarit REFERRAL_INVITATION de la migration 0301, expéditeur
 *      `email_settings`, activation BO, journal `email_logs`) et n'est
 *      annoncée envoyée que si le TRANSPORT (SDK Resend, simulé ici) l'a
 *      accepté.
 *   8. « Lien parrainage KO » : `/r/<code>` (généré par Mon compte ›
 *      Parrainage et par l'e-mail) redirige vers l'inscription, code propagé
 *      s'il est valide, sans erreur sinon ; l'inscription l'attribue.
 */
import { afterAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { runMigrationSql } from '@/db/migration-index';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  // Lu par le constructeur du service e-mail, à l'import de la route.
  process.env.RESEND_API_KEY = 're_e2e_simule';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  return {
    calls: [] as Array<{ from: string; to: string; subject: string; html: string; text?: string }>,
    /** Destinataires refusés par le fournisseur (`{ error }`, sans exception, comme le vrai SDK). */
    rejected: new Set<string>(),
    session: { userId: 0, currentAccountId: 0 as number | null },
  };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

// Transport simulé : le SDK Resend lui-même. Toute la chaîne applicative
// (route → service e-mail → gabarit en base → transport) est réelle.
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { from: string; to: string; subject: string; html: string; text?: string }) => {
        etat.calls.push(p);
        if (etat.rejected.has(p.to)) {
          return { data: null, error: { name: 'validation_error', message: 'The verebona.fr domain is not verified.' } };
        }
        return { data: { id: `em_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

function post(emails: string[]): NextRequest {
  return new NextRequest(`${APP}/api/referral/send-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emails }),
  });
}

async function suivreLien(code: string): Promise<Response> {
  const { GET } = await import('@/app/r/[code]/route');
  return GET(new NextRequest(`${APP}/r/${code}`), { params: Promise.resolve({ code }) });
}

scenario('L34I', 'Parrainage : e-mail d’invitation réellement envoyé, lien /r/<code>', ({ sql, make }) => {
  async function parrain(code: string, opts: { active?: boolean } = {}) {
    const acc = await make.account({ plan: 'premium' });
    await sql`UPDATE accounts SET plan_type = 'PREMIUM' WHERE id = ${acc.id}`;
    await sql`UPDATE users SET first_name = 'Camille', last_name = 'Durand' WHERE id = ${acc.ownerUserId}`;
    const [link] = await sql<{ id: number }[]>`
      INSERT INTO referral_links (account_id, code, created_by_user_id, is_active, created_at, updated_at)
      VALUES (${acc.id}, ${code}, ${acc.ownerUserId}, ${opts.active ?? true}, now(), now()) RETURNING id`;
    etat.session.userId = acc.ownerUserId;
    etat.session.currentAccountId = acc.id;
    return { acc, linkId: link.id };
  }

  async function expediteurBO() {
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true, sender_email = EXCLUDED.sender_email`;
  }

  it('AC-7.0 — migration 0301 : gabarit REFERRAL_INVITATION présent, rejouable sans écraser une retouche BO', async () => {
    const [t] = await sql<{ subject: string; body: string }[]>`SELECT subject, body FROM email_templates WHERE type = 'REFERRAL_INVITATION'`;
    expect(t.subject).toContain('{{senderName}}');
    expect(t.body).toContain('{{referralUrl}}');
    await sql`UPDATE email_templates SET subject = 'Objet retouché {{senderName}}' WHERE type = 'REFERRAL_INVITATION'`;
    const migration = await readFile(join(process.cwd(), 'src/db/migrations/0301_referral_invitation_email_template.sql'), 'utf8');
    await runMigrationSql(sql, migration);
    await runMigrationSql(sql, migration);
    const rows = await sql<{ subject: string }[]>`SELECT subject FROM email_templates WHERE type = 'REFERRAL_INVITATION'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('Objet retouché {{senderName}}');
    await sql`UPDATE email_templates SET subject = ${t.subject} WHERE type = 'REFERRAL_INVITATION'`;
  });

  it('AC-7.1 — invitation acceptée : transport appelé (expéditeur BO, lien /r/), journalisée, comptée', async () => {
    await expediteurBO();
    const { linkId } = await parrain('E2EOK234');
    etat.calls.length = 0;
    const { POST } = await import('@/app/api/referral/send-email/route');
    const res = await POST(post(['Ami.E2E@exemple.fr']));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: 1, total: 1, failed: 0 });

    expect(etat.calls).toHaveLength(1);
    const mail = etat.calls[0];
    expect(mail.to).toBe('ami.e2e@exemple.fr');
    // Expéditeur réglé dans le BO, plus l'adresse codée en dur.
    expect(mail.from).toBe('Verebona <bonjour@preprod.verebona.fr>');
    expect(mail.subject).toBe('Camille Durand vous invite à découvrir Verebona');
    expect(mail.html).toContain(`${APP}/r/E2EOK234`);
    expect(mail.html).not.toMatch(/\{\{\w+\}\}/);

    const logs = await sql<{ status: string }[]>`
      SELECT status FROM email_logs WHERE template_code = 'REFERRAL_INVITATION' AND recipient_email = 'ami.e2e@exemple.fr'`;
    expect(logs.map((l) => l.status)).toEqual(['sent']);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM referral_email_sends WHERE referral_link_id = ${linkId}`;
    expect(n).toBe(1);
  });

  it('AC-7.2 — refus du fournisseur (sans exception) : 502, message lisible, échec journalisé, rien compté', async () => {
    await expediteurBO();
    const { linkId } = await parrain('E2EKO234');
    etat.calls.length = 0;
    etat.rejected.add('refus.e2e@exemple.fr');
    const { POST } = await import('@/app/api/referral/send-email/route');
    const res = await POST(post(['refus.e2e@exemple.fr']));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('EMAIL_NOT_SENT');
    expect(body.sent).toBe(0);
    expect(body.message).toMatch(/n’a pas pu être envoyée/);
    expect(body.message).not.toMatch(/domain|Resend|verified|Error/i);
    expect(etat.calls).toHaveLength(1);

    const [log] = await sql<{ status: string; error_message: string }[]>`
      SELECT status, error_message FROM email_logs WHERE recipient_email = 'refus.e2e@exemple.fr'`;
    expect(log.status).toBe('failed');
    expect(log.error_message).toContain('not verified');
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM referral_email_sends WHERE referral_link_id = ${linkId}`;
    expect(n).toBe(0);
  });

  it('AC-7.3 — envoi partiel : seuls les envois acceptés sont comptés', async () => {
    await expediteurBO();
    const { linkId } = await parrain('E2EPA234');
    etat.calls.length = 0;
    etat.rejected.add('ko2.e2e@exemple.fr');
    const { POST } = await import('@/app/api/referral/send-email/route');
    const res = await POST(post(['ok2.e2e@exemple.fr', 'ko2.e2e@exemple.fr']));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: 1, total: 2, failed: 1 });
    expect(etat.calls.map((c) => c.to)).toEqual(['ok2.e2e@exemple.fr', 'ko2.e2e@exemple.fr']);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM referral_email_sends WHERE referral_link_id = ${linkId}`;
    expect(n).toBe(1);
  });

  it('AC-7.4 — e-mail désactivé dans le BO (Communications) : aucun appel transport, message explicite, « ignoré » journalisé', async () => {
    await expediteurBO();
    await parrain('E2EOFF23');
    await sql`INSERT INTO communication_channel_settings (event_code, channel, is_active)
              VALUES ('email:REFERRAL_INVITATION', 'email', false)
              ON CONFLICT (event_code, channel) DO UPDATE SET is_active = false`;
    try {
      etat.calls.length = 0;
      const { POST } = await import('@/app/api/referral/send-email/route');
      const res = await POST(post(['off.e2e@exemple.fr']));
      expect(res.status).toBe(502);
      expect((await res.json()).message).toMatch(/désactivé.*Copiez votre lien/);
      expect(etat.calls).toHaveLength(0);
      const [log] = await sql<{ status: string }[]>`SELECT status FROM email_logs WHERE recipient_email = 'off.e2e@exemple.fr'`;
      expect(log.status).toBe('skipped');
    } finally {
      await sql`DELETE FROM communication_channel_settings WHERE event_code = 'email:REFERRAL_INVITATION'`;
    }
  });

  it('AC-8.1 — le lien affiché dans Mon compte est <app>/r/<CODE> et il mène à l’inscription avec le code', async () => {
    await parrain('E2ELNK23');
    const { GET: me } = await import('@/app/api/referral/me/route');
    const res = await me(new NextRequest(`${APP}/api/referral/me`));
    const body = await res.json();
    expect(body.link.url).toBe(`${APP}/r/E2ELNK23`);

    const redir = await suivreLien('E2ELNK23');
    expect(redir.status).toBe(307);
    expect(redir.headers.get('location')).toBe(`${APP}/signup?ref=E2ELNK23`);
    expect(redir.headers.get('set-cookie')).toBeNull(); // CDC §4.2 : aucun cookie
  });

  it('AC-8.2 — code inconnu, désactivé ou mal formé : inscription sans code, jamais de 404', async () => {
    await parrain('E2EINA23', { active: false });
    for (const code of ['INCONNU9', 'E2EINA23', '%3Cscript%3E', '-']) {
      const res = await suivreLien(code);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(`${APP}/signup`);
    }
    // Casse indifférente : le code est normalisé.
    await parrain('E2EMIN23');
    expect((await suivreLien('e2emin23')).headers.get('location')).toBe(`${APP}/signup?ref=E2EMIN23`);
  });

  it('AC-8.3 — de bout en bout : le code reçu par /r/ est attribué au filleul à l’inscription', async () => {
    const { acc } = await parrain('E2EATT23');
    const location = (await suivreLien('E2EATT23')).headers.get('location')!;
    const ref = new URL(location).searchParams.get('ref');
    const filleul = await make.account();
    const { recordSignupReferral } = await import('@/services/referral-attribution.service');
    const r = await recordSignupReferral({ userId: filleul.ownerUserId, accountId: filleul.id, rawCode: ref });
    expect(r?.referrerAccountId).toBe(acc.id);
    const [ctx] = await sql<{ validation_status: string; raw_code: string }[]>`
      SELECT validation_status, raw_code FROM signup_contexts WHERE user_id = ${filleul.ownerUserId}`;
    expect(ctx).toMatchObject({ validation_status: 'valid', raw_code: 'E2EATT23' });
  });
});
