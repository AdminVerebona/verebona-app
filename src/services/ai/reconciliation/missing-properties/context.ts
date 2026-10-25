/**
 * Lot 88B — contexte FERMÉ et BORNÉ d'un objet : pagination, troncature
 * tracée, empreintes (partie PURE).
 *
 * Le code ne juge AUCUN contenu : aucun tri, filtre ni sélection d'après les
 * mots. L'ordre est neutre et déterministe — couches de l'objet (valeurs
 * canoniques, Opérations, composantes, Agenda, décisions), puis documents
 * dans l'ordre fourni et, dans un document, métadonnées → preuves de champ →
 * faits → faits non intégrés → unités, ordre de lecture conservé. Les bornes
 * sont des TAILLES (celles de la connaissance T1, `T3_KNOWLEDGE_QUERY_*`) :
 * au-delà, le contexte est INCOMPLET — tracé (éléments écartés, textes
 * coupés, par couche) et jamais conclu « information absente ».
 */
import { createHash } from 'node:crypto';
import { boundElement, elementSize, type KnowledgeBounds } from '../knowledge-query/context';
import type { KnowledgeElement } from '../knowledge-query/contract';
import {
  DOCUMENT_LAYERS, HISTORY_LAYERS, MISSING_PROPERTIES_CONTRACT_VERSION, MISSING_PROPERTIES_RULES_VERSION, SUBJECT_LAYERS,
  type ContextLayer, type PropertyContextDocument, type PropertyContextElement, type PropertyPage, type PropertyQuestion,
} from './contract';

const ORDRE: readonly ContextLayer[] = [...SUBJECT_LAYERS, ...DOCUMENT_LAYERS];

export interface PlannedPropertyContext {
  pages: PropertyPage[];
  /** Tous les éléments utiles ont été transmis (aucun écarté par les bornes). */
  complete: boolean;
  /** Éléments utiles (non vides) avant bornes. */
  elements: number;
  droppedElements: number;
  cutElements: number;
  byLayer: Record<string, number>;
  /** Éléments écartés par couche (troncature tracée). */
  droppedByLayer: Record<string, number>;
}

/**
 * Pagination déterministe (pure). Un élément vide est ignoré ; au-delà de
 * `maxPages` pages, les éléments restants sont écartés et comptés.
 */
export function planPropertyContext(
  elements: readonly PropertyContextElement[], documents: readonly PropertyContextDocument[], bounds: KnowledgeBounds,
): PlannedPropertyContext {
  const rangDoc = new Map(documents.map((d, i) => [d.ref, i + 1]));
  const rang = (e: PropertyContextElement) => (e.document === 'S' ? 0 : rangDoc.get(e.document) ?? 9_999);
  const utiles = elements
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => elementSize(e) > 0)
    .sort((a, b) => rang(a.e) - rang(b.e) || ORDRE.indexOf(a.e.layer) - ORDRE.indexOf(b.e.layer) || a.i - b.i);
  const byLayer: Record<string, number> = {};
  for (const { e } of utiles) byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1;
  const pages: PropertyPage[] = [];
  let courante: PropertyContextElement[] = [];
  let taille = 0;
  let cut = 0;
  for (const { e } of utiles) {
    if (pages.length >= bounds.maxPages) break;
    const b = boundElement(e as unknown as KnowledgeElement, bounds.charsPerElement);
    const el = b.element as unknown as PropertyContextElement;
    const t = elementSize(el);
    if (courante.length && (courante.length >= bounds.elementsPerPage || taille + t > bounds.charsPerPage)) {
      pages.push({ index: pages.length + 1, count: 0, elements: courante });
      courante = [];
      taille = 0;
      if (pages.length >= bounds.maxPages) break;
    }
    courante.push(el);
    taille += t;
    if (b.cut) cut += 1;
  }
  if (courante.length && pages.length < bounds.maxPages) pages.push({ index: pages.length + 1, count: 0, elements: courante });
  for (const p of pages) p.count = pages.length;
  const transmis = new Set(pages.flatMap((p) => p.elements.map((x) => x.ref)));
  const droppedByLayer: Record<string, number> = {};
  for (const { e } of utiles) if (!transmis.has(e.ref)) droppedByLayer[e.layer] = (droppedByLayer[e.layer] ?? 0) + 1;
  const dropped = utiles.length - transmis.size;
  return { pages, complete: dropped === 0, elements: utiles.length, droppedElements: dropped, cutElements: cut, byLayer, droppedByLayer };
}

const sha = (v: unknown, n = 24) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, n);

/**
 * Empreinte du CONTEXTE transmis (pure) : documents, éléments de PREUVE
 * (couches d'historique exclues, voir `HISTORY_LAYERS`), bornes appliquées,
 * version du contrat et des règles. Indépendante de la liste des propriétés
 * demandées : écrire une propriété ne change pas l'empreinte des autres.
 */
export function propertyContextFingerprint(documents: readonly PropertyContextDocument[], plan: Pick<PlannedPropertyContext, 'pages' | 'complete'>): string {
  return sha([
    MISSING_PROPERTIES_CONTRACT_VERSION, MISSING_PROPERTIES_RULES_VERSION,
    documents.map((d) => [d.ref, d.fileId, d.relation, d.title, d.documentType, d.rubric, d.documentDate]),
    plan.pages.map((p) => p.elements.filter((e) => !HISTORY_LAYERS.has(e.layer))
      .map((e) => [e.ref, e.document, e.layer, e.kind, e.label, e.value, e.text, e.confidence, e.links ?? null])),
    plan.complete,
  ]);
}

/** Empreinte de la QUESTION d'une propriété (registre, contrat). Pure. */
export function propertyQuestionFingerprint(q: PropertyQuestion): string {
  return sha([MISSING_PROPERTIES_CONTRACT_VERSION, MISSING_PROPERTIES_RULES_VERSION, q.key, q.registryType, q.valueType, q.unit, q.enumValues]);
}
