/**
 * Invalidation de cache par événement métier — CDC §31.7 / §31.8.
 *
 * Réutilise le cache serveur existant (`@/lib/server-cache`). À l'ajout/modif/suppression
 * d'un bien, document, échéance ou fournisseur, les caches retrieval du compte concerné
 * sont invalidés (les réponses IA ne doivent jamais s'appuyer sur des données périmées).
 */
import { serverCacheDelete } from '@/lib/server-cache';
import { cacheKeys } from './cache-keys';

export type BusinessEntity = 'asset' | 'document' | 'agenda' | 'supplier' | 'to_process';

/**
 * À appeler depuis les services métier existants après une écriture (§31.8).
 * TODO(CDC §31.8) : le cache mémoire actuel n'expose pas de suppression par motif ;
 * prévoir un index des clés par compte, ou une purge ciblée, selon l'implémentation retenue.
 */
export function invalidateAccountRetrieval(accountId: number, _entity: BusinessEntity): void {
  // Invalidation ciblée minimale (les clés précises sont reconstruites par les lecteurs).
  serverCacheDelete(cacheKeys.entitlements(accountId));
  // Les clés retrieval intègrent un hash de requête : elles expireront via TTL (§31.5).
}
