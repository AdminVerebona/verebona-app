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
import type { MascotPresentation, MascotSecondary } from '@/services/home/mascot/types';
import { getSessionEpoch } from '@/lib/session/session-lifecycle';

export const MASCOT_REFRESH_MS = 10 * 60_000;

// ══════════════════════════════════════════════════════════════════════════
// AFFICHAGE QUASI IMMÉDIAT (lot 26, point 17)
//
//   · la lecture part dès le montage de la PAGE d'accueil
//     (`prefetchMascotPresentation`), en parallèle de la session et du
//     résumé — elle n'attend plus que la session soit résolue pour que la
//     carte de la mascotte soit montée ;
//   · la dernière prise de parole reçue est gardée EN MÉMOIRE (jamais dans le
//     stockage du navigateur), liée à l'époque de session : au retour sur
//     l'accueil (navigation dans l'application), elle s'affiche aussitôt et
//     une relecture la remplace si le contexte a changé — c'est l'état
//     « pendant un recalcul, l'ancienne prise de parole reste affichée ».
//     Purgée à toute transition de session (connexion, compte…).
// ══════════════════════════════════════════════════════════════════════════

/** Une lecture lancée d'avance n'est reprise que si elle est récente. */
export const MASCOT_PREFETCH_MAX_AGE_MS = 10_000;
/** Une prise de parole gardée en mémoire au-delà n'est plus montrée d'emblée. */
export const MASCOT_MEMORY_MAX_AGE_MS = 10 * 60_000;

let prefetched: { at: number; epoch: number; promise: Promise<MascotPresentation>; consumed: boolean } | null = null;
let memory: { at: number; epoch: number; presentation: MascotPresentation } | null = null;

async function fetchPresentation(): Promise<MascotPresentation> {
  const res = await fetch('/api/home/mascot', { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as MascotPresentation;
}

const prefetchValid = (now: number) =>
  !!prefetched && prefetched.epoch === getSessionEpoch() && now - prefetched.at < MASCOT_PREFETCH_MAX_AGE_MS;

/**
 * Lance la lecture de la prise de parole, une seule par fenêtre : sans effet
 * si une lecture récente existe (lancée par la page ou par le hook, quel que
 * soit l'ordre des effets parent / enfant).
 */
export function prefetchMascotPresentation(now: number = Date.now()): void {
  if (prefetchValid(now)) return;
  const promise = fetchPresentation();
  promise.catch(() => undefined); // reprise (ou non) par le hook
  prefetched = { at: now, epoch: getSessionEpoch(), promise, consumed: false };
}

/**
 * Lecture du premier chargement : celle lancée d'avance si elle n'a pas déjà
 * servi, sinon une lecture neuve (enregistrée, pour qu'un `prefetch` qui
 * arriverait après ne la double pas).
 */
export function initialMascotRead(now: number = Date.now()): Promise<MascotPresentation> {
  if (prefetched && prefetchValid(now) && !prefetched.consumed) {
    prefetched.consumed = true;
    return prefetched.promise.catch(() => fetchPresentation());
  }
  const promise = fetchPresentation();
  promise.catch(() => undefined);
  prefetched = { at: now, epoch: getSessionEpoch(), promise, consumed: true };
  return promise;
}

/** Dernière prise de parole de la session courante, si récente. */
export function rememberedMascotPresentation(now: number = Date.now()): MascotPresentation | null {
  if (!memory || memory.epoch !== getSessionEpoch() || now - memory.at >= MASCOT_MEMORY_MAX_AGE_MS) return null;
  return memory.presentation;
}

function remember(presentation: MascotPresentation): void {
  memory = { at: Date.now(), epoch: getSessionEpoch(), presentation };
}

/** Réservé aux tests et aux transitions de session. */
export function purgeMascotPresentationMemory(): void {
  prefetched = null;
  memory = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('verebona:session-changed', purgeMascotPresentationMemory);
  window.addEventListener('storage', (e) => { if (e.key === 'user' || e.key === null) purgeMascotPresentationMemory(); });
}

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

/**
 * `visibleSecondaries` : secondaires réellement affichés par l'écran. La
 * télémétrie « affiché » (LOG-001) ne compte que ce que l'utilisateur voit ;
 * par défaut, tous.
 */
export function useMascotPresentation(visibleSecondaries?: (p: MascotPresentation) => MascotSecondary[]) {
  const visibles = useRef(visibleSecondaries);
  visibles.current = visibleSecondaries;
  // Premier rendu identique au serveur (rien) : la mémoire est lue au montage.
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
    (visibles.current ? visibles.current(p) : p.secondaries)
      .forEach((x) => presents.set(x.occurrenceKey, { sourceCode: x.sourceCode, placement: 'secondary' }));

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

  const load = useCallback(async (opts: { initial?: boolean } = {}) => {
    const mine = ++seq.current;
    try {
      // Premier chargement : la lecture lancée d'avance par la page, si elle
      // existe ; sinon (et pour toute relecture) une lecture neuve.
      const data = await (opts.initial ? initialMascotRead() : fetchPresentation());
      if (mine !== seq.current) return; // réponse obsolète
      remember(data);
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
    // Retour sur l'accueil : la dernière prise de parole s'affiche aussitôt
    // (et compte comme vue), la relecture la remplace si le contexte a changé.
    const memo = rememberedMascotPresentation();
    if (memo) {
      setPresentation(memo);
      trackDisplay(memo);
    }
    void load({ initial: true });
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
  }, [load, trackDisplay]);

  const trackClick = useCallback((occurrenceKey: string, sourceCode: string, placement: 'subject' | 'secondary', actionId: string) => {
    send([{ occurrenceKey, sourceCode, placement, eventType: 'clicked', actionId }]);
  }, [send]);

  const refresh = useCallback(() => load(), [load]);
  return { presentation, failed, refresh, trackClick };
}
