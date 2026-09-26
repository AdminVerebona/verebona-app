"use client";

/**
 * Chargement d'une vue du Dashboard (CDC BO §4).
 *
 * ERR-001 : en cas d'échec, les données précédentes sont RETIRÉES — on
 * n'affiche jamais les KPI d'une autre période comme s'ils étaient ceux de
 * la période demandée — et l'écran propose une nouvelle tentative.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function useDashboardData<T>(url: string | null) {
  const router = useRouter();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (res.status === 401 || res.status === 403) {
        router.push('/login?returnUrl=/admin');
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || body.error || `Erreur ${res.status}`);
        return;
      }
      setData(body as T);
    } catch {
      setError('Erreur réseau — impossible de charger les données.');
    } finally {
      setLoading(false);
    }
  }, [url, router]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}
