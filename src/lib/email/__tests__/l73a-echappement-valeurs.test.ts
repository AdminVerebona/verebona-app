/**
 * Lot 73A (point 3, décision PO du 20/10) — valeurs saisies par les
 * utilisateurs (prénom, nom de bien, nom de document, nom de compte…)
 * insérées dans un e-mail : jamais de lien, d'URL, de balise ni de retour à la
 * ligne injectés, dans la version TEXTE comme dans la version HTML et l'objet ;
 * les liens d'action produits par l'application (actionUrl…) restent intacts.
 *
 * L73A-ESC-01 Version texte : URL / domaine / « www. » d'une valeur neutralisés.
 * L73A-ESC-02 Retour à la ligne injecté : ni faux paragraphe, ni faux bouton
 *             (gabarit texte), ni ligne « Libellé : URL » dans la version texte.
 * L73A-ESC-03 Balises d'une valeur : jamais interprétées en HTML, retirées du texte.
 * L73A-ESC-04 Liens d'action de l'application : intacts (texte et href).
 * L73A-ESC-05 Gabarit HTML complet (WELCOME) : valeur échappée, structure intacte.
 * L73A-ESC-06 Valeur déjà échappée par l'appelant (Duo) : pas de double échappement
 *             (« Tom & Jerry » lisible en texte, « &amp; » unique en HTML).
 * L73A-ESC-07 Objet : une ligne, URL neutralisée, aucune entité visible.
 * L73A-ESC-08 Blocs HTML produits par le code (*Html) et adresse de contact :
 *             inchangés ; lien non http(s) dans une variable de lien : neutralisé.
 * L73A-ESC-09 Notification (variables title / body / actionUrl) : nom de document
 *             piégé neutralisé, bouton d'action intact.
 * L73A-ESC-10 Valeurs ordinaires : rendu identique (aucune altération visible).
 */
import { describe, expect, it } from 'vitest';
import { emailService } from '../email-service';
import { WELCOME_HTML } from '../email-html-templates';
import { neutralizeUserText, safeTemplateVariables } from '../variable-safety';

const settings = { emailsEnabled: true, senderName: 'Verebona', senderEmail: 'noreply@verebona.fr', replyToEmail: 'support@verebona.fr', footerText: null, logoUrl: null };
const render = (subject: string, body: string, variables: Record<string, string>) =>
  emailService.renderTemplate({ subject, body }, variables, settings);

const TEXT_TPL = 'Bonjour {{firstName}},\n\nVotre bien {{assetName}} a été mis à jour.\n\nVoir le bien : {{actionUrl}}\n\nL’équipe Verebona';
const ACTION = 'https://app.verebona.fr/assets/12?onglet=documents&tri=date';
const buttons = (html: string) => (html.match(/class="vb-btn"/g) ?? []).length;

describe('L73A-ESC-01 — version texte : URL et domaines d’une valeur neutralisés', () => {
  it('https://, www. et domaine nu ne sont plus des liens', async () => {
    const r = await render('Bonjour', TEXT_TPL, {
      firstName: 'Jean https://pirate.example/login', assetName: 'Maison www.pirate.example ou pirate.example/x', actionUrl: ACTION,
    });
    expect(r.text).not.toMatch(/https?:\/\/pirate/);
    expect(r.text).not.toMatch(/www\.pirate/);
    expect(r.text).not.toMatch(/pirate\.example/);
    expect(r.html).not.toMatch(/https?:\/\/pirate|www\.pirate|pirate\.example/);
    // La valeur reste lisible (neutralisée, pas supprimée).
    expect(r.text).toMatch(/Jean https\[:\]\/\/pirate\u2024example\/login/);
  });
});

describe('L73A-ESC-02 — retours à la ligne injectés', () => {
  it('ni faux paragraphe, ni faux bouton, ni fausse ligne « Libellé : URL »', async () => {
    const r = await render('Bonjour', TEXT_TPL, {
      firstName: 'Jean\n\nCliquez ici : https://pirate.example/x\r\n', assetName: 'Appartement\u2028Paris', actionUrl: ACTION,
    });
    expect(buttons(r.html)).toBe(1); // seul le bouton du gabarit
    expect(r.html).toContain(`href="${ACTION}"`);
    expect(r.text).not.toMatch(/^\s*Cliquez ici\s*:/m);
    expect(r.text.split('\n')[0]).toMatch(/^Bonjour Jean Cliquez ici/);
    expect(r.text).toContain('Votre bien Appartement Paris a été mis à jour.');
  });
});

