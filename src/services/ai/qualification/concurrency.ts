/**
 * Exécution bornée des essais de qualification — lot 86A (CDC Pilotage IA V2
 * P5, décision PO n° 14 « concurrence »). PUR (aucune base, aucun appel).
 *
 * Reproduit la concurrence EXISTANTE pour la mesurer, sans moteur parallèle :
 *   · traitements en file (T1, T3, T4) : 3 exécutions au plus par instance
 *     de worker (`AI_QUEUE_CONCURRENCY`, défaut 3), dont 2 par traitement ;
 *   · T2 et T6 (synchrones) : 3 appels simultanés initiaux chacun.
 * Chaque essai rend exactement un résultat rattaché à SA clé : l'exécuteur
 * relève la simultanéité réellement atteinte, les essais perdus (aucun
 * résultat), les doublons (deux résultats pour une clé) et les attributions
 * incorrectes (résultat portant la clé d'un autre essai).
 */

export interface PoolTask<T> {
  /** Clé unique de l'essai (cas × observation). */
  key: string;
  /** Groupe de simultanéité (traitement). */
  group: string;
  run: () => Promise<T>;
}

export interface PoolOptions {
  /** Borne globale (par instance de worker). */
  limit: number;
  /** Borne par groupe (traitement). */
  groupLimit: number;
  /** Clé portée par le résultat (attribution vérifiée), si le résultat en porte une. */
  keyOf?: (result: unknown) => string | null;
}

export interface PoolOutcome<T> {
  results: Map<string, { ok: true; value: T } | { ok: false; error: unknown }>;
  maxObserved: number;
  maxObservedByGroup: Record<string, number>;
  submitted: number;
  completed: number;
  duplicates: number;
  lost: number;
  misattributed: number;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) { this.active += 1; return; }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }
  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/**
 * Lance les essais sous les deux bornes. Ordre d'acquisition : groupe puis
 * global (un essai en attente de son groupe ne consomme pas de place globale).
 */
export async function runBounded<T>(tasks: readonly PoolTask<T>[], opts: PoolOptions): Promise<PoolOutcome<T>> {
  const global = new Semaphore(Math.max(1, opts.limit));
  const groups = new Map<string, Semaphore>();
  const enCours = new Map<string, number>();
  let actifs = 0;
  let maxObserved = 0;
  const maxByGroup: Record<string, number> = {};
  const results: PoolOutcome<T>['results'] = new Map();
  let duplicates = 0;
  let misattributed = 0;
  const cles = new Set(tasks.map((t) => t.key));

  await Promise.all(tasks.map(async (t) => {
    const g = groups.get(t.group) ?? new Semaphore(Math.max(1, opts.groupLimit));
    groups.set(t.group, g);
    await g.acquire();
    await global.acquire();
    actifs += 1;
    enCours.set(t.group, (enCours.get(t.group) ?? 0) + 1);
    maxObserved = Math.max(maxObserved, actifs);
    maxByGroup[t.group] = Math.max(maxByGroup[t.group] ?? 0, enCours.get(t.group)!);
    let r: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      r = { ok: true, value: await t.run() };
    } catch (error) {
      r = { ok: false, error };
    } finally {
      actifs -= 1;
      enCours.set(t.group, enCours.get(t.group)! - 1);
      global.release();
      g.release();
    }
    if (results.has(t.key)) duplicates += 1;
    else results.set(t.key, r);
    if (r.ok && opts.keyOf) {
      const k = opts.keyOf(r.value);
      if (k !== null && k !== t.key && cles.has(k)) misattributed += 1;
    }
  }));

  return {
    results, maxObserved, maxObservedByGroup: maxByGroup, submitted: tasks.length,
    completed: results.size, duplicates, lost: tasks.filter((t) => !results.has(t.key)).length, misattributed,
  };
}
