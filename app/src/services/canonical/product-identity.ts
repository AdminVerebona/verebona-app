/**
 * Identité d'un PRODUIT (équipement, objet) — lot 101A (ticket « Continuité
 * conversationnelle et série d'un équipement », points E, F, G, H).
 *
 * Module PUR, partagé par T1 (garde-fou des fiches fournisseur), le registre
 * (forme des valeurs), T2 (validation d'un candidat) et le contrôle de
 * cohérence COH-EQUIPMENT-IDENTITY. Aucune règle propre au mot « série » :
 * les propriétés d'identité sont celles du registre canonique.
 *
 *   brand              marque (Samsung)
 *   productSeries      série / gamme / famille du produit (MG23K3515)
 *   modelName          modèle (MG23K3515AK)
 *   productReference   référence commerciale complète (MG23K3515AK/EF)
 *   productDesignation désignation commerciale (« Micro-ondes gril 23 L »)
 *   serialNumber       numéro de série de l'EXEMPLAIRE (identifiant physique)
 *
 * Trois services :
 *   · `identityValueProblem` : la valeur a-t-elle la FORME de la propriété ?
 *     (un prix n'est jamais un numéro de série, une offre « Série Spéciale
 *     Livebox » n'est pas une série de micro-onde, un VIN n'est pas une gamme) ;
 *   · `compareProductCodes` : deux codes désignent-ils le même produit
 *     (variante d'écriture, valeur plus précise) ou deux produits différents ?
 *   · `looksLikeGenericDesignation` : un libellé générique (« Micro-Ondes Gril
 *     23L ») n'est pas un modèle.
 */

/** Propriétés d'identité d'un produit (clés canoniques du registre). */
export const PRODUCT_IDENTITY_KEYS = [
  'brand', 'productSeries', 'modelName', 'productReference', 'productDesignation', 'serialNumber',
] as const;
export type ProductIdentityKey = (typeof PRODUCT_IDENTITY_KEYS)[number];

/** Propriétés qui portent un CODE produit comparable (série, modèle, référence). */
export const PRODUCT_CODE_KEYS: ReadonlySet<string> = new Set(['productSeries', 'modelName', 'productReference']);

export function isProductIdentityKey(key: string | null | undefined): key is ProductIdentityKey {
  return !!key && (PRODUCT_IDENTITY_KEYS as readonly string[]).includes(key);
}

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Montant ou prix (« 29,99 EUR », « 149 € », « EUR 12.50 », « 29,99 TTC »). */
const MONEY = /(^|\s)(\d{1,3}([ . ]\d{3})*|\d+)([.,]\d{1,2})?\s*(€|eur\b|euros?\b|ttc\b|ht\b)|(€|\beur\b)\s*\d/i;
/** Date seule (« 12/03/2024 », « 2024-03-12 »). */
const DATE_ONLY = /^\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\s*$/;
/** VIN : 17 caractères, sans I, O, Q, au moins une lettre et un chiffre. */
const VIN = /^(?=.*\d)(?=.*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}$/;
/** Vocabulaire d'offre commerciale / d'abonnement (jamais une identité de produit). */
const OFFER = /\b(offre|abonnement|forfait|edition limitee|serie speciale|serie limitee|promo|promotion|remise|livebox|box|fibre|option|souscription)\b/;

/** Code produit : un mot d'au moins 4 caractères mêlant lettres et chiffres (« MG23K3515AK »). */
const CODE_TOKEN = /^(?=[^\s]*\d)(?=[^\s]*[a-z])[a-z0-9][a-z0-9*#._/()-]{2,}$/i;

/** Mots d'un texte (lettres / chiffres). */
const motsDe = (s: string) => s.split(/\s+/).map((w) => w.replace(/^[^a-z0-9*]+|[^a-z0-9*)]+$/gi, '')).filter(Boolean);

/** Le texte contient-il un code produit (pure) ? */
export function containsProductCode(value: string): boolean {
  return motsDe(String(value)).some((w) => CODE_TOKEN.test(w) && w.replace(/[^a-z0-9]/gi, '').length >= 4);
}

/**
 * Libellé GÉNÉRIQUE (pure, testée) : « Micro-Ondes Gril 23L », « Four
 * encastrable », « Lave-linge 8 kg » — des mots courants, aucun code produit
 * de 5 caractères au moins. Jamais un modèle.
 */
