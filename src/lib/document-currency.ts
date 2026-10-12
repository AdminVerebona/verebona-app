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
 *     document d'un compte français, et le contrat T1 déclare `amountCents`
 *     en centimes d'euro — c'est le comportement historique, conservé ;
 *   · plusieurs devises sans devise écrite avec le montant → INDÉTERMINÉE
 *     (`code: null`, `'ambiguous'`) : jamais présumée EUR.
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

/** Valeur stockable dans `document_extractions.currency` (NOT NULL). */
export function storableCurrency(d: CurrencyDetection): string {
  return d.code ?? UNDETERMINED_CURRENCY;
}
