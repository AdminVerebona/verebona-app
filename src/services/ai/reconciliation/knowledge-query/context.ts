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
}

export const DEFAULT_KNOWLEDGE_BOUNDS: KnowledgeBounds = {
  elementsPerPage: 80, charsPerPage: 16_000, maxPages: 5, charsPerElement: 600, maxLinkedDocuments: 5,
};

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
  };
}

const COUCHES = ['FACT', 'UNRESOLVED_FACT', 'SOURCE_UNIT'] as const;

/** Taille d'un élément (caractères transmis). Pure. */
export const elementSize = (e: Pick<KnowledgeElement, 'label' | 'value' | 'text'>): number =>
  (e.label?.length ?? 0) + (e.value?.length ?? 0) + (e.text?.length ?? 0);

/** Élément borné : texte coupé à `charsPerElement` (valeur et libellé conservés). Pure. */
export function boundElement(e: KnowledgeElement, charsPerElement: number): { element: KnowledgeElement; cut: boolean } {
  const reste = Math.max(0, charsPerElement - (e.label?.length ?? 0) - (e.value?.length ?? 0));
  if (!e.text || e.text.length <= reste) return { element: e, cut: false };
  return { element: { ...e, text: e.text.slice(0, reste) }, cut: true };
}

/** Un élément porte-t-il une connaissance NON STRUCTURÉE (unité, fait non intégré, fait sans clé du registre) ? */
export const isUnstructured = (e: KnowledgeElement & { structured?: boolean }): boolean =>
  e.layer !== 'FACT' || e.structured !== true;

export interface PlannedContext {
  pages: KnowledgePage[];
  /** Tous les éléments utiles ont été placés dans une page (aucun écarté par les bornes). */
  complete: boolean;
  /** Éléments écartés par les bornes (non transmis). */
  droppedElements: number;
  /** Éléments dont le texte a été coupé. */
  cutElements: number;
  byLayer: Record<string, number>;
  /** Connaissance non structurée présente (avant bornes). */
  unstructured: number;
}

/**
 * Pagination déterministe (pure) : ordre neutre — document cible, puis
 * documents liés (ordre fourni) ; dans un document, couches dans l'ordre
 * faits → faits non intégrés → unités ; ordre de lecture conservé. Un
 * élément vide est ignoré. Au-delà de `maxPages` pages : contexte incomplet.
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
  const pages: KnowledgePage[] = [];
  let courante: KnowledgeElement[] = [];
  let taille = 0;
  let cutElements = 0;
  let placés = 0;
  for (const { e } of utiles) {
    const { element, cut } = boundElement(e, bounds.charsPerElement);
    const t = elementSize(element);
    if (courante.length && (courante.length >= bounds.elementsPerPage || taille + t > bounds.charsPerPage)) {
      pages.push({ index: pages.length + 1, count: 0, elements: courante });
      courante = [];
      taille = 0;
      if (pages.length >= bounds.maxPages) break;
    }
    // Sans `structured` (détail interne) : seul le contrat est transmis.
    const { structured: _s, ...transmis } = element as KnowledgeElement & { structured?: boolean };
    courante.push(transmis);
    taille += t;
    placés += 1;
    if (cut) cutElements += 1;
  }
  if (courante.length && pages.length < bounds.maxPages) pages.push({ index: pages.length + 1, count: 0, elements: courante });
  else if (courante.length) placés -= courante.length;
  for (const p of pages) p.count = pages.length;
  return { pages, complete: placés === utiles.length, droppedElements: utiles.length - placés, cutElements, byLayer, unstructured };
}

const sha = (v: unknown, n = 24) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, n);

/** Empreinte de la QUESTION (donnée, type, constituants, version du contrat). Pure. */
export function questionFingerprint(q: KnowledgeQuestion, contractVersion: string): string {
  return sha([contractVersion, q.key, q.valueType, q.ruleCode, q.businessQuestion, q.constituents.map((c) => [c.role, c.key, c.valueType])]);
}

/** Empreinte du CONTEXTE transmis (documents, éléments, bornes appliquées). Pure. */
export function contextFingerprint(documents: readonly KnowledgeDocument[], plan: Pick<PlannedContext, 'pages' | 'complete'>): string {
  return sha([
    documents.map((d) => [d.ref, d.fileId, d.role, d.relation, d.title, d.documentType]),
    plan.pages.map((p) => p.elements.map((e) => [e.ref, e.document, e.layer, e.kind, e.label, e.value, e.text, e.confidence])),
    plan.complete,
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
