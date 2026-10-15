/**
 * Lot 58A — BUG P1 « troncature des montants » : lecture d'un nombre SAISI
 * (champ texte contrôlé `NumberInput`), sans dépendance React ni DOM.
 *
 * Le texte tapé est conservé tel quel pendant toute la saisie ; il n'est
 * converti en nombre qu'à la validation (enregistrement), par cette fonction.
 * Aucune transformation silencieuse : un texte invalide ou ambigu est REFUSÉ
 * avec un message explicite (jamais d'enregistrement partiel).
 *
 * Format accepté (usage français) :
 *  - virgule décimale : « 12500,50 » ; le point décimal reste lu (« 12500.5 »,
 *    valeurs déjà enregistrées) sauf s'il est ambigu (« 20.000 » : 20 ou 20 000 ?) ;
 *  - espaces (normales, insécables U+00A0 / U+202F, fines U+2009) uniquement
 *    comme séparateurs de milliers bien placés : « 12 500,50 », « 1 250 000 » ;
 *  - signe « € » final facultatif pour un montant (« 12 500,50 € »).
 * Refusés : virgule ET point, plusieurs séparateurs décimaux, groupes mal
 * placés (« 1 25 »), nombre inachevé (« 12500, »), lettres, négatif non
 * autorisé, trop de décimales pour un montant (« 20,000 » € : 3 décimales).
 */

export interface NumberParseOptions {
  /** Nombre maximal de décimales (montant en euros : 2). Absent : illimité. */
  maxDecimals?: number;
  /** Valeurs négatives acceptées (défaut : non). */
  allowNegative?: boolean;
  min?: number;
  max?: number;
  /** « € » final accepté (montants). */
  currency?: boolean;
}

export type NumberParseResult =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/** Montant en euros (prix, valeurs, forfaits, montants de documents). */
export const MONEY_INPUT: NumberParseOptions = { maxDecimals: 2, allowNegative: false, min: 0, currency: true };
/** Grandeur non monétaire positive (surface, kilométrage, puissance…). */
export const QUANTITY_INPUT: NumberParseOptions = { allowNegative: false, min: 0 };

const ESPACES = /[    ]/g;
const FORMAT_ATTENDU = 'utilisez des chiffres, une virgule pour les décimales et des espaces entre les milliers (ex. 12 500,50)';

function ko(error: string): NumberParseResult {
  return { ok: false, error };
}

/** Lit le texte saisi. Vide → `{ ok: true, value: null }`. */
export function parseNumberInput(text: string | null | undefined, opts: NumberParseOptions = {}): NumberParseResult {
  let s = String(text ?? '').replace(ESPACES, ' ').trim();
  if (opts.currency) s = s.replace(/\s*€$/, '').trim();
  if (s === '') return { ok: true, value: null };

  let negatif = false;
  if (s.startsWith('-')) {
    if (!opts.allowNegative) return ko('Valeur négative non acceptée.');
    negatif = true;
    s = s.slice(1).trim();
  }
  if (!/^[\d .,]+$/.test(s)) return ko(`Saisie invalide : ${FORMAT_ATTENDU}.`);
  if (/\s{2,}/.test(s)) return ko(`Espaces invalides : ${FORMAT_ATTENDU}.`);

  const virgules = (s.match(/,/g) ?? []).length;
  const points = (s.match(/\./g) ?? []).length;
  if (virgules + points > 1) {
    return ko(`Format ambigu (plusieurs séparateurs « , » ou « . ») : ${FORMAT_ATTENDU}.`);
  }
  const sep = virgules ? ',' : points ? '.' : null;
  const [entier, decimales = ''] = sep ? s.split(sep) : [s];
  if (sep && (entier.trim() === '' || decimales === '')) {
    return ko(`Nombre incomplet : ${FORMAT_ATTENDU}.`);
  }
  if (!/^\d+$/.test(decimales) && decimales !== '') return ko(`Décimales invalides : ${FORMAT_ATTENDU}.`);
  const ent = entier.trim();
  if (ent.includes(' ') && !/^\d{1,3}( \d{3})+$/.test(ent)) {
    return ko(`Séparateur de milliers mal placé : ${FORMAT_ATTENDU}.`);
  }
  if (!ent.includes(' ') && !/^\d+$/.test(ent)) return ko(`Saisie invalide : ${FORMAT_ATTENDU}.`);
  // « 20.000 » : point suivi de 3 chiffres — milliers (20 000) ou décimales (20) ?
  if (sep === '.' && decimales.length === 3) {
    return ko(`« ${s} » est ambigu (milliers ou décimales ?) : ${FORMAT_ATTENDU}.`);
  }
  if (opts.maxDecimals !== undefined && decimales.length > opts.maxDecimals) {
    return ko(opts.maxDecimals === 0 ? 'Nombre entier attendu.' : `${opts.maxDecimals} décimales maximum.`);
  }
  const chiffres = ent.replace(/ /g, '');
  if ((chiffres.replace(/^0+(?=\d)/, '') + decimales).length > 15) return ko('Nombre trop long.');

  const n = Number(`${negatif ? '-' : ''}${chiffres}${decimales ? `.${decimales}` : ''}`);
  if (!Number.isFinite(n)) return ko(`Saisie invalide : ${FORMAT_ATTENDU}.`);
  const value = Object.is(n, -0) ? 0 : n;
  if (opts.min !== undefined && value < opts.min) return ko(`Valeur minimale : ${formatNumberForInput(opts.min)}.`);
  if (opts.max !== undefined && value > opts.max) return ko(`Valeur maximale : ${formatNumberForInput(opts.max)}.`);
  return { ok: true, value };
}

/**
 * Valeur enregistrée → texte initial du champ (virgule décimale, sans
 * séparateur de milliers : « 12500,5 »). Une chaîne déjà illisible est
 * rendue telle quelle pour que l'utilisateur la voie et la corrige.
 */
export function formatNumberForInput(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const s = Math.abs(value) < 1e15 && !String(value).includes('e')
      ? String(value)
      : value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
    return s.replace('.', ',');
  }
  if (typeof value === 'string') {
    const lu = parseNumberInput(value, { allowNegative: true });
    return lu.ok && lu.value !== null ? formatNumberForInput(lu.value) : value;
  }
  return String(value);
}

/** Euros saisis → centimes entiers (jamais d'arrondi silencieux : 2 décimales max). */
export function parseMoneyInputToCents(text: string | null | undefined): { ok: true; cents: number | null } | { ok: false; error: string } {
  const r = parseNumberInput(text, MONEY_INPUT);
  if (!r.ok) return r;
  return { ok: true, cents: r.value === null ? null : Math.round(r.value * 100) };
}

/** Boutons +/- : texte suivant, sans toucher au DOM. Texte invalide : inchangé. */
export function stepNumberInput(text: string, delta: number, opts: NumberParseOptions = {}): string {
  const r = parseNumberInput(text, { ...opts, min: undefined, max: undefined });
  if (!r.ok) return text;
  let next = Math.round(((r.value ?? 0) + delta) * 1e9) / 1e9;
  if (opts.min !== undefined && next < opts.min) next = opts.min;
  if (opts.max !== undefined && next > opts.max) next = opts.max;
  return formatNumberForInput(next);
}
