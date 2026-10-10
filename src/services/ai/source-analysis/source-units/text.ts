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
