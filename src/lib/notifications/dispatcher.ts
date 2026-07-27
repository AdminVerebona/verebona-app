/**
 * NotificationDispatcher (CDC §11.1 / §11.3 / §18).
 *
 * Réclame les événements dus dans l'outbox, résout les canaux (préférences +
 * obligatoire), rend le contenu, crée une livraison par canal (et par appareil
 * pour le push) puis envoie. Journalise chaque tentative dans
 * `notification_deliveries` et agrège le statut de l'outbox :
 *   - tout envoyé/ignoré sans échec → `sent` ;
 *   - au moins un canal en échec avec un autre réussi → `partial` ;
 *   - tous les canaux en échec → `failed`.
 *
 * Le traitement d'un événement en échec n'interrompt pas les autres (§13.4).
 */

import { db } from '@/db';
import { notificationDeliveries } from '@/db/schema';
import { getCatalogEntry } from './catalog';
import { renderContent } from './content-renderer';
import { resolveChannels } from './policy-resolver';
import { deliverBell, deliverEmail, deliverWebPush, type DeliveryOutcome, type DeliveryContext } from './channels';
import { claimByIds, claimPending, markProcessed, releaseOrFail, type OutboxRow } from './outbox';

export interface DispatchSummary {
  claimed: number;
  sent: number;
  partial: number;
  failed: number;
  skipped: number;
}

async function recordDelivery(
  outboxId: string, userId: number, channel: 'bell' | 'push' | 'email', outcome: DeliveryOutcome,
  pushSubscriptionId?: string,
): Promise<void> {
  const now = new Date();
  const terminal = outcome.status === 'sent';
  await db.insert(notificationDeliveries).values({
    outboxId,
    userId,
    channel,
    pushSubscriptionId: pushSubscriptionId ?? null,
    status: outcome.status,
    providerMessageId: outcome.providerMessageId ?? null,
    lastErrorCode: outcome.errorCode ?? null,
    lastErrorMessage: outcome.errorMessage ? outcome.errorMessage.slice(0, 500) : null,
    attemptCount: 1,
    attemptedAt: now,
    sentAt: terminal ? now : null,
    createdAt: now,
  });
}

async function processRow(row: OutboxRow): Promise<'sent' | 'partial' | 'failed' | 'skipped'> {
  const entry = getCatalogEntry(row.event_type);
  if (!entry) {
    // Type hors catalogue : ne devrait pas arriver (emit valide). On échoue proprement.
    await releaseOrFail(row.id, row.attempt_count ?? 0, `unknown_event_type:${row.event_type}`);
    return 'failed';
  }

  const payload = row.payload_json ?? {};
  const channels = await resolveChannels(row.recipient_user_id, entry);
  const rendered = renderContent(entry, payload, row.deep_link);

  const ctx: DeliveryContext = {
    outboxId: row.id,
    userId: row.recipient_user_id,
    eventType: row.event_type,
    category: row.category ?? entry.category,
    payload,
    dedupeKey: row.dedupe_key,
    mustDeliverBell: !!row.mandatory_bell || entry.mandatoryBell,
  };

  const outcomes: DeliveryOutcome['status'][] = [];

  let bellNotificationId: number | undefined;
  if (channels.bell) {
    const o = await deliverBell(ctx, entry, rendered);
    bellNotificationId = o.notificationId;
    await recordDelivery(row.id, ctx.userId, 'bell', o);
    outcomes.push(o.status);
  }
  if (channels.email) {
    const o = await deliverEmail(ctx, entry, rendered);
    await recordDelivery(row.id, ctx.userId, 'email', o);
    outcomes.push(o.status);
  }
  if (channels.push) {
    // Une livraison par appareil (§12.4). Aucun appareil → une ligne skipped.
    const pushResults = await deliverWebPush(ctx, rendered, bellNotificationId);
    if (pushResults.length === 0) {
      await recordDelivery(row.id, ctx.userId, 'push', { status: 'skipped_unavailable', errorCode: 'no_active_subscription' });
      outcomes.push('skipped_unavailable');
    } else {
      for (const r of pushResults) {
        await recordDelivery(row.id, ctx.userId, 'push', r.outcome, r.subscriptionId);
        outcomes.push(r.outcome.status);
      }
    }
  }

  // Agrégation : un « skipped_* » n'est pas un échec (§18.4).
  const anySent = outcomes.includes('sent');
  const anyFailed = outcomes.includes('failed');
  const finalStatus: 'sent' | 'partial' | 'failed' =
    anyFailed && anySent ? 'partial'
    : anyFailed && !anySent ? 'failed'
    : 'sent';

  await markProcessed(row.id, finalStatus);
  return outcomes.length === 0 ? 'skipped' : finalStatus;
}

async function processRows(rows: OutboxRow[]): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: rows.length, sent: 0, partial: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    try {
      const r = await processRow(row);
      summary[r] += 1;
    } catch (err) {
      // Ne pas interrompre les autres événements.
      await releaseOrFail(row.id, row.attempt_count ?? 0, (err as Error).message).catch(() => {});
      summary.failed += 1;
    }
  }
  return summary;
}

/** Traite un lot d'événements dus (appelé par le cron `/api/cron/notifications/dispatch`). */
export async function processPending(limit = 50): Promise<DispatchSummary> {
  const rows = await claimPending(limit);
  return processRows(rows);
}

/** Traitement immédiat (best-effort) d'événements précis après enqueue (§11.3). */
export async function processOutboxIds(ids: string[]): Promise<DispatchSummary> {
  const rows = await claimByIds(ids);
  return processRows(rows);
}
