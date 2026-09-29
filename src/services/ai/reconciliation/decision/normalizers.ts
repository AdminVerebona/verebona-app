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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNITÉS MONÉTAIRES — CDC 15 T1-03, D-09, D-16
 *
 * L'ancienne version multipliait par 100 tout champ dont le NOM ressemblait à
 * un montant (regex `price|value|premium|…`) : un `acquisitionPrice` de
 * 749 € devenait « 74900 », un `amountCents` déjà en centimes « 7490000 ».
 *
 * Seul ce « ×100 » est retiré : l'aiguillage historique par nom de champ est
 * conservé TEL QUEL (dates, nombres, plaques, textes — test de parité avec
 * l'ancienne version sur toutes les clés et alias du registre). Un montant
 * est lu dans l'unité où il est écrit. Conversion euros ↔ centimes
 * UNIQUEMENT quand l'appelant DÉCLARE l'unité source (`opts.sourceUnit`) et
 * que la clé du registre est `money_eur` / `money_cents` d'une autre unité —
 * via `eurToCents` / `centsToEur` du registre, seul point de conversion.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getField, eurToCents, centsToEur } from '@/services/canonical/registry';

export type NormalizedValue = string | null;

const DATE_FR = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4})$/;
const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})/;

export interface NormalizeOpts {
  /** Unité DÉCLARÉE de la valeur brute (`EUR`, `cents`) si elle diffère de celle de la clé. */
  sourceUnit?: string;
}

/** Montant → chaîne décimale (2 décimales au plus), dans son unité. */
const numberString = (n: number) => String(Math.round(n * 100) / 100);

/** Jeton d'unité monétaire déclarée → `EUR` | `cents`, sinon undefined. */
function monetaryUnit(u: string | undefined): 'EUR' | 'cents' | undefined {
  if (!u) return undefined;
  const t = u.trim().toLowerCase();
  if (['eur', 'euro', 'euros', '€'].includes(t)) return 'EUR';
  if (['cents', 'cent', 'centimes', 'cts', 'ct'].includes(t)) return 'cents';
  return undefined;
}

/** Normalise selon la nature du champ. Renvoie null si la valeur est inexploitable. */
export function normalize(fieldKey: string, raw: unknown, opts: NormalizeOpts = {}): NormalizedValue {
  if (raw === null || raw === undefined) return null;

  const s = String(raw).trim();
  if (s === '' || /^(null|n\/a|néant|neant|non renseigné)$/i.test(s)) return null;

  if (isDateField(fieldKey)) return normalizeDate(s);
  if (isMoneyField(fieldKey)) return normalizeMoneyForKey(fieldKey, s, opts);
  if (isAreaField(fieldKey)) return normalizeNumber(s);
  if (fieldKey === 'registrationNumber') return normalizePlate(s);
  if (fieldKey === 'vin' || fieldKey === 'serialNumber') return s.toUpperCase().replace(/[\s-]/g, '');
  if (fieldKey === 'iban') return s.toUpperCase().replace(/\s/g, '');
  if (fieldKey === 'postalCode') return s.replace(/\s/g, '');
  if (isAddressField(fieldKey)) return normalizeText(s);

  return normalizeText(s);
}

/**
 * Montant d'une clé « monétaire » : lu tel quel ; converti seulement si
 * l'unité source est déclarée et diffère de l'unité de la clé du registre.
 */
function normalizeMoneyForKey(fieldKey: string, s: string, opts: NormalizeOpts): NormalizedValue {
  const lu = normalizeMoney(s);
  if (lu === null) return null;
  const def = getField(fieldKey);
  const declaree = monetaryUnit(opts.sourceUnit);
  if (!def || !declaree || (def.valueType !== 'money_eur' && def.valueType !== 'money_cents')) return lu;
  const cible = def.valueType === 'money_cents' ? 'cents' : 'EUR';
  if (declaree === cible) return lu;
  try {
    return cible === 'cents' ? String(eurToCents(Number(lu))) : numberString(centsToEur(Number(lu)));
  } catch {
    // Euros à plus de deux décimales, centimes non entiers : erreur d'unité probable.
    return null;
  }
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

/**
 * Montant lu TEL QUEL, dans l'unité où il est écrit — jamais converti
 * (T1-03). Chaîne décimale à deux chiffres au plus, ou null. Réservé aux
 * clés hors registre ; une clé du registre passe par `normalizeValue`.
 */
export function normalizeMoney(s: string): NormalizedValue {
  const cleaned = s
    .replace(/[€$£\s\u00a0]/g, '')
    .replace(/(\d)[.,](\d{3})(?=[.,]|$)/g, '$1$2')  // séparateurs de milliers
    .replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return numberString(n);
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
export function areEquivalent(fieldKey: string, a: unknown, b: unknown, opts: NormalizeOpts = {}): boolean {
  const na = normalize(fieldKey, a, opts);
  const nb = normalize(fieldKey, b, opts);
  if (na === null || nb === null) return false;
  return na === nb;
}
