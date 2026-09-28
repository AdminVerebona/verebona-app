/**
 * Cache du retrieval de l'assistant — CDC §43 (RETRIEVAL_CACHE_TTL_SECONDS),
 * §31.4, §31.5, §31.7, CA-26, §28.7.
 *
 *   · clé = compte + UTILISATEUR + offre + intention + question normalisée
 *     + contexte de page + référence résolue + locale + versions des
 *     catalogues : jamais partagé entre comptes (§31.4), ni entre membres
 *     d'un compte — l'aide dépend des rôles de l'utilisateur (`helpRolesFor`) ;
 *   · durée = la valeur configurée, plafonnée à 60 s. 0 désactive le cache ;
 *   · jamais pour les listes et les états qui bougent (recherches, « À
 *     traiter », échéances, informations manquantes, navigation, statuts) ;
 *   · mémoire du processus, au plus 500 entrées (les plus anciennes sortent).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVALIDATION VALABLE POUR TOUTES LES INSTANCES (§31.7, CA-26)
 *
 * Un événement métier n'invalidait que le processus qui l'avait reçu : une
 * autre instance pouvait resservir une donnée modifiée jusqu'à 60 s.
 *
 * Chaque événement incrémente désormais, en base, la VERSION du périmètre
 * concerné (`verebona_cache_versions`, migration 0209) : `account:<id>` pour
 * un compte, `global` pour un événement global (article d'aide publié). La
 * version du compte et la version globale sont lues AVANT chaque lecture du
 * cache et font partie de la clé : une entrée calculée avant la modification
 * n'est plus jamais atteinte, sur aucune instance. Versions illisibles (base
 * indisponible) : le cache est contourné — on ne sert jamais une entrée dont
 * on ne peut pas prouver la fraîcheur.
 *
 * L'invalidation locale immédiate (`invalidateRetrievalCacheForAccount`)
 * reste : elle libère la mémoire de l'instance qui a reçu l'événement.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Un succès du cache est signalé à l'orchestrateur (`CACHE:RETRIEVAL`), qui
 * renseigne `verebona_request_runs.cache_hit` (§28.7).
 */
import { createHash } from 'crypto';
import type { AssistantRequestInput, IntentRoute } from '../types/contracts';
import type { RetrievedSource } from '../types/sources';
import { INTENT_CATALOG_VERSION } from '../types/intents';
import { ACTION_CATALOG_VERSION } from '../types/actions';

const MAX_ENTREES = 500;
/** Plafond de durée, quelle que soit la configuration. */
export const RETRIEVAL_CACHE_MAX_TTL_SECONDS = 60;

/** Intentions jamais mises en cache : listes et états susceptibles de changer à tout moment. */
const JAMAIS_EN_CACHE = new Set<string>([
  'ACCOUNT_SEARCH_ASSET', 'ACCOUNT_SEARCH_DOCUMENT', 'ACCOUNT_SEARCH_AGENDA', 'ACCOUNT_SEARCH_SUPPLIER',
  'ACCOUNT_TO_PROCESS', 'ACCOUNT_FACT_AGENDA', 'ACCOUNT_MISSING_INFORMATION',
  'NAVIGATION_OPEN', 'NAVIGATION_FIND', 'PRODUCT_HELP_STATUS',
]);

interface Entree { accountId: number; expiresAt: number; sources: RetrievedSource[] }
const entrees = new Map<string, Entree>();

const normaliser = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── Versions d'invalidation (partagées entre instances) ─────────────────────

/** Périmètre de version d'un compte ; `global` pour les événements globaux. */
export const accountCacheScope = (accountId: number) => `account:${accountId}`;
export const GLOBAL_CACHE_SCOPE = 'global';

/**
 * Stockage des versions. Par défaut la base (`verebona_cache_versions`) ;
 * injectable pour les tests (plusieurs instances sur un même stockage).
 */
export interface CacheVersionStore {
  /** Versions courantes des périmètres demandés (absent = 0). */
  read(scopes: string[]): Promise<Record<string, number>>;
  /** Incrémente la version d'un périmètre. */
  bump(scope: string, reason: string): Promise<void>;
}

