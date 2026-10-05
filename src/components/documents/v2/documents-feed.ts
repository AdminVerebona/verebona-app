/**
 * État du chargement progressif des documents — ticket DOC-PERF.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN ÉTAT EXPLICITE, UNE SEULE REQUÊTE À LA FOIS
 *
 *   idle → loading → success → loading → … → end
 *                  ↘ error (lot suivant : erreur locale, « Réessayer »)
 *
 * La sentinelle peut signaler plusieurs fois la même approche du bas (scroll,
 * redimensionnement, rendu) : `nextRequest` ne rend un curseur que si aucune
 * requête n'est en cours, que la liste n'est pas terminée et qu'aucune erreur
 * n'attend une relance. Un seul appel par curseur, jamais deux en parallèle.
 *
 * ── UNE RÉPONSE PÉRIMÉE NE REMPLACE JAMAIS UNE RÉPONSE RÉCENTE ────────────
 *
 * Chaque liste porte la clé de sa requête (tri, filtres, périmètre) et chaque
 * appel un numéro. Une réponse dont la clé ou le numéro ne correspond plus
 * (filtre changé entre-temps, revalidation lancée depuis) est ignorée.
 *
 * Fonctions pures : l'écran ne fait qu'appliquer ces transitions, que les
 * tests rejouent sans navigateur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { FeedMeta, FeedResponse } from '@/lib/documents/document-feed';
import { NO_ASSET, NO_TYPE, UNFILED, type DocumentItem } from './documents-view';

export type FeedStatus = 'idle' | 'loading' | 'success' | 'error' | 'end';

/** Fin d'un lot : nombre de documents chargés à ce point, curseur suivant. */
export interface PageEnd {
  size: number;
  cursor: string | null;
}

export interface FeedState {
  /** Clé de la requête (tri, filtres, périmètre) de la liste affichée. */
  key: string | null;
  status: FeedStatus;
  documents: DocumentItem[];
  meta: FeedMeta | null;
  nextCursor: string | null;
  /** Appel en cours : premier lot, lot suivant ou revalidation de la liste. */
  pending: { requestId: number; kind: 'first' | 'next' | 'refresh'; previous: FeedStatus } | null;
  /** Échec du premier lot (écran d'erreur) ou d'un lot suivant (erreur locale). */
  error: 'first' | 'next' | null;
  pageEnds: PageEnd[];
  /** Nombre de lots reçus pour cette clé (observabilité). */
  batches: number;
}

export const INITIAL_FEED: FeedState = {
  key: null,
  status: 'idle',
  documents: [],
  meta: null,
  nextCursor: null,
  pending: null,
  error: null,
  pageEnds: [],
  batches: 0,
};

export type FeedAction =
  | { type: 'reset'; key: string }
  | { type: 'start'; key: string; requestId: number; kind: 'first' | 'next' | 'refresh' }
  | { type: 'success'; key: string; requestId: number; response: FeedResponse }
  | { type: 'failure'; key: string; requestId: number }
  | { type: 'retry' }
  | {
    type: 'replace';
    key: string;
    /** Absent pour une restauration (aucun appel en cours à vérifier). */
    requestId?: number;
    documents: DocumentItem[];
    meta: FeedMeta | null;
    nextCursor: string | null;
    pageEnds: PageEnd[];
  }
  | { type: 'remove'; id: number };

/**
 * Curseur du prochain lot à demander : `null` pour le premier lot, une
 * chaîne pour la suite, `undefined` quand rien ne doit partir (appel en
 * cours, fin de liste, erreur en attente de relance, liste non initialisée).
 */
export function nextRequest(s: FeedState): string | null | undefined {
  if (!s.key || s.pending) return undefined;
  if (s.status === 'idle' && s.documents.length === 0) return null;
  if (s.status === 'success' && s.nextCursor) return s.nextCursor;
  return undefined;
}

/** Ajoute un lot en écartant un document déjà présent (filet de sécurité). */
function append(existing: DocumentItem[], incoming: DocumentItem[]): DocumentItem[] {
  const seen = new Set(existing.map((d) => d.id));
  return [...existing, ...incoming.filter((d) => !seen.has(d.id))];
}

function decrement<T extends { count: number }>(list: T[], match: (item: T) => boolean): T[] {
  return list.map((item) => (match(item) ? { ...item, count: Math.max(0, item.count - 1) } : item));
}

/**
 * Compteurs après suppression d'un document affiché : il correspondait aux
 * filtres actifs (il était dans la liste), il quitte donc l'ensemble filtré
 * ET le périmètre.
 */
