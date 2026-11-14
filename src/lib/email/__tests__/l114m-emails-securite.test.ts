/**
 * Lot 114M — Trello #774 « E-mails transactionnels — gabarit commun, alertes
 * Passkey et TOTP ».
 *
 *  · L114M-01 Catalogue : « clé d'accès ajoutée » et « application
 *    d'authentification activée » ont chacune leur gabarit dédié, la date
 *    RÉELLE de l'événement (Europe/Paris, été / hiver), le lien vers Mon compte
 *    › Sécurité ; les 5 autres événements MFA sont inchangés ; règles de
 *    notification (obligation, canaux, schéma) inchangées.
 *  · L114M-02 Textes du ticket repris à l'identique ; événement exact dans
 *    l'objet, le pré-en-tête et le titre ; aucun mélange ; le mot de passe
 *    n'est jamais présenté comme suffisant ; aucun secret.
 *  · L114M-03 Gabarit commun : une colonne ≤ 600 px, en-tête court, un seul H1,
 *    un seul bouton, styles en ligne, mode sombre, contraste, images avec
 *    `alt`, accepté par l'éditeur du BO.
 *  · L114M-04 Rendu réel (`EmailService.renderTemplate`) : HTML et TEXTE BRUT,
 *    adresse d'assistance des réglages, valeurs hostiles neutralisées, lien.
 *  · L114M-05 Non-régression : enveloppe du lot 66C, logo, e-mails des 5
 *    autres événements MFA et gabarit HTML existant IDENTIQUES à l'état livré
 *    `lot114-02` (relevé `fixtures/l114m-avant-lot114-02.json`).
 *  · L114M-06 Migration 1698 : corps = module partagé, idempotente, additive.
 *  · L114M-07 Lien « ouvrir la section » : liste fermée, jamais d'ancre libre.
 *  · L114M-08 Repli : gabarit dédié absent de la base → `notif_security`.
 *
 * Aucun envoi réel : rendu seul, base et prestataire simulés. Aucune
 * dépendance à la date du jour (horloge figée).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Lignes `email_templates` présentes dans la base simulée (types). */
const seeded = new Set<string>();
const sent: Array<{ templateCode: string; variables: Record<string, string> }> = [];
vi.mock('@/db', () => ({
  db: {
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: (cond: { __type?: string }) => ({
          limit: async () => {
            if ('email' in cols) return [{ email: 'destinataire@exemple.fr' }];
            return cond.__type && seeded.has(cond.__type) ? [{ type: cond.__type }] : [];
          },
        }),
      }),
    }),
  },
}));
vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  // Seule la valeur comparée est utile à la base simulée.
  eq: (_col: unknown, value: unknown) => ({ __type: typeof value === 'string' ? value : undefined }),
}));
vi.mock('@/lib/notifications/channel-activation', () => ({ isTransactionalEmailActive: async () => true }));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.exemple.fr';
vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00.000Z'), toFake: ['Date'] });

const { emailService } = await import('../email-service');
const L = await import('../email-layout');
const T = await import('../email-html-templates');
const S = await import('../security-notification-templates');
const { buildTransactionalEmailHtml, transactionalHtmlToText } = await import('../transactional-template');
const E = await import('../template-editor');
const { NOTIFICATION_CATALOG, MFA_SECURITY_CTA_LINK, mfaSecurityContent } = await import('@/lib/notifications/catalog');
const { formatSecurityEventWhen, PASSKEY_ADDED_TEMPLATE_CODE, TOTP_ENABLED_TEMPLATE_CODE } = await import('@/lib/auth/security-email');
const { anchorFromOpenParam, OPEN_SECTION_PARAM } = await import('@/lib/account/open-section');
const { safeReturnUrl } = await import('@/lib/safe-redirect');
const { withSpaceParam } = await import('@/lib/shell/space-link');
const { deliverEmail } = await import('@/lib/notifications/channels');
const { renderContent } = await import('@/lib/notifications/content-renderer');

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const AVANT = JSON.parse(read('src/lib/email/__tests__/fixtures/l114m-avant-lot114-02.json')) as {
  document: string; documentStored: string; logo: string;
  mfa: Record<string, { content: Record<string, unknown>; href: string; subject: string; html: string; text: string }>;
  welcome: { subject: string; html: string; text: string };
};
const SETTINGS = { senderName: 'Verebona', replyToEmail: 'support@verebona.com', footerText: null, logoUrl: null };
const MFA = NOTIFICATION_CATALOG.MFA_SECURITY_EVENT!;
/** 13/11/2026 17 h 06 à Paris (heure d'hiver, UTC+1). */
const AT = '2026-11-13T16:06:00.000Z';
const QUAND = 'le 13 novembre 2026 à 17 h 06 (heure de Paris)';
const LIEN = `https://app.exemple.fr${MFA_SECURITY_CTA_LINK}`;

const PASSKEY = S.SECURITY_NOTIFICATION_TEMPLATES.NOTIF_MFA_PASSKEY_ADDED;
const TOTP = S.SECURITY_NOTIFICATION_TEMPLATES.NOTIF_MFA_TOTP_ENABLED;
const MODELES: Array<[string, { subject: string; body: string }]> = [['clé d’accès ajoutée', PASSKEY], ['TOTP activé', TOTP]];

