/**
 * Lot 66C — e-mails transactionnels à la charte « Sérénité » 2026, sur PostgreSQL 16
 * réel (toutes les migrations, dont 0279 puis 0465), transport Resend SIMULÉ.
 *
 * L66C-MAIL-E2E-01 Base neuve : WITHDRAWAL_RECEIPT inséré par 0279 est mis en page
 *                  par 0465 (corps = module partagé).
 * L66C-MAIL-E2E-02 Les 11 gabarits HTML livrés au lot 65 (corps exacts) sont mis à jour.
 * L66C-MAIL-E2E-03 Garde de personnalisation : balisage différent mais MÊME texte et
 *                  jamais enregistré depuis le BO → mis à jour ; même cas enregistré
 *                  depuis le BO (updated_by) → intact ; texte modifié → intact ;
 *                  rejouée → aucun effet (idempotence).
 * L66C-MAIL-E2E-04 Envoi réel par EmailService : gabarit HTML (WELCOME) et gabarit
 *                  texte (EMAIL_VERIFICATION) rendus à la charte, logo hébergé, aucune
 *                  variable restante, journal « sent ».
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_66c';
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
        return { data: { id: `em_66c_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

const ROOT = process.cwd();
const MIGRATION = readFileSync(join(ROOT, 'src/db/migrations/0465_l66c_emails_charte_2026.sql'), 'utf8');
const LOT65 = JSON.parse(readFileSync(join(ROOT, 'src/lib/email/__tests__/fixtures/l66c-email-lot65.json'), 'utf8')) as {
  db: Record<string, { subject: string; body: string }>;
};

scenario('L66C-MAIL', 'E-mails : mise en page « Sérénité » sans écraser les personnalisations', ({ sql, make }) => {
  beforeEach(async () => {
    process.env.RESEND_API_KEY = 're_e2e_simule_66c';
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
  });

  const poser = async (type: string, body: string, updatedBy: number | null = null) => {
    await sql`INSERT INTO email_templates (type, subject, body, updated_by, updated_at)
              VALUES (${type}, ${LOT65.db[type]?.subject ?? type}, ${body}, ${updatedBy}, now() - interval '1 day')
              ON CONFLICT (type) DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`;
  };
  const corps = async (type: string) => (await sql<{ body: string; updated_at: Date }[]>`SELECT body, updated_at FROM email_templates WHERE type = ${type}`)[0];
  const migrer = () => sql.unsafe(MIGRATION);

  it('L66C-MAIL-E2E-01 — base neuve : WITHDRAWAL_RECEIPT (0279) mis en page par 0465', async () => {
    const { WITHDRAWAL_RECEIPT_HTML } = await import('@/lib/email/email-html-templates');
    expect((await corps('WITHDRAWAL_RECEIPT')).body).toBe(WITHDRAWAL_RECEIPT_HTML);
  });

  it('L66C-MAIL-E2E-02 — les 11 gabarits HTML livrés au lot 65 sont mis à jour', async () => {
    const { EMAIL_HTML_TEMPLATES_L66 } = await import('@/lib/email/email-html-templates');
    for (const type of Object.keys(EMAIL_HTML_TEMPLATES_L66)) await poser(type, LOT65.db[type].body);
    await migrer();
    for (const [type, body] of Object.entries(EMAIL_HTML_TEMPLATES_L66)) expect((await corps(type)).body, type).toBe(body);
    // Voie « texte identique » : normalisation SQL (l66c_email_text) = normalisation du test, pour les 11 corps.
    for (const type of Object.keys(EMAIL_HTML_TEMPLATES_L66)) await poser(type, `<!-- retouche -->\n${LOT65.db[type].body.replace(/>\s+</g, '>\n  <')}`);
    await migrer();
    for (const [type, body] of Object.entries(EMAIL_HTML_TEMPLATES_L66)) expect((await corps(type)).body, `${type} (balisage retouché)`).toBe(body);
    // La fonction temporaire n'existe plus.
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'l66c_email_text'`;
    expect(n).toBe(0);
  });

  it('L66C-MAIL-E2E-03 — personnalisations jamais écrasées ; idempotente', async () => {
    const { WELCOME_HTML, TRIAL_ENDED_HTML, ACCOUNT_INVITATION_HTML } = await import('@/lib/email/email-html-templates');
    const admin = await make.user({});
    // Balisage retouché en place (marges, couleurs) mais texte identique, jamais enregistré depuis le BO.
    const retouche = (b: string) => {
      const r = b.replace('<body style="', '<body style="color:#111111; ').replace(/#3B82F6/g, '#2563EB');
      expect(r).not.toBe(b); // le balisage diffère vraiment (sinon l'empreinte exacte s'applique, à juste titre)
      return r;
    };
    await poser('WELCOME', retouche(LOT65.db.WELCOME.body));
    // Même retouche, mais enregistrée depuis le BO.
    await poser('TRIAL_ENDED', retouche(LOT65.db.TRIAL_ENDED.body), admin.id);
    // Texte modifié (personnalisation de contenu), sans auteur connu.
    const perso = LOT65.db.ACCOUNT_INVITATION.body.replace('vous pouvez simplement ignorer cet email', 'il vous suffit de supprimer ce message');
    expect(perso).not.toBe(LOT65.db.ACCOUNT_INVITATION.body);
    await poser('ACCOUNT_INVITATION', perso);
    // Gabarit texte : jamais touché.
    await poser('EMAIL_VERIFICATION', LOT65.db.EMAIL_VERIFICATION.body);

    await migrer();
    expect((await corps('WELCOME')).body).toBe(WELCOME_HTML);
    expect((await corps('TRIAL_ENDED')).body).toBe(retouche(LOT65.db.TRIAL_ENDED.body));
    expect((await corps('TRIAL_ENDED')).body).not.toBe(TRIAL_ENDED_HTML);
    expect((await corps('ACCOUNT_INVITATION')).body).toBe(perso);
    expect((await corps('ACCOUNT_INVITATION')).body).not.toBe(ACCOUNT_INVITATION_HTML);
    expect((await corps('EMAIL_VERIFICATION')).body).toBe(LOT65.db.EMAIL_VERIFICATION.body);

    // Rejouée : aucun changement (date de mise à jour comprise).
    const avant = await corps('WELCOME');
    await migrer();
    const apres = await corps('WELCOME');
    expect(apres.body).toBe(avant.body);
    expect(String(apres.updated_at)).toBe(String(avant.updated_at));
  });

  it('L66C-MAIL-E2E-04 — envoi réel : gabarit HTML et gabarit texte à la charte, logo hébergé, journal « sent »', async () => {
    const { emailService } = await import('@/lib/email/email-service');
    const { WELCOME_HTML } = await import('@/lib/email/email-html-templates');
    await poser('WELCOME', WELCOME_HTML);
    await poser('EMAIL_VERIFICATION', LOT65.db.EMAIL_VERIFICATION.body);
    etat.calls.length = 0;

    const w = await emailService.send({ templateCode: 'WELCOME', to: 'lea@test.invalid', variables: { firstName: 'Léa', loginUrl: 'https://app.e2e.verebona.test/login' }, skipChannelCheck: true });
    const v = await emailService.send({ templateCode: 'EMAIL_VERIFICATION', to: 'lea@test.invalid', variables: { firstName: 'Léa', verificationUrl: 'https://app.e2e.verebona.test/verify-email/abcdefghijkl' }, skipChannelCheck: true });
    expect(w.success).toBe(true);
    expect(v.success).toBe(true);
    expect(etat.calls).toHaveLength(2);
    for (const call of etat.calls) {
      expect(call.html).toContain('src="https://app.e2e.verebona.test/brand/verebona-logo-email.png?v=2026"');
      expect(call.html).toContain('alt="Verebona"');
      expect(call.html).toContain('bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;"');
      expect(call.html).toContain('@media (prefers-color-scheme: dark)');
      expect(call.html).not.toMatch(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/);
      expect(call.html).not.toContain('#3B82F6');
    }
    expect(etat.calls[0].html).toContain('href="https://app.e2e.verebona.test/login"');
    expect(etat.calls[0].html).toContain('Bonjour Léa,');
    // Gabarit texte : l'URL seule devient le bouton « Cliquez ici » (logique inchangée).
    expect(etat.calls[1].html).toMatch(/<a class="vb-btn" href="https:\/\/app\.e2e\.verebona\.test\/verify-email\/abcdefghijkl"[^>]*>Cliquez ici<\/a>/);
    const logs = await sql<{ status: string; error_message: string | null }[]>`SELECT status, error_message FROM email_logs WHERE id IN (${w.logId!}, ${v.logId!})`;
    expect(logs.map((l) => l.status)).toEqual(['sent', 'sent']);
    expect(logs.every((l) => l.error_message === null)).toBe(true);
  });
});
