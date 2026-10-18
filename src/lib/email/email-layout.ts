/**
 * Lot 66C — mise en page COMMUNE des e-mails transactionnels, charte « Sérénité » 2026
 * (Verebona_Charte_2026_v1.1 §1, §2, §3, §5).
 *
 * Une seule source pour l'enveloppe (fond, carte, en-tête logo, pied), les boutons,
 * les liens, les sur-titres et les encadrés. Utilisée par :
 *   · `email-service.ts` → `wrapInHTML` (tous les gabarits TEXTE, y compris ceux
 *     personnalisés dans le BO : la mise en page vit dans le code, pas en base) ;
 *   · les gabarits HTML complets livrés (`email-html-templates.ts`), reportés en base
 *     par les amorçages et la migration 0465 ;
 *   · le repli HTML de l'e-mail de transmission.
 *
 * Contraintes des clients de messagerie :
 *   · tableaux de mise en page (`role="presentation"`), styles EN LIGNE, aucune
 *     variable CSS (Gmail, Outlook les ignorent) ;
 *   · police : Figtree si le client sait la charger (Apple Mail, iOS : @font-face
 *     servi par l'application), sinon pile de repli sûre Arial / Helvetica ;
 *     jamais Google Fonts (refusé par Gmail/Outlook, et transmet l'adresse IP du
 *     destinataire à un tiers) ;
 *   · mode sombre : `color-scheme` / `supported-color-schemes` + `@media
 *     (prefers-color-scheme: dark)` et sélecteurs `[data-ogsc]` (Outlook.com) ;
 *     les clients qui inversent eux-mêmes les couleurs (Gmail mobile, Outlook)
 *     n'inversent pas les images : le logo clair est un PNG OPAQUE (fond blanc),
 *     lisible sur un fond assombri ; les clients qui appliquent la media query
 *     affichent le logo sombre (PNG opaque, fond encre).
 */

/** Couleurs de la charte (valeurs littérales : pas de variables CSS dans un e-mail). */
export const EMAIL_COLORS = {
  petrole: '#17474D',
  petroleHover: '#10383E',
  cuivreTexte: '#AA4E38',
  ivoire: '#F8F6F1',
  brume: '#E2EBE9',
  blanc: '#FFFFFF',
  filet: '#D5DEDC',
  filetDoux: '#E2EBE9',
  encre: '#26353B',
  gris: '#52636A',
  cuivreSoft: '#F6E4DE',
  /** Rouge accessible : réservé aux erreurs bloquantes / retards stricts (décision PO lot 66). */
  rouge: '#B42318',
  dark: {
    page: '#1B2529', card: '#26353B', border: '#3A4A51', text: '#F3F1EB', muted: '#A7B6B9',
    accent: '#9FD3CC', onAccent: '#1B2529', cuivre: '#E2896F', soft: '#2A4347', softEdge: '#3E5F63',
  },
} as const;

/** Pile typographique sûre : Figtree d'abord, Arial / Helvetica partout ailleurs. */
export const EMAIL_FONT_STACK = "'Figtree', Arial, Helvetica, sans-serif";

/** Logos hébergés par l'application (PNG 480 × 120, opaques). `?v=2026` : contourne le cache des proxys d'images (Gmail). */
export const EMAIL_LOGO_LIGHT_PATH = '/brand/verebona-logo-email.png?v=2026';
export const EMAIL_LOGO_DARK_PATH = '/brand/verebona-logo-email-dark.png?v=2026';
/** Figtree variable (OFL, `public/brand/email/LICENSE.txt`) servie par l'application. */
export const EMAIL_FONT_PATHS = {
  latin: '/brand/email/figtree-latin-wght-5.3.0.woff2',
  latinExt: '/brand/email/figtree-latin-ext-wght-5.3.0.woff2',
} as const;

/** Base absolue des ressources d'e-mail (même règle que `makeAbsoluteUrl` du service). */
export function emailAssetBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://app.verebona.fr').replace(/\/+$/, '');
}

const C = EMAIL_COLORS;
const F = EMAIL_FONT_STACK;

