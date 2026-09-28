/**
 * Consommateurs des événements métier de l'assistant — CDC §25.7, §31.4.
 *
 *   · cache de retrieval (§43) : invalidé pour le compte à CHAQUE événement
 *     (création, mise à jour, suppression, analyse, offre, droits) ; un
 *     événement global (article d'aide publié) vide tout ;
 *   · réponses modèle en cache (`ai_operation_idempotency`, clés
 *     `assistant:c{fil}:…`) : purgées pour le compte quand une donnée est
 *     SUPPRIMÉE ou que les droits changent — une réponse citant un document
 *     supprimé ne doit pas être resservie (§31.4).
 *
 * Enregistrement idempotent (au démarrage, et par la fabrique des ports).
 */
import { pgClient } from '@/db';
import { DELETION_EVENTS, onBusinessEvent } from './business-events';
import { clearRetrievalCache, invalidateRetrievalCacheForAccount } from '../core/retrieval-cache';
import { assistantCachePrefix } from '../core/assistant-cache-key';

/** Purge les réponses modèle en cache des fils d'un compte. Rend le nombre de lignes retirées. */
export async function purgeAccountModelCache(accountId: number): Promise<number> {
  const fils = (await pgClient.unsafe(
    `SELECT id FROM verebona_conversations WHERE account_id = $1`, [accountId] as never[],
  )) as unknown as Array<{ id: number }>;
  if (fils.length === 0) return 0;
  const motifs = fils.map((f) => `${assistantCachePrefix(f.id)}%`);
  const rows = (await pgClient.unsafe(
    `DELETE FROM ai_operation_idempotency WHERE key_hash LIKE ANY($1::text[]) RETURNING 1`,
    [motifs] as never[],
  )) as unknown[];
  return rows.length;
}

let enregistre = false;

export function registerAssistantBusinessEventHandlers(): void {
  if (enregistre) return;
  enregistre = true;
  onBusinessEvent('retrieval-cache', (e) => {
    if (e.accountId == null) clearRetrievalCache();
    else invalidateRetrievalCacheForAccount(e.accountId);
  });
  onBusinessEvent('assistant-model-cache', async (e) => {
    if (e.accountId != null && DELETION_EVENTS.has(e.type)) await purgeAccountModelCache(e.accountId);
  });
}

/** Réservé aux tests. */
export function resetAssistantHandlersForTests(): void {
  enregistre = false;
}
