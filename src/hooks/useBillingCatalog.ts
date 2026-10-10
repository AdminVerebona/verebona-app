'use client';

/**
 * Catalogue des offres lu depuis le serveur (source unique, CDC lookup_key
 * V4 LK-29, LK-31, LK-33). Relu au montage, au retour sur l'onglet et à la
 * demande : jamais figé au build, jamais servi par le service worker
 * (routes `/api/` en réseau seul). États explicites : chargement,
 * indisponible, chargé.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BillingCatalogResponse } from '@/lib/billing/catalog-client';

export interface UseBillingCatalog {
  catalog: BillingCatalogResponse | null;
  loading: boolean;
  /** Vrai si le catalogue n'a pas pu être lu ou ne permet aucune souscription. */
  unavailable: boolean;
  reload: () => Promise<BillingCatalogResponse | null>;
}

export function useBillingCatalog(): UseBillingCatalog {
  const [catalog, setCatalog] = useState<BillingCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/billing/catalog', { cache: 'no-store', credentials: 'omit' });
      const data = (await res.json()) as BillingCatalogResponse;
      if (!mounted.current) return data;
      setCatalog(data);
      setFailed(!res.ok);
      return data;
    } catch {
      if (mounted.current) setFailed(true);
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    // Onglet repris / navigation arrière : relecture (LK-33, TC-61).
    const onVisible = () => { if (document.visibilityState === 'visible') void reload(); };
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) void reload(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onShow);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onShow);
    };
  }, [reload]);

  return {
    catalog,
    loading,
    unavailable: !loading && (failed || !catalog || !catalog.purchasable || catalog.offers.length === 0),
    reload,
  };
}
