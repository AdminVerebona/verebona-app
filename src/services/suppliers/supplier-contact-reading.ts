/**
 * Lot 111X — lecture DÉTERMINISTE des coordonnées d'un fournisseur dans la
 * connaissance documentaire déjà persistée (fonctions pures, testées).
 *
 * Utilisée par :
 *   · la seconde chance T3 des fournisseurs (`missing-properties/supplier.ts`)
 *     — faits `target_type = SUPPLIER`, faits non intégrés, unités sources ;
 *   · le contrôle de couverture T1 (`source-units/coverage.ts`) — une unité
 *     portant plusieurs valeurs de contact n'est pas « couverte » si l'une
 *     d'elles n'est ni structurée ni écartée avec motif.
 *
 * Principes :
 *   · FORMATS seulement (adresse e-mail, numéro, n° de TVA à clé vérifiée,
 *     IBAN à clé vérifiée, adresse web explicite, adresse postale « voie + code
 *     postal + ville ») : aucune valeur n'est déduite, complétée ou inventée ;
 *   · ÉMETTEUR ≠ DESTINATAIRE : une unité ne parle du fournisseur que si elle
 *     porte son ANCRE (SIRET / SIREN, n° de TVA dérivé du SIREN, nom) et
 *     aucune marque du destinataire (nom / e-mail d'un membre du compte,
 *     adresse d'un bien du compte) — sinon abstention ;
 *   · télécopie : jamais prise pour le téléphone (gardée dans la connaissance
 *     documentaire, aucun champ métier nouveau) ;
 *   · IBAN : seulement un IBAN EXPLICITE dont la clé est valide, jamais
 *     journalisé en clair (`maskIban`).
 * Les indices de libellé (`FAX_CUES`, `STREET_TYPES`) sont des paramètres
 * centralisés ici, jamais une règle propre à un fournisseur.
 */

export type SupplierCoordinateField =
  | 'email' | 'phone' | 'website' | 'addressLine1' | 'postalCode' | 'city' | 'country' | 'vatNumber' | 'iban' | 'siren' | 'siret';

/** Champs de coordonnées repris par la seconde chance (l'identité — nom, SIREN, SIRET — reste à T1 / #706). */
export const SUPPLIER_COORDINATE_FIELDS: readonly SupplierCoordinateField[] = [
  'phone', 'email', 'website', 'addressLine1', 'postalCode', 'city', 'vatNumber', 'iban',
];

/** Champs d'adresse lus ensemble (jamais un code postal d'une adresse et la ville d'une autre). */
export const ADDRESS_FIELDS: readonly SupplierCoordinateField[] = ['addressLine1', 'postalCode', 'city'];

/** Indices de télécopie (la valeur qui suit n'est pas un téléphone). */
const FAX_CUES = /(?:fax|t[ée]l[ée]copie)\s*[.:：]?\s*$/i;
/** Types de voie reconnus en tête d'une ligne d'adresse (paramètre centralisé). */
const STREET_TYPES = [
  'rue', 'avenue', 'av', 'boulevard', 'bd', 'bld', 'chemin', 'ch', 'route', 'rte', 'allée', 'allee', 'impasse', 'imp', 'place', 'pl',
  'quai', 'cours', 'lieu-dit', 'lieu dit', 'lotissement', 'lot', 'zone', 'za', 'zi', 'zac', 'parc', 'résidence', 'residence', 'hameau',
  'voie', 'sentier', 'square', 'passage', 'montée', 'montee', 'faubourg', 'fbg', 'esplanade', 'promenade', 'rond-point', 'carrefour',
];

const EMAIL_RE = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![\d+])(?:\+33\s?\(?0?\)?\s?|0033\s?|0)[1-9](?:[\s.\-]?\d{2}){4}(?!\d)/g;
const VAT_RE = /\b(FR)\s?([0-9A-HJ-NP-Z]{2})\s?(\d{3})\s?(\d{3})\s?(\d{3})\b/gi;
const IBAN_RE = /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?)\b/g;
const WEB_RE = /\b(?:https?:\/\/)?(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s]*)?|\bhttps?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s]*)?/gi;
const SIRET_RE = /(?<!\d)(\d{3}\s?\d{3}\s?\d{3}\s?\d{5})(?!\d)/g;

export interface ReadValue {
  field: SupplierCoordinateField;
  /** Texte tel qu'il figure dans la source. */
  raw: string;
  /** Valeur à enregistrer (forme compacte, jamais reformulée au-delà). */
  value: string;
  /** Lue mais écartée (télécopie, clé invalide…) : jamais écrite, motif conservé. */
  excluded?: 'FAX' | 'INVALID_CHECKSUM';
}

