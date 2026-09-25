'use client';

/**
 * Chargement et rafraîchissement de la prise de parole — CDC Mascotte §14, §15, §17.
 *
 *   · recalcul au chargement (REF-001), après tout événement susceptible de
 *     changer un signal (REF-002), et toutes les 10 minutes sur l'accueil
 *     (REF-003) ;
 *   · une réponse arrivée après une plus récente est ignorée (§20, CACHE-04) ;
 *   · au premier affichage, un état de chargement court puis directement le
 *     résultat — jamais un texte de secours remplacé sous les yeux (RUN-001) :
 *     pendant un recalcul, l'ancienne prise de parole reste affichée ;
 *   · télémétrie : « affiché » une fois par occurrence et par visite
 *     (LOG-002), « disparu » quand un sujet vu dans la visite s'en va.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MascotPresentation } from '@/services/home/mascot/types';

export const MASCOT_REFRESH_MS = 10 * 60_000;

/** Événements du front qui peuvent changer un signal (matrice §15). */
export const MASCOT_REFRESH_EVENTS = [
  'document-added', 'document-deleted', 'document-analysis-complete', 'document-analysis-start',
  'agenda-mutated', 'refresh-a-traiter', 'notifications-refresh', 'verebona:data-mutated',
  'asset-details-updated',
] as const;

type EventType = 'displayed' | 'clicked' | 'disappeared';

function newVisitId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `v-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function useMascotPresentation() {
  const [presentation, setPresentation] = useState<MascotPresentation | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const visitId = useRef<string>('');
  const vus = useRef<Map<string, { sourceCode: string; placement: 'subject' | 'secondary' }>>(new Map());

  const send = useCallback((events: Array<{
    occurrenceKey: string; sourceCode: string; placement: 'subject' | 'secondary'; eventType: EventType; actionId?: string;
  }>) => {
    if (!events.length || !visitId.current) return;
    // `fetch` : la télémétrie n'est pas une modification des données du compte.
    void fetch('/api/home/mascot/events', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: events.map((e) => ({ ...e, visitId: visitId.current })) }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const trackDisplay = useCallback((p: MascotPresentation) => {
    const presents = new Map<string, { sourceCode: string; placement: 'subject' | 'secondary' }>();
    p.paragraphs.filter((x) => x.sourceCode !== 'CLEAR')
      .forEach((x) => presents.set(x.occurrenceKey, { sourceCode: x.sourceCode, placement: 'subject' }));
    p.secondaries.forEach((x) => presents.set(x.occurrenceKey, { sourceCode: x.sourceCode, placement: 'secondary' }));

    const nouveaux = [...presents.entries()].filter(([k]) => !vus.current.has(k));
    const partis = [...vus.current.entries()].filter(([k]) => !presents.has(k));
    send([
      ...nouveaux.map(([occurrenceKey, v]) => ({ occurrenceKey, ...v, eventType: 'displayed' as const })),
      ...partis.map(([occurrenceKey, v]) => ({ occurrenceKey, ...v, eventType: 'disappeared' as const })),
    ]);
    // Une occurrence déjà vue dans la visite n'est plus recomptée (LOG-002).
    nouveaux.forEach(([k, v]) => vus.current.set(k, v));
    partis.forEach(([k]) => vus.current.delete(k));
  }, [send]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch('/api/home/mascot', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as MascotPresentation;
      if (mine !== seq.current) return; // réponse obsolète
      setFailed(false);
      // Même contexte : le texte déjà affiché reste, même si une formulation
      // T6 est entre-temps disponible — jamais de texte remplacé sous les yeux
      // de l'utilisateur (RUN-001). Elle servira au prochain changement.
      setPresentation((prev) => (prev && prev.contextHash === data.contextHash ? prev : data));
      trackDisplay(data);
    } catch {
      if (mine !== seq.current) return;
      // Erreur globale : état dégradé explicite, jamais « Tout est à jour » (§20).
      setFailed(true);
    }
  }, [trackDisplay]);

  // Visite accueil : du montage au départ de la page (§3).
  useEffect(() => {
    visitId.current = newVisitId();
    vus.current = new Map();
    void load();
    const interval = setInterval(() => { void load(); }, MASCOT_REFRESH_MS);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { void load(); }, 800);
    };
    MASCOT_REFRESH_EVENTS.forEach((e) => window.addEventListener(e, onChange));
    return () => {
      clearInterval(interval);
      if (debounce) clearTimeout(debounce);
      MASCOT_REFRESH_EVENTS.forEach((e) => window.removeEventListener(e, onChange));
    };
  }, [load]);

  const trackClick = useCallback((occurrenceKey: string, sourceCode: string, placement: 'subject' | 'secondary', actionId: string) => {
    send([{ occurrenceKey, sourceCode, placement, eventType: 'clicked', actionId }]);
  }, [send]);

  return { presentation, failed, refresh: load, trackClick };
}