export const dbCacheVersionStore: CacheVersionStore = {
  async read(scopes) {
    const { pgClient } = await import('@/db');
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

let versionStore: CacheVersionStore = dbCacheVersionStore;

/** Réservé aux tests : remplace le stockage des versions (`null` : la base). */
export function setCacheVersionStoreForTests(store: CacheVersionStore | null): void {
  versionStore = store ?? dbCacheVersionStore;
}

/**
 * Incrémente la version d'invalidation d'un compte (ou globale si `null`).
 * Appelé par le consommateur des événements métier. Lève en cas d'échec :
 * l'abonné est isolé par le bus, qui journalise.
 */
export async function bumpRetrievalCacheVersion(accountId: number | null, reason: string): Promise<void> {
  await versionStore.bump(accountId == null ? GLOBAL_CACHE_SCOPE : accountCacheScope(accountId), reason);
}

/** Jeton de version « compte:global », ou `null` si illisible (cache contourné). */
async function lireVersions(accountId: number): Promise<string | null> {
  try {
    const scope = accountCacheScope(accountId);
    const v = await versionStore.read([scope, GLOBAL_CACHE_SCOPE]);
    return `${v[scope] ?? 0}:${v[GLOBAL_CACHE_SCOPE] ?? 0}`;
  } catch (e) {
    console.warn('[verebona][cache] versions d\'invalidation illisibles — cache contourné :', (e as Error).message);
    return null;
  }
}

/**
 * Clé de cache d'une demande, ou `null` si elle ne doit pas être mise en
 * cache. `version` : jeton des versions d'invalidation (§31.7).
 */
export function retrievalCacheKey(route: IntentRoute, input: AssistantRequestInput, version = '0:0'): string | null {
  if (!input.accountId || !input.message || JAMAIS_EN_CACHE.has(route.intent)) return null;
  const p = input.pageContext ?? {};
  const materiau = JSON.stringify({
    v: version, lc: input.locale ?? null, cat: [INTENT_CATALOG_VERSION, ACTION_CATALOG_VERSION],
    a: input.accountId, u: input.userId, pl: input.planType, i: route.intent, m: normaliser(input.message),
    pg: [p.route ?? null, p.assetId ?? null, p.documentId ?? null, p.supplierId ?? null, p.platform ?? null],
    ref: input.reference ? [input.reference.type, input.reference.id] : null,
    rs: input.resume ? [input.resume.assetId ?? null, input.resume.documentId ?? null] : null,
  });
  return `${input.accountId}:${createHash('sha256').update(materiau).digest('hex')}`;
}

const copier = (list: RetrievedSource[]) => list.map((s) => ({ ...s, ...(s.meta ? { meta: { ...s.meta } } : {}) }));

/**
 * Retrieval à travers le cache. Rend les sources et `hit` (servi par le
 * cache). `ttlSeconds` ≤ 0 : aucun cache ; au-delà de 60 s : plafonné.
 */
export async function cachedRetrieve(
  route: IntentRoute,
  input: AssistantRequestInput,
  fetcher: () => Promise<RetrievedSource[]>,
  ttlSeconds: number,
  now: () => number = Date.now,
): Promise<{ sources: RetrievedSource[]; hit: boolean }> {
  const duree = Math.min(ttlSeconds, RETRIEVAL_CACHE_MAX_TTL_SECONDS);
  if (duree <= 0 || !retrievalCacheKey(route, input)) return { sources: await fetcher(), hit: false };
  // §31.7 : versions lues à chaque demande — une modification faite sur une
  // autre instance change la clé ici aussi.
  const version = await lireVersions(input.accountId);
  const cle = version ? retrievalCacheKey(route, input, version) : null;
  if (!cle) return { sources: await fetcher(), hit: false };
  const e = entrees.get(cle);
  if (e && e.expiresAt > now()) return { sources: copier(e.sources), hit: true };
  if (e) entrees.delete(cle);
  const sources = await fetcher();
  entrees.set(cle, { accountId: input.accountId, expiresAt: now() + duree * 1000, sources: copier(sources) });
  while (entrees.size > MAX_ENTREES) entrees.delete(entrees.keys().next().value as string);
  return { sources, hit: false };
}

/** Invalide tout ce qui concerne un compte (événement métier, §25.7). Rend le nombre d'entrées retirées. */
export function invalidateRetrievalCacheForAccount(accountId: number): number {
  let n = 0;
  for (const [k, v] of entrees) if (v.accountId === accountId) { entrees.delete(k); n += 1; }
  return n;
}

/** Vide le cache (événement global, tests). */
export function clearRetrievalCache(): void {
  entrees.clear();
}

export function retrievalCacheSize(): number {
  return entrees.size;
}
