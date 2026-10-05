/**
 * Rafraîchissements regroupés et réponses anciennes écartées — APP-PERF-09.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT
 *
 * Une seule action (dépôt d'un document) émet plusieurs événements métier :
 * `document-added`, puis `refresh-a-traiter`, `agenda-mutated` si une
 * échéance est créée, `document-analysis-complete` à la fin de l'analyse…
 * Chacun relançait un recalcul COMPLET du résumé de l'accueil, demandé
 * « frais » (cache serveur contourné). Les réponses arrivaient dans un ordre
 * quelconque : la dernière arrivée — pas forcément la plus récente —
 * remplaçait l'écran.
 *
 * LA RÈGLE
 *
 *   1. Regroupement : les invalidations d'une même action, émises dans une
 *      courte fenêtre (`windowMs`, 300 ms pour l'accueil), ne programment
 *      qu'UNE lecture.
 *   2. Une seule lecture en cours : une invalidation arrivant pendant une
 *      lecture programme AU PLUS une lecture de plus, lancée à sa fin —
 *      jamais une par événement.
 *   3. Générations : chaque lecture porte un numéro ; une réponse plus
 *      ancienne que l'état accepté est écartée (comptée dans `staleDiscarded`).
 *   4. Les données affichées restent pendant une relecture ; une erreur est
 *      remontée à l'appelant, qui sait s'il a déjà des données à garder.
 *
 * Bascule de relecture directe (`direct: true`) : pas de regroupement ni de
 * file, chaque invalidation lance sa lecture — retour au comportement
 * précédent en cas de régression, les générations protégeant toujours
 * l'ordre d'affichage.
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface CoalescedRefreshStats {
  /** Invalidations reçues (événements, actions). */
  invalidations: number;
  /** Lectures réellement lancées. */
  loads: number;
  /** Invalidations absorbées par une lecture déjà programmée ou en file. */
  coalesced: number;
  /** Réponses arrivées après une réponse plus récente, ignorées. */
  staleDiscarded: number;
}

export interface CoalescedRefreshOptions<T> {
  load: (ctx: { signal: AbortSignal; generation: number }) => Promise<T>;
  apply: (value: T, generation: number) => void;
  onError?: (error: unknown, generation: number) => void;
  /** Début / fin d'activité (lecture en cours ou en file). */
  onBusyChange?: (busy: boolean) => void;
  /** Fenêtre de regroupement des invalidations (ms). */
  windowMs?: number;
  /** Bascule : chaque invalidation relit immédiatement (pas de regroupement). */
  direct?: boolean;
  /** Minuteur injectable (tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CoalescedRefresh {
  /** Les données ont (peut-être) changé : relire, en regroupant. */
  invalidate(): void;
  /** Lecture immédiate (premier affichage, « Réessayer »), sans fenêtre. */
  refreshNow(): void;
  /**
   * Une valeur plus récente a été obtenue autrement (événement porteur de la
   * donnée) : toute réponse encore en vol est désormais obsolète.
   */
  supersede(): void;
  dispose(): void;
  stats(): Readonly<CoalescedRefreshStats>;
  /** Lecture en cours ou programmée. */
  isBusy(): boolean;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; code?: string };
  return e.name === 'AbortError' || e.code === 'REQUEST_ABORTED';
}

export function createCoalescedRefresh<T>(opts: CoalescedRefreshOptions<T>): CoalescedRefresh {
  const windowMs = opts.windowMs ?? 300;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let generation = 0;
  let accepted = 0;
  let running = 0; // lectures en vol (plusieurs seulement en mode direct)
  const controllers = new Set<AbortController>();
  let queued = false;
  let timer: unknown = null;
  let disposed = false;
  let busy = false;
  const stats: CoalescedRefreshStats = { invalidations: 0, loads: 0, coalesced: 0, staleDiscarded: 0 };

  const setBusy = () => {
    const now = running > 0 || queued || timer !== null;
    if (now !== busy) {
      busy = now;
      opts.onBusyChange?.(now);
    }
  };

  const start = () => {
    if (disposed) return;
    const gen = ++generation;
    const controller = new AbortController();
    controllers.add(controller);
    running += 1;
    stats.loads += 1;
    setBusy();

    let promise: Promise<T>;
    try {
      promise = opts.load({ signal: controller.signal, generation: gen });
    } catch (error) {
      promise = Promise.reject(error);
    }

    promise.then(
      (value) => {
        if (disposed) return;
        if (gen <= accepted) { stats.staleDiscarded += 1; return; }
        accepted = gen;
        opts.apply(value, gen);
      },
      (error) => {
        if (disposed || isAbortError(error)) return;
        // Une lecture plus récente a déjà répondu : son état fait foi.
        if (gen <= accepted) { stats.staleDiscarded += 1; return; }
        opts.onError?.(error, gen);
      },
    ).finally(() => {
      controllers.delete(controller);
      running -= 1;
      if (disposed) return;
      if (queued && running === 0) {
        queued = false;
        start();
        return;
      }
      setBusy();
    });
  };

  const request = () => {
    if (disposed) return;
    if (running > 0 && !opts.direct) {
      if (queued) stats.coalesced += 1;
      queued = true;
      setBusy();
      return;
    }
    start();
  };

  return {
    invalidate() {
      if (disposed) return;
      stats.invalidations += 1;
      if (opts.direct) { start(); return; }
      if (timer !== null) { stats.coalesced += 1; return; }
      timer = setTimer(() => {
        timer = null;
        request();
        setBusy();
      }, windowMs);
      setBusy();
    },
    refreshNow() {
      if (disposed) return;
      if (timer !== null) { clearTimer(timer); timer = null; }
      request();
    },
    supersede() {
      accepted = ++generation;
    },
    dispose() {
      disposed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      queued = false;
      for (const c of controllers) c.abort();
      controllers.clear();
    },
    stats: () => ({ ...stats }),
    isBusy: () => busy,
  };
}