/** Styles en ligne réutilisables (texte des gabarits HTML et de l'enveloppe). */
export const EMAIL_STYLES = {
  p: `margin:0 0 16px 0;font-family:${F};font-size:16px;line-height:1.6;color:${C.encre};`,
  pLast: `margin:0;font-family:${F};font-size:16px;line-height:1.6;color:${C.encre};`,
  muted: `margin:0 0 16px 0;font-family:${F};font-size:14px;line-height:1.55;color:${C.gris};`,
  small: `font-family:${F};font-size:13px;line-height:1.5;color:${C.gris};`,
  /** Sur-titre : 12 px / 700 capitales espacées, cuivre texte. */
  eyebrow: `margin:0 0 8px 0;font-family:${F};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.cuivreTexte};`,
  h1: `margin:0 0 16px 0;font-family:${F};font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:${C.petrole};`,
  h2: `margin:0 0 12px 0;font-family:${F};font-size:18px;line-height:1.3;font-weight:700;color:${C.petrole};`,
  link: `color:${C.petrole};text-decoration:underline;font-weight:600;`,
  linkBreak: `color:${C.petrole};text-decoration:underline;word-break:break-all;`,
  strong: `color:${C.encre};font-weight:700;`,
  /** Encadré ivoire (information) — remplace les encadrés bleus. */
  callout: `background-color:${C.ivoire};border:1px solid ${C.filet};border-radius:12px;`,
  calloutCell: `padding:16px 20px;font-family:${F};font-size:15px;line-height:1.6;color:${C.encre};`,
  /** Encadré d'attention (cuivre doux). */
  attention: `background-color:${C.cuivreSoft};border:1px solid #E8C4B9;border-radius:12px;`,
  li: `margin:0 0 8px 0;font-family:${F};font-size:16px;line-height:1.6;color:${C.encre};`,
} as const;

/** Échappement des valeurs placées dans un attribut ou un texte généré par le code. */
const escAttr = (s: string) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Bloc logo d'en-tête : PNG clair (affiché par défaut) + PNG sombre (affiché par la
 * media query). `data-vb-logo` : exclut ces images du recalibrage `fixLogoSizing`.
 * Texte alternatif « Verebona » (images bloquées : le nom de marque reste lu).
 */
export function emailLogoHtml(baseUrl: string = emailAssetBaseUrl(), alt = 'Verebona'): string {
  const a = escAttr(alt);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td style="padding:0;">`
    + `<img data-vb-logo="light" class="vb-logo-light" src="${baseUrl}${EMAIL_LOGO_LIGHT_PATH}" width="160" height="40" alt="${a}" style="display:block;width:160px;height:40px;max-width:160px;border:0;outline:none;text-decoration:none;font-family:${F};font-size:20px;font-weight:700;color:${C.petrole};">`
    + `<!--[if !mso]><!--><img data-vb-logo="dark" class="vb-logo-dark" src="${baseUrl}${EMAIL_LOGO_DARK_PATH}" width="160" height="40" alt="${a}" style="display:none;width:160px;height:40px;max-width:160px;max-height:0;overflow:hidden;border:0;outline:none;mso-hide:all;"><!--<![endif]-->`
    + `</td></tr></table>`;
}

/**
 * Bouton primaire « à l'épreuve des balles » : fond pétrole, texte blanc 700,
 * rayon 12 px, padding 15 × 26 px (charte §5). Lien et libellé fournis tels quels
 * par l'appelant (déjà échappés / variables `{{…}}`).
 */
export function emailButton(href: string, label: string, { align = 'center' }: { align?: 'center' | 'left' } = {}): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="margin:8px ${align === 'center' ? 'auto' : '0'} 24px;border-collapse:separate;"><tr>`
    + `<td class="vb-btn-td" align="center" bgcolor="${C.petrole}" style="border-radius:12px;background-color:${C.petrole};">`
    + `<a class="vb-btn" href="${href}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:${F};font-size:16px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:${C.petrole};border:1px solid ${C.petrole};">${label}</a>`
    + `</td></tr></table>`;
}

