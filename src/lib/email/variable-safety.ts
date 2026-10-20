/**
 * Lot 73A (point 3, décision PO du 20/10) — insertion SÛRE des valeurs dans un
 * e-mail. Module PUR (aucun accès base), utilisé par `EmailService.renderTemplate`
 * (envoi réel, aperçu et test de l'éditeur du BO : même chemin).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS FAMILLES DE VARIABLES, reconnues par leur NOM (même convention que
 * l'éditeur du BO, `template-editor.ts`) :
 *
 *   · liens produits par l'application (`…Url`, `…Link`) dont la valeur est une
 *     URL http(s) : insérés tels quels (bouton, href, ligne « Libellé : URL »
 *     de la version texte) — seuls les caractères qui pourraient sortir d'un
 *     attribut (guillemets, chevrons, espaces) sont encodés. Une variable de
 *     lien dont la valeur n'est PAS une URL http(s) est traitée comme un texte ;
 *   · blocs HTML produits par le code (`…Html`, confirmation légale) : insérés
 *     tels quels en HTML, réduits à leur texte dans la version texte ;
 *   · tout le reste (prénom, nom, nom de bien, de document, de compte, titre et
 *     message d'une notification…) : valeur NEUTRALISÉE —
 *       1. entités décodées (valeurs déjà échappées par l'appelant : jamais de
 *          double échappement) ;
 *       2. balises retirées (`<a href…>`, `<img…>`) ; « a < b » reste un texte ;
 *       3. retours à la ligne et caractères de contrôle → une espace (ni faux
 *          paragraphe, ni fausse ligne « Libellé : URL » devenant un bouton) ;
 *          caractères de contrôle bidirectionnels retirés ;
 *       4. liens désarmés : « https:// » → « https[:]// », « javascript: » →
 *          « javascript[:] », et le point d'un nom de domaine (« pirate.example »,
 *          « www.… », adresse e-mail) remplacé par « ․ » (U+2024, visuellement
 *          un point) : aucune messagerie n'en fait un lien ;
 *     puis, en HTML seulement, échappement (& < > " ').
 *   Exception : `contactEmail` (adresse de configuration, jamais saisie par un
 *   utilisateur) n'est pas désarmée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { decodeEntities } from './template-editor';

export type InsertionMode = 'html' | 'text';

/** Valeurs de configuration (jamais saisies par un utilisateur) : non désarmées. */
const TRUSTED_TEXT_VARIABLES: ReadonlySet<string> = new Set(['contactEmail']);

const isLinkName = (name: string) => /(url|link)$/i.test(name);
const isHtmlName = (name: string) => /html$/i.test(name);
const isHttpUrl = (v: string) => /^https?:\/\/[^\s]+$/i.test(v);

const TAG = /<!--[\s\S]*?-->|<\/?[A-Za-z!?][^<>]*>/g;
const CONTROL = /\s*[\u0000-\u001f\u007f\u0085\u2028\u2029]+\s*/g;
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const SCHEME = /(?<![\p{L}\p{N}])([a-z][a-z0-9+.-]{1,20}):\/\//giu;
const DANGEROUS_SCHEME = /(?<![\p{L}\p{N}])(javascript|vbscript|data|file|mailto)\s*:(?!\/\/)/giu;
const DOMAIN = /(?<![\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,24}(?![\p{L}\p{N}-])/gu;
/** U+2024 ONE DOT LEADER : ressemble à un point, n'en est pas un pour un analyseur de liens. */
const DOT_LOOKALIKE = '\u2024';

export function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Désarme les liens d'un texte (schémas, domaines). */
export function defangLinks(v: string): string {
  return v
    .replace(SCHEME, '$1[:]//')
    .replace(DANGEROUS_SCHEME, '$1[:]')
    .replace(DOMAIN, (d) => d.replace(/\./g, DOT_LOOKALIKE));
}

/** Valeur saisie par un utilisateur → texte inerte sur une ligne (voir l'en-tête). */
export function neutralizeUserText(value: unknown, opts: { defang?: boolean } = {}): string {
  let s = decodeEntities(String(value ?? ''));
  s = s.replace(TAG, '').replace(BIDI, '').replace(CONTROL, ' ');
  if (opts.defang !== false) s = defangLinks(s);
  return s === String(value ?? '') ? s : s.trim();
}

/** Bloc HTML produit par le code → texte (version texte de l'e-mail). */
export function htmlBlockToText(value: string): string {
  return decodeEntities(value.replace(/<br\s*\/?>/gi, '\n').replace(TAG, ''))
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** Lien produit par l'application : aucun caractère ne peut sortir d'un attribut. */
export function safeLink(url: string): string {
  return url.trim().replace(/["'<>`\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** Valeur prête à être insérée dans le gabarit, selon la version (HTML ou texte). */
export function safeTemplateValue(name: string, value: unknown, mode: InsertionMode): string {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (name === 'logoUrl') return raw; // fourni par le service d'e-mail
  if (isHtmlName(name)) return mode === 'html' ? raw : htmlBlockToText(raw);
  if (isLinkName(name) && isHttpUrl(raw.trim())) return safeLink(raw);
  // Lot 73 (intégration 73B) : une adresse e-mail seule (ex. adresse invitée,
  // affichée à celui qui l'a saisie) reste lisible et copiable — ni schéma ni
  // balise possible dans ce format ; elle est échappée comme le reste.
  const plainEmail = /^[^\s@<>"'`()\[\]\\,;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(decodeEntities(raw).trim());
  const text = neutralizeUserText(raw, { defang: !TRUSTED_TEXT_VARIABLES.has(name) && !plainEmail });
  return mode === 'html' ? escapeHtml(text) : text;
}

export function safeTemplateVariables(variables: Record<string, unknown>, mode: InsertionMode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables ?? {})) out[k] = safeTemplateValue(k, v, mode);
  return out;
}
