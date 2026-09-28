/**
 * Consommateurs des événements métier de l'assistant — CDC §25.7, §31.4.
 *
 *   · cache de retrieval (§43, §31.7) : à CHAQUE événement, la version
 *     d'invalidation du compte (ou la version globale pour un événement
 *     global, comme un article d'aide publié) est incrémentée EN BASE — toutes
 *     les instances cessent d'atteindre les entrées antérieures — et
 *     l'instance courante libère aussitôt ses entrées ;
 *   · réponses modèle en cache (`ai_operation_idempotency`, clés
 *     `assistant:c{fil}:…`) : purgées pour le compte quand une donnée est
 *     SUPPRIMÉE ou que les droits changent — une réponse citant un document
 *     supprimé ne doit pas être resservie (§31.4).
 *
 * Enregistrement idempotent (au démarrage, et par la fabrique des ports).
 */
import { pgClient } from '@/db';
import { DELETION_EVENTS, onBusinessEvent } from './business-events';
import { bumpRetrievalCacheVersion, clearRetrievalCache, invalidateRetrievalCacheForAccount } from '../core/retrieval-cache';
import { assistantCachePrefix } from '../core/assistant-cache-key';

/**
 * Purge les réponses modèle en cache des fils d'un compte. Rend le nombre de
 * lignes retirées.
 *
 * Préfixe CONSTANT `assistant:c` (index `text_pattern_ops`, migration 0209)
 * puis filtre exact sur le segment du fil : un `LIKE ANY(tableau)` ne peut
 * utiliser aucun index et parcourait toute la table.
 */
export async function purgeAccountModelCache(accountId: number): Promise<number> {
  const fils = (await pgClient.unsafe(
    `SELECT id FROM verebona_conversations WHERE account_id = $1`, [accountId] as never[],
  )) as unknown as Array<{ id: number }>;
  if (fils.length === 0) return 0;
  // `assistant:c12:` → segment « c12 » (deuxième champ séparé par « : »).
  const segments = fils.map((f) => assistantCachePrefix(f.id).split(':')[1]);
  const rows = (await pgClient.unsafe(
    `DELETE FROM ai_operation_idempotency
      WHERE key_hash LIKE 'assistant:c%' AND split_part(key_hash, ':', 2) = ANY($1::text[])
      RETURNING 1`,
    [segments] as never[],
  )) as unknown as unknown[];
  return rows.length;
}

/**
 * Purges en cours, par compte. La purge part en arrière-plan (la réponse
 * HTTP ne l'attend pas) ; plusieurs suppressions du même compte pendant
 * qu'elle tourne ne relancent qu'UNE purge supplémentaire, à la fin de la
 * première — les réponses mises en cache entre-temps sont ainsi couvertes.
 */
const purges = new Map<number, { promesse: Promise<void>; relancer: boolean }>();

export function schedulePurgeAccountModelCache(accountId: number): Promise<void> {
  const enCours = purges.get(accountId);
  if (enCours) {
    enCours.relancer = true;
    return enCours.promesse;
  }
  const etat = { promesse: Promise.resolve(), relancer: false };
  etat.promesse = (async () => {
    try {
      do {
        etat.relancer = false;
        await purgeAccountModelCache(accountId).catch((e) => {
          console.error(`[verebona][evenements] purge du cache modèle du compte ${accountId} en échec (non bloquant) :`, (e as Error).message);
        });
      } while (etat.relancer);
    } finally {
      purges.delete(accountId);
    }
  })();
  purges.set(accountId, etat);
  return etat.promesse;
}

/** Réservé aux tests : attend la fin des purges en arrière-plan. */
export async function flushModelCachePurgesForTests(): Promise<void> {
  while (purges.size) await Promise.all([...purges.values()].map((p) => p.promesse));
}

let enregistre = false;

export function registerAssistantBusinessEventHandlers(): void {
  if (enregistre) return;
  enregistre = true;
  onBusinessEvent('retrieval-cache', async (e) => {
    if (e.accountId == null) clearRetrievalCache();
    else invalidateRetrievalCacheForAccount(e.accountId);
    // Invalidation partagée par toutes les instances (§31.7, CA-26).
    await bumpRetrievalCacheVersion(e.accountId, e.type);
  });
  // En arrière-plan : la purge peut être lourde, elle ne retarde jamais la
  // réponse de la route qui a émis (l'incrément de version, lui, est attendu).
  onBusinessEvent('assistant-model-cache', (e) => {
    if (e.accountId != null && DELETION_EVENTS.has(e.type)) void schedulePurgeAccountModelCache(e.accountId);
  });
}

/** Réservé aux tests. */
export function resetAssistantHandlersForTests(): void {
  enregistre = false;
}
