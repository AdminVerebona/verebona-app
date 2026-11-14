/**
 * Carte #774 — gabarit transactionnel COMMUN Verebona (HTML et texte brut).
 *
 * Une seule structure pour les e-mails transactionnels, construite sur
 * l'enveloppe de la charte « Sérénité » (`email-layout.ts`, variante compacte) :
 *
 *   pré-en-tête masqué · en-tête court (logo 120 × 30 + libellé) · UN titre H1
 *   propre à l'événement · introduction · sous-sections courtes à titre
 *   explicite (liste numérotée réservée aux actions à accomplir) · UN bouton
 *   principal · lien de repli sous le bouton · pied discret (assistance,
 *   copyright).
 *
 * Aucun second moteur d'envoi : le document produit est un gabarit HTML
 * complet comme les autres (`email_templates`, variables `{{…}}`, éditeur du
 * BO par zones de texte, `EmailService.renderTemplate`).
 *
 * Version TEXTE BRUT : dérivée du même gabarit par `transactionalHtmlToText`
 * (donc aussi d'un gabarit retouché au BO) — titres, paragraphes, liste
 * numérotée, « Libellé : lien » pour le bouton ; ni feuille de style ni
 * pré-en-tête. Les valeurs des variables sont insérées APRÈS la conversion :
 * une valeur n'est jamais interprétée comme une balise.
 *
 * Module PUR (aucun accès base, aucun import d'alias).
 */
import { EMAIL_STYLES as S, emailButton, emailDocument } from './email-layout';

export interface TransactionalSection {
  /** Titre court et explicite de la sous-section. */
  heading: string;
  /** Paragraphes placés avant la liste. */
  paragraphs?: readonly string[];
  /** Actions à accomplir, dans l'ordre (liste numérotée). */
  steps?: readonly string[];
  /** Paragraphes placés après la liste. */
  after?: readonly string[];
}

export interface TransactionalEmailSpec {
  /** Balise `<title>` du document (objet de l'e-mail). */
  documentTitle: string;
  /** Aperçu de la boîte de réception. */
  preheader: string;
  /** Libellé d'en-tête, à droite du logo. */
  headerLabel: string;
  /** Titre unique, propre à l'événement. */
  h1: string;
  intro: readonly string[];
  sections: readonly TransactionalSection[];
  /** Bouton principal unique : `href` est une variable de lien (`{{actionUrl}}`). */
  cta: { href: string; label: string };
  /** Repli sous le bouton (chemin de navigation dans l'application). */
  ctaNote?: string;
  footer: {
    help: string;
    /** Variable portant l'adresse d'assistance configurée (ex. `supportEmail`). */
    supportEmailVariable: string;
    copyright: string;
  };
}

/** Texte du code → HTML (les variables `{{…}}` sont conservées telles quelles). */
function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const p = (text: string) => `<p style="${S.p}">${esc(text)}</p>`;

/** Document HTML complet du gabarit transactionnel commun (stocké en base : logo `{{logoUrl}}`, sans @font-face). */
export function buildTransactionalEmailHtml(spec: TransactionalEmailSpec): string {
  const sections = spec.sections.map((s) => [
    `<h2 style="${S.h2}margin-top:24px;">${esc(s.heading)}</h2>`,
    ...(s.paragraphs ?? []).map(p),
    s.steps?.length
      ? `<ol style="margin:0 0 16px 0;padding:0 0 0 24px;">${s.steps.map((t) => `<li style="${S.li}">${esc(t)}</li>`).join('')}</ol>`
      : '',
    ...(s.after ?? []).map(p),
  ].filter(Boolean).join('\n'));
  const content = [
    `<h1 style="${S.h1}">${esc(spec.h1)}</h1>`,
    ...spec.intro.map(p),
    ...sections,
    emailButton(spec.cta.href, esc(spec.cta.label)),
    spec.ctaNote ? `<p class="vb-muted" style="${S.muted}text-align:center;">${esc(spec.ctaNote)}</p>` : '',
  ].filter(Boolean).join('\n');
  const v = spec.footer.supportEmailVariable;
  const footer = [
    `<p class="vb-foot" style="margin:0 0 6px 0;${S.small}">${esc(spec.footer.help)}</p>`,
    `<p class="vb-foot" style="margin:0 0 6px 0;${S.small}"><a class="vb-link" href="mailto:{{${v}}}" style="${S.link}">{{${v}}}</a></p>`,
    `<p class="vb-foot" style="margin:0;${S.small}">${esc(spec.footer.copyright)}</p>`,
  ].join('\n');
  return emailDocument({
    title: esc(spec.documentTitle), content, footer, logo: '{{logoUrl}}', baseUrl: '', fontFace: false,
    compact: { headerLabel: esc(spec.headerLabel), preheader: esc(spec.preheader) },
  });
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', rsaquo: '›', laquo: '«', raquo: '»', hellip: '…', eacute: 'é', egrave: 'è', agrave: 'à',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? all;
  });
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '');

/**
 * Version texte brut d'un gabarit construit sur le gabarit transactionnel
 * commun. `brandName` remplace le logo (variable `{{logoUrl}}`).
 * Les variables `{{…}}` sont conservées : elles sont remplies ensuite.
 */
export function transactionalHtmlToText(html: string, brandName = 'Verebona'): string {
  let s = html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    // Pré-en-tête : aperçu de la boîte de réception, pas un contenu du message.
    .replace(/<div\b[^>]*data-vb-preheader[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/\r/g, '');
  // Logo : nom de la marque (une image n'a pas de version texte).
  s = s.replace(/<img\b[^>]*\{\{\s*logoUrl\s*\}\}[^>]*>/gi, brandName).replace(/\{\{\s*logoUrl\s*\}\}/g, brandName);
  s = s.replace(/<img\b[^>]*>/gi, '');
  // Mise en page du code source : sans valeur dans le texte.
  s = s.replace(/\s*\n\s*/g, ' ');
  // Listes numérotées : « 1. … ».
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_all, items: string) => {
    let n = 0;
    return `\n\n${items.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_li, item: string) => `${++n}. ${stripTags(item).trim()}\n`)}\n`;
  });
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_li, item: string) => `\n- ${stripTags(item).trim()}\n`);
  // Liens : bouton → « Libellé : lien » sur sa ligne ; adresse → l'adresse ; autre → « libellé (lien) ».
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_all, attrs: string, inner: string) => {
    const href = (/\bhref\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2] ?? '').trim();
    const label = stripTags(inner).trim();
    if (!href) return label;
    if (/^mailto:/i.test(href)) {
      const address = href.replace(/^mailto:/i, '');
      return !label || label === address ? address : `${label} (${address})`;
    }
    if (/\bvb-btn\b/.test(attrs)) return `\n\n${label} : ${href}\n\n`;
    return !label || label === href ? href : `${label} (${href})`;
  });
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:h[1-6]|p|div|table|ul)>/gi, '\n\n')
    .replace(/<\/td>\s*<td\b[^>]*>/gi, ' — ')
    .replace(/<\/td>/gi, ' ')
    .replace(/<\/tr>/gi, '\n');
  s = decode(stripTags(s));
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