describe('L73A-ESC-03 — balises d’une valeur', () => {
  it('jamais interprétées en HTML, retirées de la version texte', async () => {
    const r = await render('Bonjour', TEXT_TPL, {
      firstName: '<a href="https://pirate.example">Support</a>', assetName: '<img src=x onerror=alert(1)><b>Villa</b>', actionUrl: ACTION,
    });
    expect(r.html).not.toMatch(/<a href="https:\/\/pirate/);
    expect(r.html).not.toMatch(/<img src=x/);
    expect(r.html).not.toMatch(/<b>Villa/);
    expect(r.text).not.toMatch(/<a |<img|<b>|onerror/);
    expect(r.text).toContain('Bonjour Support,');
    expect(r.text).toContain('Votre bien Villa a été mis à jour.');
  });
  it('« a < b » reste un texte (échappé en HTML)', async () => {
    const r = await render('Bonjour', TEXT_TPL, { firstName: 'a < b > c', assetName: 'X', actionUrl: ACTION });
    expect(r.text).toContain('Bonjour a < b > c,');
    expect(r.html).toContain('a &lt; b &gt; c');
  });
});

describe('L73A-ESC-04 — liens d’action produits par l’application intacts', () => {
  it('texte : ligne « Voir le bien : URL » exacte ; HTML : bouton avec le href exact', async () => {
    const r = await render('Bonjour', TEXT_TPL, { firstName: 'Alice', assetName: 'Villa', actionUrl: ACTION });
    expect(r.text).toMatch(new RegExp(`^Voir le bien : ${ACTION.replace(/[.?&/]/g, '\\$&')}$`, 'm'));
    expect(r.html).toContain(`href="${ACTION}"`);
    expect(r.html).toContain('>Voir le bien</a>');
  });
  it('lien d’action avec guillemet ou espace : encodé, jamais d’attribut injecté', async () => {
    // Guillemet sans espace : lien conservé, guillemets encodés.
    const r = await render('Bonjour', TEXT_TPL, { firstName: 'A', assetName: 'B', actionUrl: 'https://app.verebona.fr/x"onclick="alert(1)' });
    expect(r.html).not.toContain('onclick="alert');
    expect(r.html).toContain('href="https://app.verebona.fr/x%22onclick=%22alert(1)"');
    // Avec espace : ce n'est pas une URL produite par l'application → texte inerte, aucun bouton.
    const r2 = await render('Bonjour', TEXT_TPL, { firstName: 'A', assetName: 'B', actionUrl: 'https://app.verebona.fr/x" onclick="alert(1)' });
    expect(r2.html).not.toContain('onclick="alert');
    expect(buttons(r2.html)).toBe(0);
  });
});

describe('L73A-ESC-05 — gabarit HTML complet', () => {
  it('valeur échappée, liens du gabarit intacts', async () => {
    const r = await render('Bienvenue {{firstName}}', WELCOME_HTML, { firstName: '<img src=x onerror=alert(1)>Léa', loginUrl: 'https://app.verebona.fr/login' });
    expect(r.html).not.toMatch(/<img src=x/);
    expect(r.html).toContain('href="https://app.verebona.fr/login"');
    expect(r.html).toContain('Léa');
    expect(r.subject).toBe('Bienvenue Léa');
    expect(r.text).not.toMatch(/onerror|<img/);
  });
});

describe('L73A-ESC-06 — valeur déjà échappée par l’appelant', () => {
  it('pas de double échappement', async () => {
    const r = await render('Fin du Duo avec {{ownerFirstName}}', 'Bonjour {{firstName}},\n\nEspace partagé avec {{ownerFirstName}}.\n\nAccéder à mon compte : {{accountUrl}}', {
      firstName: 'Zoé', ownerFirstName: 'Tom &amp; Jerry &lt;3', accountUrl: 'https://app.verebona.fr/mon-compte',
    });
    expect(r.text).toContain('Espace partagé avec Tom & Jerry <3.');
    expect(r.html).toContain('Tom &amp; Jerry &lt;3');
    expect(r.html).not.toContain('&amp;amp;');
    expect(r.subject).toBe('Fin du Duo avec Tom & Jerry <3');
  });
});

describe('L73A-ESC-07 — objet', () => {
  it('une ligne, URL neutralisée', async () => {
    const r = await render('Bonjour {{firstName}}', TEXT_TPL, { firstName: 'Alice\r\nBcc: x@pirate.example https://pirate.example', assetName: 'X', actionUrl: ACTION });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.subject).not.toMatch(/https?:\/\/pirate|pirate\.example/);
    expect(r.subject.startsWith('Bonjour Alice Bcc')).toBe(true);
  });
});