export function metaWithout(meta: FeedMeta, d: DocumentItem): FeedMeta {
  const rubric = d.rubricCode ?? UNFILED;
  const bien = d.assetId ? String(d.assetId) : NO_ASSET;
  const type = d.documentTypeCode ?? NO_TYPE;
  return {
    total: Math.max(0, meta.total - 1),
    scopeTotal: Math.max(0, meta.scopeTotal - 1),
    unfiledCount: d.rubricCode ? meta.unfiledCount : Math.max(0, meta.unfiledCount - 1),
    rubrics: meta.rubrics.map((r) => (r.code === d.rubricCode
      ? { ...r, count: Math.max(0, r.count - 1), scopeCount: Math.max(0, r.scopeCount - 1) }
      : r)),
    facets: {
      biens: decrement(meta.facets.biens, (f) => f.value === bien),
      rubrics: decrement(meta.facets.rubrics, (f) => f.value === rubric),
      types: decrement(meta.facets.types, (f) => f.value === type),
    },
  };
}

export function feedReducer(s: FeedState, a: FeedAction): FeedState {
  switch (a.type) {
    case 'reset':
      // Nouveaux critères : liste vidée, curseur oublié, appel en cours ignoré.
      return { ...INITIAL_FEED, key: a.key };
    case 'start':
      if (a.key !== s.key || s.pending) return s;
      return { ...s, status: 'loading', error: null, pending: { requestId: a.requestId, kind: a.kind, previous: s.status } };
    case 'success': {
      if (a.key !== s.key || s.pending?.requestId !== a.requestId) return s;
      const r = a.response;
      const documents = append(s.documents, (r.documents ?? []) as DocumentItem[]);
      const hasMore = !!r.hasMore && !!r.nextCursor;
      return {
        ...s,
        documents,
        meta: r.meta ?? s.meta,
        nextCursor: hasMore ? r.nextCursor : null,
        status: hasMore ? 'success' : 'end',
        pending: null,
        error: null,
        pageEnds: [...s.pageEnds, { size: documents.length, cursor: hasMore ? r.nextCursor : null }],
        batches: s.batches + 1,
      };
    }
    case 'failure': {
      if (a.key !== s.key || s.pending?.requestId !== a.requestId) return s;
      // Une revalidation qui échoue laisse la liste telle quelle, sans alerte.
      if (s.pending.kind === 'refresh') return { ...s, status: s.pending.previous, pending: null };
      return { ...s, status: 'error', pending: null, error: s.documents.length > 0 || s.meta ? 'next' : 'first' };
    }
    case 'retry':
      if (s.status !== 'error') return s;
      return { ...s, status: s.documents.length > 0 || s.meta ? 'success' : 'idle', error: null };
    case 'replace': {
      if (a.key !== s.key) return s;
      if (a.requestId !== undefined && s.pending?.requestId !== a.requestId) return s;
      const hasMore = !!a.nextCursor;
      return {
        ...s,
        documents: a.documents,
        meta: a.meta,
        nextCursor: a.nextCursor,
        status: hasMore ? 'success' : 'end',
        pending: null,
        error: null,
        pageEnds: a.pageEnds,
        batches: Math.max(s.batches, a.pageEnds.length),
      };
    }
    case 'remove': {
      const index = s.documents.findIndex((d) => d.id === a.id);
      if (index < 0) return s;
      const removed = s.documents[index];
      return {
        ...s,
        documents: s.documents.filter((d) => d.id !== a.id),
        meta: s.meta ? metaWithout(s.meta, removed) : s.meta,
        pageEnds: s.pageEnds.map((p) => (p.size > index ? { ...p, size: p.size - 1 } : p)),
      };
    }
  }
}

/**
 * Liste bornée, coupée à une fin de lot : ce que l'on peut conserver pour un
 * retour (restauration) ou revalider sans tout recharger. Au-delà du
 * plafond, les lots suivants seront redemandés au défilement — à partir du
 * curseur de la coupure, sans doublon ni trou.
 */
export function boundedList(s: FeedState, max: number): { documents: DocumentItem[]; nextCursor: string | null; pageEnds: PageEnd[] } {
  if (s.documents.length <= max) {
    return { documents: s.documents, nextCursor: s.nextCursor, pageEnds: s.pageEnds };
  }
  const kept = s.pageEnds.filter((p) => p.size <= max);
  const last = kept[kept.length - 1];
  if (!last) return { documents: [], nextCursor: null, pageEnds: [] };
  return { documents: s.documents.slice(0, last.size), nextCursor: last.cursor, pageEnds: kept };
}
