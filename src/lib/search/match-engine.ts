/**
 * Moteur de correspondance de la recherche T2 — lot 33 (ticket « T2
 * Recherche : empêcher les faux positifs et imposer une correspondance
 * explicable avec la requête »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT
 *
 * « polo » remontait « Cupra » : la barre de recherche cherchait chaque mot
 * comme une SOUS-CHAÎNE (`ILIKE '%polo%'`) dans une quinzaine de colonnes,
 * dont la fiche canonique ENTIÈRE (`key_characteristics`, JSON : clés,
 * valeurs ET traces de provenance — `mileage__source: "Facture entretien VW
 * Polo"`), les notes, l'état, la liste d'équipements… Ailleurs, la catégorie
 * (« Voiture »), le nom du bien lié à un document ou une faute tolérée trop
 * largement (« polo » ↔ « golf », deux fautes) suffisaient à rendre un
 * élément « pertinent ». Relever un seuil n'aurait rien réglé : le faux
 * positif est STRUCTUREL.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE PIPELINE (toutes les recherches T2)
 *
 *   REQUÊTE → GÉNÉRATION DE CANDIDATS (SQL, large, sans valeur de preuve)
 *           → ÉLIGIBILITÉ (`evaluateCandidate`, ici : un match réel ou rien)
 *           → RANKING (`rankEligible`, sur les seuls éligibles)
 *           → AFFICHAGE
 *
 * Un score n'a jamais rendu un candidat éligible : l'éligibilité est décidée
 * AVANT le classement, sur des correspondances explicables
 * (`matchedField`, `matchedValue`, `matchType`). `matchedField = null` →
 * non éligible.
 *
 * Règles :
 *   · champs autorisés DÉCLARÉS par type d'entité (`SEARCH_FIELDS`) — un
 *     champ technique ou absent de la table ne produit aucun match ;
 *   · correspondance par MOT (début de mot), jamais à l'intérieur d'un mot
 *     (« polo » ⊄ « Apolon ») ;
 *   · CATÉGORIE (taxonomie `asset-taxonomy`, types documentaires) : ne rend
 *     éligible que si la requête vise la catégorie elle-même (tous ses mots
 *     sont du vocabulaire de catégorie) ; sinon elle ne fait que COMPLÉTER
 *     une correspondance directe (« facture toiture ») ;
 *   · RELATION (bien lié à un document) : même règle — elle complète, elle
 *     ne crée jamais un match ; aucune propagation d'une entité à ses
 *     voisines (`CROSS_ENTITY_PROPAGATION`). Seule exception DÉCLARÉE : le
 *     « bien concerné » d'une échéance (`relationEligible`, ticket §5) ;
 *   · FUZZY encadré : fautes de frappe (une faute de 5 à 7 lettres, deux à
 *     partir de 8, même première lettre), accents, pluriels, alias connus —
 *     jamais un objet « proche par le contexte » ;
 *   · SÉMANTIQUE (aucun générateur en V1, décision D-H2) : une similarité
 *     sous le seuil ne suffit jamais seule.
 *
 * Module PUR (aucun accès base) : utilisé par la barre de recherche
 * (`services/search/global-search.service.ts`) et par l'assistant
 * (`registries/retrieval-adapters.ts`).
 */
import { assetDesignationsIn, isAssetVocabularyWord, assetSearchSynonyms, subtypeMatchesCategory, toAssetFamilyCode } from '@/lib/asset-taxonomy';
import { DOCUMENT_TYPE_QUERY_WORDS, documentCodeLabel } from '@/lib/referential/document-codes';

// ── Classification ────────────────────────────────────────────────────────

