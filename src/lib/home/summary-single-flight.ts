/**
 * Recalcul partagé par clé (compte), côté serveur — APP-PERF-09.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `GET /api/home/summary` avec `x-verebona-fresh: 1` contournait le cache de
 * 30 s ET relançait un calcul complet (une quinzaine de lectures SQL) même si
 * le même compte en avait déjà un en cours : deux onglets, ou un compte Duo
 * sur deux appareils, multipliaient les recalculs.
 *
 * Règle, par clé :
 *   · lecture ordinaire : rejoint le calcul en cours s'il y en a un ;
 *   · lecture « fraîche » : un calcul en cours a démarré AVANT elle, donc
 *     peut-être avant la modification qui la motive ; elle attend la fin de
 *     ce calcul puis UN nouveau calcul, partagé par toutes les demandes
 *     fraîches arrivées entre-temps. Une rafale de N demandes fraîches
 *     pendant un calcul coûte donc au plus un calcul de plus, jamais N.
 *
 * État en mémoire de l'instance, comme `server-cache` : sur plusieurs
 * conteneurs, chacun partage ses propres calculs — suffisant pour borner les
 * rafales d'un navigateur, qui restent servies par la même instance dans la
 * plupart des cas. Pas de Redis sans mesure qui le justifie.
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface SingleFlightStats {
  /** Calculs réellement exécutés. */
  computations: number;
  /** Demandes servies par un calcul déjà en cours ou déjà programmé. */
  joined: number;
}

interface KeyState<T> {
  current: Promise<T> | null;
  next: Promise<T> | null;
}

export interface KeyedSingleFlight<T> {
  run(key: string, opts?: { fresh?: boolean }): Promise<T>;
  stats(): Readonly<SingleFlightStats>;
  /** Réservé aux tests. */
  reset(): void;
}

export function createKeyedSingleFlight<T>(compute: (key: string) => Promise<T>): KeyedSingleFlight<T> {
  const states = new Map<string, KeyState<T>>();
  let stats: SingleFlightStats = { computations: 0, joined: 0 };

  const stateOf = (key: string): KeyState<T> => {
    let s = states.get(key);
    if (!s) { s = { current: null, next: null }; states.set(key, s); }
    return s;
  };

  const launch = (key: string, s: KeyState<T>): Promise<T> => {
    stats.computations += 1;
    let p: Promise<T>;
    try {
      p = compute(key);
    } catch (error) {
      p = Promise.reject(error);
    }
    const tracked = p.finally(() => {
      if (s.current === tracked) s.current = null;
      if (!s.current && !s.next && states.get(key) === s) states.delete(key);
    });
    s.current = tracked;
    return tracked;
  };

  return {
    run(key, { fresh = false } = {}) {
      const s = stateOf(key);
      if (!fresh) {
        if (s.current) { stats.joined += 1; return s.current; }
        if (s.next) { stats.joined += 1; return s.next; }
        return launch(key, s);
      }
      // Un calcul est déjà programmé après celui en cours : il démarrera
      // après cette demande, il la satisfait.
      if (s.next) { stats.joined += 1; return s.next; }
      if (!s.current) return launch(key, s);
      // Calcul en cours démarré avant cette demande : on en attend la fin
      // (succès ou échec), puis un seul nouveau calcul pour toutes.
      const previous = s.current;
      const next: Promise<T> = previous.then(() => undefined, () => undefined).then(() => {
        if (s.next === next) s.next = null;
        return launch(key, s);
      });
      s.next = next;
      return next;
    },
    stats: () => ({ ...stats }),
    reset() {
      states.clear();
      stats = { computations: 0, joined: 0 };
    },
  };
}
