/**
 * Invalidation partagée des caches EN MÉMOIRE sans clé de version propre —
 * CDC Assistant §31.6, §31.7, §32.6 (« invalider un cache ») ; lot 23.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE PROBLÈME
 *
 * Plusieurs caches sont propres à chaque processus et ne relisent rien
 * avant leur expiration : corpus d'aide (24 h), catalogue des prix (chargé au
 * démarrage), prompts du dépôt (60 s). Une invalidation demandée depuis le
 * BO ne vidait que l'instance qui recevait le clic.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MÉCANISME
 *
 * Même table que les autres versions partagées (`verebona_cache_versions`,
 * migration 0209) : périmètre `cache:<id>`. L'invalidation incrémente la
 * version ; chaque instance relit les versions des caches qu'elle a
 * enregistrés en une requête (clé primaire), au plus toutes les `POLL_MS` (tâche de fond démarrée par
 * `instrumentation-node.ts`, `unref` : n'empêche jamais l'arrêt), et vide son
 * cache local dès qu'une version a bougé. La première lecture d'un processus
 * sert de référence et ne vide rien (un démarrage part déjà d'un cache vide).
 *
 * Base illisible : la lecture est retentée au tour suivant ; aucun cache
 * n'est vidé sur une lecture en échec (et aucun n'est servi « à tort » : ces
 * caches gardent leur TTL).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Préfixe des périmètres de ce mécanisme dans `verebona_cache_versions`. */
export const SHARED_CACHE_SCOPE_PREFIX = 'cache:';
/** Période de relecture des versions (propagation ≤ cette durée). */
export const POLL_MS = 5_000;

export const sharedCacheScope = (id: string) => `${SHARED_CACHE_SCOPE_PREFIX}${id}`;

export interface SharedCacheVersionStore {
  /** Versions des périmètres demandés (absent = 0). Peut lever. */
  readAll(scopes: string[]): Promise<Record<string, number>>;
  /** Incrémente un périmètre. Peut lever. */
  bump(scope: string, reason: string): Promise<void>;
}

export const dbSharedCacheVersionStore: SharedCacheVersionStore = {
  async readAll(scopes) {
    const { pgClient } = await import('@/db');
    // Clé primaire : une lecture d'index par périmètre enregistré (revue M-1).
    const rows = (await pgClient.unsafe(
      `SELECT scope, version FROM verebona_cache_versions WHERE scope = ANY($1::text[])`,
      [scopes] as never[],
    )) as unknown as Array<{ scope: string; version: string | number }>;
    return Object.fromEntries(rows.map((r) => [r.scope, Number(r.version)]));
  },
  async bump(scope, reason) {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO verebona_cache_versions (scope, version, last_reason, updated_at)
       VALUES ($1, 1, $2, now())
       ON CONFLICT (scope) DO UPDATE
         SET version = verebona_cache_versions.version + 1, last_reason = EXCLUDED.last_reason, updated_at = now()`,
      [scope, reason.slice(0, 60)] as never[],
    );
  },
};

type LocalClear = () => void | Promise<void>;

/**
 * Une instance de l'invalidation partagée (une par processus en exploitation ;
 * plusieurs dans les tests pour simuler plusieurs instances).
 */
export class SharedCacheInvalidator {
  private readonly clears = new Map<string, LocalClear>();
  private known: Record<string, number> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<string[]> | null = null;
  private dernierAvertissement = 0;
  /** Journal d'erreur de lecture : au plus une ligne par période (revue M-1). */
  static readonly WARN_EVERY_MS = 5 * 60_000;

  constructor(private readonly store: SharedCacheVersionStore = dbSharedCacheVersionStore, private readonly pollMs = POLL_MS) {}

  /** Déclare le vidage local d'un cache (`id` sans préfixe). */
  register(id: string, clear: LocalClear): this {
    this.clears.set(id, clear);
    return this;
  }

  registeredIds(): string[] {
    return [...this.clears.keys()];
  }

  /**
   * Relit les versions et vide localement les caches dont la version a
   * bougé. Rend les identifiants vidés. Ne lève jamais.
   */
  async poll(): Promise<string[]> {
    if (this.running) return this.running;
    this.running = (async () => {
      let versions: Record<string, number>;
      try {
        versions = await this.store.readAll(this.registeredIds().map(sharedCacheScope));
      } catch (e) {
        if (Date.now() - this.dernierAvertissement >= SharedCacheInvalidator.WARN_EVERY_MS) {
          this.dernierAvertissement = Date.now();
          console.warn('[caches] versions partagées illisibles — nouvel essai au prochain tour (message limité à un toutes les 5 min) :', (e as Error).message);
        }
        return [];
      }
      const precedent = this.known;
      this.known = versions;
      if (precedent === null) return [];
      const vides: string[] = [];
      for (const [id, clear] of this.clears) {
        const scope = sharedCacheScope(id);
        if ((versions[scope] ?? 0) === (precedent[scope] ?? 0)) continue;
        try {
          await clear();
          vides.push(id);
        } catch (e) {
          console.warn(`[caches] vidage local de « ${id} » en échec :`, (e as Error).message);
        }
      }
      if (vides.length) console.info(`[caches] invalidation partagée appliquée sur cette instance : ${vides.join(', ')}.`);
      return vides;
    })();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  /**
   * Invalide un cache sur TOUTES les instances : version partagée
   * incrémentée (lève si la base refuse : l'administrateur doit le savoir),
   * puis vidage local immédiat.
   */
  async invalidate(id: string, reason: string): Promise<void> {
    await this.store.bump(sharedCacheScope(id), reason);
    // Cette instance a déjà vidé : la nouvelle version devient la référence.
    if (this.known) this.known = { ...this.known, [sharedCacheScope(id)]: (this.known[sharedCacheScope(id)] ?? 0) + 1 };
    const clear = this.clears.get(id);
    if (clear) await clear();
  }

  /** Incrémente un périmètre quelconque de la même table (version d'un autre mécanisme). */
  async bumpScope(scope: string, reason: string): Promise<void> {
    await this.store.bump(scope, reason);
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
