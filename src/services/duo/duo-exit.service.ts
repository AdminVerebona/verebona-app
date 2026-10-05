/**
 * Fin de l'accès d'un membre à un Premium Duo — Centre d'aide GAP-13, AID-DUO-006.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX PARCOURS, MÊMES CONSÉQUENCES
 *
 *   - le TITULAIRE retire le second utilisateur (membership → REMOVED) ;
 *   - le MEMBRE quitte le Duo (membership → LEFT).
 *
 * Le titulaire ne peut pas « quitter » son propre Duo : il reste responsable
 * de l'abonnement ; pour arrêter, il change d'offre ou supprime son compte.
 *
 * Conséquences, identiques dans les deux cas (CDC 14, AID-DUO-005/006) :
 *   1. le membership passe à l'état final avec `left_at` : l'accès partagé
 *      cesse et la place est libérée pour une nouvelle invitation ;
 *   2. l'offre affichée du membre (`users.plan_type`) revient à celle de son
 *      propre compte (Standard à défaut) ;
 *   3. les demandes de déplacement / suppression de biens EN ATTENTE qui
 *      l'impliquent sont annulées et les biens déverrouillés ;
 *   4. les biens, documents et échéances du Duo ne sont PAS supprimés : ils
 *      restent dans l'espace du titulaire ;
 *   5. `duo_accounts.activated_at` est recalculé (un seul membre actif).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { isDuoUnpaidStatus } from '@/lib/billing/subscription-status';
import { db } from '@/db';
import {
  accountMemberships, accountSubscriptions, assetDeleteRequests, assetMoveRequests,
  assets, duoAccounts, duoMemberships, users,
} from '@/db/schema';

export type DuoExitError =
  | 'DUO_NOT_FOUND'
  | 'NO_ACTIVE_MEMBER'
  | 'NOT_A_DUO_MEMBER'
  | 'OWNER_CANNOT_LEAVE'
  | 'DUO_UNPAID';

export type DuoExitResult =
  | { ok: true; duoId: number; memberUserId: number; status: 'REMOVED' | 'LEFT'; cancelledRequests: number }
  | { ok: false; error: DuoExitError; message: string };

export const DUO_EXIT_MESSAGES: Record<DuoExitError, string> = {
  DUO_NOT_FOUND: 'Aucun espace Premium Duo n’est associé à votre compte.',
  NO_ACTIVE_MEMBER: 'Aucun second utilisateur n’est actif sur votre Duo.',
  NOT_A_DUO_MEMBER: 'Vous n’êtes pas membre d’un espace Premium Duo.',
  OWNER_CANNOT_LEAVE:
    'Le titulaire ne peut pas quitter son propre Duo : changez d’offre ou supprimez votre compte depuis Mon compte.',
  DUO_UNPAID:
    'Le second utilisateur ne peut pas être retiré pendant un impayé : il doit pouvoir récupérer ses biens. Régularisez d’abord le paiement.',
};

/**
 * Impayé Duo (UNPAID_RECOVERY, dès le premier échec — aucune grâce) : le
 * membre garde l'accès pour le mode récupération (sortie, déplacement ou
 * copie de ses biens), même si l'écriture normale est suspendue.
 */
export const isDuoUnpaid = (status: string | null | undefined): boolean => isDuoUnpaidStatus(status);

const fail = (error: DuoExitError): DuoExitResult => ({ ok: false, error, message: DUO_EXIT_MESSAGES[error] });

/** Offre affichée du membre une fois sorti : celle de son propre compte. */
export function planTypeAfterDuoExit(own: { planCode: string; status: string } | null | undefined): 'STANDARD' | 'PREMIUM' {
  if (!own) return 'STANDARD';
  const actif = own.status === 'active' || own.status === 'trialing';
  return actif && own.planCode === 'premium' ? 'PREMIUM' : 'STANDARD';
}

/** Offre affichée d'un utilisateur sorti d'un Duo (partagé avec plan-enforcement). */
export async function ownPlanType(userId: number): Promise<'STANDARD' | 'PREMIUM'> {
  const [own] = await db
    .select({ planCode: accountSubscriptions.planCode, status: accountSubscriptions.status })
    .from(accountMemberships)
    .innerJoin(accountSubscriptions, eq(accountSubscriptions.accountId, accountMemberships.accountId))
    .where(and(
      eq(accountMemberships.userId, userId),
      eq(accountMemberships.role, 'owner'),
      or(eq(accountMemberships.status, 'active'), eq(accountMemberships.status, 'ACTIVE')),
    ))
    .limit(1);
  return planTypeAfterDuoExit(own);
}

