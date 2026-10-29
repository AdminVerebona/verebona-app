/**
 * Purge et rétention des notifications (CDC §19.3).
 *
 * Politique appliquée (valeurs par défaut, ajustables) :
 *  - payloads d'outbox détaillés : minimisés après 90 jours (contenu effacé,
 *    la ligne est conservée pour la traçabilité et la contrainte de livraison) ;
 *  - journal de livraison : supprimé après 12 mois ;
 *  - événements d'outbox : supprimés après 12 mois ;
 *  - notifications de cloche : supprimées après 12 mois ;
 *  - abonnements Web Push (table dormante depuis le lot 94, décision PO M3) :
 *    les lignes encore « actives » sont révoquées (plus aucun envoi possible),
 *    puis supprimées 30 jours après leur révocation / expiration / échec ;
 *  - lot 97 — installations de l'application mobile : non revues depuis
 *    MOBILE_PUSH_STALE_DAYS (180 j) → révoquées (jeton vidé, PUSH-09) ;
 *    inactives depuis plus de 90 jours → supprimées.
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
  /** Lot 94 (M3) : anciens abonnements Web Push encore « actifs » révoqués. */
  webPushSubscriptionsRevoked?: number;
  /** Lot 97 : installations mobiles révoquées pour inactivité / supprimées. */
  mobileInstallationsStaled?: number;
  mobileInstallationsDeleted?: number;
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

  // 5) Web Push supprimé (lot 94, décision PO M3) : un ancien abonnement
  //    navigateur ne doit plus figurer « actif » — révoqué ici (aucun appel
  //    au navigateur), supprimé par l'étape suivante 30 jours plus tard.
  const webPushSubscriptionsRevoked = await affected(sql`
    UPDATE push_subscriptions
       SET status = 'revoked', updated_at = now()
     WHERE status = 'active'
    RETURNING id;
  `);

  // 5 bis) Nettoyer les souscriptions push inactives depuis plus de 30 jours.
  const subscriptionsDeleted = await affected(sql`
    DELETE FROM push_subscriptions
     WHERE status IN ('revoked', 'expired', 'failed')
       AND updated_at < now() - interval '30 days'
    RETURNING id;
  `);

  // 6) Lot 97 : installations mobiles (table 0814 ; absente → ignorée).
  let mobile = { staled: 0, deleted: 0 };
  try {
    const { purgeMobileInstallations } = await import('@/lib/mobile/push-installations');
    mobile = await purgeMobileInstallations();
  } catch (e) {
    if ((e as { code?: string }).code !== '42P01') console.error('[notifications/purge] installations mobiles :', (e as Error).message);
  }

  return {
    outboxMinimized, deliveriesDeleted, outboxDeleted, bellDeleted, subscriptionsDeleted, webPushSubscriptionsRevoked,
    mobileInstallationsStaled: mobile.staled, mobileInstallationsDeleted: mobile.deleted,
  };
}
