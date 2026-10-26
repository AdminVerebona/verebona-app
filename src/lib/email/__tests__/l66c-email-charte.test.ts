/**
 * Lot 66C — e-mails transactionnels à la charte « Sérénité » 2026.
 *
 * Référence « avant » : `fixtures/l66c-email-lot65.json` (corps livrés au tag lot65 :
 * migrations + amorçages sur base neuve, défauts du code, enveloppe texte, repli de
 * transmission), relevés avant la migration graphique.
 *
 *  · L66C-MAIL-01 : enveloppe commune des gabarits texte — mêmes textes, mêmes liens,
 *    mêmes libellés de bouton ; nouvelle présentation.
 *  · L66C-MAIL-02 : gabarits HTML complets (base et défauts du code) — texte visible,
 *    variables `{{…}}` et liens IDENTIQUES au lot 65.
 *  · L66C-MAIL-03 : charte — fond ivoire / carte blanche, bouton pétrole texte blanc
 *    rayon 12, liens pétrole, sur-titres cuivre texte, pile Figtree → Arial / Helvetica,
 *    aucune variable CSS ni ancienne couleur.
 *  · L66C-MAIL-04 : compatibilité clients — tableaux de présentation, styles en ligne,
 *    color-scheme / supported-color-schemes, @media (prefers-color-scheme: dark), [data-ogsc].
 *  · L66C-MAIL-05 : logo — images hébergées (URL absolue), texte alternatif, PNG
 *    opaques clair / sombre ; logo de gabarit personnalisé `{{logoUrl}}` remplacé ;
 *    recalibrage historique conservé pour les autres images.
 *  · L66C-MAIL-06 : migration 0465 — corps = module partagé, empreintes du lot 65,
 *    garde de personnalisation, gabarits texte non touchés.
 *  · L66C-MAIL-07 : repli de transmission — même texte, même lien, données échappées.
 *  · L66C-MAIL-08 : amorçages et défauts du code branchés sur le module partagé.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/lib/notifications/channel-activation', () => ({ isTransactionalEmailActive: async () => true }));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.exemple.fr';
const { emailService } = await import('../email-service');
const T = await import('../email-html-templates');
const { DEFAULT_EMAIL_TEMPLATES } = await import('@/lib/email-defaults');
const { buildTransmissionHtml } = await import('../transmission-email');
const { EMAIL_COLORS, emailLogoHtml } = await import('../email-layout');

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const fx = JSON.parse(read('src/lib/email/__tests__/fixtures/l66c-email-lot65.json')) as {
  db: Record<string, { subject: string; body: string }>;
  defaults: Record<string, { subject: string; body: string }>;
  wrapper: { sample: string; html: string };
  transmission: { html: string };
};

type Svc = {
  wrapInHTML(b: string, s: unknown, l: { type: string; content: string }): Promise<string>;
  getVerebonaEmailLogo(): Promise<{ type: string; content: string }>;
  replaceVariables(t: string, v: Record<string, string>, s: unknown, l: { type: string; content: string }): string;
  fixLogoSizing(h: string): string;
};
const svc = emailService as unknown as Svc;
const SETTINGS = { senderName: 'Verebona', replyToEmail: 'support@verebona.com', footerText: null, logoUrl: null };

/** Texte visible : <head>, commentaires (dont conditionnels Outlook) et balises retirés, entités usuelles décodées. */
const visible = (html: string) => html
  .replace(/<head[\s\S]*?<\/head>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\{\{logoUrl\}\}/g, ' ')
  .replace(/\s+/g, ' ').trim();
const placeholders = (html: string) => [...new Set([...html.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))].sort();
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].trim()).sort();

/** Paires « avant (lot 65) → après (lot 66) ». */
const PAIRS: Array<[string, string, string]> = [
  ...Object.entries(T.EMAIL_HTML_TEMPLATES_L66).map(([type, body]) => [`base ${type}`, fx.db[type].body, body] as [string, string, string]),
  ['défaut WELCOME', fx.defaults.WELCOME.body, DEFAULT_EMAIL_TEMPLATES.WELCOME.body],
  ['défaut PREMIUM_CONFIRMATION', fx.defaults.PREMIUM_CONFIRMATION.body, DEFAULT_EMAIL_TEMPLATES.PREMIUM_CONFIRMATION.body],
  ['défaut DUO_INVITATION', fx.defaults.DUO_INVITATION.body, DEFAULT_EMAIL_TEMPLATES.DUO_INVITATION.body],
  ['défaut TRIAL_CONFIRMATION', fx.defaults.TRIAL_CONFIRMATION.body, DEFAULT_EMAIL_TEMPLATES.TRIAL_CONFIRMATION.body],
];

