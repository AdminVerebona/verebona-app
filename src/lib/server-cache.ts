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

export function serverCacheClear(): void {
  store.clear();
}