export const MATCH_TYPES = ['EXACT', 'EXACT_TOKEN', 'PREFIX', 'NORMALIZED', 'ALIAS', 'FUZZY', 'SEMANTIC', 'RELATIONAL', 'CATEGORY'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export const REJECTION_REASONS = [
  'NO_MATCHING_FIELD', 'RELATION_ONLY', 'CATEGORY_ONLY', 'FUZZY_SCORE_TOO_LOW', 'SEMANTIC_SCORE_TOO_LOW',
  'CROSS_ENTITY_PROPAGATION',
  /** Barre de recherche : un mot de la requête n'est retrouvé nulle part sur l'élément. */
  'PARTIAL_MATCH',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/**
 * Éligibilité de chaque type de match (ticket §8) :
 *   EXACT, EXACT_TOKEN, PREFIX, NORMALIZED, ALIAS → oui ;
 *   FUZZY → oui si score ≥ `FUZZY_MIN_SCORE` ;
 *   SEMANTIC → oui si score ≥ `SEMANTIC_MIN_SCORE` et autorisé par la politique ;
 *   RELATIONAL → jamais seul (complète une correspondance directe) ;
 *   CATEGORY → seul seulement pour une requête de catégorie explicite.
 */
export const MATCH_TYPE_SCORES: Readonly<Record<MatchType, number>> = {
  EXACT: 1, EXACT_TOKEN: 0.95, NORMALIZED: 0.9, ALIAS: 0.85, PREFIX: 0.8, FUZZY: 0.7, SEMANTIC: 0.6, CATEGORY: 0.5, RELATIONAL: 0.4,
};
export const FUZZY_MIN_SCORE = 0.75;
export const SEMANTIC_MIN_SCORE = 0.82;

// ── Champs autorisés par type d'entité (ticket §5) ───────────────────────

export type SearchEntityType = 'asset' | 'document' | 'agenda_item' | 'equipment' | 'room' | 'supplier' | 'to_process' | 'export';

/**
 * Nature d'un champ :
 *   name       — libellé identifiant (nom, titre) : préfixe et fautes tolérés ;
 *   identifier — immatriculation, VIN, n° de série, code postal : exact
 *                (normalisé : casse, tirets, espaces) seulement ;
 *   text       — métadonnée courte (adresse, fournisseur, description) : mot
 *                entier ou début de mot, pas de faute ;
 *   content    — contenu indexé (texte extrait d'un document) : mot entier ou
 *                début de mot (4 lettres au moins), pas de faute ;
 *   category   — catégorie / type : match CATEGORY (voir l'en-tête) ;
 *   relation   — entité VOISINE (bien lié) : match RELATIONAL (complément).
 */
export type FieldKind = 'name' | 'identifier' | 'text' | 'content' | 'category' | 'relation';

export interface SearchFieldSpec {
  field: string;
  label: string;
  kind: FieldKind;
  /** Pondération du champ au classement (jamais à l'éligibilité). */
  weight: number;
  /** Taxonomie d'une catégorie : référentiel des biens, types documentaires, valeur libre. */
  taxonomy?: 'asset' | 'document' | 'free';
  /**
   * Relation EXPLICITEMENT autorisée à produire seule un match (ticket §5,
   * §8 « RELATIONAL → seulement dans les cas explicitement autorisés ») :
   * le « bien concerné » d'une échéance fait partie de son libellé
   * fonctionnel (« Contrôle technique » DE la Polo). Jamais pour un document
   * (bien associé : complément seulement).
   */
  relationEligible?: boolean;
}

const F = (field: string, label: string, kind: FieldKind, weight: number, taxonomy?: SearchFieldSpec['taxonomy'], relationEligible?: boolean): SearchFieldSpec =>
  ({ field, label, kind, weight, ...(taxonomy ? { taxonomy } : {}), ...(relationEligible ? { relationEligible } : {}) });

/**
 * SEULS champs qui peuvent produire une correspondance, par type d'entité.
 * Un champ absent d'ici (notes libres d'un bien, état général, dimensions,
 * moteur, liste d'équipements, nom de fichier de stockage, code de fonction,
 * identifiants techniques) ne rend jamais un élément éligible.
 */
export const SEARCH_FIELDS: Readonly<Record<SearchEntityType, readonly SearchFieldSpec[]>> = {
  asset: [
    F('name', 'Nom', 'name', 1),
    F('make', 'Marque', 'name', 0.9),
    F('model', 'Modèle', 'name', 0.9),
    F('brand', 'Marque', 'name', 0.9),
    F('registrationNumber', 'Immatriculation', 'identifier', 1),
    F('vin', 'VIN', 'identifier', 1),
    F('serialNumber', 'Numéro de série', 'identifier', 0.95),
    F('address', 'Adresse', 'text', 0.7),
    F('city', 'Ville', 'text', 0.75),
    F('postalCode', 'Code postal', 'identifier', 0.7),
    F('assetCategory', 'Catégorie', 'category', 0.6, 'asset'),
  ],
  document: [
    F('title', 'Titre', 'name', 1),
    F('originalFilename', 'Nom du fichier', 'name', 0.9),
    F('documentType', 'Type de document', 'category', 0.6, 'document'),
    F('supplier', 'Émetteur', 'text', 0.8),
    F('description', 'Description', 'text', 0.7),
    F('notes', 'Notes', 'text', 0.6),
    F('content', 'Contenu indexé', 'content', 0.55),
    F('assetName', 'Bien associé', 'relation', 0.4),
  ],
  agenda_item: [
    F('title', 'Libellé', 'name', 1),
    F('description', 'Description', 'text', 0.7),
    F('assetNames', 'Bien concerné', 'relation', 0.5, undefined, true),
  ],
  equipment: [
    F('name', 'Nom', 'name', 1),
    F('type', 'Type', 'category', 0.6, 'free'),
    F('assetName', 'Bien', 'relation', 0.4),
  ],
  room: [
    F('name', 'Nom', 'name', 1),
    F('assetName', 'Bien', 'relation', 0.4),
  ],
  supplier: [
    F('name', 'Nom', 'name', 1),
    F('city', 'Ville', 'text', 0.6),
  ],
  to_process: [
    F('question', 'Question', 'text', 1),
  ],
  export: [
    F('name', 'Nom', 'name', 1),
    F('exportType', 'Type de dossier', 'category', 0.6, 'free'),
    F('assetName', 'Bien', 'relation', 0.4),
  ],
};

/** Champs autorisés d'un type (copie). */
export function searchFieldsOf(type: SearchEntityType): SearchFieldSpec[] {
  return [...SEARCH_FIELDS[type]];
}

// ── Normalisation ─────────────────────────────────────────────────────────

/** Minuscules, sans accent ni ligature, ponctuation → espace (même règle que `unaccent(lower())`). */
export function normalizeSearchText(s: unknown): string {
  return String(s ?? '')
    .replace(/[œŒ]/g, 'oe').replace(/[æÆ]/g, 'ae').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const motsDe = (s: unknown): string[] => normalizeSearchText(s).split(' ').filter(Boolean);
const compact = (s: unknown): string => normalizeSearchText(s).replace(/ /g, '');
/** Minuscules AVEC accents (pour distinguer EXACT_TOKEN de NORMALIZED). */
const motsBruts = (s: unknown): string[] => String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Singulier simple (« factures » → « facture ») : s / x finaux, pas les irréguliers. */
export function singularOf(w: string): string {
  if (w.length > 3 && /[a-z]s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  if (w.length > 4 && /aux$/.test(w)) return w;
  if (w.length > 3 && /[a-z]x$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Distance d'édition bornée (Damerau restreinte : une inversion = une faute). */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cout = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cout);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** Fautes tolérées selon la longueur (ticket §6) : aucune sous 5 lettres. */
export function fuzzyTolerance(len: number): number {
  return len >= 8 ? 2 : len >= 5 ? 1 : 0;
}

// ── Requête ───────────────────────────────────────────────────────────────

/** Mots outils retirés d'une requête de la barre de recherche. */
const MOTS_OUTILS = new Set([
  'a', 'au', 'aux', 'avec', 'c', 'ce', 'ces', 'd', 'dans', 'de', 'des', 'du', 'en', 'et', 'l', 'la', 'le', 'les',
  'ma', 'mes', 'mon', 'ou', 'par', 'pour', 'sa', 'ses', 'son', 'sur', 'ta', 'tes', 'ton', 'un', 'une', 'vos', 'votre', 'nos', 'notre',
]);

/**
 * Alias CONNUS (ticket §6 « abréviations, aliases connus ») — formes
 * normalisées, symétriques. Volontairement courts : un alias est une autre
 * ÉCRITURE du même mot, jamais un objet voisin.
 */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['vw', 'volkswagen'],
  ['ct', 'controle'],
  ['mercedes', 'mb'],
  ['bmw', 'bayerische'],
];
const ALIAS_PAR_MOT = new Map<string, string[]>();
for (const g of ALIAS_GROUPS) for (const m of g) ALIAS_PAR_MOT.set(m, g.filter((x) => x !== m));

export interface QueryToken {
  /** Forme normalisée saisie. */
  norm: string;
  /** Singulier. */
  stem: string;
  /** Autres écritures légitimes (alias, synonymes déclarés). */
  aliases: string[];
  /** Identifiant (chiffres, immatriculation, VIN) : exact seulement. */
  identifier: boolean;
  /** Mot de catégorie (référentiel des biens, types documentaires). */
  category: boolean;
}

export interface ParsedQuery {
  raw: string;
  /** Requête normalisée complète (sert au match EXACT de valeur). */
  normalized: string;
  tokens: QueryToken[];
  /** Tous les mots sont du vocabulaire de catégorie : « voitures », « factures ». */
  categoryQuery: boolean;
}

const MOTS_TYPE_DOC = new Set([...DOCUMENT_TYPE_QUERY_WORDS, 'devi', 'devis']);

/** Le mot désigne-t-il une catégorie (bien ou type documentaire) ? */
export function isCategoryWord(w: string): boolean {
  const s = singularOf(w);
  return isAssetVocabularyWord(w) || isAssetVocabularyWord(s) || MOTS_TYPE_DOC.has(w) || MOTS_TYPE_DOC.has(s);
}

function token(norm: string, extraAliases: string[] = [], identifier?: boolean): QueryToken {
  const stem = /\d/.test(norm) ? norm : singularOf(norm);
  const category = !identifier && isCategoryWord(norm);
  const aliases = new Set<string>([...(ALIAS_PAR_MOT.get(norm) ?? []), ...(ALIAS_PAR_MOT.get(stem) ?? []), ...extraAliases]);
  if (category) for (const s of assetSearchSynonyms(stem)) aliases.add(s);
  aliases.delete(norm); aliases.delete(stem);
  return { norm, stem, aliases: [...aliases].filter(Boolean), identifier: identifier ?? /\d/.test(norm), category };
}

const PLAQUE = /\b[A-Za-z]{2}[- ]?\d{3}[- ]?[A-Za-z]{2}\b/g;
const VIN = /\b[A-HJ-NPR-Za-hj-npr-z0-9]{17}\b/g;

/** Découpe une requête de la barre de recherche (pure). */
export function parseSearchQuery(q: string): ParsedQuery {
  const raw = String(q ?? '').trim().slice(0, 200);
  const proteges = [...(raw.match(PLAQUE) ?? []), ...(raw.match(VIN) ?? []).filter((v) => /\d/.test(v) && /[a-z]/i.test(v))];
  let reste = raw;
  const tokens: QueryToken[] = [];
  const vus = new Set<string>();
  for (const p of proteges) {
    reste = reste.replace(p, ' ');
    const c = compact(p);
    if (!vus.has(c)) { vus.add(c); tokens.push(token(c, [], true)); }
  }
  for (const m of motsDe(reste)) {
    if (m.length === 1 && !/^\d$/.test(m)) continue;
    if (MOTS_OUTILS.has(m)) continue;
    const t = token(m);
    if (vus.has(t.stem)) continue;
    vus.add(t.stem);
    tokens.push(t);
  }
  const kept = tokens.slice(0, 8);
  return {
    raw,
    normalized: normalizeSearchText(raw),
    tokens: kept,
    categoryQuery: kept.length > 0 && kept.every((t) => t.category),
  };
}

/**
 * Requête à partir des termes déjà découpés par l'assistant
 * (`core/query-terms` : racine, synonymes métier, exact) — mêmes règles
 * d'éligibilité que la barre de recherche.
 */
export function queryFromTerms(terms: ReadonlyArray<{ raw: string; stem: string; variants: string[]; exact: boolean }>, raw?: string): ParsedQuery {
  const tokens = terms.map((t) => {
    const norm = t.exact ? compact(t.raw) : normalizeSearchText(t.raw).replace(/ /g, '');
    const base = token(norm, t.variants.map((v) => (t.exact ? compact(v) : normalizeSearchText(v).replace(/ /g, ''))), t.exact);
    return { ...base, stem: t.exact ? norm : normalizeSearchText(t.stem).replace(/ /g, '') || base.stem };
  }).filter((t) => t.norm);
  return {
    raw: raw ?? terms.map((t) => t.raw).join(' '),
    normalized: normalizeSearchText(raw ?? terms.map((t) => t.raw).join(' ')),
    tokens,
    categoryQuery: tokens.length > 0 && tokens.every((t) => t.category),
  };
}

// ── Correspondance d'un mot sur une valeur ────────────────────────────────

export interface FieldMatch {
  field: string;
  kind: FieldKind;
  matchType: MatchType;
  /** Valeur (ou extrait) qui porte la correspondance. */
  matchedValue: string;
  /** Mot de la requête concerné (forme normalisée). */
  token: string;
  /** Score de la correspondance (type × pondération du champ). */
  score: number;
}

type MotMatch = { type: MatchType; quality: number } | { tooLow: number } | null;

function matchMot(tok: QueryToken, value: string, kind: FieldKind): MotMatch {
  const mots = motsDe(value);
  if (mots.length === 0) return null;
  // Identifiant : égalité normalisée (casse, tirets, espaces), jamais partielle.
  if (kind === 'identifier' || tok.identifier) {
    const c = compact(value);
    if (c === tok.norm || c === tok.stem) return { type: String(value).toLowerCase() === tok.norm ? 'EXACT' : 'NORMALIZED', quality: 1 };
    if (mots.includes(tok.norm)) return { type: 'EXACT_TOKEN', quality: 1 };
    // Identifiant écrit en plusieurs morceaux dans un texte (« AB-123-CD »,
    // « 12/03/2024 ») : suite de mots CONSÉCUTIFS dont la jonction est exacte.
    for (let i = 0; i < mots.length; i++) {
      let joint = mots[i];
      for (let k = i + 1; k < Math.min(mots.length, i + 6) && joint.length < tok.norm.length; k++) {
        joint += mots[k];
        if (joint === tok.norm) return { type: 'NORMALIZED', quality: 1 };
      }
    }
    if (tok.aliases.some((a) => a === c || mots.includes(a))) return { type: 'ALIAS', quality: 1 };
    return null;
  }
  const bruts = motsBruts(value);
  if (mots.includes(tok.norm)) {
    return { type: bruts.some((b) => b === tok.norm) ? 'EXACT_TOKEN' : 'NORMALIZED', quality: 1 };
  }
  if (mots.some((w) => singularOf(w) === tok.stem || w === tok.stem)) return { type: 'NORMALIZED', quality: 1 };
  if (tok.aliases.some((a) => mots.some((w) => w === a || singularOf(w) === a))) return { type: 'ALIAS', quality: 1 };
  // Début de mot (jamais à l'intérieur : « polo » ⊄ « Apolon »).
  const minPrefix = kind === 'content' ? 4 : 3;
  if (kind !== 'category' && kind !== 'relation' && tok.norm.length >= minPrefix && mots.some((w) => w.length > tok.norm.length && w.startsWith(tok.norm))) {
    return { type: 'PREFIX', quality: 1 };
  }
  // Faute de frappe : noms et titres seulement, même première lettre.
  if (kind === 'name') {
    const tol = fuzzyTolerance(tok.stem.length);
    let meilleur: number | null = null;
    for (const w of mots) {
      if (w.length < 4 || w[0] !== tok.stem[0]) continue;
      const d = boundedEditDistance(singularOf(w), tok.stem, Math.max(tol, 2));
      if (d > Math.max(tol, 2)) continue;
      const q = 1 - d / Math.max(tok.stem.length, singularOf(w).length);
      if (tol > 0 && d <= tol && q >= FUZZY_MIN_SCORE) return { type: 'FUZZY', quality: q };
      meilleur = Math.max(meilleur ?? 0, q);
    }
    if (meilleur !== null) return { tooLow: meilleur };
  }
  return null;
}

/** Mots-clés de catégorie d'une valeur de type documentaire (code → libellé). */
function documentTypeWords(code: string): string {
  const label = (() => { try { return documentCodeLabel(code); } catch { return ''; } })();
  return `${code.replace(/_/g, ' ')} ${label}`;
}

/** Correspondance de catégorie (référentiel des biens) : catégorie précise jamais élargie à la famille. */
function matchAssetCategory(tok: QueryToken, tax: AssetTaxonomyValue): boolean {
  const d = assetDesignationsIn(tok.norm)[0] ?? assetDesignationsIn(tok.stem)[0];
  if (!d) return false;
  const famille = toAssetFamilyCode(tax.family ?? '') ?? null;
  if (d.kind === 'family') return famille === d.family;
  if (subtypeMatchesCategory(tax.subtype, d.category!)) return true;
  // Bien de la même famille SANS catégorie renseignée (règle 8b §C).
  return famille === d.family && !String(tax.subtype ?? '').trim() && !String(tax.objectCategory ?? '').trim();
}

// ── Candidats et éligibilité ─────────────────────────────────────────────

export interface AssetTaxonomyValue { family?: string | null; subtype?: string | null; objectCategory?: string | null }

export interface SearchCandidate {
  entityType: SearchEntityType;
  entityId: string | number;
  displayName: string;
  /** Valeurs des champs autorisés (les autres sont ignorés). Liste : plusieurs valeurs (biens liés). */
  fields: Readonly<Record<string, string | null | undefined | ReadonlyArray<string | null | undefined>>>;
  /** Catégorie d'un bien (référentiel `asset-taxonomy`) — champ `assetCategory`. */
  assetTaxonomy?: AssetTaxonomyValue | null;
  /** Similarité sémantique éventuelle (0-1). Aucun générateur en V1. */
  semanticScore?: number | null;
  /** Stratégie qui a produit le candidat (traces). */
  retrievalStrategy: string;
  /** Candidat produit par une RELATION (voisin d'une entité qui correspond) : jamais éligible seul. */
  propagatedFrom?: { entityType: SearchEntityType; entityId: string | number } | null;
}

export interface SearchPolicy {
  /** Tous les mots de la requête doivent être retrouvés (barre de recherche). */
  requireAllTokens: boolean;
  /** Correspondance sémantique admise (au-dessus de `semanticMinScore`). */
  allowSemantic?: boolean;
  semanticMinScore?: number;
}

export type EligibilityReason =
  | 'EXACT_VALUE' | 'DIRECT_MATCH' | 'DIRECT_MATCH_WITH_QUALIFIER' | 'AUTHORIZED_RELATION' | 'EXPLICIT_CATEGORY_QUERY'
  | 'SEMANTIC_ABOVE_THRESHOLD' | 'STRUCTURED_FILTER';

export interface CandidateEvaluation {
  candidate: SearchCandidate;
  eligible: boolean;
  eligibilityDecision: 'ELIGIBLE' | 'REJECTED';
  eligibilityReason: EligibilityReason | RejectionReason;
  rejectionReason: RejectionReason | null;
  matchedField: string | null;
  matchedValue: string | null;
  matchType: MatchType | null;
  /** Meilleure correspondance par mot de la requête. */
  matches: FieldMatch[];
  rawScore: number;
}

const valeurs = (v: SearchCandidate['fields'][string]): string[] =>
  (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x.trim() !== '');

const extraitDe = (v: string) => (v.length > 160 ? `${v.slice(0, 157)}…` : v);

const DIRECTS: ReadonlySet<FieldKind> = new Set(['name', 'identifier', 'text', 'content']);

/**
 * ÉLIGIBILITÉ d'un candidat (pure). Ne classe pas : `rawScore` ne sert
 * qu'au ranking, APRÈS la décision.
 */
export function evaluateCandidate(query: ParsedQuery, candidate: SearchCandidate, policy: SearchPolicy): CandidateEvaluation {
  const exacte = evaluer(query, candidate, policy, false);
  if (exacte.eligibilityReason !== 'EXACT_VALUE') return exacte;
  // Valeur entière égale sur un champ secondaire (ville « Annecy ») : la
  // correspondance par mot sur un champ plus fort (nom « Maison Annecy ») l'emporte.
  const parMots = evaluer(query, candidate, policy, true);
  return parMots.eligible && parMots.rawScore > exacte.rawScore ? parMots : exacte;
}

function evaluer(query: ParsedQuery, candidate: SearchCandidate, policy: SearchPolicy, sansExact: boolean): CandidateEvaluation {
  const specs = SEARCH_FIELDS[candidate.entityType] ?? [];
  const rejet = (reason: RejectionReason, matches: FieldMatch[] = []): CandidateEvaluation => ({
    candidate, eligible: false, eligibilityDecision: 'REJECTED', eligibilityReason: reason, rejectionReason: reason,
    matchedField: null, matchedValue: null, matchType: null, matches, rawScore: 0,
  });
  if (query.tokens.length === 0) return rejet('NO_MATCHING_FIELD');

  // EXACT : la valeur entière d'un champ direct EST la requête.
  let exact: FieldMatch | null = null;
  for (const s of specs) {
    if (!DIRECTS.has(s.kind) || s.kind === 'content') continue;
    for (const v of valeurs(candidate.fields[s.field])) {
      const egal = s.kind === 'identifier' ? compact(v) === compact(query.raw) : normalizeSearchText(v) === query.normalized;
      if (egal && query.normalized) {
        // Identifiant écrit autrement (« ab123cd » pour « AB-123-CD ») : NORMALIZED.
        const type: MatchType = s.kind === 'identifier' && v.trim().toLowerCase() !== query.raw.toLowerCase() ? 'NORMALIZED' : 'EXACT';
        exact = { field: s.field, kind: s.kind, matchType: type, matchedValue: extraitDe(v), token: query.normalized, score: MATCH_TYPE_SCORES.EXACT * s.weight };
        break;
      }
    }
    if (exact) break;
  }
  if (exact && !sansExact) {
    return {
      candidate, eligible: true, eligibilityDecision: 'ELIGIBLE', eligibilityReason: 'EXACT_VALUE', rejectionReason: null,
      matchedField: exact.field, matchedValue: exact.matchedValue, matchType: exact.matchType,
      matches: query.tokens.map((t) => ({ ...exact!, token: t.norm })), rawScore: exact.score + 0.1,
    };
  }

  const meilleurs: FieldMatch[] = [];
  let fuzzyTropFaible = false;
  const parMot = new Map<string, { direct: FieldMatch | null; qualif: FieldMatch | null }>();
  for (const tok of query.tokens) {
    let direct: FieldMatch | null = null;
    let qualif: FieldMatch | null = null;
    for (const s of specs) {
      if (s.kind === 'category') {
        let ok = false; let val = '';
        if (s.taxonomy === 'asset') {
          const tax = candidate.assetTaxonomy;
          if (tax && tok.category && matchAssetCategory(tok, tax)) { ok = true; val = [tax.subtype, tax.objectCategory, tax.family].filter(Boolean).join(' · '); }
        } else {
          for (const v of valeurs(candidate.fields[s.field])) {
            const texte = s.taxonomy === 'document' ? documentTypeWords(v) : v;
            const m = matchMot(tok, texte, 'category');
            if (m && 'type' in m) { ok = true; val = v; break; }
          }
        }
        if (ok) {
          const fm: FieldMatch = { field: s.field, kind: s.kind, matchType: 'CATEGORY', matchedValue: extraitDe(val), token: tok.norm, score: MATCH_TYPE_SCORES.CATEGORY * s.weight };
          if (!qualif || fm.score > qualif.score) qualif = fm;
        }
        continue;
      }
      for (const v of valeurs(candidate.fields[s.field])) {
        const m = matchMot(tok, v, s.kind);
        if (!m) continue;
        if ('tooLow' in m) { fuzzyTropFaible = true; continue; }
        if (s.kind === 'relation') {
          const fm: FieldMatch = { field: s.field, kind: s.kind, matchType: 'RELATIONAL', matchedValue: extraitDe(v), token: tok.norm, score: MATCH_TYPE_SCORES.RELATIONAL * s.weight };
          // Relation autorisée (bien concerné d'une échéance) : vaut match direct.
          if (s.relationEligible) { if (!direct || fm.score > direct.score) direct = fm; } else if (!qualif) qualif = fm;
          continue;
        }
        const score = MATCH_TYPE_SCORES[m.type] * (m.type === 'FUZZY' ? m.quality : 1) * s.weight;
        if (!direct || score > direct.score) direct = { field: s.field, kind: s.kind, matchType: m.type, matchedValue: extraitDe(v), token: tok.norm, score };
      }
    }
    parMot.set(tok.norm, { direct, qualif });
    const best = direct ?? qualif;
    if (best) meilleurs.push(best);
  }

  const directs = [...parMot.values()].map((x) => x.direct).filter((x): x is FieldMatch => !!x);
  const couverts = query.tokens.filter((t) => { const x = parMot.get(t.norm); return !!(x?.direct || x?.qualif); }).length;

  // Aucune correspondance DIRECTE : catégorie explicite, sémantique, ou rejet motivé.
  if (directs.length === 0) {
    const categories = [...parMot.values()].map((x) => x.qualif).filter((x): x is FieldMatch => x?.matchType === 'CATEGORY');
    if (query.categoryQuery && categories.length === query.tokens.length) {
      const top = categories.sort((a, b) => b.score - a.score)[0];
      return {
        candidate, eligible: true, eligibilityDecision: 'ELIGIBLE', eligibilityReason: 'EXPLICIT_CATEGORY_QUERY', rejectionReason: null,
        matchedField: top.field, matchedValue: top.matchedValue, matchType: 'CATEGORY', matches: categories,
        rawScore: categories.reduce((s, m) => s + m.score, 0) / query.tokens.length,
      };
    }
    const sem = candidate.semanticScore;
    if (typeof sem === 'number' && sem > 0) {
      const seuil = policy.semanticMinScore ?? SEMANTIC_MIN_SCORE;
      if (policy.allowSemantic && sem >= seuil) {
        return {
          candidate, eligible: true, eligibilityDecision: 'ELIGIBLE', eligibilityReason: 'SEMANTIC_ABOVE_THRESHOLD', rejectionReason: null,
          matchedField: 'semantic', matchedValue: candidate.displayName, matchType: 'SEMANTIC', matches: [],
          rawScore: MATCH_TYPE_SCORES.SEMANTIC * sem,
        };
      }
      return rejet('SEMANTIC_SCORE_TOO_LOW', meilleurs);
    }
    if (candidate.propagatedFrom) return rejet('CROSS_ENTITY_PROPAGATION', meilleurs);
    if (categories.length) return rejet('CATEGORY_ONLY', meilleurs);
    if (meilleurs.some((m) => m.matchType === 'RELATIONAL')) return rejet('RELATION_ONLY', meilleurs);
    if (fuzzyTropFaible) return rejet('FUZZY_SCORE_TOO_LOW', meilleurs);
    return rejet('NO_MATCHING_FIELD', meilleurs);
  }

  if (policy.requireAllTokens && couverts < query.tokens.length) return rejet('PARTIAL_MATCH', meilleurs);

  const top = [...directs].sort((a, b) => b.score - a.score)[0];
  const qualifiee = meilleurs.some((m) => !directs.includes(m));
  const raison: EligibilityReason = directs.every((d) => d.matchType === 'RELATIONAL') ? 'AUTHORIZED_RELATION'
    : qualifiee ? 'DIRECT_MATCH_WITH_QUALIFIER' : 'DIRECT_MATCH';
  return {
    candidate, eligible: true, eligibilityDecision: 'ELIGIBLE',
    eligibilityReason: raison, rejectionReason: null,
    matchedField: top.field, matchedValue: top.matchedValue, matchType: top.matchType, matches: meilleurs,
    rawScore: Math.round((meilleurs.reduce((s, m) => s + m.score, 0) / query.tokens.length) * 1000) / 1000,
  };
}

// ── Ranking (sur les seuls éligibles) ────────────────────────────────────

export interface RankedResult extends CandidateEvaluation {
  eligible: true;
  normalizedScore: number;
  rank: number;
}

/**
 * Classe les candidats ÉLIGIBLES (pure). Un candidat rejeté n'entre jamais
 * ici, quel que soit son score : le ranking ne rattrape rien.
 * Départage : score, puis type de match, puis ordre d'arrivée.
 */
export function rankEligible(evals: CandidateEvaluation[]): RankedResult[] {
  const elig = evals.map((e, i) => ({ e, i })).filter((x) => x.e.eligible && x.e.matchedField !== null);
  const ordre = (t: MatchType | null) => (t ? MATCH_TYPES.indexOf(t) : 99);
  elig.sort((a, b) => b.e.rawScore - a.e.rawScore || ordre(a.e.matchType) - ordre(b.e.matchType) || a.i - b.i);
  const top = elig[0]?.e.rawScore || 1;
  return elig.map((x, k) => ({ ...x.e, eligible: true as const, normalizedScore: Math.round((x.e.rawScore / top) * 1000) / 1000, rank: k + 1 }));
}

// ── Observabilité (ticket §10) ───────────────────────────────────────────

export interface SearchTraceEntry {
  query: string;
  entityId: string | number;
  entityType: SearchEntityType;
  displayName: string;
  matchedField: string | null;
  matchedValue: string | null;
  matchType: MatchType | null;
  rawScore: number;
  normalizedScore: number;
  retrievalStrategy: string;
  eligibilityDecision: 'ELIGIBLE' | 'REJECTED';
  eligibilityReason: string;
  rank: number | null;
  rejected?: true;
  rejectionReason?: RejectionReason;
}

export function traceOf(query: ParsedQuery, e: CandidateEvaluation | RankedResult): SearchTraceEntry {
  const r = e as Partial<RankedResult>;
  return {
    query: query.raw,
    entityId: e.candidate.entityId,
    entityType: e.candidate.entityType,
    displayName: e.candidate.displayName,
    matchedField: e.matchedField,
    matchedValue: e.matchedValue,
    matchType: e.matchType,
    rawScore: e.rawScore,
    normalizedScore: r.normalizedScore ?? 0,
    retrievalStrategy: e.candidate.retrievalStrategy,
    eligibilityDecision: e.eligibilityDecision,
    eligibilityReason: e.eligibilityReason,
    rank: r.rank ?? null,
    ...(e.eligible ? {} : { rejected: true as const, rejectionReason: e.rejectionReason ?? 'NO_MATCHING_FIELD' }),
  };
}

export interface SearchPipelineResult {
  results: RankedResult[];
  rejected: CandidateEvaluation[];
  trace: SearchTraceEntry[];
}

/** Pipeline complet sur des candidats déjà générés : éligibilité, puis ranking. */
export function runSearchPipeline(query: ParsedQuery, candidates: SearchCandidate[], policy: SearchPolicy): SearchPipelineResult {
  const evals = candidates.map((c) => evaluateCandidate(query, c, policy));
  const results = rankEligible(evals);
  const rejected = evals.filter((e) => !e.eligible);
  return { results, rejected, trace: [...results, ...rejected].map((e) => traceOf(query, e)) };
}

/**
 * Formes SQL d'un mot pour la GÉNÉRATION de candidats (motifs `LIKE` larges,
 * sans valeur de preuve) : forme saisie, singulier, alias et — pour un mot
 * qui tolère une faute — ses 3 premières lettres.
 */
export function candidatePatterns(tok: QueryToken, opts: { fuzzy?: boolean } = {}): string[] {
  const formes = new Set<string>([tok.norm, tok.stem, ...tok.aliases].filter((f) => f.length >= 2 || /^\d$/.test(f)));
  if (opts.fuzzy && !tok.identifier && fuzzyTolerance(tok.stem.length) > 0) formes.add(tok.stem.slice(0, 3));
  return [...formes];
}

/**
 * Motif d'expression régulière « DÉBUT DE MOT » d'un terme (SQL `~`, sur un
 * texte déjà passé par `unaccent(lower(...))`). Remplace `LIKE '%terme%'`,
 * qui retrouvait un terme À L'INTÉRIEUR d'un autre mot (« polo » dans
 * « Apolon ») ; le début de mot garde pluriels et composés
 * (« toit » → « toiture »). Pure.
 */
export function wordStartPattern(term: string): string {
  const t = String(term ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(^|[^a-z0-9])${t}`;
}
