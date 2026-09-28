/**
 * Verebona — composants documentaires HTML/CSS print (CDC §19.2).
 *
 * Portage TypeScript FIDÈLE de `maquettes/_system/components.mjs` (design
 * validé « design-v12 ») : même HTML, octet pour octet, pour les mêmes
 * données — contrôlé par `__tests__/v12-parity.test.ts`. Toute évolution du
 * rendu se fait d'abord dans les maquettes.
 *
 * Fonctions pures « données → chaîne HTML ». Tout composant retourne '' quand
 * il n'a rien à afficher : les templates omettent ainsi les champs et sections
 * optionnels vides sans condition (PDF-TXT-002 / 003).
 *
 * SÉCURITÉ : toute donnée utilisateur passe par `esc()` (texte et attributs).
 * Les seuls fragments insérés sans échappement sont du HTML produit par ces
 * composants ou des chaînes déjà échappées par l'appelant (paramètres nommés
 * `html`, `lead`, `render`) — voir `__tests__/v12-xss.test.ts`.
 *
 * Écart unique avec la maquette : `IntegratedPdfPage` accepte une page
 * `overlay` (cadre vide sur lequel la page PDF source est apposée en
 * vectoriel après l'impression, ANN-PDF-003/005).
 */

import { markDataUriOnce } from '../static-assets';
import type { Tone, ToneLabel, DocItem, PhotoItem, ExportInfo, Nullable } from '../types';

// ───────────────────────────── Utilitaires ─────────────────────────────

/** Échappement HTML. */
export const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Vide = null, undefined, '', espaces, [] (zéro n'est pas vide). */
export const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

type Part = unknown;

/** Joint les morceaux non vides avec « · ». */
export const dot = (...parts: Part[]): string => (parts.flat() as unknown[]).filter((p) => !isEmpty(p)).join(' · ');

/** Concatène des fragments HTML en ignorant les vides. */
export const join = (...parts: Part[]): string => (parts.flat() as unknown[]).filter(Boolean).join('\n');

const pad = (n: number) => String(n).padStart(2, '0');
/** Intl sépare les milliers par une espace fine (U+202F) ; la maquette utilise une espace insécable pleine. */
const nbsp = (s: string) => s.replace(/ /g, ' ');

/** Formats français (PDF-TXT-005 / 006). Pas d'objet Date : aucune dérive de fuseau. */
export const fmt = {
  /** 'YYYY-MM-DD' → 12/03/2024 · 'YYYY-MM' → 03/2024 · 'YYYY' → 2024 · ISO datetime → date locale écrite. */
  date(v: unknown): string {
    if (isEmpty(v)) return '';
    const s = String(v);
    let m: RegExpExecArray | null;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return `${m[3]}/${m[2]}/${m[1]}`;
    if ((m = /^(\d{4})-(\d{2})$/.exec(s))) return `${m[2]}/${m[1]}`;
    return s;
  },
  /** ISO '2026-09-28T09:14:00+02:00' → « 28/09/2026 à 09:14 » (heure locale telle qu'écrite). */
  dateTime(v: unknown): string {
    if (isEmpty(v)) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v));
    return m ? `${m[3]}/${m[2]}/${m[1]} à ${m[4]}:${m[5]}` : fmt.date(v);
  },
  /** Centimes → « 312 000 € » ; { decimals: true } → « 312 000,00 € ». */
  money(cents: unknown, { decimals = false }: { decimals?: boolean } = {}): string {
    if (isEmpty(cents)) return '';
    const euros = Number(cents) / 100;
    const d = decimals || !Number.isInteger(euros) ? 2 : 0;
    return nbsp(new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }).format(euros));
  },
  number(n: unknown, digits = 0): string {
    if (isEmpty(n)) return '';
    return nbsp(new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(Number(n)));
  },
  area(sqm: unknown): string { return isEmpty(sqm) ? '' : `${fmt.number(sqm, 1)} m²`; },
  km(n: unknown): string { return isEmpty(n) ? '' : `${fmt.number(n)} km`; },
  /** Octets → « 18,6 Mo ». */
  bytes(b: unknown): string {
    if (isEmpty(b)) return '';
    const mo = Number(b) / 1e6;
    return mo >= 1 ? `${fmt.number(mo, 1)} Mo` : `${fmt.number(Number(b) / 1e3)} Ko`;
  },
  pages(n: unknown): string { return isEmpty(n) ? '' : `${n} page${Number(n) > 1 ? 's' : ''}`; },
  /** Masquage d'identifiant : garde `start` + `end` caractères, `dots` puces au milieu. */
  mask(v: unknown, { start = 5, end = 4, dots = 5 }: { start?: number; end?: number; dots?: number } = {}): string {
    if (isEmpty(v)) return '';
    const s = String(v);
    if (s.length <= start + end) return s;
    return `${s.slice(0, start)}${'•'.repeat(dots)}${s.slice(-end)}`;
  },
  /** Échéance relative à la date de génération : « Dans 39 j », « Dans 3 mois », « En retard de 4 j ». */
  due(dueIso: string, refIso: string): { label: string; tone: Tone } {
    const d = (s: string) => { const [y, m, dd] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, dd); };
    const days = Math.round((d(dueIso) - d(refIso)) / 864e5);
    if (days < 0) return { label: `En retard de ${-days} j`, tone: 'bad' };
    if (days <= 60) return { label: days === 0 ? "Aujourd'hui" : `Dans ${days} j`, tone: 'warn' };
    return { label: `Dans ${Math.round(days / 30.4)} mois`, tone: 'ok' };
  },
};