export interface PostalAddress { addressLine1: string; postalCode: string; city: string; raw: string }

const digits = (s: string) => s.replace(/\D/g, '');

/** Clé d'un n° de TVA français : (12 + 3 × (SIREN mod 97)) mod 97. Pure. */
export function frVatKey(siren: string): string {
  const k = (12 + 3 * ((Number(siren) % 97))) % 97;
  return String(k).padStart(2, '0');
}

/** N° de TVA français valide (clé numérique vérifiée) ; SIREN embarqué. Pure. */
export function parseFrVat(v: string): { value: string; siren: string; valid: boolean } | null {
  const c = v.replace(/\s/g, '').toUpperCase();
  const m = /^FR([0-9A-HJ-NP-Z]{2})(\d{9})$/.exec(c);
  if (!m) return null;
  const valid = /^\d{2}$/.test(m[1]) ? frVatKey(m[2]) === m[1] : true;
  return { value: c, siren: m[2], valid };
}

/** IBAN à clé valide (ISO 13616, mod 97). Pure. */
export function ibanValid(v: string): boolean {
  const c = v.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(c)) return false;
  const r = (c.slice(4) + c.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let mod = 0;
  for (const ch of r) mod = (mod * 10 + Number(ch)) % 97;
  return mod === 1;
}

/** IBAN masqué (journaux, historique, diagnostic) : même masquage que la fiche (lot 109B), jamais la valeur bancaire en clair. */
export { maskIban } from '@/lib/suppliers/supplier-fiche-config';

/** Téléphone : forme compacte telle que lue (« 04 78 44 65 25 » → « 0478446525 »). Pure. */
export function compactPhone(raw: string): string {
  const s = raw.replace(/[\s.\-()]/g, '');
  return s.startsWith('0033') ? `+${s.slice(2)}` : s.replace(/^\+330/, '+33');
}

/** Valeurs de contact lisibles d'un texte (pure, ordre de lecture, sans doublon). */
export function readContactValues(text: string | null | undefined): ReadValue[] {
  if (!text) return [];
  const out: ReadValue[] = [];
  const vus = new Set<string>();
  const add = (v: ReadValue) => {
    const k = `${v.field}:${v.value}`;
    if (vus.has(k)) return;
    vus.add(k);
    out.push(v);
  };
  const emails = [...text.matchAll(EMAIL_RE)];
  for (const m of emails) add({ field: 'email', raw: m[0], value: m[0].toLowerCase() });
  // Domaines des e-mails : jamais pris pour un site.
  const domaines = new Set(emails.map((m) => m[0].split('@')[1].toLowerCase()));
  for (const m of text.matchAll(PHONE_RE)) {
    const avant = text.slice(Math.max(0, (m.index ?? 0) - 16), m.index ?? 0);
    add({ field: 'phone', raw: m[0], value: compactPhone(m[0]), ...(FAX_CUES.test(avant) ? { excluded: 'FAX' as const } : {}) });
  }
  for (const m of text.matchAll(VAT_RE)) {
    const p = parseFrVat(m[0]);
    if (p) add({ field: 'vatNumber', raw: m[0], value: p.value, ...(p.valid ? {} : { excluded: 'INVALID_CHECKSUM' as const }) });
  }
  for (const m of text.matchAll(IBAN_RE)) {
    const c = m[1].replace(/\s/g, '').toUpperCase();
    if (c.startsWith('FR') && /^FR[0-9A-Z]{2}\d{9}$/.test(c)) continue; // n° de TVA, pas un IBAN
    if (c.length < 14) continue;
    add({ field: 'iban', raw: m[1], value: c, ...(ibanValid(c) ? {} : { excluded: 'INVALID_CHECKSUM' as const }) });
  }
  for (const m of text.matchAll(WEB_RE)) {
    if ((m.index ?? 0) > 0 && text[(m.index ?? 0) - 1] === '@') continue;
    const v = m[0].replace(/[.,;)]+$/, '');
    const hote = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
    if (domaines.has(hote) && !/^(?:https?:\/\/|www\.)/i.test(v)) continue;
    add({ field: 'website', raw: v, value: v.toLowerCase().replace(/\/$/, '') });
  }
  for (const m of text.matchAll(SIRET_RE)) {
    const d = digits(m[1]);
    add({ field: 'siret', raw: m[1], value: d });
  }
  return out;
}

