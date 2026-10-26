/**
 * Purge et rétention des notifications (CDC §19.3).
 *
 * Politique appliquée (valeurs par défaut, ajustables) :
 *  - payloads d'outbox détaillés : minimisés après 90 jours (contenu effacé,
 *    la ligne est conservée pour la traçabilité et la contrainte de livraison) ;
 *  - journal de livraison : supprimé après 12 mois ;
 *  - événements d'outbox : supprimés après 12 mois ;
 *  - notifications de cloche : supprimées après 12 mois ;
 *  - souscriptions push révoquées/expirées/en échec : supprimées après 30 jours.
 *
 * Ne touche jamais aux préférences (durée du compte) ni aux consentements.
 */

import { db } from '@/db';
import { sql } from 'drizzle-orm';

export interface PurgeResult {
  outboxMinimized: number;
  deliveriesDeleted: number;
  outboxDeleted: number;
  bellDeleted: number;
  subscriptionsDeleted: number;
}

async function affected(query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(query)) as unknown as unknown[];
  return Array.isArray(rows) ? rows.length : 0;
}

export async function runNotificationPurge(): Promise<PurgeResult> {
  // 1) Minimiser les payloads d'outbox de plus de 90 jours (traités).
  const outboxMinimized = await affected(sql`
    UPDATE notification_outbox
       SET payload_json = NULL, last_error = NULL
     WHERE processed_at IS NOT NULL
       AND processed_at < now() - interval '90 days'
       AND payload_json IS NOT NULL
    RETURNING id;
  `);

  // 2) Supprimer les livraisons de plus de 12 mois.
  const deliveriesDeleted = await affected(sql`
    DELETE FROM notification_deliveries
     WHERE created_at < now() - interval '12 months'
    RETURNING id;
  `);

  // 3) Supprimer les événements d'outbox de plus de 12 mois (livraisons déjà purgées).
  const outboxDeleted = await affected(sql`
    DELETE FROM notification_outbox
     WHERE created_at < now() - interval '12 months'
    RETURNING id;
  `);

  // 4) Supprimer les notifications de cloche de plus de 12 mois.
  const bellDeleted = await affected(sql`
    DELETE FROM notifications
     WHERE created_at < now() - interval '12 months'
    RETURNING id;
  `);

  // 5) Nettoyer les souscriptions push inactives depuis plus de 30 jours.
  const subscriptionsDeleted = await affected(sql`
    DELETE FROM push_subscriptions
     WHERE status IN ('revoked', 'expired', 'failed')
       AND updated_at < now() - interval '30 days'
    RETURNING id;
  `);

  return { outboxMinimized, deliveriesDeleted, outboxDeleted, bellDeleted, subscriptionsDeleted };
}
