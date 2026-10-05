'use client';

/**
 * Chargement progressif des documents — branchement de `documents-feed.ts`
 * sur l'API (ticket DOC-PERF).
 *
 * L'état vit dans une référence mise à jour SYNCHRONEMENT avant le rendu :
 * deux signaux de la sentinelle dans la même image ne peuvent donc pas
 * lancer deux appels pour le même curseur (le second voit déjà l'appel en
 * cours).
 *
 * `apiClient` impose son propre délai d'expiration et ne relaie pas de
 * signal d'annulation : une réponse devenue inutile n'est pas interrompue,
 * elle est IGNORÉE (clé de requête et numéro d'appel, voir le réducteur).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  buildFeedQuery,
  type FeedParams,
  type FeedResponse,
} from '@/lib/documents/document-feed';
import {
  INITIAL_FEED,
  boundedList,
  feedReducer,
  nextRequest,
  type FeedAction,
  type FeedState,
  type PageEnd,
} from './documents-feed';
import { RESTORE_MAX_DOCUMENTS, type ListSnapshot } from './list-restore';
import type { DocumentItem } from './documents-view';

export type FeedQuery = Omit<FeedParams, 'cursor' | 'limit'>;

/** Mesures du chargement (DOC-PERF, observabilité) — jamais de contenu. */
export interface FeedMetrics {
  calls: number;
  errors: number;
  firstLoadMs: number | null;
  lastBatchMs: number | null;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function measure(name: string, start: number) {
  try {
    performance.measure(name, { start, end: now() });
  } catch {
    /* API absente (anciens navigateurs, tests) : la mesure est facultative */
  }
}

export function useDocumentsFeed(query: FeedQuery | null, restore?: { current: ListSnapshot | null }) {
  const key = query ? buildFeedQuery(query) : null;
  const stateRef = useRef<FeedState>(INITIAL_FEED);
  const [state, setState] = useState<FeedState>(INITIAL_FEED);
  const queryRef = useRef<FeedQuery | null>(query);
  queryRef.current = query;
  const seq = useRef(0);
  const metrics = useRef<FeedMetrics>({ calls: 0, errors: 0, firstLoadMs: null, lastBatchMs: null });
  const [restoredScrollTop, setRestoredScrollTop] = useState<number | null>(null);

  const apply = useCallback((action: FeedAction) => {
    const next = feedReducer(stateRef.current, action);
    if (next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
    }
    return next;
  }, []);

  const fetchPage = useCallback(async (q: FeedQuery, cursor: string | null, limit: number) => {
    metrics.current.calls += 1;
    return apiClient.get<FeedResponse>(`/api/v2/documents?${buildFeedQuery({ ...q, cursor, limit })}`);
  }, []);

  /** Lot suivant (ou premier lot) — sans effet si un appel est déjà en cours. */
  const loadNext = useCallback(async () => {
    const s = stateRef.current;
    const q = queryRef.current;
    const cursor = nextRequest(s);
    if (cursor === undefined || !q || !s.key) return;
    const requestKey = s.key;
    const requestId = ++seq.current;
    const kind = cursor === null ? 'first' : 'next';
    apply({ type: 'start', key: requestKey, requestId, kind });
    const started = now();
    try {
      const response = await fetchPage(q, cursor, FEED_DEFAULT_LIMIT);
      const ms = Math.round(now() - started);
      if (kind === 'first') metrics.current.firstLoadMs = ms; else metrics.current.lastBatchMs = ms;
      measure(kind === 'first' ? 'documents:premier-lot' : 'documents:lot-suivant', started);
      apply({ type: 'success', key: requestKey, requestId, response });
    } catch {
      metrics.current.errors += 1;
      apply({ type: 'failure', key: requestKey, requestId });
    }
  }, [apply, fetchPage]);

  /**
   * Revalide la liste affichée (ajout, modification) sans la vider ni perdre
   * la position : les lots déjà chargés sont redemandés (bornés), puis
   * remplacés d'un bloc. Un document modifié retrouve ainsi sa place selon le
   * tri et les filtres actifs, et un document ajouté n'est pas collé en tête
   * si le tri ne l'y met pas.
   */
  const refresh = useCallback(async () => {
    const s = stateRef.current;
    const q = queryRef.current;
    if (!q || !s.key) return;
    // Rien d'affiché encore (ou premier lot en échec) : un premier lot suffit.
    if (s.documents.length === 0 && !s.meta) {
      if (s.status === 'error') apply({ type: 'retry' });
      void loadNext();
      return;
    }
    if (s.pending) return;
    const requestKey = s.key;
    const requestId = ++seq.current;
    apply({ type: 'start', key: requestKey, requestId, kind: 'refresh' });
    const target = Math.min(Math.max(s.documents.length, FEED_DEFAULT_LIMIT), RESTORE_MAX_DOCUMENTS);
    try {
      let cursor: string | null = null;
      let documents: DocumentItem[] = [];
      let meta = null;
      const pageEnds: PageEnd[] = [];
      do {
        const r: FeedResponse = await fetchPage(q, cursor, Math.min(FEED_MAX_LIMIT, target - documents.length));
        if (r.meta) meta = r.meta;
        const seen = new Set(documents.map((d) => d.id));
        documents = [...documents, ...(r.documents as DocumentItem[]).filter((d) => !seen.has(d.id))];
        cursor = r.hasMore ? r.nextCursor : null;
        pageEnds.push({ size: documents.length, cursor });
      } while (cursor && documents.length < target);
      apply({ type: 'replace', key: requestKey, requestId, documents, meta, nextCursor: cursor, pageEnds });
    } catch {
      metrics.current.errors += 1;
      apply({ type: 'failure', key: requestKey, requestId });
    }
  }, [apply, fetchPage, loadNext]);

  // Nouveaux critères : liste vidée, curseur réinitialisé, premier lot — sauf
  // retour sur l'écran avec les MÊMES critères, où l'instantané est repris.
  useEffect(() => {
    if (!key) return;
    apply({ type: 'reset', key });
    const snapshot = restore?.current ?? null;
    // Pas effacé tout de suite : en développement, React rejoue l'effet, et le
    // second passage doit retrouver l'instantané. Il l'est dès que les
    // critères changent — revenir ensuite aux critères d'origine recharge.
    if (restore && snapshot && snapshot.key !== key) restore.current = null;
    if (snapshot && snapshot.key === key && snapshot.documents.length > 0) {
      apply({
        type: 'replace',
        key,
        documents: snapshot.documents,
        meta: snapshot.meta,
        nextCursor: snapshot.nextCursor,
        pageEnds: snapshot.pageEnds,
      });
      setRestoredScrollTop(snapshot.scrollTop);
      return;
    }
    void loadNext();
    // `restore` est une référence stable ; seule la clé relance le chargement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, apply, loadNext]);

  const retry = useCallback(() => {
    apply({ type: 'retry' });
    void loadNext();
  }, [apply, loadNext]);

  const remove = useCallback((id: number) => { apply({ type: 'remove', id }); }, [apply]);

  /** Instantané borné pour un retour sur l'écran (voir `list-restore.ts`). */
  const snapshot = useCallback((): Omit<ListSnapshot, 'filters' | 'scrollTop' | 'savedAt'> | null => {
    const s = stateRef.current;
    if (!s.key || s.documents.length === 0) return null;
    const list = boundedList(s, RESTORE_MAX_DOCUMENTS);
    if (list.documents.length === 0) return null;
    return { v: 1, key: s.key, meta: s.meta, ...list };
  }, []);

  return {
    state,
    documents: state.documents,
    meta: state.meta,
    /** Un lot peut partir maintenant (aucun appel en cours, suite disponible). */
    canLoadMore: state.status === 'success' && !!state.nextCursor && !state.pending,
    loadNext,
    refresh,
    retry,
    remove,
    snapshot,
    metrics,
    restoredScrollTop,
    clearRestoredScroll: () => setRestoredScrollTop(null),
  };
}
