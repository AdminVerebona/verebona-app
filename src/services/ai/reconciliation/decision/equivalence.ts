/**
 * Équivalence MÉTIER de deux valeurs d'un champ — lot 81A (ticket « [P1] T3 /
 * À traiter — Corriger les faux arbitrages entre valeurs identiques »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE RÉPONSE À « CES DEUX VALEURS SONT-ELLES LA MÊME ? »
 *
 * Cas « Maison » : une carte demandait d'arbitrer la date d'achat entre
 * 06/05/2021 et 06/05/2021. Deux causes de code y menaient :
 *   · le moteur proposait la meilleure preuve même quand elle ÉGALAIT la
 *     valeur en place (la vraie contradiction était une troisième valeur) ;
 *   · la comparaison passait par `normalize`, dont l'aiguillage historique
 *     se fait sur le NOM du champ (figé par un test de parité) : un alias de
 *     date dont le nom ne contient pas « date » (`acquisitionDay`) était
 *     comparé comme un texte — « 06/05/2021 » ≠ « 2021-05-06 ».
 *
 * La clé de comparaison combine donc les deux normaliseurs EXISTANTS, sans en
 * créer un troisième :
 *   · clé du registre canonique (alias résolu, unité d'alias déclarée) de
 *     nature date, montant, nombre, booléen ou liste fermée → la
 *     normalisation du registre (`normalizeValue`) — la même que la primitive
 *     d'écriture et que l'affichage de la fiche ;
 *   · sinon (texte, JSON, clé hors registre, valeur illisible pour le
 *     registre) → `normalize` (accents, casse, espaces), comportement
 *     historique du moteur, inchangé.
 *
 * Module PUR (aucun accès base) — utilisé par le moteur de décision, le pont
 * « À traiter », le contrôle de création des actions et le rattrapage.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getField, normalizeValue, resolveAliasDetailed } from '@/services/canonical/registry';
import { normalize } from './normalizers';

/** Natures pour lesquelles la normalisation du registre fait foi. */
const STRICT_TYPES = new Set(['date', 'money_eur', 'money_cents', 'number', 'boolean', 'enum']);

/** Valeur « vide » au sens d'un arbitrage (aucune valeur à proposer). */
function isBlankValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '' || /^(null|undefined)$/i.test(v.trim());
  return false;
}

/** Une `Date` est lue comme sa forme ISO (même jour calendaire UTC que le registre). */
const brut = (v: unknown): unknown => (v instanceof Date ? (Number.isNaN(v.getTime()) ? null : v.toISOString()) : v);

/**
 * Clé de comparaison métier d'une valeur pour un champ (pure). `null` :
 * valeur vide ou inexploitable — jamais équivalente à une autre.
 */
export function businessKey(fieldKey: string, raw: unknown): string | null {
  const v = brut(raw);
  if (isBlankValue(v)) return null;
  const alias = resolveAliasDetailed(fieldKey);
  const def = alias ? getField(alias.key) : getField(fieldKey);
  if (def && STRICT_TYPES.has(def.valueType)) {
    const r = normalizeValue(def.key, v, alias?.sourceUnit ? { sourceUnit: alias.sourceUnit } : {});
    if (r.ok && r.value !== null && r.value !== undefined) return String(r.value);
  }
  const n = normalize(fieldKey, typeof v === 'object' ? JSON.stringify(v) : v);
  return n === null || n === '' ? null : n;
}

/**
 * Deux valeurs sont-elles ÉQUIVALENTES pour l'utilisateur ? Vraies si leurs
 * clés métier sont égales, ou si la normalisation historique du moteur les
 * confond (elle a toujours groupé les preuves ainsi). Deux valeurs vides
 * sont équivalentes ; vide et non vide ne le sont jamais.
 */
export function areBusinessEquivalent(fieldKey: string, a: unknown, b: unknown): boolean {
  const va = brut(a);
  const vb = brut(b);
  const ea = isBlankValue(va);
  const eb = isBlankValue(vb);
  if (ea || eb) return ea && eb;
  const ka = businessKey(fieldKey, va);
  if (ka !== null && ka === businessKey(fieldKey, vb)) return true;
  const na = normalize(fieldKey, typeof va === 'object' ? JSON.stringify(va) : va);
  const nb = normalize(fieldKey, typeof vb === 'object' ? JSON.stringify(vb) : vb);
  if (na !== null && na !== '' && na === nb) return true;
  // Dernier recours : même sérialisation (JSON, booléens…).
  return JSON.stringify(va) === JSON.stringify(vb);
}

/**
 * Valeurs RÉELLEMENT alternatives à la valeur en place (pure) : celles qui
 * ne lui sont pas équivalentes, sans doublon entre elles (ordre conservé —
 * la plus autoritaire d'abord). Valeur en place vide : toutes les valeurs
 * non vides, dédoublonnées.
 */
export function realAlternatives<T>(fieldKey: string, current: unknown, items: readonly T[], valueOf: (x: T) => unknown): T[] {
  const out: T[] = [];
  for (const it of items) {
    const v = valueOf(it);
    if (isBlankValue(brut(v))) continue;
    if (!isBlankValue(brut(current)) && areBusinessEquivalent(fieldKey, v, current)) continue;
    if (out.some((o) => areBusinessEquivalent(fieldKey, valueOf(o), v))) continue;
    out.push(it);
  }
  return out;
}
