/**
 * Suppression des données de notification d'un utilisateur (CDC §19.4 RGPD).
 *
 * La suppression de compte est un « soft-delete » avec anonymisation : les
 * cascades FK ne se déclenchent donc pas. Cette fonction supprime explicitement
 * les préférences, souscriptions push, notifications internes, journaux de
 * livraison, événements d'outbox rattachés à l'utilisateur et son consentement
 * actualités.
 */

import { db } from '@/db';
import {
  notificationPreferences, pushSubscriptions, notifications,
  notificationDeliveries, notificationOutbox, newsConsents,
} from '@/db/schema';
import { eq } from 'drizzle-orm';

export interface UserNotificationPurgeResult {
  preferences: number;
  subscriptions: number;
  bell: number;
  deliveries: number;
  outbox: number;
  newsConsent: number;
}

export async function deleteUserNotificationData(userId: number): Promise<UserNotificationPurgeResult> {
  const count = (r: unknown[]) => (Array.isArray(r) ? r.length : 0);

  // Livraisons d'abord (référencent l'outbox et l'utilisateur).
  const deliveries = count(await db.delete(notificationDeliveries)
    .where(eq(notificationDeliveries.userId, userId)).returning({ id: notificationDeliveries.id }));

  // Événements d'outbox propres à cet utilisateur (un enregistrement par destinataire).
  const outbox = count(await db.delete(notificationOutbox)
    .where(eq(notificationOutbox.recipientUserId, userId)).returning({ id: notificationOutbox.id }));

  const bell = count(await db.delete(notifications)
    .where(eq(notifications.userId, userId)).returning({ id: notifications.id }));

  const subscriptions = count(await db.delete(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId)).returning({ id: pushSubscriptions.id }));

  const preferences = count(await db.delete(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId)).returning({ id: notificationPreferences.id }));

  const newsConsent = count(await db.delete(newsConsents)
    .where(eq(newsConsents.userId, userId)).returning({ id: newsConsents.id }));

  return { preferences, subscriptions, bell, deliveries, outbox, newsConsent };
}
