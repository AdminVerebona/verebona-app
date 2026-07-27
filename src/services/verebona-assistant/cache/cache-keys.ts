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

export function accountPrefix(accountId: number): string {
  return `verebona:*:${accountId}:`;
}