/** Texte visible d'un document (sans <head>, commentaires ni balises). */
const visible = (html: string) => html
  .replace(/<head[\s\S]*?<\/head>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Contraste WCAG 2.x de deux couleurs #RRGGBB. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const render = (tpl: { subject: string; body: string }, variables: Record<string, string> = { eventWhen: QUAND, actionUrl: LIEN }) =>
  emailService.renderTemplate(tpl, variables, SETTINGS);

beforeAll(() => { seeded.clear(); sent.length = 0; });
afterAll(() => { vi.useRealTimers(); });

describe('L114M-01 — catalogue : deux gabarits dédiés, date réelle, lien de sécurité', () => {
  it.each([
    ['passkey_added', 'notif_mfa_passkey_added'],
    ['totp_enabled', 'notif_mfa_totp_enabled'],
  ])('%s → gabarit %s, date de l’événement, repli déclaré', (event, code) => {
    const r = mfaSecurityContent({ event, at: AT });
    expect(r.emailTemplateCode).toBe(code);
    expect(r.emailVariables).toEqual({ eventWhen: QUAND });
    expect(r.emailFallbackTemplateCode).toBe('notif_security');
    expect(MFA.deepLink({ event, at: AT })).toBe('/mon-compte?ouvrir=securite#securite');
    // Titre et texte de repli toujours composés (gabarit `notif_security`).
    expect(r.bellTitle.length).toBeGreaterThan(0);
    expect(r.bellBody).toContain('13 novembre 2026 à 17 h 06');
  });

  it('codes des gabarits : deux gabarits DISTINCTS', () => {
    expect(PASSKEY_ADDED_TEMPLATE_CODE).toBe('notif_mfa_passkey_added');
    expect(TOTP_ENABLED_TEMPLATE_CODE).toBe('notif_mfa_totp_enabled');
    expect(PASSKEY.body).not.toBe(TOTP.body);
    expect(PASSKEY.subject).not.toBe(TOTP.subject);
  });

  it('date : horodatage UTC converti en heure de Paris, été comme hiver ; jamais la date d’envoi', () => {
    expect(formatSecurityEventWhen('2026-11-13T16:06:00.000Z')).toBe('le 13 novembre 2026 à 17 h 06 (heure de Paris)');
    expect(formatSecurityEventWhen('2026-11-13T16:05:00.000Z')).toBe('le 13 novembre 2026 à 17 h 05 (heure de Paris)');
    // Heure d'été (UTC+2).
    expect(formatSecurityEventWhen('2026-07-01T15:05:00.000Z')).toBe('le 1 juillet 2026 à 17 h 05 (heure de Paris)');
    // Passage de minuit : le JOUR est celui de Paris.
    expect(formatSecurityEventWhen('2026-12-31T23:30:00.000Z')).toBe('le 1 janvier 2027 à 00 h 30 (heure de Paris)');
    // L'horloge du test est figée au 13/11 12:00 UTC : la date rendue est bien celle de l'événement.
    expect(formatSecurityEventWhen('2026-03-02T08:00:00.000Z')).toContain('2 mars 2026 à 09 h 00');
  });

  it('données manquantes : aucune date inventée', () => {
    for (const at of [undefined, null, '', 'pas-une-date', 42]) {
      expect(formatSecurityEventWhen(at)).toBe('récemment');
    }
    const r = mfaSecurityContent({ event: 'passkey_added' });
    expect(r.emailTemplateCode).toBe('notif_mfa_passkey_added');
    expect(r.emailVariables).toEqual({ eventWhen: 'récemment' });
  });

  it('événement inconnu ou propriété héritée : jamais un gabarit dédié', () => {
    for (const event of ['constructor', 'toString', '__proto__', 'inconnu', 7, undefined]) {
      const r = mfaSecurityContent({ event, at: AT });
      expect(r.emailTemplateCode).toBe('notif_security');
      expect(r.emailVariables).toBeUndefined();
      expect(MFA.deepLink({ event, at: AT })).toBe('/mon-compte#securite');
    }
  });

  it('règles de notification INCHANGÉES (obligation, canaux, schéma)', () => {
    expect(MFA).toMatchObject({
      category: 'security', priority: 'high', deliveryMode: 'immediate',
      mandatoryEmail: true, mandatoryBell: false, neverBell: false, defaults: { push: false, email: true }, retentionDays: 365,
    });
    expect(MFA.retiredChannels?.email).toBeUndefined();
    expect(MFA.payloadSchema.safeParse({ event: 'passkey_added', at: AT }).success).toBe(true);
    expect(MFA.payloadSchema.safeParse({ event: 'autre', at: AT }).success).toBe(false);
  });

  it('un seul point d’émission, aucun envoi ajouté', () => {
    const notify = read('src/lib/auth/mfa/notify.ts');
    expect(notify.match(/await emit\(/g)).toHaveLength(1);
    expect(notify).toContain("type: 'MFA_SECURITY_EVENT'");
    // Le gabarit dédié n'est jamais envoyé directement par un autre module.
    for (const f of ['src/lib/auth/mfa/enrollment.ts', 'src/app/api/users/me/security/mfa/passkeys/route.ts', 'src/app/api/users/me/security/mfa/totp/route.ts']) {
      expect(read(f)).not.toMatch(/notif_mfa_|emailService/);
    }
  });

  it('éditeur du BO : gabarits décrits, rattachés à l’événement, e-mail non désactivable', () => {
    expect(E.NOTIFICATION_EMAIL_TEMPLATES.NOTIF_MFA_PASSKEY_ADDED).toMatchObject({ events: ['MFA_SECURITY_EVENT'], previewPayload: { event: 'passkey_added' } });
    expect(E.NOTIFICATION_EMAIL_TEMPLATES.NOTIF_MFA_TOTP_ENABLED).toMatchObject({ events: ['MFA_SECURITY_EVENT'], previewPayload: { event: 'totp_enabled' } });
    expect(E.NOTIFICATION_EMAIL_TEMPLATES.NOTIF_SECURITY.events).toContain('MFA_SECURITY_EVENT');
    // Données d'exemple de l'aperçu : acceptées par le schéma, rendues par le bon gabarit.
    for (const [code, tpl] of [['NOTIF_MFA_PASSKEY_ADDED', 'notif_mfa_passkey_added'], ['NOTIF_MFA_TOTP_ENABLED', 'notif_mfa_totp_enabled']] as const) {
      const payload = { ...E.NOTIFICATION_EMAIL_TEMPLATES[code].previewPayload, at: AT };
      expect(MFA.payloadSchema.safeParse(payload).success).toBe(true);
      expect(renderContent(MFA, payload).emailTemplateCode).toBe(tpl);
    }
  });
});

describe('L114M-02 — textes du ticket, événement exact, aucun secret', () => {
  it('clé d’accès ajoutée : objet, pré-en-tête, titre et textes du ticket (§2)', () => {
    expect(PASSKEY.subject).toBe("Une clé d'accès a été ajoutée à votre compte Verebona");
    expect(S.PASSKEY_ADDED_SPEC.preheader).toBe("Vérifiez cet ajout si vous n'en êtes pas à l'origine.");
    expect(S.PASSKEY_ADDED_SPEC.headerLabel).toBe('Notification de sécurité');
    expect(S.PASSKEY_ADDED_SPEC.h1).toBe("Une nouvelle clé d'accès a été ajoutée");
    const v = visible(PASSKEY.body);
    for (const t of [
      "Une clé d'accès a été enregistrée sur votre compte Verebona {{eventWhen}}.",
      "Vous êtes à l'origine de cet ajout ?",
      "Aucune action n'est nécessaire.",
      'Vous ne reconnaissez pas cet ajout ?',
      'Vérifiez immédiatement les méthodes de connexion associées à votre compte :',
      "Supprimez toute clé d'accès inconnue.",
      "Déconnectez les appareils/sessions suspects si l'application permet de le faire.",
      'Changez votre mot de passe.',
      'Vérifier la sécurité de mon compte',
      'Vous pouvez également ouvrir Verebona directement et accéder à Mon compte > Sécurité.',
      "Besoin d'aide ? Contactez l'assistance Verebona.",
      '© {{year}} Verebona',
    ]) expect(v, t).toContain(t);
  });

  it('TOTP activé : objet, pré-en-tête, titre et textes du ticket (§2 bis)', () => {
    expect(TOTP.subject).toBe("Une application d'authentification a été activée sur votre compte Verebona");
    expect(S.TOTP_ENABLED_SPEC.preheader).toBe("Si vous n'êtes pas à l'origine de cette activation, vérifiez la sécurité de votre compte.");
    expect(S.TOTP_ENABLED_SPEC.h1).toBe("Application d'authentification activée");
    const v = visible(TOTP.body);
    for (const t of [
      "Une application d'authentification a été activée sur votre compte Verebona {{eventWhen}}.",
      "Vous êtes à l'origine de cette activation ?",
      "Aucune action n'est nécessaire.",
      'Vous ne reconnaissez pas cette activation ?',
      'Ouvrez Verebona, puis Mon compte > Sécurité.',
      "Vérifiez les méthodes de connexion et désactivez la méthode d'authentification inconnue.",
      'Vérifiez les appareils ou sessions suspects et révoquez-les si cette fonction existe.',
      'Changez votre mot de passe.',
      "Si vous ne parvenez pas à sécuriser votre compte, contactez l'assistance Verebona.",
      'Vérifier la sécurité de mon compte',
      "Besoin d'aide ? Contactez l'assistance Verebona.",
      '© {{year}} Verebona',
    ]) expect(v, t).toContain(t);
  });

  it('CA01 : aucun mélange entre les deux événements, ni avec une connexion ou une réinitialisation', () => {
    const p = `${PASSKEY.subject} ${visible(PASSKEY.body)}`;
    const t = `${TOTP.subject} ${visible(TOTP.body)}`;
    expect(p).not.toMatch(/application d'authentification|TOTP/i);
    expect(t).not.toMatch(/clé d'accès|passkey/i);
    for (const x of [p, t]) {
      expect(x).not.toMatch(/réinitialis|nouvelle connexion|nouvel appareil|récupération/i);
      expect(x).not.toContain('Sécurité de votre compte');
      expect(x).not.toMatch(/Opération/);
    }
  });

  it('CA02 / CA03 : la méthode inconnue est retirée AVANT le mot de passe, jamais le mot de passe seul', () => {
    const steps = (spec: typeof S.PASSKEY_ADDED_SPEC) => spec.sections[1].steps ?? [];
    const p = steps(S.PASSKEY_ADDED_SPEC);
    expect(p.findIndex((s) => /Supprimez toute clé d'accès inconnue/.test(s))).toBeLessThan(p.findIndex((s) => /mot de passe/.test(s)));
    expect(p.findIndex((s) => /appareils\/sessions suspects/.test(s))).toBeLessThan(p.findIndex((s) => /mot de passe/.test(s)));
    const t = steps(S.TOTP_ENABLED_SPEC);
    expect(t.findIndex((s) => /désactivez la méthode d'authentification inconnue/.test(s))).toBeLessThan(t.findIndex((s) => /mot de passe/.test(s)));
    for (const spec of [S.PASSKEY_ADDED_SPEC, S.TOTP_ENABLED_SPEC]) {
      // Deux sous-sections distinctes, la seconde avec une marche à suivre numérotée.
      expect(spec.sections).toHaveLength(2);
      expect(spec.sections[0].heading).toMatch(/^Vous êtes à l'origine/);
      expect(spec.sections[1].heading).toMatch(/^Vous ne reconnaissez pas/);
      expect((spec.sections[1].steps ?? []).length).toBeGreaterThanOrEqual(3);
      // Recours quand la remédiation autonome échoue.
      expect(spec.sections[1].after?.join(' ')).toMatch(/contactez l'assistance Verebona/);
      // Aucune promesse : ni « suffit », ni « invalide », ni « désactive automatiquement ».
      expect(JSON.stringify(spec)).not.toMatch(/suffit|invalide|automatiquement|sera supprimée|sera désactivé/i);
    }
  });

  it('aucun secret ni donnée d’authentification : variables limitées, pas de code, de QR ni d’identifiant de clé', () => {
    for (const [, tpl] of MODELES) {
      expect(E.extractVariables(`${tpl.subject}\n${tpl.body}`).sort()).toEqual(['actionUrl', 'eventWhen', 'logoUrl', 'supportEmail', 'year']);
      // Objet : aucune variable (ni date, ni identifiant).
      expect(E.extractVariables(tpl.subject)).toEqual([]);
      expect(visible(tpl.body)).not.toMatch(/\bcode\b|QR|secret|otpauth|jeton|token|identifiant/i);
      expect(tpl.body).not.toMatch(/otpauth:|data:image/i);
    }
  });
});

describe('L114M-03 — gabarit transactionnel commun', () => {
  it.each(MODELES)('%s : une colonne ≤ 600 px fluide, en-tête court, un cadre, un H1, un bouton', (_n, tpl) => {
    const b = tpl.body;
    expect(L.isTransactionalLayout(b)).toBe(true);
    expect(b).toContain('width:100%;max-width:600px;');
    expect(b).not.toMatch(/(^|[^-])width:600px/);
    // Outlook : table fantôme de 600 px.
    expect(b).toContain('<!--[if mso]><table role="presentation" width="600"');
    // En-tête : logo et libellé sur une ligne, sans filet ni grand espace.
    expect(b).toContain('padding:20px 24px 0 24px;');
    expect(b).not.toMatch(/class="[^"]*vb-head/);
    expect(b).not.toContain('border-bottom');
    expect(b).toContain('>Notification de sécurité</td>');
    // Un seul cadre (la carte).
    expect(b.match(/border:1px solid #D5DEDC/g)).toHaveLength(1);
    // Marges internes de 24 px ; aucune marge de 40 px.
    expect(b).not.toMatch(/padding:[^;"]*40px/);
    expect(b.match(/<h1\b/g)).toHaveLength(1);
    expect(b.match(/class="vb-btn"/g)).toHaveLength(1);
    expect(b).toMatch(/<a class="vb-btn" href="\{\{actionUrl\}\}"/);
    // Titre 24 px, texte courant 16 px, interligne 1,6.
    expect(b).toMatch(/<h1 style="[^"]*font-size:24px/);
    expect(b).toMatch(/<p style="[^"]*font-size:16px;line-height:1\.6/);
    // Liste numérotée réservée aux actions.
    expect(b.match(/<ol\b/g)).toHaveLength(1);
    expect(b).not.toMatch(/<ul\b/);
  });

  it.each(MODELES)('%s : HTML d’e-mail robuste (tableaux, styles en ligne, mode sombre, pré-en-tête masqué)', (_n, tpl) => {
    const b = tpl.body;
    expect(b.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(b).not.toMatch(/var\(--|<script|<link\b|@import|fonts\.googleapis/i);
    expect(b).not.toContain('@font-face');
    for (const m of b.matchAll(/<table\b[^>]*>/g)) expect(m[0]).toContain('role="presentation"');
    expect(b).toContain('<meta name="color-scheme" content="light dark">');
    expect(b).toContain('@media (prefers-color-scheme: dark)');
    expect(b).toContain('[data-ogsc] .vb-card');
    expect(b).toMatch(/<div data-vb-preheader="1" style="display:none;[^"]*max-height:0;[^"]*overflow:hidden;[^"]*mso-hide:all;/);
    // Aucune image de contenu : seul le logo ({{logoUrl}}), aucun texte important en image.
    expect(b).not.toMatch(/<img\b/);
    expect(b.match(/\{\{logoUrl\}\}/g)).toHaveLength(1);
    // Liens : le bouton et l'adresse d'assistance, rien d'autre ; aucun domaine écrit en dur.
    expect([...b.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(['{{actionUrl}}', 'mailto:{{supportEmail}}']);
    expect(b).not.toMatch(/verebona\.(com|fr)/i);
  });

  it('accepté tel quel par l’éditeur du BO (format, variables, liens)', () => {
    for (const [code, tpl] of Object.entries(S.SECURITY_NOTIFICATION_TEMPLATES)) {
      expect(E.templateFormat(tpl.body)).toBe('html');
      const spec = E.variableSpecFor(code, { format: 'html' });
      expect(spec.declared).toBe(true);
      expect(spec.required.map((g) => g.anyOf)).toEqual([['actionUrl'], ['eventWhen']]);
      expect(E.validateDraft({ code, subject: tpl.subject, body: tpl.body, format: 'html', spec })).toEqual([]);
      expect(E.scanHtmlBody(tpl.body)).toEqual([]);
      // Retirer le lien de sécurité est refusé.
      const sansLien = tpl.body.replace('href="{{actionUrl}}"', 'href="https://app.exemple.fr/"');
      expect(E.validateDraft({ code, subject: tpl.subject, body: sansLien, format: 'html', spec }).map((i) => i.code)).toContain('REQUIRED_VARIABLE_MISSING');
    }
    expect(T.EMAIL_HTML_TEMPLATES_CURRENT.NOTIF_MFA_PASSKEY_ADDED).toBe(PASSKEY.body);
    expect(T.EMAIL_HTML_TEMPLATES_CURRENT.NOTIF_MFA_TOTP_ENABLED).toBe(TOTP.body);
  });

  it('contraste (WCAG AA) en clair et en sombre', () => {
    const C = L.EMAIL_COLORS;
    // Clair : texte, titre et texte secondaire sur la carte ; pied sur le fond ; bouton ; lien.
    expect(contrast(C.encre, C.blanc)).toBeGreaterThanOrEqual(7);
    expect(contrast(C.petrole, C.blanc)).toBeGreaterThanOrEqual(7);
    expect(contrast(C.gris, C.blanc)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(C.gris, C.ivoire)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#FFFFFF', C.petrole)).toBeGreaterThanOrEqual(7);
    expect(contrast(C.petrole, C.ivoire)).toBeGreaterThanOrEqual(7);
    // Sombre : texte et texte secondaire sur la carte ; pied et lien sur le fond ; bouton.
    expect(contrast(C.dark.text, C.dark.card)).toBeGreaterThanOrEqual(7);
    expect(contrast(C.dark.muted, C.dark.card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(C.dark.muted, C.dark.page)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(C.dark.accent, C.dark.page)).toBeGreaterThanOrEqual(7);
    expect(contrast(C.dark.onAccent, C.dark.accent)).toBeGreaterThanOrEqual(7);
  });

  it('le gabarit est RÉUTILISABLE : un autre e-mail se construit sans dupliquer de HTML', () => {
    const autre = buildTransactionalEmailHtml({
      documentTitle: 'Exemple', preheader: 'Aperçu', headerLabel: 'Votre compte', h1: 'Titre <unique> & net',
      intro: ['Bonjour {{firstName}},'], sections: [{ heading: 'Section', paragraphs: ['Texte.'] }],
      cta: { href: '{{actionUrl}}', label: 'Agir' }, footer: { help: 'Aide', supportEmailVariable: 'supportEmail', copyright: '© {{year}} Verebona' },
    });
    expect(L.isTransactionalLayout(autre)).toBe(true);
    expect(autre).toContain('Titre &lt;unique&gt; &amp; net');
    expect(autre).not.toMatch(/<ol\b/);
    // Même enveloppe que les deux e-mails de sécurité (hors contenu).
    const coque = (h: string) => h.slice(0, h.indexOf('<h1')).replace(/<title>[^<]*<\/title>/, '').replace(/data-vb-preheader="1"[^>]*>[^<]*</, '').replace(/>[^<>]*<\/td>\s*<\/tr><\/table>\s*<\/td>/, '');
    expect(coque(PASSKEY.body)).toBe(coque(TOTP.body));
    expect(coque(autre).length).toBe(coque(PASSKEY.body).length);
    // Aucune enveloppe recopiée dans le module des deux e-mails.
    const src = read('src/lib/email/security-notification-templates.ts');
    expect(src).not.toMatch(/<table|<html|style=/);
  });
});

describe('L114M-04 — rendu réel : HTML et texte brut', () => {
  it.each(MODELES)('%s : HTML envoyé — logo compact avec alt, date, lien, assistance des réglages', async (_n, tpl) => {
    const r = await render(tpl);
    expect(r.subject).toBe(tpl.subject);
    expect(r.unresolved).toEqual([]);
    expect(r.missingLinks).toEqual([]);
    expect(r.html).not.toMatch(/\{\{|\}\}/);
    // Logo hébergé par l'application, 120 × 30, texte alternatif (images bloquées : « Verebona » reste lu).
    const logos = [...r.html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(logos).toHaveLength(2);
    for (const img of logos) {
      expect(img).toContain('alt="Verebona"');
      expect(img).toContain('width="120" height="30"');
      expect(img).toMatch(/src="https:\/\/app\.exemple\.fr\/brand\/verebona-logo-email(-dark)?\.png\?v=2026"/);
    }
    expect(r.html).not.toContain('width="160"');
    expect(r.html).not.toContain('width:240px');
    expect(r.html).toContain(`sur votre compte Verebona ${QUAND}.`);
    expect(r.html).toContain(`<a class="vb-btn" href="${LIEN}"`);
    expect(r.html).toContain('<a class="vb-link" href="mailto:support@verebona.com"');
    expect(r.html).toContain('© 2026 Verebona');
    // Tous les liens : application (HTTPS, sans jeton) ou assistance.
    for (const m of r.html.matchAll(/href="([^"]*)"/g)) expect(m[1]).toMatch(/^(https:\/\/app\.exemple\.fr\/mon-compte\?ouvrir=securite#securite|mailto:support@verebona\.com)$/);
    expect(r.html).not.toMatch(/token=|code=|[?&]t=/i);
  });

  it('clé d’accès ajoutée : version TEXTE BRUT lisible, complète, sans balise ni feuille de style', async () => {
    const r = await render(PASSKEY);
    expect(r.text).toBe([
      'Verebona — Notification de sécurité',
      '',
      "Une nouvelle clé d'accès a été ajoutée",
      '',
      `Une clé d'accès a été enregistrée sur votre compte Verebona ${QUAND}.`,
      '',
      "Vous êtes à l'origine de cet ajout ?",
      '',
      "Aucune action n'est nécessaire.",
      '',
      'Vous ne reconnaissez pas cet ajout ?',
      '',
      'Vérifiez immédiatement les méthodes de connexion associées à votre compte :',
      '',
      "1. Supprimez toute clé d'accès inconnue.",
      "2. Déconnectez les appareils/sessions suspects si l'application permet de le faire.",
      '3. Changez votre mot de passe.',
      '',
      "Si vous ne parvenez pas à sécuriser votre compte, contactez l'assistance Verebona.",
      '',
      `Vérifier la sécurité de mon compte : ${LIEN}`,
      '',
      'Vous pouvez également ouvrir Verebona directement et accéder à Mon compte > Sécurité.',
      '',
      "Besoin d'aide ? Contactez l'assistance Verebona.",
      '',
      'support@verebona.com',
      '',
      '© 2026 Verebona',
    ].join('\n'));
  });

  it('TOTP activé : version TEXTE BRUT lisible, complète, sans balise ni feuille de style', async () => {
    const r = await render(TOTP);
    expect(r.text).toBe([
      'Verebona — Notification de sécurité',
      '',
      "Application d'authentification activée",
      '',
      `Une application d'authentification a été activée sur votre compte Verebona ${QUAND}.`,
      '',
      "Vous êtes à l'origine de cette activation ?",
      '',
      "Aucune action n'est nécessaire.",
      '',
      'Vous ne reconnaissez pas cette activation ?',
      '',
      '1. Ouvrez Verebona, puis Mon compte > Sécurité.',
      "2. Vérifiez les méthodes de connexion et désactivez la méthode d'authentification inconnue.",
      '3. Vérifiez les appareils ou sessions suspects et révoquez-les si cette fonction existe.',
      '4. Changez votre mot de passe.',
      '',
      "Si vous ne parvenez pas à sécuriser votre compte, contactez l'assistance Verebona.",
      '',
      `Vérifier la sécurité de mon compte : ${LIEN}`,
      '',
      'Vous pouvez également ouvrir Verebona directement et accéder à Mon compte > Sécurité.',
      '',
      "Besoin d'aide ? Contactez l'assistance Verebona.",
      '',
      'support@verebona.com',
      '',
      '© 2026 Verebona',
    ].join('\n'));
    expect(r.text).not.toMatch(/[<{}]|color-scheme|font-family/);
    // Pré-en-tête : aperçu de la boîte de réception, absent du corps texte.
    expect(r.text).not.toContain(S.TOTP_ENABLED_SPEC.preheader);
  });

  it('adresse d’assistance : celle des réglages e-mail, jamais une adresse fournie par l’appelant', async () => {
    const r = await emailService.renderTemplate(PASSKEY, { eventWhen: QUAND, actionUrl: LIEN, supportEmail: 'pirate@exemple.org' }, { ...SETTINGS, replyToEmail: 'assistance@exemple.fr' });
    expect(r.html).toContain('href="mailto:assistance@exemple.fr"');
    expect(r.text).toContain('\nassistance@exemple.fr\n');
    expect(`${r.html}${r.text}`).not.toContain('pirate@exemple.org');
  });

  it('valeurs hostiles neutralisées (HTML et texte) ; un lien qui n’est pas une URL n’est jamais un href actif', async () => {
    const r = await render(PASSKEY, { eventWhen: '<img src=x onerror=alert(1)> le 13', actionUrl: LIEN });
    expect(r.html).not.toMatch(/<img src=x|onerror/);
    expect(r.text).not.toMatch(/<img/);
    const lien = await render(PASSKEY, { eventWhen: QUAND, actionUrl: 'javascript:alert(1)' });
    expect(lien.html).not.toMatch(/href="javascript:/i);
  });

  it('données manquantes : « récemment », phrase correcte, aucune accolade', async () => {
    const c = mfaSecurityContent({ event: 'totp_enabled' });
    const r = await render(TOTP, { ...(c.emailVariables ?? {}), actionUrl: LIEN });
    expect(r.text).toContain("Une application d'authentification a été activée sur votre compte Verebona récemment.");
    expect(`${r.html}${r.text}`).not.toMatch(/\{\{|undefined|null|NaN|Invalid Date/);
  });

  it('conversion texte : gabarit retouché au BO (zone de texte modifiée) toujours lisible', () => {
    const retouche = TOTP.body.replace('Changez votre mot de passe.', 'Changez votre mot de passe &amp; vérifiez vos codes.');
    const t = transactionalHtmlToText(retouche);
    expect(t).toContain('4. Changez votre mot de passe & vérifiez vos codes.');
    expect(t).not.toMatch(/<|&amp;/);
  });
});

describe('L114M-05 — non-régression : rendus IDENTIQUES à l’état livré lot114-02', () => {
  it('enveloppe du lot 66C et logo : à l’octet près', () => {
    expect(L.emailDocument({ title: 'T', content: '<p>C</p>', footer: '<p>F</p>', baseUrl: 'https://app.exemple.fr' })).toBe(AVANT.document);
    expect(L.emailDocument({ title: 'T', content: '<p>C</p>', footer: '<p>F</p>', logo: '{{logoUrl}}', baseUrl: '', fontFace: false })).toBe(AVANT.documentStored);
    expect(L.emailLogoHtml('https://app.exemple.fr')).toBe(AVANT.logo);
    expect(L.isTransactionalLayout(AVANT.documentStored)).toBe(false);
  });

  it.each(['passkey_removed', 'totp_replaced', 'totp_removed', 'recovery_regenerated', 'recovery_used'])(
    '%s : contenu, lien, objet, HTML et texte inchangés (gabarit notif_security)', async (event) => {
      const payload = { event, at: AT };
      const c = MFA.render(payload as never);
      const avant = AVANT.mfa[event];
      expect(c).toEqual(avant.content);
      expect(c.emailTemplateCode).toBe('notif_security');
      expect(MFA.deepLink(payload as never)).toBe(avant.href);
      const r = await emailService.renderTemplate(
        { subject: 'Sécurité de votre compte', body: '{{body}}\n\nAccéder à Verebona : {{actionUrl}}' },
        { title: c.bellTitle, body: c.bellBody, actionUrl: `https://app.exemple.fr${avant.href}` }, SETTINGS,
      );
      expect({ subject: r.subject, html: r.html, text: r.text }).toEqual({ subject: avant.subject, html: avant.html, text: avant.text });
    },
  );

  it('gabarit HTML complet existant (bienvenue) : objet, HTML et texte inchangés', async () => {
    const r = await emailService.renderTemplate({ subject: 'Bienvenue sur Verebona', body: T.WELCOME_HTML }, { firstName: 'Camille', loginUrl: 'https://app.exemple.fr/login' }, SETTINGS);
    expect({ subject: r.subject, html: r.html, text: r.text }).toEqual(AVANT.welcome);
    // {{supportEmail}} n'est posé que pour le gabarit commun.
    const s = await emailService.renderTemplate({ subject: 'x', body: 'Écrire à {{supportEmail}}' }, {}, SETTINGS);
    expect(s.unresolved).toEqual(['supportEmail']);
  });

  it('le gabarit notif_security et les migrations antérieures ne sont pas modifiés', () => {
    expect(read('src/db/migrations/0077_notification_email_templates.sql')).toContain("('notif_security', 'Sécurité de votre compte', E'{{body}}\\n\\nAccéder à Verebona : {{actionUrl}}'");
    const mig = read('src/db/migrations/1698_l114m_emails_securite_gabarit_commun.sql');
    expect(mig).not.toMatch(/^\s*(UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/im);
  });
});

describe('L114M-06 — migration 1698', () => {
  const mig = read('src/db/migrations/1698_l114m_emails_securite_gabarit_commun.sql');
  const rows = [...mig.matchAll(/\('(notif_mfa_[a-z_]+)',\s*'((?:[^']|'')*)',\s*\$l114m\$([\s\S]*?)\$l114m\$,\s*'([^']*)', NOW\(\)\)\s*ON CONFLICT \(type\) DO NOTHING;/g)];

  it('deux insertions idempotentes, corps = module partagé à l’octet près', () => {
    expect(rows).toHaveLength(2);
    expect(mig.match(/^INSERT INTO email_templates/gm)).toHaveLength(2);
    expect(mig.match(/ON CONFLICT \(type\) DO NOTHING;/g)).toHaveLength(2);
    for (const [, type, subject, body, placeholders] of rows) {
      const tpl = S.SECURITY_NOTIFICATION_TEMPLATES[type.toUpperCase()];
      expect(tpl, type).toBeTruthy();
      expect(subject.replace(/''/g, "'")).toBe(tpl.subject);
      expect(body).toBe(tpl.body);
      expect(JSON.parse(placeholders).sort()).toEqual(E.extractVariables(tpl.body).sort());
    }
    expect(rows.map((r) => r[1]).sort()).toEqual([PASSKEY_ADDED_TEMPLATE_CODE, TOTP_ENABLED_TEMPLATE_CODE].sort());
  });

  it('additive : aucune table, aucune colonne, aucun autre gabarit touché', () => {
    const sql = mig.replace(/^--.*$/gm, '').replace(/\$l114m\$[\s\S]*?\$l114m\$/g, "''");
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(sql).not.toContain('notif_security');
  });
});

describe('L114M-07 — lien du bouton et ouverture de la section Sécurité', () => {
  it('lien interne, sans jeton, conservé par le retour de connexion et par le lien d’espace', () => {
    expect(MFA_SECURITY_CTA_LINK).toBe('/mon-compte?ouvrir=securite#securite');
    // Non connecté : le serveur ne reçoit pas l'ancre ; `returnUrl` garde le paramètre.
    expect(safeReturnUrl('/mon-compte?ouvrir=securite')).toBe('/mon-compte?ouvrir=securite');
    expect(withSpaceParam(MFA_SECURITY_CTA_LINK, 12)).toBe('/mon-compte?ouvrir=securite&space=12#securite');
    expect(anchorFromOpenParam('?ouvrir=securite&space=12', '', ['securite'])).toBe('securite');
  });

  it('liste FERMÉE : aucune valeur libre, l’ancre présente prime', () => {
    expect(OPEN_SECTION_PARAM).toBe('ouvrir');
    expect(anchorFromOpenParam('?ouvrir=securite', '', ['securite'])).toBe('securite');
    expect(anchorFromOpenParam('?ouvrir=securite', '#', ['securite'])).toBe('securite');
    expect(anchorFromOpenParam('?ouvrir=securite', '#appareils-connectes', ['securite'])).toBeNull();
    expect(anchorFromOpenParam('?ouvrir=securite', '#securite', ['securite'])).toBeNull();
    for (const s of ['', '?ouvrir=', '?ouvrir=zone-dangereuse', '?ouvrir=javascript:alert(1)', '?ouvrir=//exemple.org', '?autre=securite']) {
      expect(anchorFromOpenParam(s, '', ['securite']), s).toBeNull();
    }
  });

  it('la carte Sécurité rétablit l’ancre sans nouvelle entrée d’historique', () => {
    const card = read('src/components/account/security/SecurityCard.tsx');
    expect(card).toContain("export const SECURITY_ANCHOR = 'securite';");
    expect(card).toContain('anchorId={SECURITY_ANCHOR}');
    expect(card).toContain('anchorFromOpenParam(window.location.search, window.location.hash, [SECURITY_ANCHOR])');
    expect(card).toContain('window.location.replace(`#${anchor}`)');
  });
});

describe('L114M-08 — canal e-mail : gabarit dédié, sinon repli, jamais deux envois', () => {
  const ctx = { outboxId: 'ob-1', userId: 7, eventType: 'MFA_SECURITY_EVENT', category: 'security', payload: {}, dedupeKey: 'k', mustDeliverBell: false, accountId: null };
  const spy = () => vi.spyOn(emailService, 'send').mockImplementation(async (o) => {
    sent.push({ templateCode: o.templateCode, variables: o.variables });
    return { success: true, providerMessageId: 'simule' };
  });

  it.each([
    ['passkey_added', 'notif_mfa_passkey_added'],
    ['totp_enabled', 'notif_mfa_totp_enabled'],
  ])('%s : gabarit dédié en base → un seul envoi, variables sans secret', async (event, code) => {
    seeded.clear(); seeded.add(code); seeded.add('notif_security'); sent.length = 0;
    const s = spy();
    const payload = { event, at: AT };
    const o = await deliverEmail({ ...ctx, payload }, MFA, renderContent(MFA, payload));
    s.mockRestore();
    expect(o.status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].templateCode).toBe(code);
    expect(sent[0].variables).toEqual({
      eventWhen: QUAND, actionUrl: LIEN,
      title: expect.any(String), body: expect.any(String),
    });
  });

  it('gabarit dédié absent (migration non appliquée) → repli notif_security, un seul envoi', async () => {
    seeded.clear(); seeded.add('notif_security'); sent.length = 0;
    const s = spy();
    const payload = { event: 'passkey_added', at: AT };
    const o = await deliverEmail({ ...ctx, payload }, MFA, renderContent(MFA, payload));
    s.mockRestore();
    expect(o.status).toBe('sent');
    expect(sent.map((x) => x.templateCode)).toEqual(['notif_security']);
  });

  it('aucun gabarit en base → ignoré proprement, aucun envoi (comportement antérieur)', async () => {
    seeded.clear(); sent.length = 0;
    const s = spy();
    const payload = { event: 'totp_enabled', at: AT };
    const o = await deliverEmail({ ...ctx, payload }, MFA, renderContent(MFA, payload));
    s.mockRestore();
    expect(o).toEqual({ status: 'skipped_unavailable', errorCode: 'template_not_seeded' });
    expect(sent).toEqual([]);
  });

  it('événement sans gabarit dédié : notif_security, aucune variable ajoutée', async () => {
    seeded.clear(); seeded.add('notif_security'); sent.length = 0;
    const s = spy();
    const payload = { event: 'totp_removed', at: AT };
    await deliverEmail({ ...ctx, payload }, MFA, renderContent(MFA, payload));
    s.mockRestore();
    expect(sent).toHaveLength(1);
    expect(sent[0].templateCode).toBe('notif_security');
    expect(Object.keys(sent[0].variables).sort()).toEqual(['actionUrl', 'body', 'title']);
    expect(sent[0].variables.actionUrl).toBe('https://app.exemple.fr/mon-compte#securite');
  });
});
