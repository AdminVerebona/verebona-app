/**
 * Cache du retrieval de l'assistant — CDC §43 (RETRIEVAL_CACHE_TTL_SECONDS),
 * §31.4, §28.7.
 *
 * `VEREBONA_ASSISTANT_RETRIEVAL_CACHE_TTL_SECONDS` (300 s) était déclaré et
 * jamais lu : il n'existait aucun cache de retrieval. Le voici, borné :
 *
 *   · clé = compte + UTILISATEUR + offre + intention + question normalisée
 *     + contexte de page + référence résolue : jamais partagé entre comptes
 *     (§31.4), ni entre membres d'un compte — l'aide dépend des rôles de
 *     l'utilisateur (`helpRolesFor`) ;
 *   · durée = la valeur configurée, PLAFONNÉE à 60 s : le cache est propre à
 *     chaque processus, et un événement métier n'invalide que celui qui l'a
 *     reçu ; avec plusieurs instances, une donnée modifiée ailleurs peut
 *     donc être resservie au plus 60 s. 0 désactive le cache ;
 *   · jamais pour les listes et les états qui bougent (recherches, « À
 *     traiter », échéances, informations manquantes, navigation, statuts) :
 *     leur fraîcheur prime sur le gain ;
 *   · invalidé pour le compte à chaque événement métier (§25.7) — un
 *     document supprimé ou réanalysé n'est jamais resservi depuis le cache ;
 *   · mémoire du processus, au plus 500 entrées (les plus anciennes sortent).
 *
 * Un succès du cache est signalé à l'orchestrateur (`CACHE:RETRIEVAL`), qui
 * renseigne `verebona_request_runs.cache_hit` (§28.7).
 */
import { createHash } from 'crypto';
import type { AssistantRequestInput, IntentRoute } from '../types/contracts';
import type { RetrievedSource } from '../types/sources';

const MAX_ENTREES = 500;
/** Plafond de durée, quelle que soit la configuration (multi-instances). */
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

/** Clé de cache d'une demande, ou `null` si elle ne doit pas être mise en cache. */
export function retrievalCacheKey(route: IntentRoute, input: AssistantRequestInput): string | null {
  if (!input.accountId || !input.message || JAMAIS_EN_CACHE.has(route.intent)) return null;
  const p = input.pageContext ?? {};
  const materiau = JSON.stringify({
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
  const cle = duree > 0 ? retrievalCacheKey(route, input) : null;
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
