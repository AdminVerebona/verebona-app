/**
 * Clé de version partagée de la configuration IA — CDC 15 CFG-01, DOD-18.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE PROBLÈME
 *
 * La configuration effective est mise en cache 30 s PAR PROCESSUS
 * (`config-resolver.ts`, `telemetry/execution-context.ts`). `promote()`,
 * `backToDraft()`, `activate()`, `rollback()` vidaient bien le cache… de
 * l'instance qui avait reçu le clic. Les autres continuaient d'appliquer
 * l'ancienne version, et de tracer l'ancien `configVersionId`, jusqu'à
 * trente secondes.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA CLÉ DE VERSION
 *
 * Même mécanisme que le cache de l'assistant (migration 0209,
 * `verebona_cache_versions`) : chaque changement de version effective
 * incrémente le périmètre `ai-config`. Chaque résolution relit ce compteur
 * (une ligne par clé primaire, coût négligeable) et recharge la configuration
 * dès qu'il a bougé : toutes les instances appliquent le nouveau
 * `configVersionId` dès l'appel suivant.
 *
 * Compteur illisible (base lente, table absente) : `null`. Les appelants
 * retombent alors sur le TTL historique — une configuration peut avoir
 * trente secondes de retard, jamais faire échouer un appel.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Périmètre de la configuration IA dans `verebona_cache_versions`. */
export const AI_CONFIG_CACHE_SCOPE = 'ai-config';

/**
 * Délai maximal de lecture du compteur. Court : la lecture est faite à
 * chaque résolution, sur le chemin d'appel. Au-delà, repli sur le TTL.
 */
export const VERSION_READ_TIMEOUT_MS = 300;

/** Stockage du compteur — la base par défaut, injectable pour les tests. */
export interface ConfigVersionCounterStore {
  /** Valeur courante (absent = 0). Peut lever. */
  read(): Promise<number>;
  /** Incrémente le compteur. Peut lever. */
  bump(reason: string): Promise<void>;
}

export const dbConfigVersionCounterStore: ConfigVersionCounterStore = {
  async read() {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT version FROM verebona_cache_versions WHERE scope = $1`,
      [AI_CONFIG_CACHE_SCOPE] as never[],
    )) as unknown as Array<{ version: string | number }>;
    return rows[0] ? Number(rows[0].version) : 0;
  },
  async bump(reason) {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO verebona_cache_versions (scope, version, last_reason, updated_at)
       VALUES ($1, 1, $2, now())
       ON CONFLICT (scope) DO UPDATE
         SET version = verebona_cache_versions.version + 1,
             last_reason = EXCLUDED.last_reason, updated_at = now()`,
      [AI_CONFIG_CACHE_SCOPE, reason.slice(0, 60)] as never[],
    );
  },
};

let store: ConfigVersionCounterStore | null = null;

/**
 * Réservé aux tests : remplace le stockage (`null` : retour au défaut).
 * Posé, il est utilisé même sous `NODE_ENV=test` — c'est ce qui permet de
 * simuler plusieurs instances sur un même stockage.
 */
export function __setConfigVersionCounterStoreForTests(s: ConfigVersionCounterStore | null): void {
  store = s;
  memo = null;
}

/** Un stockage de test est-il posé ? */
export function hasTestCounterStore(): boolean {
  return store !== null;
}

function currentStore(): ConfigVersionCounterStore | null {
  if (store) return store;
  // Les tests unitaires n'ouvrent aucune connexion (convention de `db/index.ts`).
  if (process.env.NODE_ENV === 'test') return null;
  return dbConfigVersionCounterStore;
}

/**
 * Mémoire du compteur par processus : ~1 s. Sans elle, chaque appel modèle
 * ajoutait une à deux lectures (résolveur + trace) et une course de 300 ms
 * occupant une connexion du pool. Une bascule est donc vue par les autres
 * instances en ≤ 1 s — contre 30 s avant CFG-01 ; l'instance qui bascule la
 * voit immédiatement (mémoire vidée par `bumpConfigVersionCounter`).
 */
export const COUNTER_MEMO_MS = 1_000;
let memo: { value: number | null; at: number } | null = null;
let enVol: Promise<number | null> | null = null;

/**
 * Compteur courant, ou `null` s'il est illisible (appelant : repli sur TTL).
 * Ne lève jamais. Lectures concurrentes regroupées.
 */
export async function readConfigVersionCounter(): Promise<number | null> {
  const s = currentStore();
  if (!s) return null;
  if (memo && Date.now() - memo.at < COUNTER_MEMO_MS) return memo.value;
  if (enVol) return enVol;
  enVol = (async () => {
    let value: number | null;
    try {
      value = await Promise.race([
        s.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), VERSION_READ_TIMEOUT_MS).unref?.()),
      ]);
    } catch {
      value = null;
    }
    // Un compteur illisible n'est pas mémorisé : relu à l'appel suivant.
    memo = value === null ? null : { value, at: Date.now() };
    return value;
  })();
  try {
    return await enVol;
  } finally {
    enVol = null;
  }
}

/** Oublie la valeur mémorisée (bascule locale, tests). */
export function forgetConfigVersionCounter(): void {
  memo = null;
}

/**
 * Incrémente le compteur après un changement de configuration effective.
 * Ne lève jamais : l'invalidation locale a déjà eu lieu, et les autres
 * instances rattraperont au plus tard à l'expiration de leur TTL.
 */
export async function bumpConfigVersionCounter(reason: string): Promise<boolean> {
  const s = currentStore();
  if (!s) return false;
  try {
    await s.bump(reason);
    // L'instance qui bascule relit le compteur tout de suite.
    memo = null;
    return true;
  } catch (e) {
    console.warn(
      '[ai-config] clé de version partagée non incrémentée — les autres instances '
      + 'suivront à l\'expiration de leur cache (30 s) :', (e as Error).message,
    );
    return false;
  }
}