export function looksLikeGenericDesignation(value: string): boolean {
  const mots = motsDe(String(value ?? ''));
  if (mots.length === 0) return false;
  const codeFort = mots.some((w) => CODE_TOKEN.test(w) && w.replace(/[^a-z0-9]/gi, '').length >= 5);
  if (codeFort) return false;
  const motsAlpha = mots.filter((w) => /^[a-zà-ÿ'-]{3,}$/i.test(w));
  return motsAlpha.length >= 1 && (mots.length >= 2 || motsAlpha.length === mots.length);
}

/** Motif d'une valeur incompatible avec sa propriété d'identité, ou `null` (pure, testée). */
export type IdentityValueProblem = 'MONEY' | 'DATE' | 'VIN' | 'OFFER' | 'GENERIC_LABEL' | 'FREE_TEXT';

export function identityValueProblem(key: string, raw: unknown): IdentityValueProblem | null {
  if (raw === null || raw === undefined || typeof raw === 'number' || !isProductIdentityKey(key)) return null;
  const v = String(raw).trim();
  if (!v) return null;
  // Marque, désignation : seul un montant est manifestement incompatible.
  if (key === 'brand' || key === 'productDesignation') return MONEY.test(v) && !containsProductCode(v) ? 'MONEY' : null;
  if (MONEY.test(v)) return 'MONEY';
  if (DATE_ONLY.test(v)) return 'DATE';
  if (OFFER.test(plain(v))) return 'OFFER';
  const compact = v.toUpperCase().replace(/[\s-]/g, '');
  if (key !== 'serialNumber' && VIN.test(compact)) return 'VIN';
  if (key === 'modelName' || key === 'productSeries' || key === 'productReference') {
    if (looksLikeGenericDesignation(v)) return 'GENERIC_LABEL';
  }
  if (key === 'serialNumber') {
    // Un numéro de série est un identifiant : jamais une phrase.
    const mots = motsDe(v);
    if (mots.length >= 3 && !containsProductCode(v)) return 'FREE_TEXT';
  }
  return null;
}

// ── Comparaison de codes produit (G) ─────────────────────────────────────

/**
 * Forme comparable d'un code (pure) : majuscules, sans espace ; « MC32J7035AK(MC32J7035AK_EF) »
 * → « MC32J7035AK » (la parenthèse répète une variante) ; jokers conservés.
 */
export function normalizeProductCode(raw: string): string {
  let s = String(raw ?? '').trim().toUpperCase();
  s = s.replace(/\s*\([^)]*\)\s*$/, '');
  return s.replace(/\s+/g, '');
}

/** Code sans séparateurs ni suffixe régional (« MG23K3515AK/EF » → « MG23K3515AK »). */
function racine(code: string): { base: string; region: string | null } {
  const m = /^(.+?)[/_](?:[A-Z]{2,3}|[A-Z]\d|\d[A-Z])$/.exec(code);
  const base = (m ? m[1] : code).replace(/[-.]/g, '');
  return { base, region: m ? code.slice(m[1].length + 1) : null };
}

/** Joker d'une référence générique (« MG23K3515** »). */
const JOKER = /[*#?]+$/;

export type ProductCodeRelation =
  /** Même code. */
  | 'SAME'
  /** Même code, écrit autrement (casse, tirets, espaces). */
  | 'FORMAT_VARIANT'
  /** `b` précise `a` (joker « MG23K3515** » → « MG23K3515AK », série → modèle, modèle → référence régionale). */
  | 'B_MORE_PRECISE'
  /** `a` précise `b`. */
  | 'A_MORE_PRECISE'
  /** Deux produits différents (MG23K3515AK ≠ MC32J7035AK). */
  | 'INCOMPATIBLE';

/**
 * Relation entre deux codes produit (pure, testée). Un préfixe n'est retenu
 * comme « plus précis » que s'il a au moins 5 caractères significatifs : deux
 * modèles qui ne partagent que « MG » restent incompatibles.
 */
export function compareProductCodes(a: string, b: string): ProductCodeRelation {
  const na = normalizeProductCode(a);
  const nb = normalizeProductCode(b);
  if (na === nb) return 'SAME';
  const ja = JOKER.test(na);
  const jb = JOKER.test(nb);
  const ra = racine(na.replace(JOKER, ''));
  const rb = racine(nb.replace(JOKER, ''));
  if (!ja && !jb && ra.base === rb.base && ra.region === rb.region) return 'FORMAT_VARIANT';
  if (ra.base === rb.base) {
    // Même racine : la référence régionale ou sans joker est la plus précise.
    if (ja !== jb) return ja ? 'B_MORE_PRECISE' : 'A_MORE_PRECISE';
    if (!ra.region && rb.region) return 'B_MORE_PRECISE';
    if (ra.region && !rb.region) return 'A_MORE_PRECISE';
    return 'INCOMPATIBLE';
  }
  const prefixe = (court: string, long: string) => court.length >= 5 && long.startsWith(court);
  if (prefixe(ra.base, rb.base)) return 'B_MORE_PRECISE';
  if (prefixe(rb.base, ra.base)) return 'A_MORE_PRECISE';
  return 'INCOMPATIBLE';
}

/** Deux codes désignent-ils le même produit (éventuellement plus précis) ? */
export function sameProduct(a: string, b: string): boolean {
  return compareProductCodes(a, b) !== 'INCOMPATIBLE';
}

/**
 * Codes produit d'un texte (pure) : mots qui ont la forme d'un code
 * (lettres + chiffres, ≥ 5 caractères significatifs), normalisés et dédoublonnés.
 */
export function productCodesIn(text: string): string[] {
  const out: string[] = [];
  for (const w of motsDe(String(text ?? ''))) {
    if (!CODE_TOKEN.test(w)) continue;
    const c = normalizeProductCode(w);
    if (c.replace(/[^A-Z0-9]/g, '').length < 5) continue;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Groupes de valeurs d'une propriété code d'un même objet (pure, testée) :
 * les valeurs du même produit sont regroupées (la plus précise en tête) ;
 * plus d'un groupe = modèles INCOMPATIBLES (conflit, jamais concaténés).
 */
export function groupProductCodes(values: readonly string[]): Array<{ best: string; members: string[] }> {
  const groupes: Array<{ best: string; members: string[] }> = [];
  for (const v of values) {
    const g = groupes.find((x) => x.members.some((m) => sameProduct(m, v)));
    if (!g) { groupes.push({ best: v, members: [v] }); continue; }
    if (!g.members.includes(v)) g.members.push(v);
    const r = compareProductCodes(g.best, v);
    if (r === 'B_MORE_PRECISE') g.best = v;
  }
  return groupes;
}