/** Tous les rendus « charte » à contrôler. */
async function allRenders(): Promise<Array<[string, string]>> {
  const logo = await svc.getVerebonaEmailLogo();
  const out: Array<[string, string]> = [['enveloppe texte', await svc.wrapInHTML(fx.wrapper.sample, SETTINGS, logo)]];
  for (const [name, , html] of PAIRS) out.push([name, html]);
  out.push(['transmission', buildTransmissionHtml('Léa', 'Vélo cargo', 'https://app.exemple.fr/t/abc', '2026')]);
  return out;
}

describe('L66C-MAIL-01 — enveloppe des gabarits texte', () => {
  it('mêmes textes, mêmes liens et libellés de boutons qu’au lot 65', async () => {
    const html = await svc.wrapInHTML(fx.wrapper.sample, SETTINGS, await svc.getVerebonaEmailLogo());
    // Avant : le sigle dessiné portait le mot « Verebona » en texte ; il est maintenant le texte alternatif du logo.
    expect(visible(html)).toBe(visible(fx.wrapper.html).replace(/^Verebona /, ''));
    expect(hrefs(html)).toEqual(hrefs(fx.wrapper.html));
    expect(html).toMatch(/<a class="vb-btn" href="https:\/\/app\.verebona\.fr\/duo\/join\/abc"[^>]*>Accepter<\/a>/);
    expect(html).toMatch(/<a class="vb-btn" href="https:\/\/app\.verebona\.fr\/x"[^>]*>Cliquez ici<\/a>/);
  });
  it('pied : texte du BO et adresse de réponse conservés', async () => {
    const html = await svc.wrapInHTML('Bonjour', { ...SETTINGS, footerText: 'Pied personnalisé BO', replyToEmail: 'aide@verebona.com' }, await svc.getVerebonaEmailLogo());
    expect(html).toContain('Pied personnalisé BO');
    expect(html).toContain('href="mailto:aide@verebona.com"');
  });
});

describe('L66C-MAIL-02 — gabarits HTML : textes, variables et liens inchangés', () => {
  for (const [name, before, after] of PAIRS) {
    it(name, () => {
      expect(visible(after)).toBe(visible(before));
      // Seule variable de MISE EN PAGE admise en plus : `logoUrl` (en-tête logo des gabarits
      // d'essai, qui n'en avaient pas), toujours renseignée par le service lui-même.
      const added = placeholders(after).filter((v) => !placeholders(before).includes(v));
      expect(added.filter((v) => v !== 'logoUrl')).toEqual([]);
      expect(placeholders(before).filter((v) => !placeholders(after).includes(v))).toEqual([]);
      expect(hrefs(after)).toEqual(hrefs(before));
    });
  }
  it('`logoUrl` ajouté aux gabarits d’essai : remplacé à l’envoi par le logo (jamais « variable non fournie »)', async () => {
    const out = svc.replaceVariables(T.TRIAL_ENDED_HTML, { firstName: 'Léa', offersUrl: 'https://a.fr/offres' }, SETTINGS, await svc.getVerebonaEmailLogo());
    expect(out).not.toMatch(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/);
    expect(out).toContain('vb-logo-light');
  });
  it('objets inchangés (amorçage = lot 65)', () => {
    for (const type of Object.keys(T.EMAIL_HTML_TEMPLATES_L66)) {
      expect(read('src/db/migrations/0465_l66c_emails_charte_2026.sql')).not.toMatch(new RegExp(`'${type}'[\\s\\S]{0,40}SET subject`));
    }
    expect(DEFAULT_EMAIL_TEMPLATES.WELCOME.subject).toBe(fx.defaults.WELCOME.subject);
    expect(DEFAULT_EMAIL_TEMPLATES.PREMIUM_CONFIRMATION.subject).toBe(fx.defaults.PREMIUM_CONFIRMATION.subject);
  });
});