/** Texte multi-paragraphes (\n\n) → <p> échappés. */
export const paragraphs = (text: unknown): string =>
  isEmpty(text) ? '' : String(text).split(/\n{2,}/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');

/** Titre sur plusieurs lignes : tableau de lignes → <br>. */
const lines = (v: unknown): string => (Array.isArray(v) ? v.map(esc).join('<br>') : esc(v));

/**
 * Borne un texte libre placé dans une zone de hauteur FIXE (en-tête, bannière
 * d'annexe, page « Références ») : au-delà de `max` caractères il est coupé
 * avec « … ». Garantit l'invariant de pagination de `render/render-pdf.ts`
 * (une page par page d'annexe, une seule page « Références »).
 */
export const clip = <T,>(v: T, max: number): T | string =>
  (typeof v === 'string' && v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v);

/** Bornes des zones de hauteur fixe (caractères). */
export const TEXT_BOUNDS = { header: 110, bannerTitle: 140, bannerMeta: 90, refsMeta: 80, refsLead: 60, refsParagraph: 700 } as const;

// ───────────────────────────── Page, en-tête, pied ─────────────────────────────

/**
 * Caractères écrits tels quels dans une chaîne CSS : lettres et chiffres de
 * toutes écritures, espaces simples et ponctuation courante. Tout le reste
 * (`"`, `\`, `<`, `>`, `{`, `}`, `;`, `(`, `)`, caractères de contrôle, séparateurs
 * Unicode…) est écrit en échappement hexadécimal CSS `\HHHHHH ` : la valeur ne
 * peut ni fermer la chaîne, ni fermer la balise <style>, ni ouvrir un `url()`.
 */
const CSS_SAFE_CHAR = /^[\p{L}\p{M}\p{N} .,:!?'’·–—«»…%°&+=@#*/_\-]$/u;

export const cssString = (s: unknown): string => {
  let out = '';
  // NUL, CR, FF supprimés (CR/FF = fins de ligne CSS, NUL = remplacé par U+FFFD) ;
  // tabulations et retours ligne ramenés à une espace (en-tête sur une ligne).
  const text = String(s ?? '').replace(/[\u0000\r\f]/g, '').replace(/[\t\n\v]+/g, ' ');
  for (const ch of text) {
    if (CSS_SAFE_CHAR.test(ch)) { out += ch; continue; }
    const cp = ch.codePointAt(0)!;
    // Contrôles C0/C1 restants et substituts isolés : supprimés.
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff)) continue;
    out += `\\${cp.toString(16).toUpperCase()} `;
  }
  return `"${out}"`;
};

/** `object-position` d'une photo : seul le motif « NN% NN% » est admis. */
const safeFocus = (v: unknown): string => {
  const s = String(v ?? '');
  return /^\d{1,3}% \d{1,3}%$/.test(s) ? s : '50% 50%';
};

/**
 * Règles @page du dossier : en-tête « [marque] Verebona … <headerLabel> » et pied
 * « Ce dossier a été préparé avec Verebona. · Page X / Y » en boîtes de marge,
 * pages nommées cover / annex / refs (PDF-TXT-007 à 009).
 *
 * `headerLabel` contient des données utilisateur : il est écrit comme CHAÎNE
 * CSS par `cssString` (liste blanche de caractères, le reste en échappement
 * hexadécimal) : il ne peut ni sortir de la chaîne ni fermer la balise <style>.
 */
export function pageSetup({ headerLabel }: { headerLabel: string }): string {
  const chrome = 'font-family:Inter,sans-serif;font-size:10.5px;color:#8A93A6;';
  const footer = `
    @bottom-left { content: "Ce dossier a été préparé avec Verebona."; ${chrome} vertical-align: bottom; padding-bottom: 26px; }
    @bottom-right { content: "Page " counter(page) " / " counter(pages); ${chrome} vertical-align: bottom; padding-bottom: 26px; text-align: right; }`;
  return `<style>
  @page {
    size: A4;
    margin: 70px 44px 64px 44px;
    @top-left { content: "Verebona"; font-family: Inter, sans-serif; font-size: 10.5px; font-weight: 600; color: #0F1B33;
      vertical-align: top; padding: 22px 0 0 22px; background: url(${markDataUriOnce()}) no-repeat 0 21.5px / 14px 14px; }
    @top-right { content: ${cssString(clip(headerLabel, TEXT_BOUNDS.header))}; ${chrome} vertical-align: top; padding-top: 22px; text-align: right; }
    ${footer}
  }
  @page cover { margin: 0; @top-left { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
  @page annex {
    margin: 0 0 64px 0;
    @top-left { content: none; } @top-right { content: none; }
    @bottom-left { padding-left: 44px; } @bottom-right { padding-right: 44px; }
  }
  @page refs {
    @bottom-left { padding-bottom: 34px; } @bottom-right { padding-bottom: 34px; }
    @bottom-center { content: "verebona.fr"; ${chrome} vertical-align: bottom; padding-bottom: 34px; text-align: center; }
  }
</style>`;
}

