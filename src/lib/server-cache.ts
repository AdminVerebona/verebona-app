/**
 * Cache serveur en mémoire, avec durée de vie — APP-PERF-22.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PORTÉE ET LIMITES
 *
 * Une `Map` par processus Node : chaque instance (Scalingo : plusieurs
 * conteneurs web) a SON cache. Une invalidation faite sur une instance
 * n'atteint pas les autres. D'où la politique ci-dessous, sans cache
 * distribué (pas de Redis imposé) :
 *
 *   1. durées COURTES pour les données privées (≤ 30 s) — jamais allongées
 *      pour masquer une charge ;
 *   2. clés VERSIONNÉES et ISOLÉES par compte ou par utilisateur
 *      (`v2:acct:<id>:…`, `v2:user:<id>:…`) — une réponse privée n'est
 *      jamais servie à un autre compte ; un changement de format change la
 *      version (les anciennes clés ne sont plus lues et expirent seules) ;
 *   3. invalidation LOCALE à chaque écriture authentifiée (SessionService :
 *      méthode ≠ GET) — l'instance qui a traité l'écriture ne ressert pas
 *      l'état d'avant ;
 *   4. demande de FRAÎCHEUR du client (`x-verebona-fresh: 1`) après une
 *      écriture, honorée par toutes les routes en cache, quelle que soit
 *      l'instance qui répond : c'est elle qui garantit la convergence
 *      immédiate pour l'auteur de la modification en multi-instance ;
 *   5. autres utilisateurs du même compte (Premium Duo) et autres instances :
 *      convergence au plus tard à l'expiration (≤ 30 s), documentée.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVENTAIRE (durée — clé — invalidations — portée)
 *
 *   /api/home/summary          30 s  acct:<compte>:home-summary
 *                              écriture du compte ; fraîcheur client
 *   /api/to-process/suppliers  30 s  acct:<compte>:to-process-suppliers
 *                              écriture du compte ; fraîcheur client
 *   /api/users/me              30 s  user:<utilisateur>:me
 *                              écriture de l'utilisateur ; synchronisation
 *                              d'abonnement (tous les membres) ; statut admin,
 *                              suppression ; fraîcheur client
 *   session-cutoff:<utilisateur> 60 s  borne de révocation (session-guard),
 *                              vidée localement au changement de mot de passe
 *   checkout-pending           — (supprimé : remplacé par la réconciliation
 *                              durable en base, APP-PERF-18)
 *
 * Hors de ce module : cache mémoire du navigateur (`lib/api-client.ts`, clé
 * avec époque de session, vidé à chaque transition d'identité et à chaque
 * écriture), en-têtes HTTP `Cache-Control: private, no-cache` des routes
 * ci-dessus, et caches propres à l'assistant (`services/verebona-assistant`).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { FRESH_HEADER } from './data-freshness';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/** Version du format des clés : la changer rend les anciennes illisibles. */
export const SERVER_CACHE_KEY_VERSION = 'v2';

/** Compteurs de fonctionnement (mesures APP-PERF-22 : hits / miss / invalidations). */
const stats = { hits: 0, misses: 0, invalidations: 0 };

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
  if (!entry) {
    stats.misses += 1;
    return null;
  }
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    stats.misses += 1;
    return null;
  }
  stats.hits += 1;
  return entry.data as T;
}

export function serverCacheSet<T>(key: string, data: T, ttlMs: number): void {
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function serverCacheDelete(key: string): void {
  if (store.delete(key)) stats.invalidations += 1;
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
  stats.invalidations += supprimees;
  return supprimees;
}

export function serverCacheClear(): void {
  store.clear();
}

// ── Clés isolées par compte / utilisateur ──────────────────────────────────

function idSegment(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Identifiant de cache invalide : ${id}`);
  return String(id);
}

/**
 * Clé d'une lecture privée d'un COMPTE. Le `:` final du préfixe garantit que
 * l'invalidation du compte 12 n'atteint pas le compte 123.
 */
export function accountCacheKey(accountId: number, resource: string, ...parts: Array<string | number>): string {
  return [`${SERVER_CACHE_KEY_VERSION}:acct:${idSegment(accountId)}`, resource, ...parts.map(String)].join(':');
}

/** Clé d'une lecture privée d'un UTILISATEUR (indépendante du compte courant). */
export function userCacheKey(userId: number, resource: string, ...parts: Array<string | number>): string {
  return [`${SERVER_CACHE_KEY_VERSION}:user:${idSegment(userId)}`, resource, ...parts.map(String)].join(':');
}

/** Oublie toutes les lectures en cache d'un compte (cette instance). */
export function invalidateAccountReadCache(accountId: number): number {
  return serverCacheDeleteByPrefix(`${SERVER_CACHE_KEY_VERSION}:acct:${idSegment(accountId)}:`);
}

/** Oublie toutes les lectures en cache d'un utilisateur (cette instance). */
export function invalidateUserReadCache(userId: number): number {
  return serverCacheDeleteByPrefix(`${SERVER_CACHE_KEY_VERSION}:user:${idSegment(userId)}:`);
}

/** Méthode HTTP d'écriture (invalide les lectures du compte). */
export function isMutatingMethod(method: string | null | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

/** Le client demande-t-il explicitement un état frais (après une écriture) ? */
export function wantsFreshRead(headers: Pick<Headers, 'get'>): boolean {
  return headers.get(FRESH_HEADER) === '1';
}

/** Compteurs de fonctionnement (copie). */
export function serverCacheStats(): { hits: number; misses: number; invalidations: number; size: number } {
  return { ...stats, size: store.size };
}

/** Réservé aux tests. */
export function __resetServerCacheStatsForTests(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.invalidations = 0;
}
