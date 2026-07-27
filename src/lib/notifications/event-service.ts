/**
 * NotificationEventService (CDC §11.1 / §11.2 / §4.1).
 *
 * Point d'entrée unique des événements métier. Un service métier n'insère plus
 * jamais directement une cloche/un email/un push : il appelle `emit()`.
 *
 * emit() :
 *   1. résout l'entrée de catalogue (type impossible → erreur) ;
 *   2. valide le payload (Zod, §16) ;
 *   3. identifie les destinataires (explicites ou membres actifs du compte) ;
 *   4. calcule le lien profond et les drapeaux obligatoires depuis le catalogue ;
 *   5. crée UNE ligne d'outbox par destinataire (dedupe_key par utilisateur) ;
 *   6. déclenche un traitement immédiat best-effort hors transaction (§11.3),
 *      la reprise étant toujours assurée par le cron dispatcher.
 *
 * Motif transactional outbox : passer `tx` pour enqueuer dans la transaction du
 * fait métier (atomicité). Dans ce cas, la livraison est faite par le cron.
 */

import { getCatalogEntry } from './catalog';
import { resolveRecipients } from './recipient-resolver';
import { enqueue, type NewOutboxRow, type DbHandle } from './outbox';
import { processOutboxIds } from './dispatcher';
import type { NotificationType, NotificationPayloadFor } from '@/types/notifications';

export interface EmitInput<T extends NotificationType> {
  type: T;
  /** Payload typé par type d'événement (détection à la compilation, §16). */
  payload: NotificationPayloadFor<T>;
  /** Destinataires explicites ; sinon dérivés de `accountId`. */
  recipientUserIds?: number[];
  accountId?: number | null;
  actorUserId?: number | null;
  entityType?: string | null;
  entityId?: string | number | null;
  /** Clé métier stable et déterministe SANS l'utilisateur (§4.4).
   *  emit() ajoute `:u{userId}` par destinataire. */
  dedupeKey: string;
  /** Pour les notifications planifiées (J-7, récap 8 h 30) — Lot 4. */
  scheduledFor?: Date;
  /** Transaction Drizzle du producteur (enqueue atomique). */
  tx?: DbHandle;
}

export async function emit<T extends NotificationType>(input: EmitInput<T>): Promise<void> {
  const entry = getCatalogEntry(input.type);
  if (!entry) {
    throw new Error(`[notifications] Type hors catalogue: ${input.type}`);
  }

  // Validation du payload à l'exécution (§16). Un payload incomplet est refusé.
  const parsed = entry.payloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    throw new Error(`[notifications] Payload invalide pour ${input.type}: ${parsed.error.message}`);
  }
  const payload = parsed.data as Record<string, unknown>;

  const recipients = await resolveRecipients({
    recipientUserIds: input.recipientUserIds,
    accountId: input.accountId ?? undefined,
  });
  if (recipients.length === 0) return;

  const deepLink = safeDeepLink(entry, payload);

  const rows: NewOutboxRow[] = recipients.map((userId) => ({
    eventType: input.type,
    category: entry.category,
    accountId: input.accountId ?? null,
    recipientUserId: userId,
    actorUserId: input.actorUserId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId != null ? String(input.entityId) : null,
    payloadJson: payload,
    deepLink,
    priority: entry.priority,
    mandatoryBell: entry.mandatoryBell,
    mandatoryEmail: entry.mandatoryEmail,
    dedupeKey: `${input.dedupeKey}:u${userId}`,
    scheduledFor: input.scheduledFor ?? null,
    status: 'pending',
  }));

  const insertedIds = await enqueue(rows, input.tx ?? undefined);

  // Traitement immédiat uniquement hors transaction externe (les lignes d'une
  // transaction non validée ne sont pas visibles du dispatcher). Sinon, le cron
  // prend le relais. Best-effort : une erreur ici ne remonte pas au producteur.
  if (!input.tx && !input.scheduledFor && insertedIds.length > 0) {
    processOutboxIds(insertedIds).catch((err) => {
      console.error('[notifications] traitement immédiat échoué (repris par le cron):', err);
    });
  }
}

function safeDeepLink(entry: ReturnType<typeof getCatalogEntry>, payload: unknown): string | null {
  try {
    return entry!.deepLink(payload);
  } catch {
    return null;
  }
}
