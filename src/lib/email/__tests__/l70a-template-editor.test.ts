/**
 * Lot 70A — éditeur des modèles d'e-mails transactionnels (BO), règles PURES.
 *
 * MAIL-ED-01 Zones des gabarits HTML livrés : aller-retour à l'octet près,
 *            seule la zone modifiée change, liens / structure intacts.
 * MAIL-ED-02 Déclaration des variables : couvre TOUS les textes livrés (base au
 *            lot 65, défauts du code, J−7 de la 0477) — enregistrer le texte
 *            livré tel quel n'est jamais refusé.
 * MAIL-ED-03 Variable inconnue → refus.
 * MAIL-ED-04 Variable obligatoire retirée → refus (lien d'action, vérification,
 *            portail, montant / date du J−7, mentions du contrat).
 * MAIL-ED-05 Contenu assaini : script, on*, javascript:, balises non admises,
 *            « < » dans une zone, libellé de bouton vide, lien non http(s).
 * MAIL-ED-06 Objet : injection d'en-tête (CR/LF), longueur, balise, lien.
 * MAIL-ED-07 Gabarits légaux verrouillés ; verrou « non désactivable » distinct.
 * MAIL-ED-08 Comparaison simple (lignes) et texte comparable.
 * MAIL-ED-09 Rendu d'envoi : aucune variable non remplacée, objet sur une ligne,
 *            gabarit texte mis en page à la charte.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_LOCKED_TEMPLATES,
  applyHtmlZones,
  comparableText,
  contentLockReason,
  diffLines,
  extractHtmlZones,
  extractVariables,
  hasDeclaredVariables,
  isAllowedLink,
  limitedEditReason,
  scanHtmlBody,
  templateFormat,
  validateDraft,
  validateSubject,
  variableSpecFor,
} from '../template-editor';
import { EMAIL_HTML_TEMPLATES_L66, WELCOME_HTML, ACCOUNT_INVITATION_HTML } from '../email-html-templates';
import { DEFAULT_EMAIL_TEMPLATES } from '../../email-defaults';
import { transactionalLockReason } from '../../notifications/channel-activation';
import { emailService, sanitizeSubjectHeader, stripUnresolvedPlaceholders } from '../email-service';

const LOT65 = JSON.parse(readFileSync(join(process.cwd(), 'src/lib/email/__tests__/fixtures/l66c-email-lot65.json'), 'utf8')) as {
  db: Record<string, { subject: string; body: string }>;
};
const J7 = (() => {
  const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0477_annual_renewal_reminder.sql'), 'utf8');
  return {
    subject: /\$l68c_subject\$([\s\S]*?)\$l68c_subject\$/.exec(sql)![1],
    body: /\$l68c_body\$([\s\S]*?)\$l68c_body\$/.exec(sql)![1],
  };
})();

const spec = (type: string, body: string, subject = '') =>
  variableSpecFor(type, { format: templateFormat(body), currentTexts: [subject, body], shippedTexts: [subject, body] });
/** `htmlVariablesAllowed` : blocs HTML admis quand ils figurent dans le texte livré (règle du service). */
const check = (type: string, subject: string, body: string) =>
  validateDraft({ subject, body, format: templateFormat(body), spec: spec(type, body, subject), htmlVariablesAllowed: true });
const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

