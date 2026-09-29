/**
 * FIXTURE — normaliseur de réconciliation tel qu'au tag `lot11` (×100
 * compris), copié à l'identique. Sert UNIQUEMENT au test de parité CDC 15
 * T1-03 : le nouveau normaliseur doit rendre les mêmes sorties, à la seule
 * exception du « ×100 » retiré. Ne pas modifier, ne pas importer ailleurs.
 */
export type NormalizedValue = string | null;

const DATE_FR = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4})$/;
const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})/;

export function legacyNormalize(fieldKey: string, raw: unknown): NormalizedValue {
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

/** Vrai si l'ancienne version passait la clé par la branche « montant » (×100). */
export function legacyIsMoneyBranch(k: string): boolean {
  return !isDateField(k) && isMoneyField(k);
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
function normalizeDate(s: string): NormalizedValue {
  const iso = s.match(DATE_ISO);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const fr = s.match(DATE_FR);
  if (fr) {
    const [, d, m, y] = fr;
    const day = d.padStart(2, '0');
    const month = m.padStart(2, '0');
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
    return `${y}-${month}-${day}`;
  }
  return null;
}
function normalizeMoney(s: string): NormalizedValue {
  const cleaned = s
    .replace(/[€$£\s ]/g, '')
    .replace(/(\d)[.,](\d{3})(?=[.,]|$)/g, '$1$2')
    .replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return String(Math.round(n * 100));
}
function normalizeNumber(s: string): NormalizedValue {
  const cleaned = s.replace(/[^\d,.\-]/g, '').replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return String(Math.round(n * 100) / 100);
}
function normalizePlate(s: string): NormalizedValue {
  const compact = s.toUpperCase().replace(/[\s-]/g, '');
  if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(compact)) {
    return `${compact.slice(0, 2)}-${compact.slice(2, 5)}-${compact.slice(5)}`;
  }
  return compact.length > 0 ? compact : null;
}
function normalizeText(s: string): NormalizedValue {
  const out = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return out === '' ? null : out;
}
