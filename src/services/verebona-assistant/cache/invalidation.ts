/**
 * Invalidation de cache par événement métier — CDC §31.7 / §31.8.
 *
 * Réutilise le cache serveur existant (`@/lib/server-cache`). À l'ajout/modif/suppression
 * d'un bien, document, échéance ou fournisseur, les caches retrieval du compte concerné
 * sont invalidés (les réponses IA ne doivent jamais s'appuyer sur des données périmées).
 */
import { serverCacheDeleteByPrefix } from '@/lib/server-cache';
import { accountPrefixes } from './cache-keys';

export type BusinessEntity = 'asset' | 'document' | 'agenda' | 'supplier' | 'to_process';

/**
 * Invalide les caches d'un compte après une écriture — §31.8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'INVALIDATION ÉTAIT SYMBOLIQUE
 *
 * Seule la clé des droits était supprimée. Les entrées de récupération, qui
 * portent une empreinte de requête, restaient servies jusqu'à l'expiration du
 * délai — et l'assistant répondait sur des données périmées, ce que le §31.7
 * interdit expressément.
 *
 * Concrètement : un document ajouté n'apparaissait pas dans les réponses tant
 * que le cache n'avait pas expiré de lui-même, sans que rien ne l'explique.
 *
 * ── L'ENTITÉ N'EST PAS DISCRIMINANTE, ET C'EST VOULU ──────────────────────
 *
 * Un même cache de récupération peut contenir des biens, des documents et des
 * échéances : les clés portent une empreinte de requête, pas un type. Invalider
 * finement supposerait de savoir ce que chaque entrée contient — donc de
 * l'indexer, pour un gain nul sur un cache de quelques minutes.
 *
 * L'entité reste au contrat : elle sert au journal, et permettra un affinage
 * si le cache grandit.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function invalidateAccountRetrieval(accountId: number, entity: BusinessEntity): number {
  let supprimees = 0;
  for (const prefixe of accountPrefixes(accountId)) {
    supprimees += serverCacheDeleteByPrefix(prefixe);
  }
  if (supprimees > 0) {
    console.debug(
      `[verebona] cache invalidé — compte ${accountId}, ${entity} : ${supprimees} entrée(s).`,
    );
  }
  return supprimees;
}
