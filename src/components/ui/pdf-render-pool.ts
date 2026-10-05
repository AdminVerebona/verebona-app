/**
 * Gestion des ressources des rendus PDF côté navigateur (APP-PERF-07).
 *
 * Module sans React ni DOM, testé en environnement Node :
 *   · `LruCache` : cache borné en nombre ET en volume, éviction du moins
 *     récemment utilisé ;
 *   · `Semaphore` : nombre de rendus simultanés borné, attente annulable ;
 *   · `SharedTasks` : un seul rendu par clé, partagé par tous les demandeurs
 *     (compteur de références) ; quand le DERNIER demandeur se retire, le
 *     rendu est annulé (signal) et ses ressources libérées par la tâche.
 */

export class LruCache<V> {
  private map = new Map<string, { value: V; size: number }>();
  private total = 0;

  constructor(private readonly maxEntries: number, private readonly maxSize: number, private readonly sizeOf: (v: V) => number) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    // Rafraîchit la position (le plus récent en fin de Map).
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    const size = this.sizeOf(value);
    if (size > this.maxSize) return; // jamais plus gros que tout le cache
    const prev = this.map.get(key);
    if (prev) {
      this.total -= prev.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.total += size;
    while (this.map.size > this.maxEntries || this.total > this.maxSize) {
      const oldest = this.map.keys().next().value as string;
      const e = this.map.get(oldest)!;
      this.map.delete(oldest);
      this.total -= e.size;
    }
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.total -= e.size;
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  get stats(): { entries: number; size: number } {
    return { entries: this.map.size, size: this.total };
  }
}

export class AbortError extends Error {
  constructor() { super('Aborted'); this.name = 'AbortError'; }
}

export class Semaphore {
  private active = 0;
  private waiters: Array<{ resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(private readonly max: number) {}

  get running(): number { return this.active; }
  get waiting(): number { return this.waiters.length; }

  /** Attend une place ; renvoie la fonction de libération (idempotente). */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AbortError();
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const w: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new AbortError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) {
        if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
        next.resolve(); // la place passe directement au suivant
      } else {
        this.active--;
      }
    };
  }
}

interface Shared<T> {
  promise: Promise<T>;
  controller: AbortController;
  refs: number;
}

export class SharedTasks<T> {
  private tasks = new Map<string, Shared<T>>();

  get size(): number { return this.tasks.size; }

  /**
   * Rejoint (ou lance) la tâche `key`. `signal` : retrait de CE demandeur.
   * La tâche reçoit un signal qui n'est levé que lorsque plus personne ne
   * l'attend.
   */
  run(key: string, start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new AbortError());
    let shared = this.tasks.get(key);
    if (!shared) {
      const controller = new AbortController();
      const entry: Shared<T> = { controller, refs: 0, promise: Promise.resolve() as unknown as Promise<T> };
      entry.promise = start(controller.signal).finally(() => {
        if (this.tasks.get(key) === entry) this.tasks.delete(key);
      });
      // Évite un rejet non géré si tous les demandeurs sont partis.
      entry.promise.catch(() => undefined);
      this.tasks.set(key, entry);
      shared = entry;
    }
    const s = shared;
    s.refs++;
    return new Promise<T>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        s.refs--;
        if (s.refs <= 0) {
          s.controller.abort();
          if (this.tasks.get(key) === s) this.tasks.delete(key);
        }
        reject(new AbortError());
      };
      signal?.addEventListener('abort', leave, { once: true });
      s.promise.then(
        (v) => { if (!left) { left = true; s.refs--; signal?.removeEventListener('abort', leave); resolve(v); } },
        (e) => { if (!left) { left = true; s.refs--; signal?.removeEventListener('abort', leave); reject(e); } },
      );
    });
  }

  /** Annule tout (changement de contexte de session). */
  abortAll(): void {
    for (const s of this.tasks.values()) s.controller.abort();
    this.tasks.clear();
  }
}
