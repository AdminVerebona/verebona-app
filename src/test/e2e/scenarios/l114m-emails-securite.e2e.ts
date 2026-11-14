/**
 * Lot 114M — Trello #774 « E-mails transactionnels — gabarit commun, alertes
 * Passkey et TOTP », sur PostgreSQL réel (migration 1698 appliquée).
 *
 * Chaîne complète, à partir du point d'émission réel (`notifyMfaEvent`) :
 * file d'envoi → distribution → gabarit en base → rendu → prestataire SIMULÉ
 * (aucun envoi réel) → journal des envois.
 *
 *   E01 Clé d'accès ajoutée : UN e-mail, objet propre à l'événement, gabarit
 *       dédié, date de l'ÉVÉNEMENT (pas de l'envoi), lien Mon compte ›
 *       Sécurité sans jeton, HTML et texte brut, adresse d'assistance des
 *       réglages, cloche et push toujours supprimés.
 *   E02 Application d'authentification activée : idem, gabarit distinct,
 *       aucun mélange avec la clé d'accès.
 *   E03 Les autres événements MFA gardent `notif_security`, inchangé.
 *   E04 Panne du prestataire : échec tracé, aucun doublon ; isolation : rien
 *       pour un autre utilisateur.
 *   E05 BO : les deux gabarits sont éditables (zones de texte), non
 *       désactivables, et leur aperçu est complet (données d'exemple).
 *   E06 Migration rejouable : aucun doublon, gabarit retouché non écrasé.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

interface Mail { to: string | string[]; subject?: string; html?: string; text?: string; replyTo?: string }
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule';
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  // Adresse de l'application (liens absolus des e-mails) : valeur d'exemple.
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.exemple.fr';
  return { mails: [] as Mail[], refus: new Set<string>(), n: 0, appUrl };
});
afterAll(() => {
  delete process.env.RESEND_API_KEY;
  if (etat.appUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = etat.appUrl;
});
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: Mail) => {
        const dest = Array.isArray(p.to) ? p.to : [p.to];
        if (dest.some((d) => etat.refus.has(d))) return { data: null, error: { name: 'simulated', message: 'refus simulé' } };
        etat.mails.push(p);
        etat.n += 1;
        return { data: { id: `em_l114m_${etat.n}` }, error: null };
      },
    };
  },
}));

const OBJET_CLE = "Une clé d'accès a été ajoutée à votre compte Verebona";
const OBJET_TOTP = "Une application d'authentification a été activée sur votre compte Verebona";
const QUAND = /le \d{1,2} \S+ \d{4} à \d{2} h \d{2} \(heure de Paris\)/;

scenario('L114M', 'E-mails de sécurité : clé d’accès ajoutée et application d’authentification activée (gabarit commun)', ({ sql, make }) => {
  beforeEach(async () => {
    etat.refus.clear();
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@verebona.com', 'assistance-recette@exemple.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true, reply_to_email = 'assistance-recette@exemple.fr'`;
  });

  async function compte() {
    const email = `${uid('l114m')}@test.invalid`;
    const owner = await make.user({ email });
    const acc = await make.account({ owner });
    return { id: owner.id, email, accountId: acc.id };
  }
  const emettre = async (userId: number, event: Parameters<typeof import('@/lib/auth/mfa/notify').notifyMfaEvent>[1]) => {
    const { notifyMfaEvent } = await import('@/lib/auth/mfa/notify');
    await notifyMfaEvent(userId, event);
  };
  async function distribuer(userId: number, attendus = 1) {
    const { processPending } = await import('@/lib/notifications');
    let rows: Array<{ id: string; status: string; deep_link: string | null; payload_json: { event: string; at: string } }> = [];
    for (let i = 0; i < 200; i++) {
      await processPending(100);
      rows = await sql`SELECT id, status, deep_link, payload_json FROM notification_outbox
        WHERE recipient_user_id = ${userId} AND event_type = 'MFA_SECURITY_EVENT' ORDER BY created_at`;
      if (rows.length >= attendus && rows.every((r) => r.status !== 'pending' && r.status !== 'processing')) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return rows;
  }
  const livraisons = (outboxId: string) => sql<{ channel: string; status: string; last_error_code: string | null }[]>`
    SELECT channel, status, last_error_code FROM notification_deliveries WHERE outbox_id = ${outboxId}::uuid ORDER BY channel, id`;
  const mailsA = (email: string) => etat.mails.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(email));
  const journal = (email: string) => sql<{ template_code: string; status: string; subject: string }[]>`
    SELECT template_code, status, subject FROM email_logs WHERE recipient_email = ${email} ORDER BY id`;

  it('E01 clé d’accès ajoutée : un seul e-mail, gabarit dédié, date de l’événement, lien de sécurité, HTML et texte', async () => {
    const u = await compte();
    await emettre(u.id, 'passkey_added');
    const [ligne, ...autres] = await distribuer(u.id);
    expect(autres).toEqual([]);
    expect(ligne.status).toBe('sent');
    expect(ligne.deep_link).toBe('/mon-compte?ouvrir=securite#securite');
    // Canaux : e-mail envoyé ; cloche (et push) toujours supprimés (lot 101B).
    expect(await livraisons(ligne.id)).toEqual([
      { channel: 'bell', status: 'skipped_unavailable', last_error_code: 'channel_retired' },
      { channel: 'email', status: 'sent', last_error_code: null },
    ]);
    expect(await sql`SELECT id FROM notifications WHERE user_id = ${u.id}`).toEqual([]);

    const mails = mailsA(u.email);
    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.subject).toBe(OBJET_CLE);
    expect(m.replyTo).toBe('assistance-recette@exemple.fr');
    const html = m.html ?? '';
    const text = m.text ?? '';
    expect(html).toContain('data-vb-gabarit="transactionnel-v1"');
    expect(html).toContain("Une nouvelle clé d'accès a été ajoutée</h1>");
    expect(html).toContain("Vérifiez cet ajout si vous n'en êtes pas à l'origine.");
    expect(html).not.toMatch(/\{\{|\}\}/);
    expect(html).not.toMatch(/application d'authentification/i);
    // Date : celle de l'ÉVÉNEMENT (payload), convertie en heure de Paris.
    const { formatSecurityEventWhen } = await import('@/lib/auth/security-email');
    const quand = formatSecurityEventWhen(ligne.payload_json.at);
    expect(quand).toMatch(QUAND);
    expect(html).toContain(`sur votre compte Verebona ${quand}.`);
    expect(text).toContain(`Une clé d'accès a été enregistrée sur votre compte Verebona ${quand}.`);
    // Lien : application, Mon compte › Sécurité, espace de l'émetteur éventuel, aucun jeton.
    const liens = [...html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]);
    expect(liens).toHaveLength(2);
    expect(liens[0]).toMatch(/^https:\/\/app\.exemple\.fr\/mon-compte\?ouvrir=securite(&amp;space=\d+|&space=\d+)?#securite$/);
    expect(liens[0]).not.toMatch(/token|code=/i);
    expect(liens[1]).toBe('mailto:assistance-recette@exemple.fr');
    // Texte brut : lisible, ordonné, sans balise.
    expect(text).toContain("1. Supprimez toute clé d'accès inconnue.\n2. Déconnectez les appareils/sessions suspects si l'application permet de le faire.\n3. Changez votre mot de passe.");
    expect(text).toMatch(/\n\nVérifier la sécurité de mon compte : https:\/\/app\.exemple\.fr\/mon-compte\?ouvrir=securite\S*#securite\n\n/);
    expect(text).toContain('assistance-recette@exemple.fr');
    expect(text).not.toMatch(/<[a-z!/]|font-family|color-scheme/i);
    // Journal des envois : gabarit dédié, objet exact.
    expect(await journal(u.email)).toEqual([{ template_code: 'notif_mfa_passkey_added', status: 'sent', subject: OBJET_CLE }]);
    // Rejeu de la distribution : aucun second envoi.
    await distribuer(u.id);
    expect(mailsA(u.email)).toHaveLength(1);
    // Une seconde clé ajoutée (utilisateur à plusieurs clés) : un e-mail par ajout, jamais regroupé ni perdu.
    await emettre(u.id, 'passkey_added');
    expect((await distribuer(u.id, 2)).map((l) => l.status)).toEqual(['sent', 'sent']);
    expect(mailsA(u.email).map((x) => x.subject)).toEqual([OBJET_CLE, OBJET_CLE]);
  });

  it('E02 application d’authentification activée : gabarit distinct, aucun mélange', async () => {
    const u = await compte();
    await emettre(u.id, 'totp_enabled');
    const [ligne] = await distribuer(u.id);
    expect(ligne.status).toBe('sent');
    const mails = mailsA(u.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe(OBJET_TOTP);
    const html = mails[0].html ?? '';
    const text = mails[0].text ?? '';
    expect(html).toContain("Application d'authentification activée</h1>");
    expect(html).toContain("Si vous n'êtes pas à l'origine de cette activation, vérifiez la sécurité de votre compte.");
    expect(`${html}${text}`).not.toMatch(/clé d'accès/i);
    expect(text).toMatch(/Une application d'authentification a été activée sur votre compte Verebona le \d{1,2} \S+ \d{4} à \d{2} h \d{2} \(heure de Paris\)\./);
    expect(text).toContain("2. Vérifiez les méthodes de connexion et désactivez la méthode d'authentification inconnue.");
    expect(text).toContain('4. Changez votre mot de passe.');
    expect(text).toContain("Si vous ne parvenez pas à sécuriser votre compte, contactez l'assistance Verebona.");
    // Aucune donnée d'authentification.
    expect(`${html}${text}`).not.toMatch(/otpauth|secret|QR/i);
    expect(await journal(u.email)).toEqual([{ template_code: 'notif_mfa_totp_enabled', status: 'sent', subject: OBJET_TOTP }]);
  });

  it('E03 autres événements MFA : gabarit notif_security et lien inchangés', async () => {
    const u = await compte();
    await emettre(u.id, 'totp_removed');
    await emettre(u.id, 'passkey_removed');
    const lignes = await distribuer(u.id, 2);
    expect(lignes.map((l) => l.status)).toEqual(['sent', 'sent']);
    expect(lignes.map((l) => l.deep_link)).toEqual(['/mon-compte#securite', '/mon-compte#securite']);
    const mails = mailsA(u.email);
    expect(mails.map((m) => m.subject)).toEqual(['Sécurité de votre compte', 'Sécurité de votre compte']);
    for (const m of mails) expect(m.html ?? '').not.toContain('data-vb-gabarit');
    expect((await journal(u.email)).map((j) => j.template_code)).toEqual(['notif_security', 'notif_security']);
  });

  it('E04 panne du prestataire : échec tracé, aucun doublon ; un autre utilisateur ne reçoit rien', async () => {
    const u = await compte();
    const autre = await compte();
    etat.refus.add(u.email);
    await emettre(u.id, 'passkey_added');
    const [ligne] = await distribuer(u.id);
    expect(ligne.status).toBe('failed');
    expect((await livraisons(ligne.id)).find((l) => l.channel === 'email')).toMatchObject({ status: 'failed' });
    expect(mailsA(u.email)).toEqual([]);
    expect(await journal(u.email)).toEqual([{ template_code: 'notif_mfa_passkey_added', status: 'failed', subject: OBJET_CLE }]);
    // Isolation : aucun événement, aucun e-mail pour l'autre utilisateur.
    expect(await sql`SELECT id FROM notification_outbox WHERE recipient_user_id = ${autre.id}`).toEqual([]);
    expect(mailsA(autre.email)).toEqual([]);
  });

  it('E05 BO : gabarits éditables par zones, e-mail non désactivable, aperçu complet avec données d’exemple', async () => {
    const admin = await compte();
    const { getEditorState, renderDraft } = await import('@/services/admin/email-template-editor.service');
    for (const [code, objet, titre] of [
      ['NOTIF_MFA_PASSKEY_ADDED', OBJET_CLE, "Une nouvelle clé d'accès a été ajoutée"],
      ['NOTIF_MFA_TOTP_ENABLED', OBJET_TOTP, "Application d'authentification activée"],
    ] as const) {
      const s = await getEditorState(code);
      expect(s.ok, code).toBe(true);
      if (!s.ok) continue;
      expect(s.state.format).toBe('html');
      expect(s.state.kind).toBe('notification');
      expect(s.state.usedBy.map((x) => x.code)).toEqual(['MFA_SECURITY_EVENT']);
      expect(JSON.stringify(s.state)).toMatch(/toujours envoyé/);
      const r = await renderDraft({ code, adminId: admin.id, accountId: admin.accountId });
      expect(r.ok, code).toBe(true);
      if (!r.ok) continue;
      expect(r.render.subject).toBe(objet);
      expect(r.render.incomplete).toBe(false);
      expect(r.render.html).toContain(`${titre}</h1>`);
      expect(r.render.html).toMatch(QUAND);
      expect(r.render.html).toContain('mailto:assistance-recette@exemple.fr');
      expect(r.render.html).not.toMatch(/\{\{|donnée indisponible/);
    }
  });

  it('E06 migration 1698 rejouable : aucun doublon, gabarit retouché non écrasé', async () => {
    const mig = readFileSync(join(process.cwd(), 'src/db/migrations/1698_l114m_emails_securite_gabarit_commun.sql'), 'utf8');
    const avant = await sql<{ type: string; md5: string }[]>`SELECT type, md5(body) AS md5 FROM email_templates WHERE type LIKE 'notif_mfa_%' ORDER BY type`;
    expect(avant.map((r) => r.type)).toEqual(['notif_mfa_passkey_added', 'notif_mfa_totp_enabled']);
    const { SECURITY_NOTIFICATION_TEMPLATES } = await import('@/lib/email/security-notification-templates');
    const [cle] = await sql<{ subject: string; body: string }[]>`SELECT subject, body FROM email_templates WHERE type = 'notif_mfa_passkey_added'`;
    expect(cle.subject).toBe(SECURITY_NOTIFICATION_TEMPLATES.NOTIF_MFA_PASSKEY_ADDED.subject);
    expect(cle.body).toBe(SECURITY_NOTIFICATION_TEMPLATES.NOTIF_MFA_PASSKEY_ADDED.body);
    await sql.unsafe(mig);
    await sql.unsafe(mig);
    expect(await sql`SELECT type, md5(body) AS md5 FROM email_templates WHERE type LIKE 'notif_mfa_%' ORDER BY type`).toEqual(avant);
    // Le gabarit générique n'est pas touché.
    expect(await sql`SELECT subject, body FROM email_templates WHERE type = 'notif_security'`).toEqual([
      { subject: 'Sécurité de votre compte', body: '{{body}}\n\nAccéder à Verebona : {{actionUrl}}' },
    ]);
  });
});
