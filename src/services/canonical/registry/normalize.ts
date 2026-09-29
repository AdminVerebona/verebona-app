/**
 * Normalisation des valeurs canoniques et recopie vers les colonnes miroirs.
 *
 * T1-03 : l'unité est définie PAR CLÉ CANONIQUE. La seule conversion
 * d'unité du système est ici, et elle n'a lieu que si l'unité source est
 * DÉCLARÉE (`opts.sourceUnit`, unité portée par un alias, ou unité écrite
 * dans la valeur : « 749 € », « 1,2 ha »). Jamais de « ×100 » déduit du nom
 * du champ ni de l'ordre de grandeur de la valeur.
 *
 * Exemple de recette : 749 EUR → `acquisitionPrice` = 749 (fiche) et
 * `purchase_price_cents` = 74900 (miroir).
 */
import { getField } from './registry';
import type { CanonicalFieldDef, NormalizeOptions, NormalizeResult } from './types';

const ko = (reason: string): NormalizeResult => ({ ok: false, reason });
const okv = (value: unknown): NormalizeResult => ({ ok: true, value });

/** Valeurs textuelles équivalentes à « vide » : la normalisation rend `null` (effacement). */
const VIDE = /^(null|undefined|n\/a|na|néant|neant|non renseigné|non renseigne|-)$/i;

const sansAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const jeton = (s: string) => sansAccents(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/* ── Montants ────────────────────────────────────────────────────────────── */

/**
 * Euros → centimes, exact. Refuse plus de deux décimales (une conversion
 * silencieuse masquerait une erreur d'unité). Pour un nombre d'au plus deux
 * décimales, l'erreur flottante de `n × 100` reste < 0,5 : l'arrondi est exact.
 */
export function eurToCents(eur: number): number {
  if (!Number.isFinite(eur)) throw new RangeError(`Montant invalide : ${eur}`);
  const cents = Math.round(eur * 100);
  if (Math.abs(cents / 100 - eur) > 1e-9 * Math.max(1, Math.abs(eur))) {
    throw new RangeError(`Montant en euros avec plus de deux décimales : ${eur}`);
  }
  return cents;
}

/** Centimes → euros, exact pour un entier. */
export function centsToEur(cents: number): number {
  if (!Number.isInteger(cents)) throw new RangeError(`Centimes non entiers : ${cents}`);
  return cents / 100;
}

/* ── Nombres ─────────────────────────────────────────────────────────────── */

interface NombreLu { n: number; unit?: string }

/**
 * Lit un nombre écrit à la française ou à l'anglaise, et l'unité qui le suit.
 * « 12 500,50 € », « 12.500,50 », « 12,500.50 », « 78,4 m² », « 1,2 ha ».
 */
function lireNombre(raw: unknown): NombreLu | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { n: raw } : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\u00a0\u202f]/g, ' ');
  // Devise placée avant le nombre : « € 749 », « EUR 749 ».
  const devant = /^(€|eur|euros?)\s*(.+)$/i.exec(s);
  if (devant) s = `${devant[2]} ${devant[1]}`;
  const m = /^([+-]?[\d\s.,']+)\s*(.*)$/.exec(s);
  if (!m) return null;
  let num = m[1].replace(/[\s']/g, '');
  const unit = m[2].trim() || undefined;
  const virgules = (num.match(/,/g) ?? []).length;
  const points = (num.match(/\./g) ?? []).length;
  if (virgules && points) {
    // Le dernier séparateur est le séparateur décimal.
    const dec = num.lastIndexOf(',') > num.lastIndexOf('.') ? ',' : '.';
    const mil = dec === ',' ? '.' : ',';
    num = num.split(mil).join('').replace(dec, '.');
  } else if (virgules > 1 || points > 1) {
    // « 1.234.567 » ou « 1,234,567 » : séparateurs de milliers.
    num = num.replace(/[.,]/g, '');
  } else if (virgules + points === 1) {
    // Un seul séparateur suivi d'exactement trois chiffres (« 12.500 », « 1,500 ») :
    // milliers ou décimales ? Ambigu — refusé plutôt que deviné.
    if (/^[+-]?[1-9]\d{0,2}[.,]\d{3}$/.test(num)) return null;
    num = num.replace(',', '.');
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(num)) return null;
  const n = Number(num);
  return Number.isFinite(n) ? { n, unit } : null;
}

/** Jetons d'unité reconnus → unité normalisée. */
const UNITES: Record<string, string> = {
  eur: 'EUR', euro: 'EUR', euros: 'EUR', '€': 'EUR',
  'k€': 'kEUR', keur: 'kEUR', k: 'kEUR',
  cents: 'cents', cent: 'cents', centimes: 'cents', cts: 'cents', ct: 'cents',
  km: 'km', kms: 'km', kilometres: 'km', kilometre: 'km', mi: 'miles', miles: 'miles', mile: 'miles',
  h: 'h', heures: 'h', heure: 'h',
  m2: 'm2', 'm²': 'm2', mc: 'm2', ha: 'ha', hectares: 'ha', hectare: 'ha', a: 'a', ares: 'a', are: 'a',
  kg: 'kg', t: 't', tonnes: 't', tonne: 't', g: 'g',
  kw: 'kW', cv: 'CV', cm3: 'cm3', 'cm³': 'cm3', cc: 'cm3',
  kwhm2an: 'kWh/m2/an', kwhm2: 'kWh/m2/an', 'kwh/m²/an': 'kWh/m2/an',
  mois: 'mois',
};

function uniteNormalisee(u: string | undefined): string | undefined {
  if (!u) return undefined;
  const brut = u.trim().toLowerCase();
  return UNITES[brut] ?? UNITES[jeton(brut)] ?? UNITES[brut.replace(/\s/g, '')] ?? u.trim();
}

/** Facteurs de conversion vers l'unité canonique. Toute autre paire est refusée. */
const CONVERSIONS: Record<string, Record<string, number>> = {
  EUR: { kEUR: 1000, cents: 0.01 },
  km: { miles: 1.609344 },
  m2: { ha: 10000, a: 100 },
  kg: { t: 1000, g: 0.001 },
};

function convertir(n: number, from: string | undefined, to: string | undefined): number | string {
  if (!from || !to || from === to) return n;
  // Kilométrage exprimé en heures : même colonne, unité portée par mileageUnit.
  if (to === 'km' && from === 'h') return n;
  const f = CONVERSIONS[to]?.[from];
  if (f === undefined) return `unité ${from} non convertible en ${to}`;
  return n * f;
}

/* ── Dates ───────────────────────────────────────────────────────────────── */

function jourValide(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Date → `AAAA-MM-JJ`, ou null si invalide. Formes : ISO (avec heure), JJ/MM/AAAA, JJ-MM-AAAA, JJ.MM.AAAA, Date. */
export function normalizeDateValue(raw: unknown): string | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(s);
  const fr = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (fr) { d = +fr[1]; m = +fr[2]; y = +fr[3]; }
  else return null;
  return jourValide(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/* ── Chaînes ─────────────────────────────────────────────────────────────── */

/** Mise en forme propre à certaines clés (identifiants). */
function formerChaine(key: string, s: string): string {
  switch (key) {
    case 'registrationNumber': {
      const c = s.toUpperCase().replace(/[\s-]/g, '');
      return /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(c) ? `${c.slice(0, 2)}-${c.slice(2, 5)}-${c.slice(5)}` : c;
    }
    case 'vin':
    case 'serialNumber':
      return s.toUpperCase().replace(/\s/g, '');
    case 'postalCode':
      return s.replace(/\s/g, '');
    default:
      return s.replace(/\s+/g, ' ');
  }
}

/* ── Point d'entrée ──────────────────────────────────────────────────────── */

function borner(def: CanonicalFieldDef, n: number): NormalizeResult | null {
  if (def.integer && !Number.isInteger(n)) return ko(`${def.key} : nombre entier attendu (${n})`);
  if (def.range?.min !== undefined && n < def.range.min) return ko(`${def.key} : valeur inférieure au minimum ${def.range.min}`);
  if (def.range?.max !== undefined && n > def.range.max) return ko(`${def.key} : valeur supérieure au maximum ${def.range.max}`);
  return null;
}

/**
 * Normalise une valeur brute pour une clé CANONIQUE (résoudre les alias
 * d'abord avec `resolveAlias` / `resolveAliasDetailed`).
 * `null`, `''` et les équivalents textuels de « vide » donnent `{ ok: true, value: null }`.
 */
export function normalizeValue(key: string, raw: unknown, opts: NormalizeOptions = {}): NormalizeResult {
  const def = getField(key);
  if (!def) return ko(`clé non canonique : ${key}`);
  if (raw === null || raw === undefined) return okv(null);
  if (typeof raw === 'string' && (raw.trim() === '' || VIDE.test(raw.trim()))) return okv(null);

  switch (def.valueType) {
    case 'date': {
      const d = normalizeDateValue(raw);
      return d ? okv(d) : ko(`${key} : date invalide (${String(raw)})`);
    }

    case 'money_eur':
    case 'money_cents': {
      const lu = lireNombre(raw);
      if (!lu) return ko(`${key} : montant illisible (${String(raw)})`);
      const declaree = uniteNormalisee(opts.sourceUnit);
      const ecrite = uniteNormalisee(lu.unit);
      if (declaree && ecrite && declaree !== ecrite) return ko(`${key} : unité écrite (${ecrite}) ≠ unité déclarée (${declaree})`);
      const source = declaree ?? ecrite ?? (def.valueType === 'money_cents' ? 'cents' : 'EUR');
      if (!['EUR', 'kEUR', 'cents'].includes(source)) return ko(`${key} : unité monétaire inconnue (${source})`);
      if (source === 'cents' && !Number.isInteger(lu.n)) return ko(`${key} : centimes non entiers (${lu.n})`);
      const eur = source === 'EUR' ? lu.n : source === 'kEUR' ? lu.n * 1000 : lu.n / 100;
      let cents: number;
      try { cents = source === 'cents' ? lu.n : eurToCents(source === 'kEUR' ? Math.round(eur * 100) / 100 : eur); }
      catch (e) { return ko(`${key} : ${(e as Error).message}`); }
      const value = def.valueType === 'money_cents' ? cents : centsToEur(cents);
      return borner(def, value) ?? okv(value);
    }

    case 'number': {
      const lu = lireNombre(raw);
      if (!lu) return ko(`${key} : nombre illisible (${String(raw)})`);
      const declaree = uniteNormalisee(opts.sourceUnit);
      const ecrite = uniteNormalisee(lu.unit);
      if (declaree && ecrite && declaree !== ecrite) return ko(`${key} : unité écrite (${ecrite}) ≠ unité déclarée (${declaree})`);
      const canon = uniteNormalisee(def.unit);
      const r = convertir(lu.n, declaree ?? ecrite, canon);
      if (typeof r === 'string') return ko(`${key} : ${r}`);
      // Conversion : arrondi à l'entier pour une clé entière, à 2 décimales sinon.
      const converti = r !== lu.n;
      const n = converti ? (def.integer ? Math.round(r) : Math.round(r * 100) / 100) : r;
      return borner(def, n) ?? okv(n);
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return okv(raw);
      const t = jeton(String(raw));
      if (['true', 'oui', 'yes', '1', 'vrai'].includes(t)) return okv(true);
      if (['false', 'non', 'no', '0', 'faux'].includes(t)) return okv(false);
      return ko(`${key} : booléen illisible (${String(raw)})`);
    }

    case 'enum': {
      const t = jeton(String(raw));
      const values = def.enumValues ?? [];
      const code = values.find((v) => jeton(v) === t)
        ?? values.find((v) => def.enumLabels?.[v] !== undefined && jeton(def.enumLabels[v]) === t);
      return code !== undefined ? okv(code) : ko(`${key} : valeur hors liste (${String(raw)})`);
    }

    case 'json': {
      if (typeof raw === 'string') {
        const s = raw.trim();
        if (s.startsWith('[') || s.startsWith('{')) {
          try { return okv(JSON.parse(s)); } catch { return ko(`${key} : JSON invalide`); }
        }
        return okv(s);
      }
      if (typeof raw === 'function' || typeof raw === 'symbol' || typeof raw === 'bigint') return ko(`${key} : valeur non sérialisable`);
      return okv(raw);
    }

    case 'string':
    default: {
      if (typeof raw === 'object') return ko(`${key} : texte attendu`);
      const s = formerChaine(key, String(raw).trim());
      return s === '' ? okv(null) : okv(s);
    }
  }
}

/**
 * Valeurs des colonnes miroirs (nom SQL → valeur) pour une valeur canonique.
 * La valeur est normalisée d'abord ; une valeur invalide lève une erreur
 * (un miroir divergent de keyCharacteristics est pire qu'un refus).
 * Clé sans miroir → `{}`.
 */
export function toMirrorValue(key: string, value: unknown): Record<string, unknown> {
  const def = getField(key);
  if (!def?.mirrorColumns?.length) return {};
  const r = normalizeValue(key, value);
  if (!r.ok) throw new RangeError(`toMirrorValue(${key}) : ${r.reason}`);
  const v = r.value;
  const out: Record<string, unknown> = {};
  for (const col of def.mirrorColumns) {
    if (v === null) { out[col.column] = null; continue; }
    switch (col.transform ?? 'identity') {
      case 'eur_to_cents':
        out[col.column] = def.valueType === 'money_cents' ? v : eurToCents(v as number);
        break;
      case 'integer':
        out[col.column] = Math.round(v as number);
        break;
      case 'date':
        out[col.column] = normalizeDateValue(v);
        break;
      default:
        out[col.column] = v;
    }
  }
  return out;
}

/** Nom SQL → propriété Drizzle (`purchase_price_cents` → `purchasePriceCents`). */
export function columnToProperty(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Comme `toMirrorValue`, avec les noms de propriétés Drizzle (prêt pour `db.update(assets).set(...)`). */
export function toMirrorPatch(key: string, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [col, v] of Object.entries(toMirrorValue(key, value))) out[columnToProperty(col)] = v;
  return out;
}
