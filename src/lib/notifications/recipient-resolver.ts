/**
 * NotificationRecipientResolver (CDC §11.1).
 *
 * Identifie les utilisateurs concernés à partir du compte, de l'auteur et du
 * type d'événement. Les producteurs qui connaissent déjà le destinataire
 * (validateur d'une demande Duo, importeur d'un lot…) passent `recipientUserIds`
 * directement à `emit()` ; ce resolver sert aux événements « tous les membres
 * actifs du compte » (échéances, quota…).
 */

import { db } from '@/db';
import { accounts, accountMemberships } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

/** Tous les membres actifs d'un compte (propriétaire + memberships actifs). */
export async function resolveActiveAccountMembers(accountId: number): Promise<number[]> {
  const [account] = await db
    .select({ ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  const members = await db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(and(
      eq(accountMemberships.accountId, accountId),
      eq(accountMemberships.status, 'active'),
    ));

  const ids = new Set<number>();
  if (account?.ownerUserId) ids.add(account.ownerUserId);
  for (const m of members) if (m.userId) ids.add(m.userId);
  return Array.from(ids);
}

/**
 * Résout les destinataires d'un événement.
 * - `recipientUserIds` explicites → utilisés tels quels.
 * - sinon, si `accountId` fourni → tous les membres actifs du compte.
 */
export async function resolveRecipients(input: {
  recipientUserIds?: number[];
  accountId?: number | null;
}): Promise<number[]> {
  if (input.recipientUserIds && input.recipientUserIds.length > 0) {
    return Array.from(new Set(input.recipientUserIds));
  }
  if (input.accountId) {
    return resolveActiveAccountMembers(input.accountId);
  }
  return [];
}