describe('L73A-ESC-08 — valeurs produites par le code', () => {
  it('blocs *Html inchangés ; adresse de contact intacte', async () => {
    const block = '<p style="margin:0">Votre abonnement <strong>Premium</strong>.</p>';
    const r = await render('Objet', '<html><body>{{subscriptionBlockHtml}}<p>Écrivez à <a href="mailto:{{contactEmail}}">{{contactEmail}}</a></p></body></html>', {
      subscriptionBlockHtml: block, contactEmail: 'contact@verebona.fr',
    });
    expect(r.html).toContain(block);
    expect(r.html).toContain('href="mailto:contact@verebona.fr">contact@verebona.fr</a>');
    expect(r.text).toContain('Votre abonnement Premium.');
    expect(r.text).toContain('contact@verebona.fr');
  });
  it('variable de lien dont la valeur n’est pas http(s) : traitée comme un texte', async () => {
    const r = await render('Objet', TEXT_TPL, { firstName: 'A', assetName: 'B', actionUrl: 'javascript:alert(1)' });
    expect(r.html).not.toMatch(/href="javascript:/i);
    expect(r.text).not.toMatch(/javascript:alert/);
  });
});

describe('L73A-ESC-09 — e-mail de notification (title / body / actionUrl)', () => {
  it('nom de document piégé neutralisé, bouton intact', async () => {
    const tpl = '{{body}}\n\nAccéder à Verebona : {{actionUrl}}';
    const r = await render('Analyse de vos documents', tpl, {
      title: 'Analyse impossible',
      body: 'Nous n’avons pas pu analyser ce document : <a href="https://pirate.example">facture.pdf</a>\nOuvrir : https://pirate.example',
      actionUrl: 'https://app.verebona.fr/documents/42',
    });
    expect(buttons(r.html)).toBe(1);
    expect(r.html).toContain('href="https://app.verebona.fr/documents/42"');
    expect(`${r.html}${r.text}`).not.toMatch(/https?:\/\/pirate|pirate\.example|<a href="https:\/\/pirate/);
    expect(r.text).toMatch(/^Accéder à Verebona : https:\/\/app\.verebona\.fr\/documents\/42$/m);
  });
});

describe('L73A-ESC-11 — motifs de remplacement « $ » dans une valeur', () => {
  it('« $& », « $` », « $\' » insérés tels quels (jamais de recopie du gabarit)', async () => {
    const r = await render('Objet {{firstName}}', TEXT_TPL, { firstName: 'A$&B$`C$\'D', assetName: 'X', actionUrl: ACTION });
    expect(r.text).toContain('Bonjour A$&B$`C$\'D,');
    expect(r.subject).toBe('Objet A$&B$`C$\'D');
    expect(r.html).toContain('A$&amp;B$`C$&#39;D');
  });
});

describe('L73A-ESC-10 — valeurs ordinaires : aucune altération visible', () => {
  it('prénoms, montants, dates, noms de bien usuels', () => {
    for (const v of ['Jean-Pierre', 'Zoé', 'Maison de M. Dupont', '49,00 € TTC', '12 mars 2026', 'Appartement n°3 (Lyon 6e)', 'O’Connor']) {
      expect(neutralizeUserText(v)).toBe(v);
    }
  });
  it('liens produits par l’application inchangés ; noms de variables reconnus', () => {
    const out = safeTemplateVariables({ actionUrl: ACTION, invitationLink: 'https://app.verebona.fr/join/abc', firstName: 'Léa', subscriptionBlockHtml: '<p>x</p>' }, 'text');
    expect(out.actionUrl).toBe(ACTION);
    expect(out.invitationLink).toBe('https://app.verebona.fr/join/abc');
    expect(out.firstName).toBe('Léa');
    expect(out.subscriptionBlockHtml).toBe('x');
    expect(safeTemplateVariables({ subscriptionBlockHtml: '<p>x</p>' }, 'html').subscriptionBlockHtml).toBe('<p>x</p>');
  });
});
