/**
 * Lot 85F — contexte T1 FERMÉ d'une question de connaissance : bornes,
 * pagination, empreintes, normalisation des textes (partie PURE).
 *
 * Le code ne JUGE AUCUN contenu : il ne trie, ne filtre ni ne sélectionne un
 * élément d'après ses mots (ticket §6 — aucune regex métier, aucune liste
 * d'alias, aucune règle par fournisseur ou par type de contrat). L'ordre est
 * neutre et déterministe (document cible d'abord, puis couches, puis ordre
 * de lecture), les bornes sont des tailles. Une connaissance qui dépasse les
 * bornes rend le contexte INCOMPLET : jamais « information absente ».
 */
import { createHash } from 'node:crypto';
import type { KnowledgeDocument, KnowledgeElement, KnowledgePage, KnowledgeQuestion } from './contract';

/** Bornes du contexte (variables d'environnement, défauts prudents). */
export interface KnowledgeBounds {
  /** Éléments par page (appel). */
  elementsPerPage: number;
  /** Caractères par page (somme des libellés, valeurs et textes). */
  charsPerPage: number;
  /** Pages (appels) au plus par question. */
  maxPages: number;
  /** Caractères au plus par élément (texte coupé, signalé). */
  charsPerElement: number;
  /** Documents liés au plus. */
  maxLinkedDocuments: number;
  /**
   * Lot 111M — pages au plus pour une question, TOUS passages confondus
   * (continuation persistante : `maxPages` pages par passage, reprise au
   * passage suivant). Absent : 3 × `maxPages`. Au-delà : contexte INCOMPLET
   * explicite (jamais « information absente »).
   */
  maxContinuationPages?: number;
}

export const DEFAULT_KNOWLEDGE_BOUNDS: KnowledgeBounds = {
  elementsPerPage: 80, charsPerPage: 16_000, maxPages: 5, charsPerElement: 600, maxLinkedDocuments: 5, maxContinuationPages: 15,
};

/** Lot 111M — plafond total de pages d'une question (continuation comprise). Pure. */
export const continuationPageCap = (b: KnowledgeBounds): number =>
  Math.max(b.maxPages, Math.trunc(b.maxContinuationPages ?? b.maxPages * 3));

const entier = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};

/** Bornes lues de l'environnement (`T3_KNOWLEDGE_QUERY_*`). Pure. */
export function knowledgeBounds(env: Record<string, string | undefined> = process.env): KnowledgeBounds {
  return {
    elementsPerPage: entier(env.T3_KNOWLEDGE_QUERY_ELEMENTS_PER_PAGE, DEFAULT_KNOWLEDGE_BOUNDS.elementsPerPage, 5, 200),
    charsPerPage: entier(env.T3_KNOWLEDGE_QUERY_CHARS_PER_PAGE, DEFAULT_KNOWLEDGE_BOUNDS.charsPerPage, 2_000, 60_000),
    maxPages: entier(env.T3_KNOWLEDGE_QUERY_MAX_PAGES, DEFAULT_KNOWLEDGE_BOUNDS.maxPages, 1, 20),
    charsPerElement: entier(env.T3_KNOWLEDGE_QUERY_CHARS_PER_ELEMENT, DEFAULT_KNOWLEDGE_BOUNDS.charsPerElement, 100, 4_000),
    maxLinkedDocuments: entier(env.T3_KNOWLEDGE_QUERY_MAX_LINKED_DOCUMENTS, DEFAULT_KNOWLEDGE_BOUNDS.maxLinkedDocuments, 0, 20),
    maxContinuationPages: entier(env.T3_KNOWLEDGE_QUERY_MAX_CONTINUATION_PAGES, DEFAULT_KNOWLEDGE_BOUNDS.maxContinuationPages!, 1, 60),
  };
}

const COUCHES = ['FACT', 'UNRESOLVED_FACT', 'SOURCE_UNIT'] as const;

/** Taille d'un élément (caractères transmis). Pure. */
export const elementSize = (e: Pick<KnowledgeElement, 'label' | 'value' | 'text'>): number =>
  (e.label?.length ?? 0) + (e.value?.length ?? 0) + (e.text?.length ?? 0);

/**
 * Lot 111M — texte minimal d'un segment : même si libellé et valeur occupent
 * presque toute la borne, chaque segment fait AVANCER la lecture (aucune
 * boucle, aucun segment vide).
 */
