/**
 * NotificationOutboxService (CDC §11.1 / §12.3 / §11.3).
 *
 * File persistante des événements métier. Garantit :
 *  - la déduplication via `dedupe_key` unique (§4.4) — une relance technique ne
 *    crée jamais un second fait utilisateur ;
 *  - une réclamation atomique par le dispatcher via `FOR UPDATE SKIP LOCKED`
 *    afin que deux workers/appels cron n'envoient pas la même notification.
 *
 * Motif « transactional outbox » : l'enqueue peut se faire dans la transaction
 * du producteur (passer `dbh = tx`) pour être atomique avec le fait métier.
 */

import { db } from '@/db';
import { notificationOutbox } from '@/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';

// db et une transaction Drizzle partagent la même API de requête.
export type DbHandle = typeof db | any;

export type NewOutboxRow = typeof notificationOutbox.$inferInsert;
export type OutboxRow = Record<string, any>;

/** Insère les événements ; ignore silencieusement les doublons (dedupe_key).
 *  Retourne les ids réellement insérés (hors doublons). */
export async function enqueue(rows: NewOutboxRow[], dbh: DbHandle = db): Promise<string[]> {
  if (rows.length === 0) return [];
  const inserted = await dbh.insert(notificationOutbox).values(rows)
    .onConflictDoNothing({ target: notificationOutbox.dedupeKey })
    .returning({ id: notificationOutbox.id });
  return inserted.map((r: { id: string }) => r.id);
}

/**
 * Réclame jusqu'à `limit` événements dus et non terminés, en les passant à
 * `processing` de façon atomique (verrou ligne + SKIP LOCKED). Concurrence-safe.
 */
export async function claimPending(limit: number): Promise<OutboxRow[]> {
  const result = await db.execute(sql`
    UPDATE notification_outbox SET status = 'processing'
    WHERE id IN (
      SELECT id FROM notification_outbox
      WHERE status = 'pending'
        AND (scheduled_for IS NULL OR scheduled_for <= now())
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `);
  return result as unknown as OutboxRow[];
}

/** Réclame des événements précis par id (traitement immédiat post-enqueue). */
export async function claimByIds(ids: string[]): Promise<OutboxRow[]> {
  if (ids.length === 0) return [];
  // NB : on passe par `inArray` (paramètres liés individuellement) plutôt qu'un
  // littéral `ANY($1::uuid[])`, que le driver postgres-js sérialise mal.
  const result = await db.execute(sql`
    UPDATE notification_outbox SET status = 'processing'
    WHERE id IN (
      SELECT id FROM notification_outbox
      WHERE ${inArray(notificationOutbox.id, ids)} AND status = 'pending'
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `);
  return result as unknown as OutboxRow[];
}

export type OutboxFinalStatus = 'sent' | 'partial' | 'failed';

export async function markProcessed(id: string, status: OutboxFinalStatus): Promise<void> {
  await db.update(notificationOutbox)
    .set({ status, processedAt: new Date(), attemptCount: sql`${notificationOutbox.attemptCount} + 1` })
    .where(eq(notificationOutbox.id, id));
}

/** Remet un événement en file (échec technique retryable) ou le marque failed. */
export async function releaseOrFail(id: string, currentAttempt: number, error: string, maxAttempts = 5): Promise<void> {
  const nextAttempt = currentAttempt + 1;
  const failed = nextAttempt >= maxAttempts;
  await db.update(notificationOutbox)
    .set({
      status: failed ? 'failed' : 'pending',
      attemptCount: nextAttempt,
      lastError: error.slice(0, 500),
      ...(failed ? { processedAt: new Date() } : {}),
    })
    .where(eq(notificationOutbox.id, id));
}

/** Utilisé par la purge (Lot 6) et les tests. */
export async function cancelByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.update(notificationOutbox)
    .set({ status: 'cancelled', processedAt: new Date() })
    .where(inArray(notificationOutbox.id, ids));
}
