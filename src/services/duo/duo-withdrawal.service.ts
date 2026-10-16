/**
 * Premium Duo — rétractation (14 jours) du titulaire : FERMETURE DU DUO.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISION PO DU 16/10/2026 (lot 63B)
 *
 * Le lot 61 (61B) laissait le statut du Duo inchangé à la rétractation : le
 * compte WITHDRAWN suffisait à retirer la suggestion d'invitation
 * (vérification croisée de `readDuoInvite`), mais le Duo restait ACTIVE,
 * joignable en théorie, et le second utilisateur gardait l'accès partagé et
 * l'offre affichée « Premium Duo » jusqu'à la suppression du compte.
 *
 * Désormais la rétractation est traitée comme une SORTIE DE L'OFFRE :
 *   1. `duo_accounts.subscription_status` = CANCELED ; la date de sortie
 *      `duo_subscription_ended_at` est posée par le déclencheur 0438 (passage
 *      d'un statut d'offre à un statut hors offre) — jamais réécrite ensuite ;
 *   2. fin du partage par le service EXISTANT de sortie de Duo
 *      (`endDuoSharing`, AID-DUO-005) : invitation en attente annulée (l'e-mail
 *      d'invitation en file n'est plus envoyé : INVITATION_WITHDRAWN), second
 *      utilisateur retiré (`endMembership` : membership REMOVED, offre
 *      affichée ramenée à celle de son propre compte, demandes de
 *      déplacement / suppression en attente annulées, biens déverrouillés),
 *      aucun bien supprimé ici ;
 *   3. pendant un impayé Duo, `endDuoSharing` s'abstient (mode
 *      récupération) : le Duo étant d'abord passé CANCELED, ce cas ne se
 *      présente plus ; par prudence, un membre encore actif est retiré par
 *      la même sortie (`endMembership`), comme la suppression volontaire.
 *
 * Aucun e-mail n'est envoyé au membre : la sortie de Duo existante n'en
 * prévoit pas (signalé au PO).
 *
 * Idempotente : rejouée (reprise du balayage, webhook rejoué, BO), elle ne
 * change plus rien — statut déjà CANCELED (date de sortie conservée), plus
 * d'invitation ni de membre actif. Elle ne RÉACTIVE jamais un Duo.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, duoAccounts, duoMemberships } from '@/db/schema';
import { endDuoSharing } from '@/lib/plan-enforcement';
import { endMembership } from './duo-exit.service';

/** Statuts Duo « dans l'offre » : ceux que la rétractation ferme. */
const IN_OFFER = ['ACTIVE', 'TRIALING', 'UNPAID_RECOVERY'];

export interface DuoWithdrawalOutcome {
  /** Duo dont le compte rétracté est le payeur, sinon null. */
  duoId: number | null;
  /** Le Duo vient d'être fermé par cet appel (false : déjà fermé / absent). */
  closed: boolean;
  /** Seconds utilisateurs retirés par cet appel. */
  removedMembers: number;
}

/**
 * Ferme le Duo dont le titulaire du compte `accountId` est le payeur. Sans
 * Duo : sans effet. Lève en cas d'erreur base (l'appelant décide : reprise).
 */
export async function closeDuoForWithdrawal(accountId: number): Promise<DuoWithdrawalOutcome> {
  const [account] = await db
    .select({ ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const ownerUserId = account?.ownerUserId;
  if (!ownerUserId) return { duoId: null, closed: false, removedMembers: 0 };

  const [duo] = await db
    .select({ id: duoAccounts.id })
    .from(duoAccounts)
    .where(eq(duoAccounts.billingOwnerUserId, ownerUserId))
    .limit(1);
  if (!duo) return { duoId: null, closed: false, removedMembers: 0 };

  // 1. Sortie de l'offre (déclencheur 0438 : `duo_subscription_ended_at`).
  //    Seulement depuis un statut d'offre : un Duo déjà hors offre garde sa
  //    date de sortie.
  const closed = await db
    .update(duoAccounts)
    .set({ subscriptionStatus: 'CANCELED', updatedAt: new Date() })
    .where(and(eq(duoAccounts.id, duo.id), inArray(duoAccounts.subscriptionStatus, IN_OFFER)))
    .returning({ id: duoAccounts.id });

  const activeBefore = await activeMembers(duo.id, ownerUserId);

  // 2. Fin du partage : service existant (invitation, second utilisateur).
  await endDuoSharing(ownerUserId);

  // 3. Défense : un membre encore actif est retiré par la même sortie.
  for (const m of await activeMembers(duo.id, ownerUserId)) {
    await endMembership({ duoId: duo.id, membershipId: m.id, memberUserId: m.userId, status: 'REMOVED' });
  }

  return { duoId: duo.id, closed: closed.length > 0, removedMembers: activeBefore.length };
}

async function activeMembers(duoId: number, ownerUserId: number) {
  return db
    .select({ id: duoMemberships.id, userId: duoMemberships.userId })
    .from(duoMemberships)
    .where(and(eq(duoMemberships.duoId, duoId), eq(duoMemberships.status, 'ACTIVE'), ne(duoMemberships.userId, ownerUserId)));
}
