/**
 * Métriques de santé des notifications (CDC §20.1).
 *
 * Agrégats pour l'écran d'administration, sans exposer de contenu sensible ni
 * de clés push : volumétrie par type, livraisons par canal, taux de succès,
 * erreurs push par code, emails en échec, abonnements actifs, longueur de
 * l'outbox et événements bloqués.
 */

import { db } from '@/db';
import { sql } from 'drizzle-orm';

const n = (v: unknown) => Number(v ?? 0);

export interface NotificationHealth {
  windowDays: number;
  eventsByType: { eventType: string; count: number }[];
  deliveriesByChannel: { channel: string; status: string; count: number }[];
  successRate: number | null;
  pushErrorsByCode: { code: string | null; count: number }[];
  failedEmails: number;
  activeSubscriptions: number;
  outboxPending: number;
  stuckEvents: number;
  generatedAt: string;
}

export async function getNotificationHealth(windowDays = 30): Promise<NotificationHealth> {
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Record<string, unknown>[];

  const [byType, byChannel, pushErrors, deliveryTotals, subs, pending, stuck] = await Promise.all([
    rows(sql`SELECT event_type, count(*) AS c FROM notification_outbox
             WHERE created_at > now() - (${windowDays} || ' days')::interval
             GROUP BY event_type ORDER BY c DESC`),
    rows(sql`SELECT channel, status, count(*) AS c FROM notification_deliveries
             WHERE created_at > now() - (${windowDays} || ' days')::interval
             GROUP BY channel, status ORDER BY channel, status`),
    rows(sql`SELECT last_error_code AS code, count(*) AS c FROM notification_deliveries
             WHERE channel = 'push' AND status = 'failed'
               AND created_at > now() - (${windowDays} || ' days')::interval
             GROUP BY last_error_code ORDER BY c DESC`),
    rows(sql`SELECT
               count(*) FILTER (WHERE status = 'sent') AS sent,
               count(*) FILTER (WHERE status IN ('sent','failed')) AS attempted,
               count(*) FILTER (WHERE channel = 'email' AND status = 'failed') AS failed_emails
             FROM notification_deliveries
             WHERE created_at > now() - (${windowDays} || ' days')::interval`),
    rows(sql`SELECT count(*) AS c FROM push_subscriptions WHERE status = 'active'`),
    rows(sql`SELECT count(*) AS c FROM notification_outbox WHERE status = 'pending'`),
    rows(sql`SELECT count(*) AS c FROM notification_outbox
             WHERE status IN ('pending','processing') AND created_at < now() - interval '1 hour'`),
  ]);

  const sent = n(deliveryTotals[0]?.sent);
  const attempted = n(deliveryTotals[0]?.attempted);

  return {
    windowDays,
    eventsByType: byType.map((r) => ({ eventType: String(r.event_type), count: n(r.c) })),
    deliveriesByChannel: byChannel.map((r) => ({ channel: String(r.channel), status: String(r.status), count: n(r.c) })),
    successRate: attempted > 0 ? Math.round((sent / attempted) * 1000) / 10 : null,
    pushErrorsByCode: pushErrors.map((r) => ({ code: r.code ? String(r.code) : null, count: n(r.c) })),
    failedEmails: n(deliveryTotals[0]?.failed_emails),
    activeSubscriptions: n(subs[0]?.c),
    outboxPending: n(pending[0]?.c),
    stuckEvents: n(stuck[0]?.c),
    generatedAt: new Date().toISOString(),
  };
}
