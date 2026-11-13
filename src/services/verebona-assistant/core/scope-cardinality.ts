/**
 * Lot 114A (Trello #753, CDC T2 §1.3-2, §5.2, §6.2, §12.1, M08) — CARDINALITÉ DE LA PORTÉE.
 *
 * « Mon vélo » vise UN bien ; « mes vélos » vise l'ensemble. Tant que cette
 * différence n'est pas lue, une question au singulier posée sur un compte
 * qui possède deux vélos peut recevoir un total portant sur les deux.
 *
 * Ce module ne contient AUCUNE règle métier : il lit uniquement la
 * grammaire du français (déterminant singulier ou pluriel devant le mot qui
 * désigne le bien). Les mots qui désignent un bien sont fournis par
 * l'appelant, à partir des biens réels du compte et du référentiel.
 *
 *   SINGLE      un seul élément visé (« mon vélo », « la Clio », « ce bien ») ;
 *   COLLECTION  un ensemble explicitement demandé (« mes vélos », « tous mes
 *               contrats », « chaque voiture ») ;
 *   GLOBAL      aucune désignation : tout le périmètre du compte ;
 *   UNKNOWN     une désignation existe mais son nombre n'est pas établi.
 *
 * Règle d'emploi (garde commune) : un agrégat n'est JAMAIS calculé sur des
 * biens concurrents si la cardinalité n'est pas COLLECTION. COLLECTION n'est
 * jamais déduit d'un échec de résolution : seul un pluriel écrit le fonde.
 */

export type ScopeCardinality = 'SINGLE' | 'COLLECTION' | 'GLOBAL' | 'UNKNOWN';

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const tokens = (message: string): string[] =>
  plain(message).replace(/['’]/g, ' ').split(/[^a-z0-9-]+/).filter(Boolean);

/** Déterminants et quantifieurs qui annoncent PLUSIEURS éléments. */
const PLURIEL = new Set([
  'mes', 'tes', 'ses', 'nos', 'vos', 'leurs', 'les', 'ces', 'des', 'aux',
  'tous', 'toutes', 'chaque', 'chacun', 'chacune', 'plusieurs', 'differents', 'differentes',
  'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
]);

/** Déterminants qui annoncent UN SEUL élément. */
const SINGULIER = new Set([
  'mon', 'ma', 'ton', 'ta', 'son', 'sa', 'notre', 'votre', 'leur',
  'le', 'la', 'l', 'ce', 'cet', 'cette', 'un', 'une', 'du', 'au',
]);

/** Mots qui peuvent s'intercaler entre le déterminant et le nom (« mes deux vieux vélos »). */
const INTERCALAIRE = new Set([
  'de', 'd', 'autre', 'autres', 'ancien', 'ancienne', 'anciens', 'anciennes', 'nouveau', 'nouvelle', 'nouveaux', 'nouvelles',
  'vieux', 'vieille', 'vieilles', 'petit', 'petite', 'petits', 'petites', 'grand', 'grande', 'grands', 'grandes',
  'premier', 'premiere', 'second', 'seconde', 'dernier', 'derniere', 'propre', 'propres',
]);

const singulierDe = (w: string) => (w.length > 3 && /[sx]$/.test(w) ? w.slice(0, -1) : w);

/**
 * Cardinalité demandée par le message.
 *
 * @param designations mots du message qui désignent réellement un bien du
 *   compte ou une catégorie de biens (déjà normalisés ou non). Liste vide :
 *   le message ne désigne rien — portée GLOBAL.
 */
export function detectScopeCardinality(message: string, designations: readonly string[]): ScopeCardinality {
  const cibles = new Set(designations.map((d) => plain(d)).flatMap((d) => [d, singulierDe(d)]));
  if (cibles.size === 0) return 'GLOBAL';
  const t = tokens(message);
  let singulier = false;
  let trouve = false;
  for (let i = 0; i < t.length; i++) {
    if (!cibles.has(t[i]) && !cibles.has(singulierDe(t[i]))) continue;
    trouve = true;
    // Remonte jusqu'au déterminant, en traversant les mots intercalaires.
    let pluriel = false;
    let det = false;
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      const w = t[j];
      if (PLURIEL.has(w)) { pluriel = true; det = true; continue; }
      if (SINGULIER.has(w)) { det = true; break; }
      if (INTERCALAIRE.has(w)) continue;
      break;
    }
    // « tous mes vélos », « mes deux vélos », « chaque voiture » : ensemble demandé.
    if (pluriel) return 'COLLECTION';
    if (det) singulier = true;
  }
  if (!trouve) return 'UNKNOWN';
  // Désignation sans déterminant (« dépenses Clio ») : un nom propre vise un seul bien.
  return singulier ? 'SINGLE' : 'UNKNOWN';
}

/**
 * Garde commune avant toute totalisation : `true` si l'agrégat est permis.
 * Plusieurs biens concurrents ne sont additionnés que pour un ensemble
 * explicitement demandé.
 */
export function aggregateAllowed(scope: { ambiguous: boolean; cardinality?: ScopeCardinality }): boolean {
  return !scope.ambiguous || scope.cardinality === 'COLLECTION';
}