describe('L66C-MAIL-03 — charte « Sérénité »', () => {
  it('fond ivoire, carte blanche filet #D5DEDC, bouton pétrole texte blanc rayon 12, pile Figtree / Arial / Helvetica', async () => {
    for (const [name, html] of await allRenders()) {
      expect(html, name).toContain(`background-color:${EMAIL_COLORS.ivoire}`);
      expect(html, name).toContain(`border:1px solid ${EMAIL_COLORS.filet};border-radius:16px`);
      expect(html, name).toContain("font-family:'Figtree', Arial, Helvetica, sans-serif");
      if (html.includes('class="vb-btn"')) {
        expect(html, name).toMatch(/<td class="vb-btn-td" align="center" bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;">/);
        expect(html, name).toMatch(/class="vb-btn"[^>]*style="[^"]*color:#FFFFFF;[^"]*border-radius:12px;background-color:#17474D;/);
      }
      expect(html, name).not.toMatch(/#3B82F6|#2D3748|#0b5fff|#EFF6FF/i);
      expect(html, name).not.toMatch(/var\(--/);
      expect(html, name).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    }
  });
  it('sur-titres en cuivre texte (#AA4E38, #E2896F en sombre), liens pétrole', async () => {
    expect(T.PREMIUM_CONFIRMATION_HTML).toMatch(/class="vb-eyebrow" style="[^"]*text-transform:uppercase;color:#AA4E38;">Verebona Premium/);
    expect(T.WITHDRAWAL_RECEIPT_HTML).toMatch(/class="vb-link" href="\{\{legalPermalinkUrl\}\}" style="color:#17474D;/);
    expect(T.WELCOME_HTML).toMatch(/\.vb-text \.vb-eyebrow,\s+\.vb-eyebrow \{ color:#E2896F !important; \}/);
    // Mot-symbole texte des gabarits légaux : clair en mode sombre (lisible sur la carte encre).
    expect(T.WITHDRAWAL_RECEIPT_HTML).toContain('<p class="vb-wordmark"');
    expect(T.WITHDRAWAL_RECEIPT_HTML).toMatch(/\.vb-wordmark \{ color:#F3F1EB !important; \}/);
  });
  it('les couleurs d’attention restent du cuivre (pas de rouge hors erreur bloquante)', () => {
    expect(T.MEMBER_REMOVED_DUE_TO_DOWNGRADE_HTML).toContain(`background-color:${EMAIL_COLORS.cuivreSoft}`);
    for (const html of Object.values(T.EMAIL_HTML_TEMPLATES_L66)) expect(html).not.toContain(EMAIL_COLORS.rouge);
  });
});

describe('L66C-MAIL-04 — compatibilité des clients de messagerie', () => {
  it('tableaux de présentation, styles en ligne, mode sombre déclaré', async () => {
    for (const [name, html] of await allRenders()) {
      expect(html, name).toMatch(/^<!DOCTYPE html>/);
      expect(html, name).toContain('<meta name="color-scheme" content="light dark">');
      expect(html, name).toContain('<meta name="supported-color-schemes" content="light dark">');
      expect(html, name).toContain('@media (prefers-color-scheme: dark)');
      expect(html, name).toContain('[data-ogsc] .vb-card');
      expect(html, name).toContain('<table role="presentation" class="vb-container vb-card" width="600"');
      // Aucune mise en page par <div> ni flex / grid (non pris en charge par Outlook).
      expect(html, name).not.toMatch(/display:\s*(flex|grid)/);
      expect(html, name).not.toMatch(/<div\b/);
    }
  });
  it('police : @font-face auto-hébergée dans l’enveloppe (Figtree OFL servie par l’application), absente des gabarits en base', async () => {
    const html = await svc.wrapInHTML('Bonjour', SETTINGS, await svc.getVerebonaEmailLogo());
    expect(html).toContain("src:url('https://app.exemple.fr/brand/email/figtree-latin-wght-5.3.0.woff2') format('woff2')");
    for (const f of ['figtree-latin-wght-5.3.0.woff2', 'figtree-latin-ext-wght-5.3.0.woff2', 'LICENSE.txt']) {
      expect(existsSync(join(ROOT, 'public/brand/email', f)), f).toBe(true);
    }
    expect(read('public/brand/email/LICENSE.txt')).toContain('SIL Open Font License');
    for (const body of Object.values(T.EMAIL_HTML_TEMPLATES_L66)) expect(body).not.toContain('@font-face');
  });
});

describe('L66C-MAIL-05 — logo', () => {
  it('images hébergées en URL absolue, texte alternatif, version sombre masquée par défaut (Outlook compris)', async () => {
    const logo = await svc.getVerebonaEmailLogo();
    expect(logo.type).toBe('html');
    expect(logo.content).toContain('src="https://app.exemple.fr/brand/verebona-logo-email.png?v=2026"');
    expect(logo.content).toContain('src="https://app.exemple.fr/brand/verebona-logo-email-dark.png?v=2026"');
    expect(logo.content.match(/alt="Verebona"/g)).toHaveLength(2);
    expect(logo.content).toMatch(/class="vb-logo-dark"[^>]*style="display:none;[^"]*mso-hide:all;"/);
    expect(logo.content).toContain('<!--[if !mso]><!-->');
  });
  it('PNG 480 × 120 OPAQUES (lisibles même quand le client assombrit le fond sans media query)', () => {
    for (const f of ['verebona-logo-email.png', 'verebona-logo-email-dark.png']) {
      const b = readFileSync(join(ROOT, 'public/brand', f));
      expect(b.subarray(1, 4).toString(), f).toBe('PNG');
      expect(b.readUInt32BE(16), f).toBe(480);
      expect(b.readUInt32BE(20), f).toBe(120);
      expect(b[25], `${f} : type de couleur RVB sans alpha`).toBe(2);
    }
  });
  it('gabarit personnalisé en base avec <img src="{{logoUrl}}"> : remplacé par le logo 2026, non recalibré', async () => {
    const logo = await svc.getVerebonaEmailLogo();
    const custom = '<html><body><img src="{{logoUrl}}" alt="x" style="height:40px"><p>Bonjour {{firstName}}</p></body></html>';
    const out = svc.fixLogoSizing(svc.replaceVariables(custom, { firstName: 'Léa' }, SETTINGS, logo));
    expect(out).toContain('class="vb-logo-light" src="https://app.exemple.fr/brand/verebona-logo-email.png?v=2026" width="160" height="40"');
    expect(out).not.toContain('{{logoUrl}}');
    expect(out).toContain('Bonjour Léa');
    // Les autres images de marque gardent le recalibrage historique (240 px).
    expect(svc.fixLogoSizing('<img src="https://x.fr/brand/autre.png" style="height:20px">')).toContain('width="240"');
  });
  it('emailLogoHtml échappe le texte alternatif', () => {
    expect(emailLogoHtml('https://a.fr', 'A "B"')).toContain('alt="A &quot;B&quot;"');
  });
});

describe('L66C-MAIL-06 — migration 0465', () => {
  const mig = read('src/db/migrations/0465_l66c_emails_charte_2026.sql');
  const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
  const emailText = (b: string) => b.replace(/<head[\s\S]*?<\/head>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  it('chaque gabarit HTML livré : corps = module partagé, empreintes du lot 65, garde « non personnalisé »', () => {
    for (const [type, body] of Object.entries(T.EMAIL_HTML_TEMPLATES_L66)) {
      expect(mig, type).toContain(`SET body = $l66c$${body}$l66c$`);
      expect(mig, type).toContain(`WHERE upper(type) = '${type}'\n  AND (md5(body) = '${md5(fx.db[type].body)}'\n       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = '${md5(emailText(fx.db[type].body))}'));`);
    }
    expect(mig.match(/^UPDATE email_templates/gm)).toHaveLength(Object.keys(T.EMAIL_HTML_TEMPLATES_L66).length);
  });
  it('gabarits texte jamais touchés ; fonction temporaire supprimée', () => {
    for (const type of ['EMAIL_VERIFICATION', 'PASSWORD_RESET', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT', 'notif_news']) {
      expect(mig).not.toContain(`upper(type) = '${type}'`);
    }
    expect(mig).toContain('DROP FUNCTION IF EXISTS l66c_email_text(text);');
    expect(mig).not.toMatch(/CONCURRENTLY/);
  });
});

describe('L66C-MAIL-07 — repli de l’e-mail de transmission', () => {
  it('même texte et mêmes liens qu’au lot 65 ; nom saisi échappé', () => {
    const before = fx.transmission.html.replace(/\{\{senderName\}\}/g, 'Léa').replace(/\{\{assetName\}\}/g, 'Vélo cargo')
      .replace(/\{\{shareUrl\}\}/g, 'https://app.exemple.fr/t/abc').replace(/\{\{year\}\}/g, '2026');
    const after = buildTransmissionHtml('Léa', 'Vélo cargo', 'https://app.exemple.fr/t/abc', '2026');
    expect(visible(after)).toBe(visible(before).replace(/^Verebona /, ''));
    expect(hrefs(after)).toEqual(hrefs(before));
    expect(buildTransmissionHtml('<b>X</b>', 'A&B', 'https://a.fr/t', '2026')).toContain('&lt;b&gt;X&lt;/b&gt;');
  });
});

describe('L66C-MAIL-08 — amorçages et défauts branchés sur le module partagé', () => {
  it('aucun corps HTML 2025 ne subsiste dans les amorçages et défauts', () => {
    for (const f of ['src/db/seeds/email_templates_system.ts', 'src/db/seeds/email_templates_trial.ts', 'src/db/seeds/account_membership_email_templates.ts',
      'src/db/seeds/legal/email_template_cgvu.ts', 'src/db/seeds/withdrawal/email_template_withdrawal.ts', 'src/lib/email-defaults.ts', 'src/app/api/assets/[id]/transmission/route.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/<!DOCTYPE html>|#3B82F6|#2D3748/i);
      if (!f.includes('transmission')) expect(src, f).toContain("from '@/lib/email/email-html-templates'");
    }
  });
});
