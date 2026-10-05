"use client";

/**
 * Résumé de l'accueil : chargement, rafraîchissements regroupés, états
 * distincts — APP-PERF-09 et APP-PERF-39.
 *
 * · Tous les déclencheurs (événements métier, retour d'un dialogue, Duo,
 *   transmission, retour sur l'onglet) passent par UN coordinateur
 *   (`createCoalescedRefresh`) : regroupement sur 300 ms, une lecture à la
 *   fois, réponses anciennes écartées.
 * · Fraîcheur : un résumé frais (`x-verebona-fresh`) n'est demandé que si
 *   une modification a eu lieu depuis le DÉBUT de la dernière lecture
 *   acceptée (`lib/data-freshness`). Une modification pendant une lecture
 *   rend donc la lecture suivante fraîche.
 * · États : `loading` (rien encore), `ready` (données, éventuellement en
 *   revalidation : `refreshing`), `error` (aucune donnée et échec). Une
 *   relecture qui échoue GARDE les données affichées (`refreshError`).
 *
 * Bascule de relecture directe (diagnostic, retour arrière) :
 * `localStorage['verebona:home-refresh-direct'] = '1'`.
 * Traces : `localStorage['verebona:home-refresh-debug'] = '1'` journalise
 * le compte d'invalidations, de lectures et de réponses écartées.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { FRESH_HEADER, mutatedSince } from '@/lib/data-freshness';
import { createCoalescedRefresh, type CoalescedRefresh } from '@/lib/home/coalesced-refresh';
import type { HomeSummaryPayload } from '@/services/home/HomeSummaryService';

/** Événements qui invalident le résumé (une même action en émet plusieurs). */
export const HOME_SUMMARY_EVENTS = [
  'document-added',
  'document-deleted',
  'document-analysis-complete',
  'agenda-mutated',
  'notifications-refresh',
  'refresh-a-traiter',
] as const;

/** Fenêtre de regroupement des événements d'une même action (ms). */
export const HOME_REFRESH_WINDOW_MS = 300;
/** Retour sur l'onglet : relecture si la dernière date de plus de… (ms). */
export const HOME_VISIBILITY_REFRESH_MS = 30_000;

/**
 * Début de la dernière lecture acceptée, conservé entre deux visites de
 * l'accueil (navigation client) : une modification faite ailleurs depuis
 * déclenche un résumé frais.
 */
let lastHomeSummaryLoadAt = 0;

export type HomeSummaryStatus = 'loading' | 'ready' | 'error';

function lireDrapeau(cle: string): boolean {
  try {
    return globalThis.localStorage?.getItem(cle) === '1';
  } catch {
    return false;
  }
}

export function useHomeSummary(enabled = true) {
  const [summary, setSummary] = useState<HomeSummaryPayload | null>(null);
  const [status, setStatus] = useState<HomeSummaryStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const coordinator = useRef<CoalescedRefresh | null>(null);
  const hasData = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const debug = lireDrapeau('verebona:home-refresh-debug');
    const startedAt = new Map<number, number>();

    const c = createCoalescedRefresh<HomeSummaryPayload>({
      windowMs: HOME_REFRESH_WINDOW_MS,
      direct: lireDrapeau('verebona:home-refresh-direct'),
      load: ({ signal, generation }) => {
        const debut = Date.now();
        startedAt.set(generation, debut);
        const fresh = mutatedSince(lastHomeSummaryLoadAt);
        return apiClient.get<HomeSummaryPayload>('/api/home/summary', {
          signal,
          // Deux montages simultanés (double rendu, deux composants) partagent
          // un transport ; la clé inclut l'en-tête de fraîcheur.
          dedupe: true,
          headers: fresh ? { [FRESH_HEADER]: '1' } : undefined,
        });
      },
      apply: (data, generation) => {
        lastHomeSummaryLoadAt = startedAt.get(generation) ?? lastHomeSummaryLoadAt;
        for (const g of startedAt.keys()) if (g <= generation) startedAt.delete(g);
        hasData.current = true;
        setSummary(data);
        setStatus('ready');
        setRefreshError(false);
        if (debug) console.info('[accueil] résumé', c.stats());
      },
      onError: (error) => {
        console.error('Error loading home summary:', error);
        if (hasData.current) setRefreshError(true);
        else setStatus('error');
      },
      onBusyChange: (busy) => setRefreshing(busy),
    });
    coordinator.current = c;
    c.refreshNow();

    const onEvent = () => c.invalidate();
    HOME_SUMMARY_EVENTS.forEach((e) => window.addEventListener(e, onEvent));

    // Modification faite sur un autre appareil (Duo) : pas d'événement local.
    // Au retour sur l'onglet, une relecture ordinaire (cache serveur ≤ 30 s)
    // si la dernière est ancienne — bornée, sans minuterie permanente.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastHomeSummaryLoadAt >= HOME_VISIBILITY_REFRESH_MS) c.invalidate();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      HOME_SUMMARY_EVENTS.forEach((e) => window.removeEventListener(e, onEvent));
      document.removeEventListener('visibilitychange', onVisible);
      if (debug) console.info('[accueil] résumé (fin de visite)', c.stats());
      c.dispose();
      if (coordinator.current === c) coordinator.current = null;
    };
  }, [enabled]);

  /** Après une action confirmée : la modification est notée par l'appelant. */
  const invalidate = useCallback(() => coordinator.current?.invalidate(), []);

  /** « Réessayer » : lecture immédiate. */
  const retry = useCallback(() => {
    if (!hasData.current) setStatus('loading');
    coordinator.current?.refreshNow();
  }, []);

  return { summary, status, refreshing, refreshError, invalidate, retry };
}