const MIN_SEGMENT_CHARS = 100;
/** Recouvrement entre deux segments : une phrase à cheval reste citable d'un seul tenant. */
const SEGMENT_OVERLAP_CHARS = 120;

/**
 * Lot 111M (P1 T3) — découpe SANS PERTE d'un élément dont le texte dépasse
 * `charsPerElement` (pure) : segments consécutifs, recouvrement court, le
 * premier garde la référence, le libellé et la valeur d'origine ; les suivants
 * portent la référence `<ref>#<n>`, le libellé (contexte) et la même
 * provenance (document, fichier, unité source). Un élément court est rendu
 * tel quel (plan et empreinte inchangés).
 */
export function segmentElement<E extends KnowledgeElement>(e: E, charsPerElement: number): E[] {
  const tete = (k: number) => (e.label?.length ?? 0) + (k === 1 ? e.value?.length ?? 0 : 0);
  const place = (k: number) => Math.max(MIN_SEGMENT_CHARS, charsPerElement - tete(k));
  const texte = e.text ?? '';
  if (!e.text || texte.length <= Math.max(0, charsPerElement - tete(1))) return [e];
  const out: E[] = [];
  let debut = 0;
  for (let k = 1; debut < texte.length; k += 1) {
    const largeur = place(k);
    const fin = Math.min(texte.length, debut + largeur);
    out.push({ ...e, ref: k === 1 ? e.ref : `${e.ref}#${k}`, value: k === 1 ? e.value : null, text: texte.slice(debut, fin) });
    if (fin >= texte.length) break;
    debut = fin - Math.min(SEGMENT_OVERLAP_CHARS, Math.floor(largeur / 5));
  }
  return out;
}

/** Un élément porte-t-il une connaissance NON STRUCTURÉE (unité, fait non intégré, fait sans clé du registre) ? */
const isUnstructured = (e: KnowledgeElement & { structured?: boolean }): boolean =>
  e.layer !== 'FACT' || e.structured !== true;

interface PlannedContext {
  /** Pages du PREMIER passage (`maxPages` au plus). */
  pages: KnowledgePage[];
  /**
   * Lot 111M — pages suivantes (continuation persistante, examinées aux
   * passages suivants), dans la limite de `continuationPageCap`.
   */
  continuationPages: KnowledgePage[];
  /**
   * Tous les éléments utiles sont INTÉGRALEMENT placés dans une page (premier
   * passage ou continuation) : aucun élément écarté, aucun segment de texte
   * non transmis. Lot 111M : un élément coupé rend le contexte incomplet.
   */
  complete: boolean;
  /** Éléments écartés par les bornes (aucune partie transmise). */
  droppedElements: number;
  /** Éléments dont une partie du texte n'est pas transmise (segments au-delà du plafond de pages). */
  cutElements: number;
  /** Lot 111M — éléments longs découpés en plusieurs segments (tous transmis ou non). */
  segmentedElements: number;
  byLayer: Record<string, number>;
  /** Connaissance non structurée présente (avant bornes). */
  unstructured: number;
}

/**
 * Pagination déterministe (pure) : ordre neutre — document cible, puis
 * documents liés (ordre fourni) ; dans un document, couches dans l'ordre
 * faits → faits non intégrés → unités ; ordre de lecture conservé. Un
 * élément vide est ignoré. Lot 111M : un texte long est découpé en segments
 * (`segmentElement`) au lieu d'être coupé ; les pages au-delà de `maxPages`
 * forment la continuation ; au-delà du plafond total : contexte incomplet.
 */