/** Applique la sortie d'un membre (non titulaire), en une transaction. */
export async function endMembership(p: {
  duoId: number;
  membershipId: number;
  memberUserId: number;
  status: 'REMOVED' | 'LEFT';
}): Promise<number> {
  const now = new Date();
  const planType = await ownPlanType(p.memberUserId);

  const annulees = await db.transaction(async (tx) => {
    await tx.update(duoMemberships)
      .set({ status: p.status, leftAt: now, updatedAt: now })
      .where(eq(duoMemberships.id, p.membershipId));

    await tx.update(users)
      .set({ planType, updatedAt: now })
      .where(eq(users.id, p.memberUserId));

    // Demandes en attente qui l'impliquent : annulées, biens déverrouillés.
    const implique = (t: typeof assetMoveRequests | typeof assetDeleteRequests) => and(
      eq(t.duoId, p.duoId),
      eq(t.status, 'PENDING'),
      or(eq(t.initiatorUserId, p.memberUserId), eq(t.validatorUserId, p.memberUserId)),
    );
    const moves = await tx.update(assetMoveRequests)
      .set({ status: 'CANCELLED', resolvedAt: now, resolvedByType: 'SYSTEM' })
      .where(implique(assetMoveRequests))
      .returning({ assetId: assetMoveRequests.assetId });
    const deletes = await tx.update(assetDeleteRequests)
      .set({ status: 'CANCELLED', resolvedAt: now, resolvedByType: 'SYSTEM' })
      .where(implique(assetDeleteRequests))
      .returning({ assetId: assetDeleteRequests.assetId });
    const assetIds = [...new Set([...moves, ...deletes].map((r) => r.assetId))];
    if (assetIds.length) {
      await tx.update(assets).set({ lockState: 'NONE', updatedAt: now }).where(inArray(assets.id, assetIds));
    }

    // Un seul membre actif : le Duo n'est plus « activé » à deux.
    await tx.update(duoAccounts).set({ activatedAt: null, updatedAt: now }).where(eq(duoAccounts.id, p.duoId));

    return moves.length + deletes.length;
  });
  signalerDroitsModifies();
  return annulees;
}

/**
 * CDC Assistant §25.7 : les droits d'un membre ont changé (entrée ou sortie
 * d'un Duo). Événement GLOBAL (compte non résolu ici) : le cache de
 * recherche de l'assistant de ce processus est vidé. Non bloquant.
 */
export function signalerDroitsModifies(): void {
  void import('@/services/verebona-assistant/events/business-events')
    .then(({ emitBusinessEvent }) => emitBusinessEvent({ type: 'ACCOUNT_PERMISSION_CHANGED', accountId: null }))
    .catch(() => { /* non bloquant */ });
}

/** Le titulaire retire le second utilisateur de son Duo. */
export async function removeDuoMember(ownerUserId: number): Promise<DuoExitResult> {
  const [duo] = await db
    .select({ id: duoAccounts.id, status: duoAccounts.subscriptionStatus })
    .from(duoAccounts)
    .where(eq(duoAccounts.billingOwnerUserId, ownerUserId))
    .limit(1);
  if (!duo) return fail('DUO_NOT_FOUND');
  if (isDuoUnpaid(duo.status)) return fail('DUO_UNPAID');

  const [member] = await db
    .select({ id: duoMemberships.id, userId: duoMemberships.userId })
    .from(duoMemberships)
    .where(and(eq(duoMemberships.duoId, duo.id), eq(duoMemberships.status, 'ACTIVE')))
    .then((rows) => rows.filter((r) => r.userId !== ownerUserId));
  if (!member) return fail('NO_ACTIVE_MEMBER');

  const cancelledRequests = await endMembership({
    duoId: duo.id, membershipId: member.id, memberUserId: member.userId, status: 'REMOVED',
  });
  return { ok: true, duoId: duo.id, memberUserId: member.userId, status: 'REMOVED', cancelledRequests };
}

/** Le membre (non titulaire) quitte le Duo. */
export async function leaveDuo(userId: number): Promise<DuoExitResult> {
  const [row] = await db
    .select({
      membershipId: duoMemberships.id,
      duoId: duoMemberships.duoId,
      billingOwnerUserId: duoAccounts.billingOwnerUserId,
    })
    .from(duoMemberships)
    .innerJoin(duoAccounts, eq(duoAccounts.id, duoMemberships.duoId))
    .where(and(eq(duoMemberships.userId, userId), eq(duoMemberships.status, 'ACTIVE')))
    .limit(1);
  if (!row) return fail('NOT_A_DUO_MEMBER');
  if (row.billingOwnerUserId === userId) return fail('OWNER_CANNOT_LEAVE');

  const cancelledRequests = await endMembership({
    duoId: row.duoId, membershipId: row.membershipId, memberUserId: userId, status: 'LEFT',
  });
  return { ok: true, duoId: row.duoId, memberUserId: userId, status: 'LEFT', cancelledRequests };
}
