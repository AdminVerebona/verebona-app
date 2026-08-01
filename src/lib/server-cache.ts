/**
 * Cache serveur mémoïsant en mémoire avec TTL.
 *
 * Utile pour éviter des requêtes DB redondantes (ex: grace period check)
 * ou pour mettre en cache des réponses API coûteuses.
 *
 * ⚠️ Cache in-memory partagé sur l'instance Node.js.
 * En scaling horizontal (multi-instances), chaque instance a son propre cache.
 * Pour un cache partagé, ajouter Redis.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

// Nettoyage périodique des entrées expirées (toutes les 5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.expiresAt) store.delete(key);
  }
}, CLEANUP_INTERVAL_MS).unref();

export function serverCacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.data as T;
}

export function serverCacheSet<T>(key: string, data: T, ttlMs: number): void {
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function serverCacheDelete(key: string): void {
  store.delete(key);
}

/**
 * Supprime toutes les clés dont le préfixe correspond.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN PRÉFIXE ET NON UN MOTIF LIBRE
 *
 * L'invalidation par compte (§31.8) doit atteindre toutes les entrées d'un
 * compte, quelles que soient l'intention et l'empreinte de requête qu'elles
 * portent. Sans cela, une donnée modifiée reste servie jusqu'à l'expiration
 * du délai — et l'assistant répond sur un état périmé, ce que le §31.7
 * interdit.
 *
 * Un préfixe suffit, parce que les clés sont construites pour cela : compte
 * en troisième position, le reste ensuite. Accepter une expression
 * quelconque inviterait à des motifs approximatifs qui videraient le cache
 * d'autres comptes.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * @returns nombre d'entrées supprimées — utile en journal pour distinguer
 *          « rien à invalider » de « invalidation qui n'a rien trouvé ».
 */
export function serverCacheDeleteByPrefix(prefix: string): number {
  if (!prefix) return 0;
  let supprimees = 0;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      supprimees += 1;
    }
  }
  return supprimees;
}

export function serverCacheClear(): void {
  store.clear();
}