/** Document HTML complet. */
export function htmlDocument({ title, lang = 'fr', stylesheets = [], head = '', body }: { title: string; lang?: string; stylesheets?: string[]; head?: string; body: string }): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
${stylesheets.map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join('\n')}
${head}
</head>
<body>
${body}
</body>
</html>
`;
}

// ───────────────────────────── Couvertures ─────────────────────────────

const brand = (sys: string, dark = true) =>
  `<div class="brand"><img src="${sys}assets/brand/${dark ? 'verebona-mark-on-dark.svg' : 'verebona-mark.svg'}" alt=""><span>Verebona</span></div>`;

export interface MetaItem { label: string; value: Nullable<string | number> }

const coverMeta = (items: Nullable<MetaItem[]>) => {
  const kept = (items ?? []).filter((i) => !isEmpty(i?.value));
  if (!kept.length) return '';
  return `<div class="cover-meta">${kept.map((i) => `<div><div class="k">${esc(i.label)}</div><div class="v">${esc(i.value)}</div></div>`).join('')}</div>`;
};

/** « Page 1 / N » de couverture (la couverture n'a pas de boîte de marge). */
const coverFoot = (pageLabel: Nullable<string>) =>
  `<div class="cover-foot"><span>Ce dossier a été préparé avec Verebona.</span><span>${esc(pageLabel ?? '')}</span></div>`;

export interface CoverPhoto { src: string; focus?: Nullable<string> }

/**
 * CoverDocumentary — CIL, dossier complet, assurances. Sans rupture, infos clés visibles.
 *  variant 'regulatory' : marine, halo bleu, trame de points, encadré « Nature du document » (CIL)
 *  variant 'premium'    : marine, double halo, panneau photo arrondi si photo retenue (dossier complet)
 *  variant 'band'       : papier + bandeau marine, fiche sous le bandeau (assurances)
 */
export function CoverDocumentary({ sys, variant = 'regulatory', kind, kicker, titleLines, address, lead, leadWidth, note, photo, meta, sheet, pageLabel }: {
  sys: string; variant?: 'regulatory' | 'premium' | 'band'; kind: string; kicker?: Nullable<string>; titleLines: string[] | string;
  address?: string[] | string; lead?: Nullable<string>; leadWidth?: number; note?: { label: string; text: string } | null;
  photo?: CoverPhoto | null; meta?: MetaItem[]; sheet?: string; pageLabel?: string;
}): string {
  const top = `<div class="cover-top">${brand(sys)}<div class="cover-kind">${esc(kind)}</div></div>`;
  const h1 = `<h1>${lines(titleLines)}</h1>`;
  const kick = isEmpty(kicker) ? '' : `<div class="cover-kicker">${esc(kicker)}</div>`;
  if (variant === 'band') {
    return `<section class="cover band">
  <div class="cover-band">${top}${kick}${h1}${isEmpty(lead) ? '' : `<p class="cover-lead"${leadWidth ? ` style="max-width:${leadWidth}px"` : ''}>${esc(lead)}</p>`}</div>
  <div class="cover-sheet">${sheet ?? ''}</div>
  ${coverFoot(pageLabel)}
</section>`;
  }
  const premium = variant === 'premium';
  return `<section class="cover ${premium ? 'premium' : ''} ${premium && !photo ? 'no-photo' : ''}">
  <div class="halo ${premium ? 'premium' : ''}"></div><div class="dots ${premium ? 'premium' : ''}"></div>
  ${top}
  <div class="cover-body">${kick}${h1}
    ${isEmpty(address) ? '' : `<div class="cover-address">${lines(address)}</div>`}
    ${isEmpty(lead) ? '' : `<p class="cover-lead">${esc(lead)}</p>`}
    ${note ? `<div class="cover-note"><div class="cover-kind">${esc(note.label)}</div><p>${esc(note.text)}</p></div>` : ''}
  </div>
  ${premium && photo ? `<div class="cover-photo"><img src="${esc(photo.src)}" alt="" style="object-position:${safeFocus(photo.focus)}"></div>` : ''}
  ${coverMeta(meta)}
  ${coverFoot(pageLabel)}
</section>`;
}

/**
 * CoverMarketing — vente, location. Première photo retenue en plein cadre sous un
 * dégradé ; sans photo, repli graphique (fond marine, halo, trame).
 */
export function CoverMarketing({ sys, kind, kicker, titleLines, lead, photo, meta, pageLabel }: {
  sys: string; kind: string; kicker?: Nullable<string>; titleLines: string[] | string; lead?: Nullable<string>;
  photo?: CoverPhoto | null; meta?: MetaItem[]; pageLabel?: string;
}): string {
  const bg = photo
    ? `<img class="shot" src="${esc(photo.src)}" alt="" style="object-position:${safeFocus(photo.focus)}"><div class="scrim"></div>`
    : `<div class="halo"></div><div class="dots"></div>`;
  return `<section class="cover marketing ${photo ? 'photo' : 'fallback'}">
  ${bg}
  <div class="cover-top">${brand(sys)}<div class="cover-kind">${esc(kind)}</div></div>
  <div class="cover-bottom">
    ${isEmpty(kicker) ? '' : `<div class="cover-kicker">${esc(kicker)}</div>`}
    <h1>${lines(titleLines)}</h1>
    ${isEmpty(lead) ? '' : `<p class="cover-lead">${esc(lead)}</p>`}
    ${coverMeta(meta)}
  </div>
  ${coverFoot(pageLabel)}
