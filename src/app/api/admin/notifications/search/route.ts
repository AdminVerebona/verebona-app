import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { db } from '@/db';
import { notificationOutbox, notificationDeliveries } from '@/db/schema';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

/**
 * GET /api/admin/notifications/search  (CDC §20.2)
 * Recherche d'événements par utilisateur et/ou type, avec l'état de livraison
 * agrégé par canal. Réservé aux administrateurs.
 * Query: ?userId=&type=&limit=
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const type = url.searchParams.get('type');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);

  const conditions: SQL[] = [];
  if (userId && /^\d+$/.test(userId)) conditions.push(eq(notificationOutbox.recipientUserId, Number(userId)));
  if (type) conditions.push(eq(notificationOutbox.eventType, type));

  const events = await db
    .select({
      id: notificationOutbox.id,
      eventType: notificationOutbox.eventType,
      category: notificationOutbox.category,
      recipientUserId: notificationOutbox.recipientUserId,
      status: notificationOutbox.status,
      dedupeKey: notificationOutbox.dedupeKey,
      createdAt: notificationOutbox.createdAt,
      processedAt: notificationOutbox.processedAt,
      lastError: notificationOutbox.lastError,
    })
    .from(notificationOutbox)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(notificationOutbox.createdAt))
    .limit(limit);

  // État de livraison par canal pour les événements retournés.
  const ids = events.map((e) => e.id);
  const deliveries = ids.length
    ? await db.select({
        outboxId: notificationDeliveries.outboxId,
        channel: notificationDeliveries.channel,
        status: notificationDeliveries.status,
        count: sql<number>`count(*)`,
      })
      .from(notificationDeliveries)
      .where(sql`${notificationDeliveries.outboxId} = ANY(${ids})`)
      .groupBy(notificationDeliveries.outboxId, notificationDeliveries.channel, notificationDeliveries.status)
    : [];

  const byEvent: Record<string, { channel: string; status: string; count: number }[]> = {};
  for (const d of deliveries) {
    (byEvent[d.outboxId] ??= []).push({ channel: d.channel, status: d.status, count: Number(d.count) });
  }

  return NextResponse.json({
    events: events.map((e) => ({ ...e, deliveries: byEvent[e.id] ?? [] })),
    count: events.length,
  });
}
