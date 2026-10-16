/**
 * Lot 61B — audit du ticket P0 e-mails (identique au lot 57) : écart
 * résiduel prouvé sur PostgreSQL réel, transport Resend SIMULÉ.
 *
 * MAIL-R-01  §3-A « Corriger la cause établie » sans SQL : lorsque le
 *            diagnostic (docs/exploitation/emails-delivrabilite.md) établit
 *            que l'expéditeur n'est pas sur le domaine vérifié chez Resend,
 *            le PO le corrige depuis le BO (Communications › E-mails
 *            transactionnels) — avant : écran en lecture seule, correction
 *            par SQL uniquement. Administrateur seulement, validé, journalisé,
 *            aucun secret renvoyé ; l'envoi suivant (reprise automatique de
 *            la demande en échec) part avec le nouvel expéditeur.
 */
import { afterAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_61b';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return {
    calls: [] as Array<{ to: string; from: string; replyTo?: string }>,
    /** Le domaine vérifié chez Resend (simulé). */
    verifiedDomain: 'verebona.fr',
  };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; from: string; replyTo?: string; reply_to?: string }) => {
        const domaine = /@([^>\s]+)>?$/.exec(p.from)?.[1] ?? '';
        if (domaine !== etat.verifiedDomain) {
          return { data: null, error: { name: 'validation_error', message: `The ${domaine} domain is not verified.` } };
        }
        etat.calls.push({ to: p.to, from: p.from, replyTo: p.replyTo ?? p.reply_to });
        return { data: { id: `em_61b_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test' };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? 'PATCH', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

scenario('L61B-MAIL', 'P0 e-mails : écart résiduel — correction de l’expéditeur depuis le BO, sans SQL', ({ sql, make }) => {
  async function jeton(userId: number, email: string, role: 'ADMIN' | 'USER') {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({ id: userId, email, role: role as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true });
  }

  it('MAIL-R-01 — expéditeur hors domaine vérifié : corrigé depuis le BO, la demande en échec repart seule, sans SQL', async () => {
    // État constaté par le diagnostic : expéditeur sur un domaine NON vérifié.
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'noreply@verebona.com', 'support@verebona.com')
              ON CONFLICT (id) DO UPDATE SET sender_email = 'noreply@verebona.com', sender_name = 'Verebona', emails_enabled = true`;
    const inscrit = await make.user({ email: `${uid('r01')}@proton.me` });
    await sql`UPDATE users SET is_active = false WHERE id = ${inscrit.id}`;
    const [{ email }] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${inscrit.id}`;
    const jobs = await import('@/services/email/transactional-email-jobs.service');
    const { jobId } = await jobs.enqueueVerificationEmail({ userId: inscrit.id, email });
    expect(await jobs.processEmailJob(jobId)).toMatchObject({ status: 'pending', error: expect.stringMatching(/domain is not verified/) });

    const admin = await make.user({ email: `${uid('adm')}@verebona.test`, role: 'ADMIN' });
    await sql`UPDATE users SET role = 'ADMIN', is_active = true, status = 'ACTIVE' WHERE id = ${admin.id}`;
    const tokAdmin = await jeton(admin.id, `${admin.id}@a`, 'ADMIN');
    const { PATCH } = await import('@/app/api/admin/communications/email-settings/route');

    // Non-administrateur : refusé, rien n'est modifié.
    const user = await make.user();
    const refus = await PATCH(req('/api/admin/communications/email-settings', { body: { senderEmail: 'pirate@evil.test' }, cookie: `access_token=${await jeton(user.id, 'u@u', 'USER')}` }));
    expect(refus.status).toBeGreaterThanOrEqual(401);
    // Valeurs invalides : 400 (adresse, en-tête injecté, champ inconnu).
    for (const body of [{ senderEmail: 'pas-une-adresse' }, { senderName: 'Verebona\r\nBcc: x@y.z' }, { replyToEmail: 'a@b' }, { logoUrl: 'x' }, {}]) {
      expect((await PATCH(req('/api/admin/communications/email-settings', { body, cookie: `access_token=${tokAdmin}` }))).status).toBe(400);
    }
    const [avant] = await sql<{ sender_email: string }[]>`SELECT sender_email FROM email_settings WHERE id = 1`;
    expect(avant.sender_email).toBe('noreply@verebona.com');

    // Correction : expéditeur sur le domaine vérifié.
    const ok = await PATCH(req('/api/admin/communications/email-settings', {
      body: { senderName: 'Verebona', senderEmail: 'Bonjour@Verebona.fr', replyToEmail: 'support@verebona.fr' }, cookie: `access_token=${tokAdmin}`,
    }));
    expect(ok.status).toBe(200);
    const corps = await ok.json();
    expect(corps.config).toMatchObject({ source: 'base', senderEmail: 'bonjour@verebona.fr', senderDomain: 'verebona.fr', replyToEmail: 'support@verebona.fr', apiKeyConfigured: true });
    expect(JSON.stringify(corps)).not.toContain('re_e2e_simule_61b');
    // Journal d'audit : avant / après.
    const [audit] = await sql<{ old_value: { senderEmail: string }; new_value: { senderEmail: string }; result: string }[]>`
      SELECT old_value, new_value, result FROM admin_audit_log WHERE action_type = 'EMAIL_SETTINGS_UPDATE' AND admin_user_id = ${admin.id} ORDER BY id DESC LIMIT 1`;
    expect(audit).toMatchObject({ result: 'SUCCESS', old_value: { senderEmail: 'noreply@verebona.com' }, new_value: { senderEmail: 'bonjour@verebona.fr' } });

    // La reprise automatique (tâche planifiée interne) renvoie avec le nouvel expéditeur.
    const r = await jobs.runTransactionalEmailRetry({ now: () => new Date(Date.now() + 2 * 60_000), deadline: Date.now() + 30_000 });
    expect(r.accepted).toBeGreaterThanOrEqual(1);
    const envoi = etat.calls.find((c) => c.to === email)!;
    expect(envoi.from).toContain('bonjour@verebona.fr');
  });
});
