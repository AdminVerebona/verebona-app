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
 * Lot 72D (décision PO Q15) — audience « titulaire seulement ».
 *
 * Essai, renouvellement, facturation, impayé et parrainage concernent le
 * TITULAIRE contractuel du compte : un membre (invité Premium Duo) ne les
 * reçoit pas — il ne recevait « fin d'essai » qu'à cause du compte personnel
 * artificiel, et recevrait sinon les relances de paiement du titulaire. Les
 * notifications MÉTIER (échéances, documents, quotas) restent adressées à
 * tous les membres. Un compte ARCHIVÉ (rattrapage duo-shared-account) n'émet
 * plus aucune notification d'essai ni de facturation (Q9).
 */
const OWNER_ONLY_PREFIXES = ['TRIAL_', 'SUBSCRIPTION_', 'PAYMENT_', 'REFERRAL_', 'BILLING_', 'UNPAID_'];

export function isOwnerOnlyNotification(type: string | null | undefined): boolean {
  const t = String(type ?? '').toUpperCase();
  return OWNER_ONLY_PREFIXES.some((p) => t.startsWith(p));
}

/** Titulaire(s) actif(s) d'un compte ; [] si le compte est archivé. */
async function resolveAccountOwners(accountId: number): Promise<number[]> {
  const [account] = await db
    .select({ ownerUserId: accounts.ownerUserId, archivedAt: accounts.archivedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account || account.archivedAt) return [];
  const owners = await db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(and(
      eq(accountMemberships.accountId, accountId),
      eq(accountMemberships.status, 'active'),
      eq(accountMemberships.role, 'owner'),
    ));
  const ids = new Set<number>();
  for (const m of owners) if (m.userId) ids.add(m.userId);
  // Compte historique sans ligne d'adhésion titulaire.
  if (ids.size === 0 && account.ownerUserId) ids.add(account.ownerUserId);
  return Array.from(ids);
}

/**
 * Résout les destinataires d'un événement.
 * - `recipientUserIds` explicites → utilisés tels quels.
 * - sinon, si `accountId` fourni → tous les membres actifs du compte, ou son
 *   seul titulaire pour un type « titulaire seulement » (lot 72D).
 */
export async function resolveRecipients(input: {
  recipientUserIds?: number[];
  accountId?: number | null;
  type?: string;
}): Promise<number[]> {
  if (input.recipientUserIds && input.recipientUserIds.length > 0) {
    return Array.from(new Set(input.recipientUserIds));
  }
  if (input.accountId) {
    if (isOwnerOnlyNotification(input.type)) return resolveAccountOwners(input.accountId);
    return resolveActiveAccountMembers(input.accountId);
  }
  return [];
}
