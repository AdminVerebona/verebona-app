/**
 * Normalisation des valeurs — première étape du §4.2.8.
 *
 * « Le moteur doit utiliser dans cet ordre : 1. normalisation des valeurs […] »
 *
 * Deux valeurs ne peuvent être comparées qu'après normalisation. Sans cette
 * étape, « 78,40 m² » et « 78.4 » seraient traités comme une contradiction et
 * généreraient un arbitrage inutile — le genre de faux positif qui décrédibilise
 * la page « À traiter ».
 *
 * Une valeur non normalisable n'est jamais appliquée : elle est ignorée.
 */

export type NormalizedValue = string | null;

const DATE_FR = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4})$/;
const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})/;

/** Normalise selon la nature du champ. Renvoie null si la valeur est inexploitable. */
export function normalize(fieldKey: string, raw: unknown): NormalizedValue {
  if (raw === null || raw === undefined) return null;

  const s = String(raw).trim();
  if (s === '' || /^(null|n\/a|néant|neant|non renseigné)$/i.test(s)) return null;

  if (isDateField(fieldKey)) return normalizeDate(s);
  if (isMoneyField(fieldKey)) return normalizeMoney(s);
  if (isAreaField(fieldKey)) return normalizeNumber(s);
  if (fieldKey === 'registrationNumber') return normalizePlate(s);
  if (fieldKey === 'vin' || fieldKey === 'serialNumber') return s.toUpperCase().replace(/[\s-]/g, '');
  if (fieldKey === 'iban') return s.toUpperCase().replace(/\s/g, '');
  if (fieldKey === 'postalCode') return s.replace(/\s/g, '');
  if (isAddressField(fieldKey)) return normalizeText(s);

  return normalizeText(s);
}

function isDateField(k: string): boolean {
  return /date|expiry|deadline|echeance|End$|Start$/i.test(k);
}
function isMoneyField(k: string): boolean {
  return /price|value|premium|rent|charges|amount|cents/i.test(k);
}
function isAreaField(k: string): boolean {
  return /area|surface|mileage|weight|power|count|year|hp|kw/i.test(k);
}
function isAddressField(k: string): boolean {
  return /address|city|country|location/i.test(k);
}

/** Toute date devient ISO `AAAA-MM-JJ`, ou null. */
export function normalizeDate(s: string): NormalizedValue {
  const iso = s.match(DATE_ISO);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const fr = s.match(DATE_FR);
  if (fr) {
    const [, d, m, y] = fr;
    const day = d.padStart(2, '0');
    const month = m.padStart(2, '0');
    // Contrôle de validité : une date impossible n'est pas une date.
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
    return `${y}-${month}-${day}`;
  }
  return null;
}

/** Tout montant devient une chaîne d'entier en centimes, ou null. */
export function normalizeMoney(s: string): NormalizedValue {
  const cleaned = s
    .replace(/[€$£\s\u00a0]/g, '')
    .replace(/(\d)[.,](\d{3})(?=[.,]|$)/g, '$1$2')  // séparateurs de milliers
    .replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return String(Math.round(n * 100));
}

/** Nombre décimal normalisé, ou null. */
export function normalizeNumber(s: string): NormalizedValue {
  const cleaned = s.replace(/[^\d,.\-]/g, '').replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // Deux décimales suffisent partout : évite qu'un arrondi crée un faux conflit.
  return String(Math.round(n * 100) / 100);
}

/** Plaque française : majuscules, tirets normalisés. */
export function normalizePlate(s: string): NormalizedValue {
  const compact = s.toUpperCase().replace(/[\s-]/g, '');
  if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(compact)) {
    return `${compact.slice(0, 2)}-${compact.slice(2, 5)}-${compact.slice(5)}`;
  }
  return compact.length > 0 ? compact : null;
}

/** Texte comparable : minuscules, accents retirés, espaces réduits. */
export function normalizeText(s: string): NormalizedValue {
  const out = s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return out === '' ? null : out;
}

/** Deux valeurs sont-elles équivalentes après normalisation ? */
export function areEquivalent(fieldKey: string, a: unknown, b: unknown): boolean {
  const na = normalize(fieldKey, a);
  const nb = normalize(fieldKey, b);
  if (na === null || nb === null) return false;
  return na === nb;
}