</section>`;
}

// ───────────────────────────── Titres ─────────────────────────────

/**
 * Section : sur-titre (numéro « 01 », « 04 · suite » ou libellé) + titre h2 + chapô.
 * `gap` : 'xl' 44 px, 'lg' 38 px (défaut), 'md' 34 px, 'sm' 30 px ; `first` : sans marge.
 * `size` : 'sm' pour un titre 22 px. `leadGap` : 'lg' | 'md' | 'sm'.
 * `className` : 'index' rend la section insécable (index d'annexes court : jamais coupé).
 * `lead` est du HTML : l'appelant échappe les données qu'il y place.
 */
export function Section({ eyebrow, title, lead, leadGap, size, gap, first = false, body, className = '' }: {
  eyebrow?: Nullable<string>; title: string; lead?: Nullable<string>; leadGap?: string; size?: string; gap?: string;
  first?: boolean; body: Nullable<string>; className?: string;
}): string {
  if (isEmpty(body)) return '';
  const cls = ['sec', first ? 'first' : '', gap && gap !== 'lg' ? `gap-${gap}` : '', className].filter(Boolean).join(' ');
  const head = `<div class="sec-head">
  ${isEmpty(eyebrow) ? '' : `<div class="eyebrow">${esc(eyebrow)}</div>`}
  <h2 class="sec-title ${size === 'sm' ? 'sm' : ''} ${isEmpty(lead) ? '' : 'has-lead'}">${esc(title)}</h2>
  ${isEmpty(lead) ? '' : `<p class="sec-lead ${leadGap ?? ''}">${lead}</p>`}
</div>`;
  // .sec-head porte break-after: avoid : le titre reste solidaire du premier élément.
  return `<section class="${cls}">${head}
