/**
 * Lot 53 — e-mail d'invitation Duo : le bouton « Accepter » était inopérant
 * (« Accepter : {{actionUrl}} », 12 et 13/10/2026).
 *
 * Chaîne réelle : route POST /api/duo/invitation → service e-mail → gabarit
 * DUO_INVITATION en base (migration 0125) → transport (SDK Resend simulé).
 *
 * DUO-MAIL-E2E-01 : l'e-mail porte un bouton vers /duo/join/<jeton>, aucune
 *                   variable « {{…} } » ne reste.
 * DUO-MAIL-E2E-02 : gabarit retouché dans le BO avec un autre nom de lien
 *                   ({{inviteUrl}}, {{invitationLink}}) : lien posé quand même.
 * DUO-MAIL-E2E-03 : renvoi depuis le BO (fiche utilisateur) : même résultat.
 * DUO-MAIL-E2E-04 : invitation sans lien utilisable : NON envoyée, échec
 *                   motivé dans le journal des e-mails.
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return {
    calls: [] as Array<{ to: string; subject: string; html: string }>,
    session: { userId: 0, currentAccountId: 0 as number | null },
  };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject: string; html: string }) => {
        etat.calls.push(p);
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

/** L'envoi de la route est « fire and forget » : on attend qu'il arrive. */
async function attendreEnvoi(to: string, timeoutMs = 5000) {
  const fin = Date.now() + timeoutMs;
  for (;;) {
    const c = etat.calls.find((x) => x.to === to);
    if (c) return c;
    if (Date.now() > fin) throw new Error(`aucun e-mail envoyé à ${to}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const inviter = (email: string) => new NextRequest(`${APP}/api/duo/invitation`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', host: 'app.e2e.verebona.test' },
  body: JSON.stringify({ email }),
});

scenario('L53-DUO-MAIL', 'Invitation Duo : bouton « Accepter » opérant', ({ sql, make }) => {
  let corpsOrigine = '';

  beforeEach(async () => {
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    const [t] = await sql<{ body: string }[]>`SELECT body FROM email_templates WHERE upper(type) = 'DUO_INVITATION'`;
    if (!corpsOrigine) corpsOrigine = t.body;
    await sql`UPDATE email_templates SET body = ${corpsOrigine} WHERE upper(type) = 'DUO_INVITATION'`;
  });

  async function titulaire() {
    const acc = await make.account({ plan: 'premium' });
    await sql`UPDATE users SET first_name = 'Camille', last_name = 'Durand', plan_type = 'PREMIUM_DUO' WHERE id = ${acc.ownerUserId}`;
    await sql`INSERT INTO duo_accounts (billing_owner_user_id) VALUES (${acc.ownerUserId})`;
    etat.session.userId = acc.ownerUserId;
    etat.session.currentAccountId = acc.id;
    return acc;
  }

  const verifierBouton = async (html: string, ownerUserId: number) => {
    const [d] = await sql<{ t: string }[]>`SELECT pending_invite_token AS t FROM duo_accounts WHERE billing_owner_user_id = ${ownerUserId}`;
    expect(html).toContain(`href="${APP}/duo/join/${d.t}"`);
    expect(html).not.toMatch(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/);
    expect(html).toContain('Accepter');
  };

  it('DUO-MAIL-E2E-01 — gabarit en base (0125, {{actionUrl}}) : bouton vers /duo/join/<jeton>, aucune variable restante', async () => {
    const [t] = await sql<{ body: string }[]>`SELECT body FROM email_templates WHERE upper(type) = 'DUO_INVITATION'`;
    expect(t.body).toContain('{{actionUrl}}');
    const acc = await titulaire();
    const { POST } = await import('@/app/api/duo/invitation/route');
    const res = await POST(inviter('invite-01@e2e.verebona.test'));
    expect(res.status).toBe(200);
    const mail = await attendreEnvoi('invite-01@e2e.verebona.test');
    await verifierBouton(mail.html, acc.ownerUserId);
  });

  it('DUO-MAIL-E2E-02 — gabarit retouché dans le BO avec un autre nom de lien : lien posé quand même', async () => {
    const { POST } = await import('@/app/api/duo/invitation/route');
    for (const [i, nom] of ['inviteUrl', 'invitationLink'].entries()) {
      await sql`UPDATE email_templates SET body = ${`Bonjour,\n\n{{ownerFullName}} vous invite.\n\nAccepter : {{${nom}}}`} WHERE upper(type) = 'DUO_INVITATION'`;
      const acc = await titulaire();
      const to = `invite-02-${i}@e2e.verebona.test`;
      await POST(inviter(to));
      await verifierBouton((await attendreEnvoi(to)).html, acc.ownerUserId);
    }
  });

  it('DUO-MAIL-E2E-03 — renvoi depuis le BO : même bouton opérant', async () => {
    const acc = await titulaire();
    const { POST } = await import('@/app/api/duo/invitation/route');
    await POST(inviter('invite-03@e2e.verebona.test'));
    await attendreEnvoi('invite-03@e2e.verebona.test');
    etat.calls.length = 0;
    const { resendInvitation } = await import('@/services/admin/user-detail.service');
    const r = await resendInvitation(acc.ownerUserId, APP);
    expect(r.ok).toBe(true);
    const mail = await attendreEnvoi('invite-03@e2e.verebona.test');
    await verifierBouton(mail.html, acc.ownerUserId);
  });

  it('DUO-MAIL-E2E-04 — invitation sans lien utilisable : non envoyée, échec motivé dans le journal du BO', async () => {
    const { emailService } = await import('@/lib/email/email-service');
    const r = await emailService.send({
      templateCode: 'DUO_INVITATION', to: 'invite-04@e2e.verebona.test',
      variables: { ownerFullName: 'Camille Durand', expiresIn: '7 jours' },
    });
    expect(r.success).toBe(false);
    expect(etat.calls.find((c) => c.to === 'invite-04@e2e.verebona.test')).toBeUndefined();
    const [log] = await sql<{ status: string; error_message: string }[]>`
      SELECT status, error_message FROM email_logs WHERE recipient_email = 'invite-04@e2e.verebona.test' ORDER BY id DESC LIMIT 1`;
    expect(log.status).toBe('failed');
    expect(log.error_message).toMatch(/Lien manquant : actionUrl/);
  });
});
