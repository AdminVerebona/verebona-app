/**
 * Outils de texte de la couche A (fonctions pures) : forme de comparaison,
 * marques de page, pagination, valeurs structurables.
 */

/** Forme de comparaison : sans accents, casse, ponctuation ni espaces (même règle que `verifyExcerpts`). */
export const plat = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Mots (≥ 2 caractères) en forme de comparaison. */
export const mots = (s: string): string[] =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

/**
 * Marque de début de page décorée, seule sur sa ligne :
 * « --- Page 3 --- », « [page 3] », « === PAGE 3 === », « # Page 3 ».
 */
const MARQUE_PAGE = /^\s*(?:-{2,}|={2,}|#{1,3}|\[)\s*page\s+(\d{1,4})\s*(?:\/\s*\d{1,4}|sur\s+\d{1,4})?\s*(?:-{2,}|={2,}|\])?\s*$/i;

/** Numéro de la page qui COMMENCE à cette ligne, sinon null. */
export function pageMarker(line: string): number | null {
  const m = MARQUE_PAGE.exec(line);
  return m ? Number(m[1]) : null;
}

/** Pagination seule (« Page 2/5 », « 2 / 5 », « - 3 - », « p. 4 ») : pas une information. */
const PAGINATION = /^\s*(?:page|p\.)?\s*-?\s*\d{1,4}\s*(?:(?:\/|sur|of)\s*\d{1,4})?\s*-?\s*$/i;

/** Pied de page « Page N/M » (sans décoration) : rend N, sinon null. */
export function paginationFooter(line: string): number | null {
  const m = /^\s*page\s+(\d{1,4})\s*(?:\/|sur)\s*\d{1,4}\s*$/i.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * Texte sans connaissance utile : vide, séparateur, pagination, décoration
 * (moins de deux caractères alphanumériques).
 */
export function isNonInformational(text: string | null | undefined): boolean {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  if (pageMarker(t) !== null) return true;
  if (t.split('\n').every((l) => !l.trim() || PAGINATION.test(l) || pageMarker(l) !== null || plat(l).length < 2)) return true;
  return plat(t).length < 2;
}

const DATE = /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:er)?\s+(?:janv|fevr|févr|mars|avr|mai|juin|juil|aout|août|sept|oct|nov|dec|déc)[a-zéû]*\.?\s+\d{4})\b/i;
const MONTANT = /\d[\d\s .,]*\s?(?:€|eur\b|euros?\b|ht\b|ttc\b)/i;
const UNITE = /\b\d+(?:[.,]\d+)?\s?(?:kwh|kw|kva|wc|w|m2|m²|m3|m³|km|cm|mm|kg|l|ch|cv|bar|°c|db|ans?|mois)\b/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const TEL = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/;
/** Identifiant : jeton mêlant chiffres et lettres (VIN, immatriculation, n° de série, référence). */
const IDENTIFIANT = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{4,}\b/i;
const NOMBRE_LONG = /\b\d{5,}\b/;

/** Le texte porte-t-il une valeur structurable (date, montant, quantité, identifiant, contact) ? */
export function hasStructurableValue(text: string): boolean {
  return DATE.test(text) || MONTANT.test(text) || UNITE.test(text) || EMAIL.test(text)
    || TEL.test(text) || IDENTIFIANT.test(text) || NOMBRE_LONG.test(text);
}

// ── Lot 83B (C-Q7) : valeurs significatives d'un extrait, lues de façon DÉTERMINISTE ──

/** Nature d'une valeur significative repérée dans une unité source. */
export type SignificantKind = 'AMOUNT' | 'DATE' | 'IDENTIFIER';

export interface SignificantValue {
  kind: SignificantKind;
  /** Texte tel qu'il figure dans l'unité. */
  raw: string;
  /** Forme normalisée : centimes (montant), `AAAA-MM-JJ` (date), jeton compact en majuscules (identifiant). */
  normalized: string;
}

/** Montant ACCOMPAGNÉ d'une devise explicite (€, EUR, euros) — plus strict que `MONTANT` : jamais un simple « HT ». */
const MONTANT_DEVISE = /(?<![\d,.])(\d{1,3}(?:[   .]\d{3})+|\d+)(?:,(\d{1,2})|\.(\d{1,2}))?\s?(?:€|eur\b|euros?\b)/gi;
const DATE_NUM = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DATE_MOIS = /\b(\d{1,2})(?:er)?\s+(janv|f[ée]vr|mars|avr|mai|juin|juil|ao[uû]t|sept|oct|nov|d[ée]c)[a-zéû]*\.?\s+(\d{4})\b/gi;
const IDENTIFIANT_G = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{4,}\b/gi;
const MOIS: Record<string, number> = { janv: 1, fevr: 2, févr: 2, mars: 3, avr: 4, mai: 5, juin: 6, juil: 7, aout: 8, août: 8, sept: 9, oct: 10, nov: 11, dec: 12, déc: 12 };