export function planKnowledgePages(
  elements: ReadonlyArray<KnowledgeElement & { structured?: boolean }>, documents: readonly KnowledgeDocument[], bounds: KnowledgeBounds,
): PlannedContext {
  const rangDoc = new Map(documents.map((d, i) => [d.ref, i]));
  const utiles = elements
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => elementSize(e) > 0)
    .sort((a, b) => (rangDoc.get(a.e.document) ?? 99) - (rangDoc.get(b.e.document) ?? 99)
      || COUCHES.indexOf(a.e.layer) - COUCHES.indexOf(b.e.layer) || a.i - b.i);
  const byLayer: Record<string, number> = {};
  for (const { e } of utiles) byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1;
  const unstructured = utiles.filter(({ e }) => isUnstructured(e)).length;
  const plafond = continuationPageCap(bounds);
  const pages: KnowledgePage[] = [];
  const attendus = new Map<string, number>();
  let courante: KnowledgeElement[] = [];
  let taille = 0;
  let plein = false;
  let segmentes = 0;
  const fermer = () => {
    pages.push({ index: pages.length + 1, count: 0, elements: courante });
    courante = [];
    taille = 0;
  };
  for (const { e } of utiles) {
    const segments = segmentElement(e, bounds.charsPerElement);
    attendus.set(e.ref, segments.length);
    if (segments.length > 1) segmentes += 1;
    for (const s of segments) {
      if (plein) break;
      const t = elementSize(s);
      if (courante.length && (courante.length >= bounds.elementsPerPage || taille + t > bounds.charsPerPage)) {
        fermer();
        if (pages.length >= plafond) { plein = true; break; }
      }
      // Sans `structured` (détail interne) : seul le contrat est transmis.
      const { structured: _s, ...transmis } = s as KnowledgeElement & { structured?: boolean };
      courante.push(transmis);
      taille += t;
    }
  }
  if (courante.length && pages.length < plafond) fermer();
  const premier = pages.slice(0, bounds.maxPages);
  const suite = pages.slice(bounds.maxPages);
  for (const p of premier) p.count = premier.length;
  for (const p of suite) p.count = pages.length;
  // Couverture vérifiée sur les pages RÉELLES : segments transmis par élément.
  const transmis = new Map<string, number>();
  const racine = (ref: string) => { const i = ref.lastIndexOf('#'); return i > 0 && attendus.has(ref.slice(0, i)) ? ref.slice(0, i) : ref; };
  for (const p of pages) for (const x of p.elements) transmis.set(racine(x.ref), (transmis.get(racine(x.ref)) ?? 0) + 1);
  let dropped = 0;
  let cut = 0;
  for (const [ref, n] of attendus) {
    const vus = transmis.get(ref) ?? 0;
    if (vus === 0) dropped += 1;
    else if (vus < n) cut += 1;
  }
  return {
    pages: premier, continuationPages: suite, complete: dropped === 0 && cut === 0,
    droppedElements: dropped, cutElements: cut, segmentedElements: segmentes, byLayer, unstructured,
  };
}

const sha = (v: unknown, n = 24) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, n);

/** Empreinte de la QUESTION (donnée, type, constituants, version du contrat). Pure. */
export function questionFingerprint(q: KnowledgeQuestion, contractVersion: string): string {
  return sha([contractVersion, q.key, q.valueType, q.ruleCode, q.businessQuestion, q.constituents.map((c) => [c.role, c.key, c.valueType])]);
}

/** Empreinte du CONTEXTE transmis (documents, éléments, bornes appliquées). Pure. */
export function contextFingerprint(documents: readonly KnowledgeDocument[], plan: Pick<PlannedContext, 'pages' | 'complete'> & { continuationPages?: KnowledgePage[] }): string {
  const page = (p: KnowledgePage) => p.elements.map((e) => [e.ref, e.document, e.layer, e.kind, e.label, e.value, e.text, e.confidence]);
  return sha([
    documents.map((d) => [d.ref, d.fileId, d.role, d.relation, d.title, d.documentType]),
    plan.pages.map(page),
    plan.complete,
    // Lot 111M : la continuation fait partie du contexte (clé stable d'un
    // passage à l'autre) ; absente, l'empreinte est INCHANGÉE (aucune
    // réinterrogation des entrées déjà mémorisées).
    ...(plan.continuationPages?.length ? [plan.continuationPages.map(page)] : []),
  ]);
}

/**
 * Normalisation de COMPARAISON d'un texte (pure) : accents, casse, espaces
 * (insécables compris), apostrophes et guillemets typographiques. Aucune
 * connaissance du vocabulaire : sert seulement à vérifier qu'un extrait cité
 * est bien recopié des éléments transmis.
 */
export function normalizeForComparison(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”«»]/g, '"')
    .toLowerCase()
    .replace(/[\s  ]+/g, ' ')
    .trim();
}

/** Séparateur de segments d'un extrait réparti sur plusieurs éléments. */
export const EXCERPT_SEGMENT_SEPARATOR = '[...]';