const STREET_ALT = STREET_TYPES.map((t) => t.replace(/[-\s]/g, '[-\\s]')).sort((a, b) => b.length - a.length).join('|');
const ADDRESS_RE = new RegExp(
  `(\\d{1,4}\\s?(?:bis|ter|b|t)?\\s*,?\\s*(?:${STREET_ALT})\\.?\\s+[^,\\n\\d]{2,60}?)\\s*[,\\n]?\\s*(?:\\n\\s*)?(\\d{5})\\s+([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’\\- ]{1,40}?)(?=\\s*(?:$|\\n|,|;|\\||\\s{2,}|\\s+(?:t[ée]l|fax|e-?mail|mail|siret|siren|tva|www|http|france|cedex)\\b))`,
  'giu',
);

/** Adresses postales « n° + voie, code postal, ville » d'un texte (pure, sans doublon). */
export function readPostalAddresses(text: string | null | undefined): PostalAddress[] {
  if (!text) return [];
  const out: PostalAddress[] = [];
  const vus = new Set<string>();
  for (const m of text.matchAll(ADDRESS_RE)) {
    const line = m[1].replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();
    const city = m[3].replace(/\s+/g, ' ').trim();
    const k = `${line.toLowerCase()}|${m[2]}|${city.toLowerCase()}`;
    if (vus.has(k)) continue;
    vus.add(k);
    out.push({ addressLine1: line, postalCode: m[2], city, raw: m[0].trim() });
  }
  return out;
}

/** Forme de comparaison (minuscules, sans accents ni ponctuation). */
export function plain(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9@]+/g, ' ').trim();
}

/** Mots significatifs d'un nom (≥ 4 caractères, hors formes juridiques). */
const LEGAL_WORDS = new Set(['sarl', 'sas', 'sasu', 'eurl', 'scop', 'societe', 'entreprise', 'etablissements', 'ets', 'groupe', 'france']);
export function nameTokens(name: string | null | undefined): string[] {
  return [...new Set(plain(name ?? '').split(' ').filter((w) => w.length >= 4 && !LEGAL_WORDS.has(w)))];
}

export interface SupplierAnchor {
  name: string | null;
  siren: string | null;
  siret: string | null;
}

export interface RecipientMarks {
  /** Noms (nom de famille…) des membres du compte (≥ 3 caractères). */
  names: string[];
  emails: string[];
  /** Adresses des biens du compte (code postal + premier mot de la voie). */
  addresses: Array<{ postalCode: string | null; line: string | null }>;
}

/** L'unité porte-t-elle l'ancre du fournisseur ? (SIRET / SIREN, TVA dérivée du SIREN, nom complet.) Pure. */
export function anchoredToSupplier(text: string, a: SupplierAnchor): boolean {
  const d = digits(text);
  const siren = a.siren ?? (a.siret ? a.siret.slice(0, 9) : null);
  if (a.siret && d.includes(a.siret)) return true;
  if (siren && siren.length === 9) {
    for (const m of text.matchAll(VAT_RE)) { const p = parseFrVat(m[0]); if (p?.valid && p.siren === siren) return true; }
    if (new RegExp(`(?<!\\d)${siren.slice(0, 3)}\\s?${siren.slice(3, 6)}\\s?${siren.slice(6)}(?!\\d)`).test(text)) return true;
  }
  const t = nameTokens(a.name);
  if (t.length === 0) return false;
  const p = ` ${plain(text)} `;
  return t.every((w) => p.includes(` ${w} `));
}

/** L'unité porte-t-elle une marque du DESTINATAIRE (membre du compte, adresse d'un bien) ? Pure. */
export function markedAsRecipient(text: string, r: RecipientMarks): boolean {
  const p = ` ${plain(text)} `;
  if (r.names.some((n) => n.length >= 3 && p.includes(` ${plain(n)} `))) return true;
  const low = text.toLowerCase();
  if (r.emails.some((e) => e && low.includes(e.toLowerCase()))) return true;
  for (const ad of readPostalAddresses(text)) {
    if (r.addresses.some((x) => x.postalCode === ad.postalCode && !!x.line && plain(ad.addressLine1).includes(plain(x.line)))) return true;
  }
  return false;
}

/** L'e-mail désigne-t-il le fournisseur par son nom (partie locale ou domaine) ? Pure. */
export function emailNamesSupplier(email: string, name: string | null | undefined): boolean {
  const e = plain(email.replace(/[@._-]+/g, ' '));
  return nameTokens(name).some((w) => ` ${e} `.includes(` ${w} `) || e.split(' ').some((x) => x.length >= 4 && x.startsWith(w)));
}