/** Encadré ivoire (contenu HTML fourni par le gabarit). */
export function emailCallout(html: string, { tone = 'info' }: { tone?: 'info' | 'attention' } = {}): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="${tone === 'info' ? 'vb-callout' : 'vb-attention'}" style="${tone === 'info' ? EMAIL_STYLES.callout : EMAIL_STYLES.attention}margin:8px 0 24px 0;border-collapse:separate;"><tr><td class="vb-text" style="${EMAIL_STYLES.calloutCell}">${html}</td></tr></table>`;
}

/** Feuille de style embarquée : police, mode sombre, petits écrans. */
function headStyles(baseUrl: string, fontFace = true): string {
  const D = C.dark;
  const dark = (p: string) => `
  ${p} .vb-page, ${p}.vb-page { background-color:${D.page} !important; }
  ${p} .vb-card { background-color:${D.card} !important; border-color:${D.border} !important; }
  ${p} .vb-head, ${p} .vb-rule { border-color:${D.border} !important; }
  ${p} .vb-text, ${p} .vb-text p, ${p} .vb-text li, ${p} .vb-text td, ${p} .vb-text span, ${p} .vb-text strong, ${p} .vb-text h1, ${p} .vb-text h2 { color:${D.text} !important; }
  ${p} .vb-text .vb-muted, ${p} .vb-muted, ${p} .vb-foot, ${p} .vb-foot p { color:${D.muted} !important; }
  ${p} .vb-text .vb-eyebrow, ${p} .vb-eyebrow { color:${D.cuivre} !important; }
  ${p} .vb-wordmark { color:${D.text} !important; }
  ${p} a, ${p} .vb-text a, ${p} .vb-link { color:${D.accent} !important; }
  ${p} .vb-btn-td { background-color:${D.accent} !important; }
  ${p} a.vb-btn, ${p} .vb-text a.vb-btn { background-color:${D.accent} !important; border-color:${D.accent} !important; color:${D.onAccent} !important; }
  ${p} .vb-callout { background-color:${D.soft} !important; border-color:${D.softEdge} !important; }
  ${p} .vb-attention { background-color:#3D302C !important; border-color:#5A4038 !important; }`;
  const faces = !fontFace ? '' : `
  @font-face { font-family:'Figtree'; font-style:normal; font-weight:400 800; font-display:swap; src:url('${baseUrl}${EMAIL_FONT_PATHS.latin}') format('woff2'); unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
  @font-face { font-family:'Figtree'; font-style:normal; font-weight:400 800; font-display:swap; src:url('${baseUrl}${EMAIL_FONT_PATHS.latinExt}') format('woff2'); unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }`;
  return `<style type="text/css">${faces}
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { -ms-interpolation-mode:bicubic; }
  a.vb-btn:hover { background-color:${C.petroleHover} !important; border-color:${C.petroleHover} !important; }
  @media screen and (max-width:620px) {
    .vb-container { width:100% !important; }
    .vb-pad { padding-left:24px !important; padding-right:24px !important; }
  }
  @media (prefers-color-scheme: dark) {${dark('')}
    .vb-logo-light { display:none !important; max-height:0 !important; }
    .vb-logo-dark { display:block !important; max-height:none !important; overflow:visible !important; }
  }${dark('[data-ogsc]')}
  [data-ogsc] .vb-logo-light { display:none !important; }
  [data-ogsc] .vb-logo-dark { display:block !important; max-height:none !important; }
</style>`;
}

/**
 * Document complet : fond ivoire, carte blanche (filet #D5DEDC, rayon 16), en-tête
 * logo, contenu, pied. `content`, `footer` et `logo` sont du HTML fourni par le code
 * ou par un gabarit (variables `{{…}}` comprises).
 */
export function emailDocument({ title, content, footer, logo, baseUrl = emailAssetBaseUrl(), fontFace = true }: {
  title: string; content: string; footer: string; logo?: string; baseUrl?: string;
  /** false : pas de @font-face (gabarits stockés en base : aucune URL d'application figée). */
  fontFace?: boolean;
}): string {
  return `<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${title}</title>
  ${headStyles(baseUrl, fontFace)}
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:${C.ivoire};font-family:${F};color:${C.encre};">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.ivoire}" style="background-color:${C.ivoire};">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.blanc}" style="width:600px;max-width:600px;background-color:${C.blanc};border:1px solid ${C.filet};border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid ${C.filetDoux};">
              ${logo ?? emailLogoHtml(baseUrl)}
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:${F};font-size:16px;line-height:1.6;color:${C.encre};">
              ${content}
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:${F};font-size:13px;line-height:1.5;color:${C.gris};text-align:center;">
              ${footer}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
