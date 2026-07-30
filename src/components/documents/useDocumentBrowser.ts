'use client';

/**
 * Consultation documentaire — crochet partagé par les deux écrans.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA DIFFÉRENCE ENTRE LES DEUX ÉCRANS TIENT DANS UN PARAMÈTRE
 *
 * Le §3 du CDC design le formule ainsi : « seules les informations
 * contextuelles et la sélection des catégories changent ». `assetId`
 * renseigné = onglet d'un bien ; absent = page globale.
 *
 * Tout le reste — filtres, tri, compteurs, pagination par catégorie — est
 * identique, parce qu'il vient du même contrat serveur. C'est ce qui empêche
 * les deux écrans de dériver, ce que le §1.3 du CDC fonctionnel reproche à
 * l'implémentation actuelle.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentCardData } from './DocumentCard';

export interface DocumentFilters {
  typeCodes: string[];
  formats: string[];
  dateFrom: string | null;
  dateTo: string | null;
  onlyToClassify: boolean;
  sort: 'createdAt' | 'documentDate' | 'title';
  direction: 'asc' | 'desc';
}

export const DEFAULT_FILTERS: DocumentFilters = {
  typeCodes: [], formats: [], dateFrom: null, dateTo: null,
  onlyToClassify: false,
  // §7.1 : tri par défaut, createdAt DESC.
  sort: 'createdAt', direction: 'desc',
};

export interface GroupState {
  code: string;
  label: string;
  count: number;
  documents: DocumentCardData[];
  hasMore: boolean;
}

interface Response {
  groups: GroupState[];
  totalCount: number;
  toClassifyCount: number;
  pageSize: number;
}

export function useDocumentBrowser(options: { assetId?: number }) {
  const [groups, setGroups] = useState<GroupState[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [toClassifyCount, setToClassifyCount] = useState(0);
  const [filters, setFilters] = useState<DocumentFilters>(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(true);
  const [loadingGroup, setLoadingGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Décalages par catégorie : chaque accordéon se déroule indépendamment.
  const offsets = useRef<Record<string, number>>({});

  const buildQuery = useCallback(
    (extraOffsets: Record<string, number> = {}) => {
      const p = new URLSearchParams();
      if (options.assetId) p.set('assetId', String(options.assetId));
      for (const t of filters.typeCodes) p.append('type', t);
      for (const f of filters.formats) p.append('format', f);
      if (filters.dateFrom) p.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) p.set('dateTo', filters.dateTo);
      if (filters.onlyToClassify) p.set('onlyToClassify', '1');
      p.set('sort', filters.sort);
      p.set('direction', filters.direction);
      for (const [code, offset] of Object.entries(extraOffsets)) {
        if (offset > 0) p.set(`offset[${code}]`, String(offset));
      }
      return p.toString();
    },
    [options.assetId, filters],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    offsets.current = {};
    try {
      const r = await fetch(`/api/documents/browse?${buildQuery()}`, { credentials: 'include' });
      if (!r.ok) { setError('Les documents n’ont pas pu être chargés.'); return; }
      const data: Response = await r.json();
      setGroups(data.groups);
      setTotalCount(data.totalCount);
      setToClassifyCount(data.toClassifyCount);
    } catch {
      setError('Les documents n’ont pas pu être chargés.');
    } finally {
      setLoading(false);
    }
  }, [buildQuery]);

  useEffect(() => { load(); }, [load]);

  /** Déroule une catégorie sans recharger les autres. */
  const loadMore = useCallback(
    async (code: string) => {
      const current = groups.find((g) => g.code === code);
      if (!current) return;

      setLoadingGroup(code);
      try {
        const nextOffset = current.documents.length;
        const r = await fetch(
          `/api/documents/browse?${buildQuery({ [code]: nextOffset })}&category=${encodeURIComponent(code)}`,
          { credentials: 'include' },
        );
        if (!r.ok) return;
        const data: Response = await r.json();
        const incoming = data.groups.find((g) => g.code === code);
        if (!incoming) return;

        setGroups((prev) =>
          prev.map((g) =>
            g.code === code
              ? {
                  ...g,
                  // Déduplication : un document classé entre deux appels
                  // pourrait remonter deux fois.
                  documents: [
                    ...g.documents,
                    ...incoming.documents.filter(
                      (d) => !g.documents.some((existing) => existing.id === d.id),
                    ),
                  ],
                  hasMore: incoming.hasMore,
                  count: incoming.count,
                }
              : g,
          ),
        );
      } finally {
        setLoadingGroup(null);
      }
    },
    [groups, buildQuery],
  );

  /**
   * Applique les variations de compteurs renvoyées par la modification.
   *
   * §8.4 : « retourner le document mis à jour et les deltas de compteurs
   * nécessaires à l'actualisation immédiate du front ». Le §5.1 ajoute :
   * « après enregistrement, le drawer reste ouvert et les pages se mettent à
   * jour sans rechargement ».
   *
   * Recharger la liste entière fermerait les accordéons et ferait perdre la
   * position de lecture — pour un changement qui ne concerne qu'une ligne.
   */
  const applyCounterDeltas = useCallback(
    (deltas: Record<string, number>, movedDocumentId: number) => {
      setGroups((prev) =>
        prev.map((g) => {
          const delta = deltas[g.code] ?? 0;
          if (delta === 0) return g;
          return {
            ...g,
            count: Math.max(0, g.count + delta),
            // Le document quitte le groupe qu'il perd. Il n'est pas inséré
            // dans le nouveau : sa place y dépend du tri, et l'y placer au
            // hasard serait pire que de le laisser réapparaître au prochain
            // déroulement.
            documents: delta < 0
              ? g.documents.filter((d) => d.id !== movedDocumentId)
              : g.documents,
          };
        }),
      );
    },
    [],
  );

  const activeFilterCount =
    filters.typeCodes.length +
    filters.formats.length +
    (filters.dateFrom ? 1 : 0) +
    (filters.dateTo ? 1 : 0) +
    (filters.onlyToClassify ? 1 : 0);

  return {
    groups, totalCount, toClassifyCount,
    filters, setFilters,
    loading, loadingGroup, error,
    reload: load, loadMore, applyCounterDeltas,
    activeFilterCount,
  };
}
