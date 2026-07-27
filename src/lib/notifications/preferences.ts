/**
 * PreferencesService (CDC §12.1) — préférences par utilisateur.
 *
 * Les préférences sont TOUJOURS au niveau `user_id`, jamais du compte partagé
 * (§8.3). Une ligne n'existe que si l'utilisateur a modifié un réglage ; sinon
 * la valeur par défaut est lue dans le catalogue. L'API renverra la matrice
 * complète fusionnée (Lot 3).
 */

import { db } from '@/db';
import { notificationPreferences } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import type { NotificationCategory, NotificationChannel, DeliveryMode } from './catalog';

export type ConfigurableChannel = Extract<NotificationChannel, 'push' | 'email'>;

/**
 * Retourne l'état d'une préférence configurable, ou `null` si l'utilisateur
 * n'a jamais modifié ce réglage (auquel cas le défaut du catalogue s'applique).
 */
export async function getPreference(
  userId: number,
  category: NotificationCategory,
  deliveryMode: DeliveryMode,
  channel: ConfigurableChannel,
): Promise<boolean | null> {
  const [row] = await db
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(and(
      eq(notificationPreferences.userId, userId),
      eq(notificationPreferences.category, category),
      eq(notificationPreferences.deliveryMode, deliveryMode),
      eq(notificationPreferences.channel, channel),
    ))
    .limit(1);
  return row ? row.enabled : null;
}