const isoValide = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};

/** Jeton d'identifiant comparable : majuscules, sans espace, tiret, point ni barre. */
export const compactIdentifier = (s: string): string => s.toUpperCase().replace(/[\s\-./]/g, '');

/** Montant écrit (« 1 234,56 », « 1.234 », « 87.5 ») → centimes, ou null. */
export function amountToCents(entier: string, decimales?: string | null): number | null {
  const e = entier.replace(/[   .]/g, '');
  if (!/^\d{1,12}$/.test(e)) return null;
  const d = (decimales ?? '').padEnd(2, '0').slice(0, 2);
  const n = Number(e) * 100 + (d ? Number(d) : 0);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Valeurs significatives d'un texte (pure, déterministe) : montants avec
 * devise, dates (numériques ou « 1er janvier 2026 »), identifiants (jeton
 * lettres + chiffres, seulement si `identifiers` — la valeur d'un couple
 * libellé / valeur). Aucun jugement de PERTINENCE : c'est à T1 de dire si
 * une valeur est utile (lot 91D : décisions `valueDecisions`, contrat
 * t1-value-decisions-v1 ; demande d'origine 82B-t1-omissions-extract) ; le code ne
 * fait que repérer et comparer.
 */
export function significantValues(text: string | null | undefined, opts: { identifiers?: boolean } = {}): SignificantValue[] {
  if (!text) return [];
  const out: SignificantValue[] = [];
  const vus = new Set<string>();
  const ajouter = (v: SignificantValue) => {
    const k = `${v.kind}:${v.normalized}`;
    if (!vus.has(k)) { vus.add(k); out.push(v); }
  };
  const zonesDates: Array<[number, number]> = [];
  for (const m of text.matchAll(DATE_NUM)) {
    const iso = m[3] ? isoValide(+m[3], +m[2], +m[1]) : isoValide(+m[4], +m[5], +m[6]);
    zonesDates.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    if (iso) ajouter({ kind: 'DATE', raw: m[0], normalized: iso });
  }
  for (const m of text.matchAll(DATE_MOIS)) {
    const mois = MOIS[m[2].toLowerCase().normalize('NFC')] ?? MOIS[m[2].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')];
    const iso = mois ? isoValide(+m[3], mois, +m[1]) : null;
    zonesDates.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    if (iso) ajouter({ kind: 'DATE', raw: m[0], normalized: iso });
  }
  const dansUneDate = (i: number) => zonesDates.some(([a, b]) => i >= a && i < b);
  for (const m of text.matchAll(MONTANT_DEVISE)) {
    if (dansUneDate(m.index ?? 0)) continue;
    const c = amountToCents(m[1], m[2] ?? m[3] ?? null);
    if (c !== null && c > 0) ajouter({ kind: 'AMOUNT', raw: m[0].trim(), normalized: String(c) });
  }
  if (opts.identifiers) {
    for (const m of text.matchAll(IDENTIFIANT_G)) {
      if (dansUneDate(m.index ?? 0)) continue;
      const c = compactIdentifier(m[0]);
      if (c.length >= 6 && /[A-Z]/.test(c) && /\d/.test(c)) ajouter({ kind: 'IDENTIFIER', raw: m[0], normalized: c });
    }
  }
  return out;
}

/**
 * Couple « Libellé : valeur » sur une ligne. Le libellé contient une lettre,
 * n'est ni une URL ni une heure (« 12:30 »), et la valeur n'est pas vide.
 */
export function labelValue(line: string): { label: string; value: string } | null {
  const m = /^\s*([^:：]{2,80}?)\s*[:：]\s*(\S.*?)\s*$/.exec(line);
  if (!m) return null;
  const label = m[1].trim();
  const value = m[2].trim();
  if (!/[a-zA-Zà-ÿ]/.test(label)) return null;
  if (/^(?:https?|ftp|mailto)$/i.test(label) || /\/\/$/.test(value.slice(0, 2))) return null;
  if (/^\d{1,2}$/.test(label)) return null;
  return { label, value };
}

/** Élément de formulaire : case (cochée ou non) suivie d'un libellé. */
export function formField(line: string): { label: string; checked: boolean | null } | null {
  const m = /^\s*(?:([☐□○◯])|([☑☒■●✓✔✗✘])|\[\s?\]|\[\s?([xX✓])\s?\]|\(\s?\)|\(\s?([xX])\s?\))\s*(.+)$/.exec(line);
  if (!m) return null;
  const checked = m[2] || m[3] || m[4] ? true : m[1] ? false : /^\s*[[(]\s?[\])]/.test(line) ? false : null;
  return { label: m[5].trim(), checked };
}
