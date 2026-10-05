/**
 * Travail différé « quand le navigateur est libre », ANNULABLE — APP-PERF-39.
 *
 * La coquille différait ses lectures secondaires avec `requestIdleCallback`
 * sans jamais garder la poignée : une navigation rapide, une déconnexion ou
 * un changement d'utilisateur laissaient partir des lectures tardives qui
 * écrivaient ensuite un état obsolète. Chaque planification rend désormais sa
 * fonction d'annulation, à appeler dans le nettoyage de l'effet.
 */
export type CancelIdle = () => void;

export interface IdleOptions {
  /** Délai maximal avant exécution forcée (ms). */
  timeout?: number;
  /** Repli sans `requestIdleCallback` (Safari) : attente fixe (ms). */
  fallbackDelay?: number;
}

export function scheduleIdle(callback: () => void, { timeout = 2_000, fallbackDelay = 200 }: IdleOptions = {}): CancelIdle {
  let annule = false;
  const run = () => { if (!annule) callback(); };

  const w = typeof window !== 'undefined' ? window : undefined;
  if (w && typeof w.requestIdleCallback === 'function') {
    const handle = w.requestIdleCallback(run, { timeout });
    return () => {
      annule = true;
      w.cancelIdleCallback?.(handle);
    };
  }
  const handle = setTimeout(run, fallbackDelay);
  return () => {
    annule = true;
    clearTimeout(handle);
  };
}