${body}
</section>`;
}

/** Numérotation continue des sections affichées (01, 02, …). */
export function counter(): () => string {
  let n = 0;
  return () => pad(++n);
}

// ───────────────────────────── Statuts ─────────────────────────────

export const STATUS: Record<string, ToneLabel> = {
  complete: { label: 'Renseigné', tone: 'ok' },
  unknown: { label: 'À compléter', tone: 'warn' },
  missing: { label: 'Manquant', tone: 'bad' },
  // CDC §2.1 « invalid » (ex. travaux sans date) : la maquette n'a que 4 libellés, il est rendu « À compléter ».
  invalid: { label: 'À compléter', tone: 'warn' },
  not_applicable: { label: 'Non applicable', tone: '' },
};

/** Pastille de statut. `status` : clé de STATUS ou { label, tone }. */
export function StatusPill(status: Nullable<string | ToneLabel>, { size }: { size?: string } = {}): string {
  const s = typeof status === 'string' ? STATUS[status] ?? { label: status, tone: '' as Tone } : status;
  if (!s || isEmpty(s.label)) return '';
  return `<span class="pill ${s.tone ?? ''} ${size === 'lg' ? 'lg' : ''}">${esc(s.label)}</span>`;
}

/** En-tête de bloc CIL : code bleu · titre · pastille. */
export function BlockHeader({ code, title, status }: { code: string; title: string; status?: Nullable<string | ToneLabel> }): string {
  return `<div class="blk-head"><span class="blk-code">${esc(code)}</span><h2 class="blk-title">${esc(title)}</h2>${status ? StatusPill(status) : ''}</div>`;
}

/** Compteurs de statut (CIL : renseignés / à compléter / bloquants / non applicables). */
export function StatusCounters(items: Array<{ value: number | string; label: string; tone?: Tone }>): string {
  return `<div class="counters">${items.map((i) => `<div class="counter ${i.tone ?? ''}"><div class="n">${esc(i.value)}</div><div class="l">${esc(i.label)}</div></div>`).join('')}</div>`;
}

// ───────────────────────────── SummaryCard ─────────────────────────────

/**
 * SummaryCard — synthèse (5 à 7 lignes en cas nominal).
 *  rows : [{ label, value, strong }] (lignes vides masquées) · ou paragraphs : 'texte\n\ntexte'
 *  labelWidth : 110 (défaut) · 120 · 130 px.
 */
export function SummaryCard({ rows, paragraphs: text, labelWidth = 110 }: {
  rows?: Array<{ label: string; value: Nullable<string>; strong?: boolean }>; paragraphs?: Nullable<string>; labelWidth?: number;
}): string {
  if (!isEmpty(text)) return `<div class="summary prose">${paragraphs(text)}</div>`;
  const kept = (rows ?? []).filter((r) => !isEmpty(r.value));
  if (!kept.length) return '';
  return `<div class="summary rows" style="--label-w:${labelWidth}px">${kept
    .map((r) => `<div class="row"><span class="k">${esc(r.label)}</span><span class="v ${r.strong === false ? '' : 'strong'}">${esc(r.value)}</span></div>`)
    .join('')}</div>`;
}

// ───────────────────────────── KeyValueGrid ─────────────────────────────

export interface KvRow { label: string; value: Nullable<string | number> }

/**
 * KeyValueGrid — masque automatiquement les champs vides.
 *  variant : 'grid' (2 colonnes, défaut) · 'compact' (2 colonnes, 8 px) · 'one' (1 colonne, 8 px)
 *            · 'stack' (libellé 150 px, valeur à gauche : conditions de vente / location)
 */
export function KeyValueGrid(rows: Nullable<Array<Nullable<KvRow>>>, { variant = 'grid', className = '' }: { variant?: 'grid' | 'compact' | 'one' | 'stack'; className?: string } = {}): string {
  const kept = (rows ?? []).filter((r): r is KvRow => !!r && !isEmpty(r.value));
  if (!kept.length) return '';
  const cls = ({ grid: 'kv', compact: 'kv compact', one: 'kv one compact open', stack: 'kv stack' } as Record<string, string>)[variant] ?? 'kv';
  return `<div class="${cls} ${className}">${kept
    .map((r) => `<div class="row"><span class="k">${esc(r.label)}</span><span class="v">${esc(r.value)}</span></div>`)
    .join('')}</div>`;
}

// ───────────────────────────── Chiffres, étiquettes ─────────────────────────────

export interface FigureItem { label: string; value: Nullable<string>; sub?: Nullable<string>; primary?: boolean }

/** Cartes de chiffres clés. items : [{ label, value, sub, primary }] ; `tight` : variante 16 × 18 px. */
export function FigureCards(items: Nullable<FigureItem[]>, { tight = false, large = false, className = '' }: { tight?: boolean; large?: boolean; className?: string } = {}): string {
  const kept = (items ?? []).filter((i) => !isEmpty(i.value));
  if (!kept.length) return '';
  return `<div class="figures ${tight ? 'tight' : ''} ${className}" >${kept
    .map((i) => `<div class="figure ${i.primary ? 'primary' : ''}"><div class="eyebrow">${esc(i.label)}</div><div class="val ${large ? 'lg' : ''}">${esc(i.value)}</div>${isEmpty(i.sub) ? '' : `<div class="sub">${esc(i.sub)}</div>`}</div>`)
    .join('')}</div>`;
}

/** Bloc prix (vente) : carte marine 200 px + conditions en liste. */
export function PriceBlock({ price, rows }: { price: { label: string; value: string; sub?: Nullable<string> } | null; rows: KvRow[] }): string {
  const list = KeyValueGrid(rows, { variant: 'stack' });
  if (!price && !list) return '';
  if (!price) return list;
  return `<div class="price-block"><div class="figure primary price"><div class="eyebrow">${esc(price.label)}</div><div class="val">${esc(price.value)}</div>${isEmpty(price.sub) ? '' : `<div class="sub">${esc(price.sub)}</div>`}</div>${list || '<div></div>'}</div>`;
}

/** Étiquettes DPE / GES + grille compacte (CIL B8). */
export function EnergyTiles({ dpe, ges, rows }: { dpe?: Nullable<string>; ges?: Nullable<string>; rows: KvRow[] }): string {
  const tiles = ([['DPE', dpe], ['GES', ges]] as Array<[string, Nullable<string>]>).filter(([, v]) => !isEmpty(v))
    .map(([t, v]) => `<div class="energy-tile"><span class="t">${t}</span><span class="c">${esc(v)}</span></div>`).join('');
  const grid = KeyValueGrid(rows, { variant: 'compact' });
  if (!tiles && !grid) return '';
  if (!tiles) return grid;
  return `<div class="energy"><div class="energy-tiles">${tiles}</div>${grid || '<div></div>'}</div>`;
}

/** Pastilles d'équipements. */
export function Chips(items: Nullable<Array<Nullable<string>>>, { large = false }: { large?: boolean } = {}): string {
  const kept = (items ?? []).filter((i) => !isEmpty(i));
  if (!kept.length) return '';
  return `<div class="chips ${large ? 'lg' : ''}">${kept.map((i) => `<span class="chip">${esc(i)}</span>`).join('')}</div>`;
}

/** Cartes 2 colonnes (points forts, protections, garanties, actions). items : [{ when, title, text }]. */
export function Cards(items: Nullable<Array<{ when?: Nullable<string>; title: Nullable<string>; text?: Nullable<string> }>>, { small = false }: { small?: boolean } = {}): string {
  const kept = (items ?? []).filter((i) => !isEmpty(i.title));
  if (!kept.length) return '';
  return `<div class="cards ${small ? 'sm' : ''} ${kept.length <= 6 ? 'keep' : ''}">${kept
    .map((i) => `<div class="card">${isEmpty(i.when) ? '' : `<div class="when">${esc(i.when)}</div>`}<div class="t">${esc(i.title)}</div>${isEmpty(i.text) ? '' : `<div class="d">${esc(i.text)}</div>`}</div>`)
    .join('')}</div>`;
}

/** Lignes datées encadrées (suivi rassurant, échanges, état). items : [{ date, title, aside }]. */
export function LineRows(items: Nullable<Array<{ date?: Nullable<string>; dateLabel?: Nullable<string>; title: Nullable<string>; aside?: Nullable<string> }>>): string {
  const kept = (items ?? []).filter((i) => !isEmpty(i.title));
  if (!kept.length) return '';
  // Liste courte (≤ 6 lignes) : insécable, elle passe entière à la page suivante.
  return `<div class="rows ${kept.length <= 6 ? 'keep' : ''}">${kept
    .map((i) => `<div class="line-row"><span class="when">${esc(fmt.date(i.date) || i.dateLabel || '')}</span><span class="t">${esc(i.title)}</span>${isEmpty(i.aside) ? '' : `<span class="aside">${esc(i.aside)}</span>`}</div>`)
    .join('')}</div>`;
}

/** Échéances à venir : titre · date · pastille relative (calculée à la date de génération). */
export function DeadlineRows(items: Nullable<Array<{ title: Nullable<string>; date: Nullable<string> }>>, { refDate }: { refDate: string }): string {
  const kept = (items ?? []).filter((i) => !isEmpty(i.title) && !isEmpty(i.date));
  if (!kept.length) return '';
  return `<div class="rows tight ${kept.length <= 6 ? 'keep' : ''}">${kept
    .map((i) => {
      const d = fmt.due(String(i.date), refDate);
      return `<div class="line-row due"><span class="t">${esc(i.title)}</span><span class="aside">${esc(fmt.date(i.date))}</span>${StatusPill(d, { size: 'lg' })}</div>`;
    })
    .join('')}</div>`;
}

/** Note encadrée (texte déjà échappé ou HTML contrôlé). */
export const Note = (html: Nullable<string>, { after = false, large = false }: { after?: boolean; large?: boolean } = {}): string =>
  isEmpty(html) ? '' : `<div class="note ${after ? 'after' : ''} ${large ? 'lg' : ''}">${html}</div>`;

// ───────────────────────────── LongTable ─────────────────────────────

export interface Column<R> {
  label: string;
  key?: keyof R & string;
  /** Renvoie du HTML : l'appelant échappe. */
  render?: (row: R) => string;
  className?: string | ((row: R) => string);
  width?: number;
  align?: 'r';
}

/**
 * LongTable — en-tête répété à chaque page (thead), lignes insécables.
 *  columns : [{ label, key | render(row), className (texte ou fonction de la ligne), width, align:'r' }]
 *  rows    : objets ; une ligne dont toutes les cellules sont vides est ignorée.
 *  airy    : cellules 11 px (historique, état CIL).
 */
export function LongTable<R>({ columns, rows, airy = false, className = '' }: { columns: Array<Column<R>>; rows: Nullable<Array<Nullable<R>>>; airy?: boolean; className?: string }): string {
  const kept = (rows ?? []).filter(Boolean) as R[];
  if (!kept.length) return '';
  const cell = (c: Column<R>, r: R) => (c.render ? c.render(r) : esc((c.key ? (r as Record<string, unknown>)[c.key] : '') ?? ''));
  return `<table class="table ${airy ? 'airy' : ''} ${className}">
