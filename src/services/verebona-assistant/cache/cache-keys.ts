/**
 * Clés de cache — CDC §31.4.
 *
 * Toutes les clés sont préfixées par le compte pour un cloisonnement strict et une
 * invalidation ciblée par événement métier (§31.7).
 */
export const cacheKeys = {
  retrieval: (accountId: number, intent: string, qHash: string) =>
    `verebona:retrieval:${accountId}:${intent}:${qHash}`,
  help: (locale: string, qHash: string) => `verebona:help:${locale}:${qHash}`,
  entitlements: (accountId: number) => `verebona:entitlements:${accountId}`,
  suggestions: (accountId: number, route: string) => `verebona:suggestions:${accountId}:${route}`,
};

/**
 * Préfixes à invalider pour un compte.
 *
 * Une seule expression ne suffit pas : le compte n'occupe pas la même
 * position dans toutes les clés — `verebona:retrieval:42:…` mais
 * `verebona:help:fr-FR:…`, qui n'est pas rattachée à un compte.
 *
 * Énumérer les familles concernées est plus sûr qu'un motif à joker : on sait
 * exactement ce qui est vidé, et l'aide produit — partagée entre comptes —
 * n'est pas invalidée sans raison.
 */
export function accountPrefixes(accountId: number): string[] {
  return [
    `verebona:retrieval:${accountId}:`,
    `verebona:suggestions:${accountId}:`,
    `verebona:entitlements:${accountId}`,
  ];
}
