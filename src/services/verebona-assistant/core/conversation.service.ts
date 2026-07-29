/**
 * Persistance conversationnelle & historique — CDC §24 / §28.
 *
 * Gère la conversation active (1 par compte — §28.1), les messages, l'idempotence
 * (réutilise `client_request_id`), l'historique 7 jours au niveau COMPTE (partagé Duo,
 * auteur conservé — §24.3) et l'effacement manuel (§24.5).
 *
 * Utilise les tables verebona_* (voir migration 0100). Câblé sur `@/db` (postgres.js).
 */
import { pgClient } from '@/db';
import type { AssistantRunResult, AssistantRequestInput } from '../types/contracts';
import { getAssistantConfig } from '../config/assistant-config';

/** Récupère (ou crée) la conversation active du compte. */
export async function getOrCreateActiveConversation(accountId: number, locale: string): Promise<number> {
  const cfg = getAssistantConfig();
  const expires = new Date(Date.now() + cfg.historyDays * 86400_000).toISOString();
  const rows = await pgClient.unsafe(
    `INSERT INTO verebona_conversations (account_id, status, machine_state, locale, expires_at)
       VALUES ($1, 'active', 'IDLE', $2, $3)
       ON CONFLICT (account_id) WHERE status = 'active'
       DO UPDATE SET updated_at = now()
       RETURNING id`,
    [accountId, locale, expires],
  );
  return (rows as unknown as Array<{ id: number }>)[0].id;
}

/** Idempotence : renvoie le message existant si `client_request_id` déjà vu (§31.9). */
export async function findByClientRequestId(accountId: number, clientRequestId: string): Promise<number | null> {
  const rows = await pgClient.unsafe(
    `SELECT id FROM verebona_messages WHERE account_id = $1 AND client_request_id = $2 LIMIT 1`,
    [accountId, clientRequestId],
  );
  const list = rows as unknown as Array<{ id: number }>;
  return list.length ? list[0].id : null;
}

/** Persiste le résultat complet (message + claims + sources + actions). */
export async function persistResult(result: AssistantRunResult, input: AssistantRequestInput): Promise<void> {
  // TODO(CDC §28) : insérer verebona_messages (user + assistant), verebona_message_claims,
  // verebona_message_sources, verebona_claim_sources, verebona_message_actions,
  // verebona_request_runs — dans une transaction. Squelette :
  //
  //   await db.transaction(async (tx) => { ... });
  //
  console.debug('[verebona] persistResult (stub)', result.requestId, input.accountId);
}

/** Effacement manuel de l'historique du compte (§24.5). */
export async function clearAccountHistory(accountId: number): Promise<void> {
  await pgClient.unsafe(
    `UPDATE verebona_conversations SET status = 'deleted' WHERE account_id = $1 AND status = 'active'`,
    [accountId],
  );
}

/** Purge quotidienne des conversations expirées (> 7 j) — appelée par cleanup-job (§28.13). */
export async function purgeExpired(): Promise<number> {
  const rows = await pgClient.unsafe(
    `DELETE FROM verebona_conversations WHERE expires_at < now() RETURNING id`,
  );
  return (rows as unknown as Array<{ id: number }>).length;
}