describe('MAIL-ED-01 — zones de texte des gabarits HTML complets', () => {
  for (const [type, html] of Object.entries(EMAIL_HTML_TEMPLATES_L66)) {
    it(`${type} : aller-retour sans modification = corps identique`, () => {
      const zones = extractHtmlZones(html);
      expect(zones.length).toBeGreaterThan(2);
      const r = applyHtmlZones(html, zones.map((z) => z.text));
      expect(r.ok && r.body).toBe(html);
      // Ni CSS ni <title> dans les zones.
      expect(zones.some((z) => /color-scheme|@media|mso-/.test(z.text))).toBe(false);
    });
  }

  it('WELCOME : seule la zone modifiée change ; liens, balises et styles intacts', () => {
    const zones = extractHtmlZones(WELCOME_HTML);
    const i = zones.findIndex((z) => z.text.startsWith('Votre compte est maintenant activé'));
    const texts = zones.map((z) => z.text);
    texts[i] = 'Votre compte est prêt & activé, {{firstName}} !';
    const r = applyHtmlZones(WELCOME_HTML, texts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toEqual([i]);
    expect(r.body).toContain('Votre compte est prêt &amp; activé, {{firstName}} !');
    const tags = (s: string) => s.match(/<[^>]+>/g);
    expect(tags(r.body)).toEqual(tags(WELCOME_HTML));
    expect(r.body).toContain('href="{{loginUrl}}"');
  });

  it('le libellé du bouton est une zone « lien » ; le logo {{logoUrl}} est verrouillé', () => {
    const zones = extractHtmlZones(WELCOME_HTML);
    expect(zones.find((z) => z.text === 'Accéder à mon espace')?.inLink).toBe(true);
    expect(zones.find((z) => z.text === '{{logoUrl}}')?.locked).toBe(true);
    const texts = zones.map((z) => (z.text === '{{logoUrl}}' ? 'autre logo' : z.text));
    const r = applyHtmlZones(WELCOME_HTML, texts);
    expect(r.ok).toBe(false);
    expect(!r.ok && codes(r.issues)).toContain('ZONE_LOCKED');
  });

  it('nombre de zones différent → refus (gabarit changé depuis l’ouverture)', () => {
    const r = applyHtmlZones(WELCOME_HTML, ['un seul texte']);
    expect(!r.ok && codes(r.issues)).toEqual(['ZONES_MISMATCH']);
  });
});

describe('MAIL-ED-02 — les textes livrés respectent la déclaration de variables', () => {
  const scope = Object.entries(LOT65.db).filter(([t]) => hasDeclaredVariables(t));
  it('19 gabarits déclarés présents dans la base livrée', () => {
    expect(scope.length).toBeGreaterThanOrEqual(19);
  });
  for (const [type, t] of scope) {
    it(`${type} (base livrée) : aucune variable inconnue ni obligatoire manquante`, () => {
      expect(check(type, t.subject, t.body)).toEqual([]);
    });
  }
  for (const [type, html] of Object.entries(EMAIL_HTML_TEMPLATES_L66)) {
    it(`${type} (HTML 2026) : accepté tel quel`, () => {
      const subject = LOT65.db[type]?.subject ?? 'Objet';
      expect(check(type, subject, html)).toEqual([]);
    });
  }
  // SUBSCRIPTION_EXPIRING : ancien modèle, déclenché par aucun code (non déclaré).
  for (const [type, t] of Object.entries(DEFAULT_EMAIL_TEMPLATES).filter(([k]) => k !== 'SUBSCRIPTION_EXPIRING')) {
    it(`${type} (défaut du code) : accepté tel quel`, () => {
      expect(check(type, t.subject, t.body)).toEqual([]);
    });
  }
  it('SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER (0477) : accepté tel quel', () => {
    expect(check('SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', J7.subject, J7.body)).toEqual([]);
  });
  it('gabarit non déclaré : variables déjà employées seulement, liens livrés obligatoires', () => {
    const body = 'Bonjour {{firstName}},\n\nVoir : {{actionUrl}}';
    const s = variableSpecFor('DOCUMENT_BATCH_X', { format: 'text', currentTexts: [body], shippedTexts: [body] });
    expect(s.declared).toBe(false);
    expect(s.variables.map((x) => x.name).sort()).toEqual(['actionUrl', 'firstName', 'year']);
    expect(s.required[0].anyOf).toEqual(['actionUrl']);
  });
});

describe('MAIL-ED-03 — variable inconnue', () => {
  it('refusée dans le contenu et dans l’objet', () => {
    const body = LOT65.db.EMAIL_VERIFICATION.body.replace('Bonjour {{firstName}}', 'Bonjour {{prenom}}');
    expect(codes(check('EMAIL_VERIFICATION', 'Objet', body))).toContain('UNKNOWN_VARIABLE');
    expect(codes(check('EMAIL_VERIFICATION', 'Objet {{token}}', LOT65.db.EMAIL_VERIFICATION.body))).toContain('UNKNOWN_VARIABLE');
  });
  it('variable mal formée refusée', () => {
    const body = `${LOT65.db.EMAIL_VERIFICATION.body}\n\n{{ prénom }}`;
    expect(codes(check('EMAIL_VERIFICATION', 'Objet', body))).toContain('MALFORMED_VARIABLE');
    expect(codes(check('EMAIL_VERIFICATION', 'Objet {{firstName}', LOT65.db.EMAIL_VERIFICATION.body))).toContain('MALFORMED_VARIABLE');
  });
});

describe('MAIL-ED-04 — variable obligatoire retirée', () => {
  const sans = (type: string, body: string, name: string, subject = 'Objet') =>
    codes(validateDraft({ subject, body: body.split(`{{${name}}}`).join('lien'), format: templateFormat(body), spec: variableSpecFor(type, { format: templateFormat(body) }) }));

  it('lien de vérification (EMAIL_VERIFICATION)', () => {
    expect(sans('EMAIL_VERIFICATION', LOT65.db.EMAIL_VERIFICATION.body, 'verificationUrl')).toContain('REQUIRED_VARIABLE_MISSING');
  });
  it('lien d’action (DUO_INVITATION, PASSWORD_RESET, ACCOUNT_INVITATION)', () => {
    expect(sans('DUO_INVITATION', LOT65.db.DUO_INVITATION.body, 'actionUrl')).toContain('REQUIRED_VARIABLE_MISSING');
    expect(sans('PASSWORD_RESET', LOT65.db.PASSWORD_RESET.body, 'resetUrl')).toContain('REQUIRED_VARIABLE_MISSING');
    expect(sans('ACCOUNT_INVITATION', ACCOUNT_INVITATION_HTML, 'invitationLink')).toContain('REQUIRED_VARIABLE_MISSING');
  });
  it('remplacer un lien par un autre nom équivalent reste admis (actionUrl ↔ inviteUrl)', () => {
    const body = LOT65.db.DUO_INVITATION.body.replace('{{actionUrl}}', '{{inviteUrl}}');
    expect(check('DUO_INVITATION', 'Objet', body)).toEqual([]);
  });
  it('J−7 : lien du portail, montant et date', () => {
    for (const name of ['manageSubscriptionUrl', 'amountLabel']) {
      expect(sans('SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', J7.body, name, J7.subject)).toContain('REQUIRED_VARIABLE_MISSING');
    }
    const sansDate = validateDraft({
      subject: 'Votre abonnement annuel', body: J7.body.split('{{renewalDate}}').join('bientôt'),
      format: 'text', spec: variableSpecFor('SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', { format: 'text' }),
    });
    expect(codes(sansDate)).toContain('REQUIRED_VARIABLE_MISSING');
  });
  it('confirmation du contrat (édition limitée) : montant obligatoire', () => {
    const html = EMAIL_HTML_TEMPLATES_L66.PREMIUM_CONFIRMATION;
    expect(limitedEditReason('PREMIUM_CONFIRMATION')).toBeTruthy();
    expect(sans('PREMIUM_CONFIRMATION', html, 'amountLabel')).toContain('REQUIRED_VARIABLE_MISSING');
  });
  it('la zone d’un bouton ne peut pas retirer le lien : le href n’est pas éditable', () => {
    const zones = extractHtmlZones(ACCOUNT_INVITATION_HTML).map((z) => z.text.replace(/\{\{invitationLink\}\}/g, 'lien'));
    const r = applyHtmlZones(ACCOUNT_INVITATION_HTML, zones);
    expect(r.ok).toBe(true);
    if (r.ok) expect(check('ACCOUNT_INVITATION', 'Objet {{accountName}}', r.body)).toEqual([]); // href conservé
  });
});

describe('MAIL-ED-05 — contenu assaini', () => {
  const base = LOT65.db.EMAIL_VERIFICATION.body;
  it('script, attribut on*, javascript:, balises non admises → refus', () => {
    expect(codes(check('EMAIL_VERIFICATION', 'Objet', `${base}\n<script>alert(1)</script>`))).toContain('SCRIPT');
    expect(codes(check('EMAIL_VERIFICATION', 'Objet', `${base}\n<b onclick="x()">a</b>`))).toContain('FORBIDDEN_ATTRIBUTE');
    expect(codes(check('EMAIL_VERIFICATION', 'Objet', `${base}\nVoir : javascript:alert(1)`))).toContain('JAVASCRIPT_URL');
    expect(codes(check('EMAIL_VERIFICATION', 'Objet', `${base}\nVoir : java&#115;cript:alert(1)`))).toContain('JAVASCRIPT_URL');
    expect(codes(check('EMAIL_VERIFICATION', 'Objet', `${base}\n<a href="https://x.example">x</a>`))).toContain('FORBIDDEN_TAG');
    expect(codes(check('EMAIL_VERIFICATION', 'Objet', `${base}\n<img src=x>`))).toContain('FORBIDDEN_TAG');
  });
  it('mise en forme simple admise ; « a < b » reste du texte', () => {
    expect(check('EMAIL_VERIFICATION', 'Objet', `${base}\n<strong>Important</strong> : 2 < 3<br>`)).toEqual([]);
  });
  it('un gabarit texte ne peut pas devenir un document HTML', () => {
    expect(codes(check('EMAIL_VERIFICATION', 'Objet', `<html><body>{{verificationUrl}}</body></html>`).concat(
      validateDraft({ subject: 'Objet', body: '<html><body>{{verificationUrl}}</body></html>', format: 'text', spec: spec('EMAIL_VERIFICATION', base) }),
    ))).toContain('FORMAT_CHANGED');
  });
  it('zone HTML : « < » refusé, libellé de bouton vide refusé, & encodé', () => {
    const zones = extractHtmlZones(WELCOME_HTML);
    const i = zones.findIndex((z) => z.inLink);
    const first = zones.findIndex((z) => !z.locked);
    const texts = zones.map((z) => z.text);
    texts[first] = '<img src=x onerror=alert(1)>';
    texts[i] = '';
    const r = applyHtmlZones(WELCOME_HTML, texts);
    expect(!r.ok && codes(r.issues)).toEqual(expect.arrayContaining(['FORBIDDEN_TAG', 'LINK_LABEL_EMPTY']));
  });
  it('filet HTML : liens http(s), mailto ou variable seulement', () => {
    expect(isAllowedLink('{{loginUrl}}')).toBe(true);
    expect(isAllowedLink('mailto:{{contactEmail}}')).toBe(true);
    expect(isAllowedLink('https://verebona.fr/aide')).toBe(true);
    expect(isAllowedLink('javascript:alert(1)')).toBe(false);
    expect(isAllowedLink('ftp://x')).toBe(false);
    expect(codes(scanHtmlBody(WELCOME_HTML.replace('href="{{loginUrl}}"', 'href="data:text/html,x"')))).toContain('JAVASCRIPT_URL');
    for (const html of Object.values(EMAIL_HTML_TEMPLATES_L66)) expect(scanHtmlBody(html)).toEqual([]);
  });
  it('longueur bornée', () => {
    expect(codes(check('EMAIL_VERIFICATION', 'Objet', `${base}\n${'x'.repeat(20_001)}`))).toContain('BODY_TOO_LONG');
  });
});

describe('MAIL-ED-06 — objet', () => {
  it('retour à la ligne / caractère de contrôle → refus (injection d’en-tête)', () => {
    expect(codes(validateSubject('Bonjour\r\nBcc: pirate@example.com'))).toContain('SUBJECT_HEADER_INJECTION');
    expect(codes(validateSubject('Bonjour\nx'))).toContain('SUBJECT_HEADER_INJECTION');
    expect(codes(validateSubject('Bonjour\u0000x'))).toContain('SUBJECT_HEADER_INJECTION');
  });
  it('vide, trop long, balise → refus', () => {
    expect(codes(validateSubject('  '))).toEqual(['SUBJECT_EMPTY']);
    expect(codes(validateSubject('x'.repeat(201)))).toContain('SUBJECT_TOO_LONG');
    expect(codes(validateSubject('<b>Promo</b>'))).toContain('SUBJECT_HTML');
  });
  it('lien dans l’objet → refus', () => {
    expect(codes(check('EMAIL_VERIFICATION', 'Cliquez {{verificationUrl}}', LOT65.db.EMAIL_VERIFICATION.body))).toContain('VARIABLE_NOT_ALLOWED_IN_SUBJECT');
  });
  it('à l’envoi : une valeur ne peut pas ajouter de ligne d’en-tête', () => {
    expect(sanitizeSubjectHeader('Bonjour Alice\r\nBcc: x@y.z')).toBe('Bonjour Alice Bcc: x@y.z');
  });
});

describe('MAIL-ED-07 — gabarits légaux et verrou « non désactivable »', () => {
  it('confirmation légale et accusé de rétractation : contenu verrouillé, motif affiché', () => {
    expect(Object.keys(CONTENT_LOCKED_TEMPLATES).sort()).toEqual(['LEGAL_CONFIRMATION', 'WITHDRAWAL_RECEIPT']);
    expect(contentLockReason('legal_confirmation')).toMatch(/SHA-256/);
    expect(contentLockReason('WITHDRAWAL_RECEIPT')).toMatch(/L221-21/);
  });
  it('un gabarit non désactivable reste modifiable (verrous distincts)', () => {
    for (const t of ['DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT', 'PASSWORD_RESET', 'EMAIL_VERIFICATION']) {
      expect(transactionalLockReason(t)).toBeTruthy();
      expect(contentLockReason(t)).toBeNull();
    }
  });
});

describe('MAIL-ED-08 — comparaison', () => {
  it('lignes ajoutées et retirées', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([
      { op: 'same', text: 'a' }, { op: 'del', text: 'b' }, { op: 'add', text: 'B' }, { op: 'same', text: 'c' },
    ]);
  });
  it('gabarit HTML : comparaison sur les textes des zones', () => {
    const t = comparableText(WELCOME_HTML);
    expect(t).toContain('Accéder à mon espace');
    expect(t).not.toContain('<');
    expect(extractVariables(t)).toContain('firstName');
  });
});

