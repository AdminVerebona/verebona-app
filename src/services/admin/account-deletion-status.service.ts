/**
 * Suppression en cours d'un compte, pour la fiche Compte du back-office —
 * CDC Back-Office V1 §5.2.1 (« Nom et statut du compte »), ACC-L01.
 *
 * Même règle que la liste des comptes (`app/api/admin/accounts/route.ts`) :
 * un compte est « en suppression » s'il a un compte à rebours SCHEDULED de
 * portée `account` (rétractation, impayé, back-office, essai abandonné), ou
 * de portée `user` demandé par son TITULAIRE (suppression volontaire, 30
 * jours). Un second utilisateur qui supprime son propre compte n'emporte pas
 * l'espace partagé : sa demande n'est pas reprise ici.
 *
 * Lecture seule : le back-office ne peut ni annuler ni modifier une
 * suppression (GDP-008, REC-GDP-05).
 */
import { and, asc, eq, or } from 'drizzle-orm';
import { db } from '@/db';
import { scheduledAccountDeletions } from '@/db/schema';

export interface AccountPendingDeletion {
  /** Date prévue de la suppression effective. */
  scheduledAt: Date;
  /** WITHDRAWAL | VOLUNTARY | TRIAL_ABANDONED | ADMIN | UNPAID. */
  reason: string;
  /** user | system | admin. */
  origin: string;
}

export async function loadAccountPendingDeletion(
  accountId: number,
  ownerUserId: number | null,
): Promise<AccountPendingDeletion | null> {
  const scopeRule = ownerUserId === null
    ? eq(scheduledAccountDeletions.scope, 'account')
    : or(
        eq(scheduledAccountDeletions.scope, 'account'),
        eq(scheduledAccountDeletions.userId, ownerUserId),
      );
  const [row] = await db
    .select({
      scheduledAt: scheduledAccountDeletions.scheduledAt,
      reason: scheduledAccountDeletions.reason,
      origin: scheduledAccountDeletions.origin,
    })
    .from(scheduledAccountDeletions)
    .where(and(
      eq(scheduledAccountDeletions.accountId, accountId),
      eq(scheduledAccountDeletions.status, 'SCHEDULED'),
      scopeRule,
    ))
    // Plusieurs comptes à rebours : la suppression la plus proche l'emporte.
    .orderBy(asc(scheduledAccountDeletions.scheduledAt))
    .limit(1);
  return row ?? null;
}
