'use client';

/**
 * Lot 109B — chargement progressif d'une section de la fiche fournisseur
 * (documents, biens, équipements) jusqu'à la TOTALITÉ des objets associés.
 * Première page fournie par la fiche ; pages suivantes par
 * `GET /api/suppliers/[id]/sections/[section]`. Dédoublonnage par identifiant
 * (une page relue après une modification ne duplique rien).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { SUPPLIER_SECTION_PAGE_MAX, type SupplierSection } from '@/lib/suppliers/supplier-fiche-config';
import type { SupplierSectionPage } from '@/services/suppliers/supplier-detail.service';

/** Fusion sans doublon (pure, testée) : l'ordre du serveur est conservé. */
export function mergeById<T extends { id: number }>(prev: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(prev.map((x) => x.id));
  return [...prev, ...next.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))];
}

export function useSupplierSection<T extends { id: number }>(
  supplierId: number,
  section: SupplierSection,
  first: SupplierSectionPage<T> | null,
) {
  const [items, setItems] = useState<T[]>(first?.items ?? []);
  const [total, setTotal] = useState(first?.total ?? 0);
  const [nextOffset, setNextOffset] = useState<number | null>(first?.nextOffset ?? null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const nextRef = useRef(nextOffset);
  nextRef.current = nextOffset;

  // Nouvelle première page (fiche relue) : la section repart de celle-ci.
  useEffect(() => {
    setItems(first?.items ?? []);
    setTotal(first?.total ?? 0);
    setNextOffset(first?.nextOffset ?? null);
    setFailed(false);
  }, [first]);

  const fetchFrom = useCallback(async (offset: number, limit?: number) => {
    const p = new URLSearchParams({ offset: String(offset) });
    if (limit) p.set('limit', String(Math.min(limit, SUPPLIER_SECTION_PAGE_MAX)));
    return apiClient.get<SupplierSectionPage<T>>(`/api/suppliers/${supplierId}/sections/${section}?${p}`);
  }, [supplierId, section]);

  /** Page suivante ; rend le nombre de lignes reçues (0 : rien à charger ou échec). */
  const loadMore = useCallback(async (limit?: number): Promise<number> => {
    const offset = nextRef.current;
    if (offset == null) return 0;
    setLoading(true);
    try {
      const page = await fetchFrom(offset, limit);
      setItems((prev) => mergeById(prev, page.items));
      setTotal(page.total);
      setNextOffset(page.nextOffset);
      nextRef.current = page.nextOffset;
      setFailed(false);
      return page.items.length;
    } catch {
      setFailed(true);
      return 0;
    } finally {
      setLoading(false);
    }
  }, [fetchFrom]);

  /** Recharge jusqu'à `count` lignes (retour sur la fiche : sections déjà dépliées). */
  const ensureLoaded = useCallback(async (count: number) => {
    let loaded = itemsRef.current.length;
    let guard = 0;
    while (loaded < count && nextRef.current != null && guard < 50) {
      guard += 1;
      const n = await loadMore(SUPPLIER_SECTION_PAGE_MAX);
      if (n === 0) break;
      loaded += n;
    }
  }, [loadMore]);

  return { items, total, nextOffset, loading, failed, loadMore, ensureLoaded };
}
