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
import { and, eq, inArray, sql } from 'drizzle-orm';
import { autoResolveNotificationChannels, reportNotificationFailure } from '@/services/admin/anomaly.service';

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

/**
 * Statut terminal d'un événement traité (lot 81E) :
 *   · sent    — au moins un canal a ENVOYÉ (accepté par le canal), aucun échec ;
 *   · partial — au moins un canal envoyé ET au moins un canal en échec ;
 *   · failed  — au moins un canal en échec, aucun envoyé ;
 *   · skipped — aucun canal n'a envoyé, sans échec : canal supprimé ou
 *               désactivé, sans destinataire, sans appareil, préférence…
 *               (`outcome_reason` porte la cause). Jamais « envoyé », jamais
 *               une anomalie technique.
 */
type OutboxFinalStatus = 'sent' | 'partial' | 'failed' | 'skipped';

export async function markProcessed(id: string, status: OutboxFinalStatus, opts: { reason?: string | null } = {}): Promise<void> {
  await db.update(notificationOutbox)
    .set({
      status, processedAt: new Date(), attemptCount: sql`${notificationOutbox.attemptCount} + 1`,
      outcomeReason: opts.reason ? opts.reason.slice(0, 200) : null,
    })
    .where(eq(notificationOutbox.id, id));
  // Supervision (CDC BO SUP-008/009) : un canal en échec au traitement est un
  // échec final (pas de relance par canal) ; un canal délivré résout l'anomalie.
  // Lot 81E : un événement volontairement ignoré n'est pas un incident technique.
  if (status === 'sent' || status === 'partial') await autoResolveNotificationChannels(id);
  if (status === 'failed' || status === 'partial') await reportNotificationFailure(id);
}

/**
 * Lot 81E — événement regroupé avec l'incident porté par `carrierId` : statut
 * `grouped`, référence conservée (jamais compté envoyé, jamais une anomalie).
 */
export async function markGrouped(id: string, carrierId: string): Promise<void> {
  await db.update(notificationOutbox)
    .set({
      status: 'grouped', processedAt: new Date(), groupedWithId: carrierId, outcomeReason: 'grouped_incident',
      lastError: `grouped_with:${carrierId}`, attemptCount: sql`${notificationOutbox.attemptCount} + 1`,
    })
    .where(eq(notificationOutbox.id, id));
}

/**
 * Lot 81E — l'événement qui portait un incident n'a été envoyé par AUCUN canal
 * (échec, ignoré) : les événements regroupés avec lui sont remis en file — une
 * information n'est jamais supprimée au profit d'une communication qui n'est
 * pas partie. À leur traitement, le porteur en échec ne les absorbe plus.
 */
export async function reopenGroupedBy(carrierId: string): Promise<string[]> {
  const rows = await db.update(notificationOutbox)
    .set({ status: 'pending', groupedWithId: null, outcomeReason: 'carrier_not_sent', processedAt: null, scheduledFor: null })
    .where(and(eq(notificationOutbox.groupedWithId, carrierId), eq(notificationOutbox.status, 'grouped')))
    .returning({ id: notificationOutbox.id });
  return rows.map((r: { id: string }) => r.id);
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
  // Retries épuisés : échec définitif, anomalie de supervision (SUP-009).
  if (failed) await reportNotificationFailure(id);
}
