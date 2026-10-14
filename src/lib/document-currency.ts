/**
 * Devise d'un montant documentaire — lot 38, O0 (CDC Opérations V1 §11.4,
 * C12.3 : « montant et devise d'origine toujours conservés » ; « aucun appel
 * automatique à la BCE » ; une valeur non EUR sans conversion fiable ne
 * nourrit aucun champ ni agrégat en euros).
 *
 * FONCTION PURE, déterministe (aucun appel modèle) : la devise est LUE dans
 * l'extrait qui prouve le montant, sinon dans la transcription du document.
 *
 *   · devise écrite avec le montant          → retenue (`basis: 'amount'`) ;
 *   · sinon une seule devise dans le document → retenue (`'document'`) ;
 *   · aucune mention de devise               → EUR présumé (`'presumed'`) :
 *     simple HYPOTHÈSE de lecture (le contrat T1 déclare `amountCents` en
 *     centimes d'euro), jamais une devise établie ;
 *   · plusieurs devises sans devise écrite avec le montant → INDÉTERMINÉE
 *     (`code: null`, `'ambiguous'`) : jamais présumée EUR.
 *
 * Lot 53D (retour PO D2, 13/10/2026) : « ne pas intégrer aux totaux un prix
 * exprimé dans une devise seulement présumée ; ne pas déduire EUR du seul
 * contexte du compte ». Une devise PRÉSUMÉE n'est donc jamais une devise
 * ÉTABLIE (`isCurrencyEstablished`) : le montant est conservé, sa devise est
 * stockée « XXX » (ISO 4217 : aucune devise) et il reste hors des agrégats
 * EUR jusqu'à confirmation ; un prix d'achat ainsi lu n'est qu'une
 * proposition à confirmer.
 *
 * Seul `code === 'EUR'` autorise une propagation vers un champ en euros
 * (`isEurAmount`). Aucune conversion n'est jamais faite ici.
 */

export type CurrencyBasis = 'amount' | 'document' | 'presumed' | 'ambiguous';

export interface CurrencyDetection {
  /** Code ISO 4217, ou null si indéterminé (plusieurs devises). */
  code: string | null;
  basis: CurrencyBasis;
  /** Devises repérées (extrait du montant puis document), sans doublon. */
  seen: string[];
}

/** Code ISO 4217 « aucune devise » : valeur stockée quand la devise est indéterminée. */
export const UNDETERMINED_CURRENCY = 'XXX';

/** Codes ISO écrits en majuscules (sensible à la casse : « cad » n'est pas une devise). */
const CODES = /\b(EUR|USD|GBP|CHF|CAD|AUD|NZD|JPY|CNY|HKD|SGD|SEK|NOK|DKK|ISK|PLN|CZK|HUF|RON|BGN|TRY|MAD|TND|DZD|XOF|XAF|XPF|INR|BRL|MXN|ZAR|AED)\b/g;

/** Symboles (les plus longs d'abord : « US$ » avant « $ »). */
const SYMBOLES: ReadonlyArray<[RegExp, string]> = [
  [/US\s?\$/g, 'USD'],
  [/(?:CA|C)\$/g, 'CAD'],
  [/(?:AU|A)\$/g, 'AUD'],
  [/NZ\$/g, 'NZD'],
  [/HK\$/g, 'HKD'],
  [/S\$/g, 'SGD'],
  [/\$/g, 'USD'],
  [/€/g, 'EUR'],
  [/£/g, 'GBP'],
  [/¥/g, 'JPY'],
];

/** Mots (insensible à la casse). */
const MOTS: ReadonlyArray<[RegExp, string]> = [
  [/\beuros?\b/gi, 'EUR'],
  [/\bfrancs?\s+suisses?\b/gi, 'CHF'],
  [/\bSFr\.?(?=\s|\d|$)/g, 'CHF'],
  [/\bFr\.\s?\d/g, 'CHF'],
  [/\b(?:francs?\s+CFP|F\s?CFP|CFP)\b/gi, 'XPF'],
  [/\bfrancs?\s+CFA\b/gi, 'XOF'],
  [/\blivres?\s+sterling\b/gi, 'GBP'],
  [/\bdollars?\s+canadiens?\b/gi, 'CAD'],
  [/\bdollars?\b/gi, 'USD'],
];

/** Devises mentionnées dans un texte, dans l'ordre d'apparition, sans doublon. */
export function currenciesIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const hits: Array<{ at: number; code: string }> = [];
  let reste = text;
  // Chaque motif reconnu est MASQUÉ (remplacé par des espaces, positions
  // conservées) : « dollars canadiens » n'est pas relu comme « dollars »,
  // ni « US$ » comme « $ ».
  const masquer = (re: RegExp, code: (m: RegExpExecArray) => string) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    const zones: Array<[number, number]> = [];
    while ((m = g.exec(reste)) !== null) {
      if (m[0].length === 0) { g.lastIndex++; continue; }
      hits.push({ at: m.index, code: code(m) });
      zones.push([m.index, m.index + m[0].length]);
    }
    for (const [d, f] of zones) reste = reste.slice(0, d) + ' '.repeat(f - d) + reste.slice(f);
  };
  for (const [re, code] of MOTS) masquer(re, () => code);
  for (const [re, code] of SYMBOLES) masquer(re, () => code);
  masquer(CODES, (m) => m[1]);
  return [...new Set(hits.sort((x, y) => x.at - y.at).map((h) => h.code))];
}