<thead><tr>${columns.map((c) => `<th class="${c.align === 'r' ? 'r' : ''}"${c.width ? ` style="width:${c.width}px"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
<tbody>${kept.map((r) => `<tr>${columns.map((c) => `<td class="${[typeof c.className === 'function' ? c.className(r) : c.className, c.align === 'r' ? 'r' : ''].filter(Boolean).join(' ')}">${cell(c, r)}</td>`).join('')}</tr>`).join('\n')}</tbody>
</table>`;
}

/** Cellule titre + sous-titre (tableaux). */
export const cellTS = (t: unknown, s: unknown): string => `<span class="cell-t">${esc(t)}</span>${isEmpty(s) ? '' : `<span class="cell-s">${esc(s)}</span>`}`;

// ───────────────────────────── DocumentList ─────────────────────────────

const FORMAT_LABEL: Record<string, string> = { PDF: 'PDF', JPG: 'JPG', JPEG: 'JPG', PNG: 'PNG', WEBP: 'IMG', DOCX: 'DOC', DOC: 'DOC', XLSX: 'XLS', HEIC: 'IMG', ZIP: 'ZIP' };

/** Document décoré par `planAttachments` (référence d'annexe ou chemin ZIP). */
export type PlannedDoc = DocItem & { annexRef?: string; pageCount?: number; startPage?: number | null; bannerType?: Nullable<string>; bannerExtra?: Nullable<string> };

/** Ligne de méta d'un document : type · date · pages · précision. */
export const docMeta = (d: DocItem): string => dot(d.typeLabel, fmt.date(d.date), fmt.pages(d.pages), d.detail);

/** Pastille de destination : « Intégré · annexe A1 » (bleue) / « Joint au ZIP » (neutre). */
export function destinationPill(d: PlannedDoc, { short = false }: { short?: boolean } = {}): string {
  if (d.annexRef) return `<span class="pill blue">Intégré · ${short ? '' : 'annexe '}${esc(d.annexRef)}</span>`;
  if (d.zipPath) return `<span class="pill">Joint au ZIP</span>`;
  return '';
}

/**
 * DocumentList — titre, type, date, format, destination.
 *  docs : documents décorés par planAttachments() (annexRef / zipPath).
 *  Badge de format : ton `d.tone` ('amber' diagnostics énergie, 'green' attestations,
 *  'neutral' pièces volumineuses / techniques) — bleu par défaut.
 */
export function DocumentList(docs: Nullable<PlannedDoc[]>): string {
  const kept = (docs ?? []).filter(Boolean);
  if (!kept.length) return '';
  return `<div class="docs">${kept
    .map((d) => `<div class="doc"><span class="fmt ${esc(d.tone ?? '')}">${esc(FORMAT_LABEL[String(d.format).toUpperCase()] ?? d.format)}</span><span class="body"><span class="t">${esc(d.title)}</span><span class="m">${esc(docMeta(d))}</span></span>${destinationPill(d)}</div>`)
    .join('')}</div>`;
}

/** Tableau des documents joints au ZIP : fichier + chemin, colonne libre, date, taille. */
export function ZipTable(zip: PlannedDoc[], { secondColumn = { label: 'Type', render: (d: PlannedDoc) => esc(d.typeLabel ?? '') } }: { secondColumn?: { label: string; render: (d: PlannedDoc) => string } } = {}): string {
  return LongTable<PlannedDoc>({
    columns: [
      { label: 'Fichier', render: (d) => `<span class="cell-t">${esc(d.zipTitle ?? d.title)}</span><span class="cell-path">/${esc(d.zipPathLabel ?? d.zipPath)}</span>` },
      { label: secondColumn.label, render: secondColumn.render, className: 'muted' },
      { label: 'Date', render: (d) => esc(fmt.date(d.date)), className: 'muted nowrap' },
      { label: 'Taille', render: (d) => esc(fmt.bytes(d.sizeBytes)), className: 'muted nowrap', align: 'r' },
    ],
    rows: zip,
  });
}

// ───────────────────────────── AnnexIndex ─────────────────────────────

/** Plage de pages « p. 9–14 » (ou « p. — » avant la 2e passe de rendu). */
export const pageRange = (start: Nullable<number>, count: number): string =>
  !start ? 'p. —' : count > 1 ? `p. ${start}–${start + count - 1}` : `p. ${start}`;

/**
 * AnnexIndex — précède les pièces intégrées (ANN-PDF-001/002).
 *  annexes : [{ annexRef, title, pageCount, startPage, indexMeta }]
 *  density : 'tight' (10 px) · 'mid' (11 px) · défaut 12 px.
 */
export function AnnexIndex(annexes: Nullable<PlannedDoc[]>, { meta = (a: PlannedDoc) => dot(fmt.date(a.date), fmt.pages(a.pageCount)), density = '' }: { meta?: (a: PlannedDoc) => string; density?: string } = {}): string {
  if (!annexes?.length) return '';
  return `<div class="annex-index ${density}">${annexes
    .map((a) => `<div class="row"><span class="ref">${esc(a.annexRef)}</span><span class="t">${esc(a.annexTitle ?? a.title)}</span><span class="m">${esc(meta(a))}</span><span class="p">${esc(pageRange(a.startPage, a.pageCount ?? 1))}</span></div>`)
    .join('')}</div>`;
}

// ───────────────────────────── IntegratedPdfPage ─────────────────────────────

const PREVIEW_TEXT: Record<string, string> = {
  pdf: "Page du PDF source rendue à l'échelle, ratio préservé.",
  image: 'Image ou scan intégré en pleine page, centré, sans déformation.',
  plan: "Plan rendu à l'échelle, ratio préservé, sans recadrage.",
};

/**
 * IntegratedPdfPage — une page par page source (ANN-PDF-003 à 005) : bannière
 * « A1 · titre · type · date · Page n / N du document » puis contenu source.
 * En maquette, cadre « Contenu source » ; si `page.src` est fourni, l'image de la
 * page est posée en contain (ratio préservé, aucun recadrage, rien par-dessus).
 * Si `page.overlay`, le cadre est laissé vide : la page PDF source y est apposée
 * en vectoriel par `render/annexes.ts` après l'impression.
 */
export function IntegratedPdfPage(a: PlannedDoc, pageIndex: number): string {
  const p = a.preview?.pages?.[pageIndex] ?? {};
  const kind = a.preview?.kind ?? 'pdf';
  const frame = p.src
    ? `<div class="annex-frame has-img"><img src="${esc(p.src)}" alt=""></div>`
    : p.overlay
      ? `<div class="annex-frame has-img"></div>`
      : `<div class="annex-frame ${kind === 'pdf' ? 'ruled' : ''}"><div><div class="eyebrow">Contenu source</div><div class="txt">${esc(a.preview?.note ?? PREVIEW_TEXT[kind] ?? PREVIEW_TEXT.pdf)}</div></div></div>`;
  return `<section class="annex-page">
  <div class="annex-banner"><span class="ref">${esc(a.annexRef)}</span><span class="t">${esc(clip(a.annexTitle ?? a.title, TEXT_BOUNDS.bannerTitle))}</span><span class="m">${esc(clip(dot(a.bannerType ?? a.typeLabel, a.bannerExtra, fmt.date(a.date)), TEXT_BOUNDS.bannerMeta))}</span><span class="p">Page ${pageIndex + 1} / ${a.pageCount} du document</span></div>
  ${frame}
</section>`;
}

/** Toutes les pages intégrées, dans l'ordre de l'index. */
export const IntegratedPages = (annexes: Nullable<PlannedDoc[]>): string =>
  (annexes ?? []).map((a) => Array.from({ length: a.pageCount ?? 1 }, (_, i) => IntegratedPdfPage(a, i)).join('\n')).join('\n');

// ───────────────────────────── PhotoGallery ─────────────────────────────

export type GalleryPhoto = PhotoItem & { src: string };

const photoImg = (p: GalleryPhoto, h?: number) =>
  `<img src="${esc(p.src)}" alt="" style="${h ? `height:${h}px;` : ''}object-position:${safeFocus(p.focus)}">`;
const caption = (p: GalleryPhoto) => {
  const ref = isEmpty(p.ref) ? '' : `<b>${esc(p.ref)}</b> · `;
  const txt = isEmpty(p.caption) ? '' : esc(p.caption);
  return ref || txt ? `<figcaption>${ref}${txt}</figcaption>` : '';
};

/**
 * PhotoGallery — 1 à 4 photos par rangée selon le gabarit, légendes factuelles.
 *  layout : 'grid2' (2 colonnes, légende dessous) · 'grid3' · 'grid4'
 *           · 'feature' (1 grande + 2, légendes en surimpression — vente)
 *           · 'hero' (1 large + 2, surimpression — location)
 *  height : hauteur d'image (px) pour les grilles ; dim : désaturation légère (sinistre).
 */
export function PhotoGallery(photos: Nullable<GalleryPhoto[]>, { layout = 'grid2', height = 190, dim = false }: { layout?: 'grid2' | 'grid3' | 'grid4' | 'feature' | 'hero'; height?: number; dim?: boolean } = {}): string {
  const kept = (photos ?? []).filter((p) => p && !isEmpty(p.src));
  if (!kept.length) return '';
  if (layout === 'feature' && kept.length >= 2) {
    // 1 grande photo (2 rangées de 230 px) + 1 à 3 photos empilées à droite.
    const side = kept.slice(1, 4);
    const rowH = (472 - (side.length - 1) * 12) / side.length;
    const main = `<figure style="grid-row:span ${side.length}">${photoImg(kept[0])}${caption(kept[0])}</figure>`;
    return `<div class="gallery overlay feature" style="grid-auto-rows:${rowH}px">${main}${side.map((p) => `<figure>${photoImg(p)}${caption(p)}</figure>`).join('')}</div>${kept.length > 4 ? PhotoGallery(kept.slice(4), { layout: 'grid2', height: 230 }) : ''}`;
  }
  if (layout === 'hero' && kept.length >= 1) {
    // 1 photo large (300 px) + 1 à 3 photos côte à côte (190 px) ; au-delà, rangées de 2.
    const [first, ...rest] = kept;
    const row = rest.slice(0, 3);
    const cols = Math.max(row.length, 1);
    return `<div class="gallery overlay hero" style="grid-template-columns:repeat(${cols},1fr)"><figure class="wide" style="grid-column:1 / ${cols + 1}">${photoImg(first)}${caption(first)}</figure>${row.map((p) => `<figure>${photoImg(p)}${caption(p)}</figure>`).join('')}</div>${rest.length > 3 ? PhotoGallery(rest.slice(3), { layout: 'grid2', height: 190 }) : ''}`;
  }
  const cls = ({ grid2: 'g2', grid3: 'g3', grid4: 'g4', feature: 'g2', hero: 'g2' } as Record<string, string>)[layout] ?? 'g2';
  return `<div class="gallery ${cls} ${dim ? 'dim' : ''}">${kept.map((p) => `<figure>${photoImg(p, height)}${caption(p)}</figure>`).join('')}</div>`;
}

// ───────────────────────────── Timeline ─────────────────────────────

/**
 * Timeline — dates alignées à droite, rail à pastilles, ordre chronologique.
 *  events : [{ date, dateLabel, title, text, tone: 'past' | 'key' | 'open' | undefined }]
 */
export function Timeline(events: Nullable<Array<{ date?: Nullable<string>; dateLabel?: Nullable<string>; title: Nullable<string>; text?: Nullable<string>; tone?: Nullable<string> }>>): string {
  const kept = (events ?? []).filter((e) => !isEmpty(e.title))
    .slice().sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  if (!kept.length) return '';
  return `<div class="timeline">${kept
    .map((e) => `<div class="tl-row ${esc(e.tone ?? '')}"><div class="tl-date">${esc(e.dateLabel ?? fmt.date(e.date))}</div><div class="tl-rail"><span class="dot"></span><span class="bar"></span></div><div class="tl-body"><div class="t">${esc(e.title)}</div>${isEmpty(e.text) ? '' : `<div class="d">${esc(e.text)}</div>`}</div></div>`)
    .join('')}</div>`;
}

// ───────────────────────────── Références et limites ─────────────────────────────

const DISCLAIMER =
  "Ce dossier est généré par Verebona à partir des informations et documents que vous avez importés. Il sert à structurer, synthétiser et transmettre vos informations. Il ne constitue ni une certification, ni une validation juridique, ni un conseil juridique.";

/**
 * Dernière page « Références / Sources et limites » : méta de génération,
 * méthode et limites, carte mascotte en bas de page, pied « verebona.fr ».
 *  paragraphs : ['texte'] ou [{ lead: 'Méthode.', text }] (liste avec intitulés gras).
 */
export function References({ sys, title, exportInfo, paragraphs: paras }: {
  sys: string; title: string; exportInfo: ExportInfo; paragraphs: Array<string | { lead?: string; text: string }>;
}): string {
  const meta = KeyValueGrid([
    { label: 'Généré le', value: fmt.dateTime(exportInfo.generatedAt) },
    { label: 'Préparé par', value: clip(exportInfo.preparedBy, TEXT_BOUNDS.refsMeta) },
    { label: 'Référence', value: clip(exportInfo.reference, TEXT_BOUNDS.refsMeta) },
    { label: 'Modèle', value: exportInfo.templateVersion },
  ]);
  // Page de hauteur fixe : textes bornés (voir `clip`).
  const para = (t: unknown) => clip(t, TEXT_BOUNDS.refsParagraph);
  const structured = (paras ?? []).some((p) => typeof p === 'object');
  const text = structured
    ? `<div class="refs-text list">${paras.map((p) => (typeof p === 'object' ? `<p>${p.lead ? `<strong>${esc(clip(p.lead, TEXT_BOUNDS.refsLead))}</strong> ` : ''}${esc(para(p.text))}</p>` : `<p>${esc(para(p))}</p>`)).join('')}</div>`
    : (paras ?? []).map((p) => `<p class="refs-text">${esc(para(p))}</p>`).join('');
  return `<section class="refs">
  <div class="eyebrow">Références</div>
  <h2 class="sec-title">${esc(title)}</h2>
  ${meta}
  ${text}
  <div class="mascot-card"><img src="${sys}assets/brand/info-card.webp" alt=""><p>${DISCLAIMER}</p></div>
</section>`;
}