describe('MAIL-ED-09 — rendu d’envoi sans variable non remplacée', () => {
  const settings = { emailsEnabled: true, senderName: 'Verebona', senderEmail: 'noreply@verebona.fr', replyToEmail: 'support@verebona.fr', footerText: null, logoUrl: null };
  it('variable non fournie retirée du rendu (signalée), objet nettoyé', async () => {
    const r = await emailService.renderTemplate(
      { subject: 'Bonjour {{firstName}} {{inconnue}}', body: 'Bonjour {{firstName}},\n\nTexte {{inconnue}}.\n\nVoir : {{actionUrl}}' },
      { firstName: 'Alice', actionUrl: 'https://app.verebona.fr/x' }, settings,
    );
    expect(r.unresolved).toEqual(['inconnue']);
    expect(`${r.subject}${r.html}${r.text}`).not.toMatch(/\{\{|\}\}/);
    expect(r.subject).toBe('Bonjour Alice');
    expect(r.html).toContain('class="vb-btn"');
    expect(r.html).toContain('href="https://app.verebona.fr/x"');
  });
  it('gabarit HTML livré rendu avec le logo hébergé, sans accolade', async () => {
    const r = await emailService.renderTemplate({ subject: 'Bienvenue', body: WELCOME_HTML }, { firstName: 'Alice', loginUrl: 'https://app.verebona.fr/login' }, settings);
    expect(r.html).not.toMatch(/\{\{|\}\}/);
    expect(r.html).toContain('data-vb-logo="light"');
  });
  it('stripUnresolvedPlaceholders', () => {
    expect(stripUnresolvedPlaceholders('a {{ x }} b {{y}}')).toBe('a  b ');
  });
});

describe('MAIL-ED-05b — blocs HTML produits par le code', () => {
  it('refusés dans un contenu où ils ne figurent pas au texte livré', () => {
    const body = `${LOT65.db.EMAIL_VERIFICATION.body}\n{{subscriptionBlockHtml}}`;
    const r = validateDraft({ subject: 'Objet', body, format: 'text', spec: variableSpecFor('LEGAL_CONFIRMATION', { format: 'text' }) });
    expect(codes(r)).toContain('HTML_VARIABLE_NOT_ALLOWED');
  });
});