export function detectDocumentCurrency(input: {
  /** Extrait qui prouve le montant (« Total TTC : 1 250,00 CHF »). */
  amountExcerpt?: string | null;
  /** Valeur brute lue, si elle porte son unité (« 1 250 CHF »). */
  rawValue?: string | number | null;
  /** Transcription complète du document. */
  transcription?: string | null;
}): CurrencyDetection {
  const duMontant = currenciesIn([typeof input.rawValue === 'string' ? input.rawValue : '', input.amountExcerpt ?? ''].join(' '));
  const duDocument = currenciesIn(input.transcription);
  const seen = [...new Set([...duMontant, ...duDocument])];
  if (duMontant.length === 1) return { code: duMontant[0], basis: 'amount', seen };
  if (duMontant.length > 1) return { code: null, basis: 'ambiguous', seen };
  if (duDocument.length === 1) return { code: duDocument[0], basis: 'document', seen };
  if (duDocument.length > 1) return { code: null, basis: 'ambiguous', seen };
  return { code: 'EUR', basis: 'presumed', seen };
}

/** Le montant peut-il nourrir un champ en euros (sans conversion) ? */
export function isEurAmount(d: CurrencyDetection): boolean {
  return d.code === 'EUR';
}

/** Devise explicitement étrangère (écrite, unique, non EUR) — sinon null. */
export function foreignCurrencyOf(d: CurrencyDetection): string | null {
  return d.code !== null && d.code !== 'EUR' ? d.code : null;
}

/** Devise ÉCRITE sur le document (avec le montant, ou seule devise du document) — jamais présumée. */
export function isCurrencyEstablished(d: CurrencyDetection): boolean {
  return d.code !== null && (d.basis === 'amount' || d.basis === 'document');
}

/**
 * Valeur stockable dans `document_extractions.currency` (NOT NULL). Lot 53D
 * (D2) : une devise seulement PRÉSUMÉE est stockée « XXX » — le montant est
 * conservé, il n'entre dans aucun agrégat EUR.
 */
export function storableCurrency(d: CurrencyDetection): string {
  return isCurrencyEstablished(d) ? d.code! : UNDETERMINED_CURRENCY;
}

/** Écritures possibles d'un montant (unités mineures, 2 décimales) : « 1 250,00 », « 1250.00 », « 1.250,00 »… */
function amountWritings(amountMinor: number): string[] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return [];
  const ent = Math.floor(amountMinor / 100);
  const dec = String(amountMinor % 100).padStart(2, '0');
  const groupe = (sep: string) => String(ent).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const entiers = [...new Set([String(ent), groupe(' '), groupe(' '), groupe(' '), groupe('.'), groupe(','), groupe('\'')])];
  const out = new Set<string>();
  for (const e of entiers) {
    out.add(`${e},${dec}`);
    out.add(`${e}.${dec}`);
    if (dec === '00') { out.add(`${e},-`); out.add(`${e}.-`); }
  }
  // Montant rond écrit sans décimales (« 1 250 € »), seulement s'il est groupé ou ≥ 10.
  if (dec === '00' && ent >= 10) for (const e of entiers) out.add(e);
  return [...out];
}

const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Devises écrites JUSTE À CÔTÉ d'un montant donné dans des textes (lot 53D,
 * D2 / Q16) : « 1 250,00 CHF », « CHF 1 250.00 », « 749,00 € ». Pure. Rend
 * les devises distinctes trouvées (ordre d'apparition) ; vide : le montant
 * n'est écrit nulle part avec une devise accolée.
 */
export function currenciesNextToAmount(texts: ReadonlyArray<string | null | undefined>, amountMinor: number): string[] {
  const formes = amountWritings(amountMinor).sort((a, b) => b.length - a.length);
  if (!formes.length) return [];
  // Ni chiffre avant (« 11 250,00 » ne contient pas « 1 250,00 »), ni groupe de milliers (« 1 250,00 » ne contient pas « 250,00 »).
  const motif = new RegExp(`(?<![\\d.,])(?<!\\d[\\s  .,'])(?:${formes.map(echapper).join('|')})(?![\\d]|[.,]\\d)`, 'g');
  const vues: string[] = [];
  for (const t of texts) {
    if (!t) continue;
    let m: RegExpExecArray | null;
    while ((m = motif.exec(t)) !== null) {
      const avant = t.slice(Math.max(0, m.index - 6), m.index);
      const apres = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
      // Devise accolée : immédiatement après (« 749,00 € », « 749,00 EUR TTC »), sinon immédiatement avant (« CHF 749.00 »).
      const suite = currenciesIn(/^\s{0,2}(\S+(?:\s+suisses?|\s+CFP|\s+CFA|\s+sterling|\s+canadiens?)?)/i.exec(apres)?.[1] ?? '');
      const devant = currenciesIn(/(\S+)\s{0,2}$/.exec(avant)?.[1] ?? '');
      const c = suite[0] ?? devant[0];
      if (c && !vues.includes(c)) vues.push(c);
    }
  }
  return vues;
}
