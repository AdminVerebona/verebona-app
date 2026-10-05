/**
 * Shared plan enforcement logic called by both the Stripe webhook and the admin PATCH.
 * Any plan change that needs to propagate across accounts/users/duo must go through here.
 */

import { db } from '@/db';
import { accounts, users, accountMemberships, duoAccounts, duoMemberships, subscriptionHistory } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import {
  sendDowngradeToStandardEmail,
  sendMemberRemovedDueToDowngradeEmail,
} from '@/lib/email/billing-emails';
import { endMembership, isDuoUnpaid } from '@/services/duo/duo-exit.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export type KnownPlan = 'STANDARD' | 'PREMIUM' | 'PREMIUM_DUO' | 'PREMIUM_PRO';

interface PlanChangeOptions {
  accountId: number;
  ownerUserId: number;
  oldPlanType: string;
  newPlanType: KnownPlan;
  newSubStatus: string;
  newPremiumUntil: number | null; // Unix seconds
  newMaxMembers: number;
  source: string; // e.g. 'admin:override', 'webhook:subscription.updated'
  sendEmails?: boolean;
  /**
   * Faux quand l'historique a déjà été écrit pour ce changement (écho du
   * webhook synchronisé avant l'application locale admin) : évite la ligne
   * en double dans `subscription_history`.
   */
  recordHistory?: boolean;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Apply a plan change and propagate it everywhere:
 *  - accounts row
 *  - users.planType for the owner
 *  - duo_accounts status when relevant
 *  - subscription_history audit entry
 *  - standard limits enforcement (member removal, pending invitations) —
 *    assets over quota are kept, read-only (GAP-11, lib/asset-quota-guard)
 */
export async function applyPlanChange(opts: PlanChangeOptions): Promise<void> {
  const {
    accountId,
    ownerUserId,
    oldPlanType,
    newPlanType,
    newSubStatus,
    newPremiumUntil,
    newMaxMembers,
    source,
    sendEmails = true,
    recordHistory = true,
  } = opts;

  const subscriptionTier =
    newPlanType === 'PREMIUM_DUO' || newPlanType === 'PREMIUM_PRO' ? 'pro'
    : 'premium';

  // 1. Update accounts row
  await db.update(accounts).set({
    planType: newPlanType,
    subscriptionTier,
    subscriptionStatus: newSubStatus,
    premiumUntil: newPremiumUntil,
    maxMembers: newMaxMembers,
    updatedAt: new Date(),
  }).where(eq(accounts.id, accountId));

  // 2. Sync users.planType for the account owner
  const userPlanType =
    newPlanType === 'PREMIUM_DUO' ? 'PREMIUM_DUO'
    : newPlanType === 'PREMIUM_PRO' ? 'PREMIUM_PRO'
    : newPlanType === 'PREMIUM' ? 'PREMIUM'
    : 'STANDARD';

  if (userPlanType !== oldPlanType) {
    await db.update(users).set({ planType: userPlanType, updatedAt: new Date() })
      .where(eq(users.id, ownerUserId));
  }

  // 3. duo_accounts sync
  const [duo] = await db.select({ id: duoAccounts.id, status: duoAccounts.subscriptionStatus })
    .from(duoAccounts)
    .where(eq(duoAccounts.billingOwnerUserId, ownerUserId))
    .limit(1);

  if (newPlanType === 'PREMIUM_DUO') {
    // Ensure duo_accounts is ACTIVE
    if (duo) {
      await db.update(duoAccounts).set({ subscriptionStatus: 'ACTIVE', updatedAt: new Date() })
        .where(eq(duoAccounts.id, duo.id));
      // Ensure owner is in duo_memberships as slot 0
      const existing = await db.select({ id: duoMemberships.id })
        .from(duoMemberships)
        .where(and(eq(duoMemberships.duoId, duo.id), eq(duoMemberships.userId, ownerUserId)))
        .limit(1);
      if (!existing.length) {
        await db.insert(duoMemberships).values({
          duoId: duo.id, userId: ownerUserId,
          status: 'ACTIVE', slot: 0,
          invitedAt: new Date(), joinedAt: new Date(),
          createdAt: new Date(), updatedAt: new Date(),
        });
      }
    } else {
      const [newDuo] = await db.insert(duoAccounts).values({
        billingOwnerUserId: ownerUserId,
        subscriptionStatus: 'ACTIVE',
        activatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning();
      await db.insert(duoMemberships).values({
        duoId: newDuo.id, userId: ownerUserId,
        status: 'ACTIVE', slot: 0,
        invitedAt: new Date(), joinedAt: new Date(),
        createdAt: new Date(), updatedAt: new Date(),
      });
      // Link duo to account
      await db.update(accounts).set({ duoAccountId: newDuo.id, updatedAt: new Date() })
        .where(eq(accounts.id, accountId));
    }
  } else if (oldPlanType === 'PREMIUM_DUO' && duo) {
    // Leaving PREMIUM_DUO: cancel duo_accounts, puis fin du partage.
    await db.update(duoAccounts).set({ subscriptionStatus: 'CANCELED', updatedAt: new Date() })
      .where(eq(duoAccounts.id, duo.id));
    await endDuoSharing(ownerUserId);
  }

  // 4. Subscription history audit
  if (recordHistory) await db.insert(subscriptionHistory).values({
    userId: ownerUserId,
    accountId,
    oldTier: oldPlanType,
    newTier: newPlanType,
    oldPremiumUntil: null,
    newPremiumUntil: newPremiumUntil,
    source,
    createdAt: new Date(),
  });

  // 5. Standard enforcement: remove excess members (assets are never deactivated)
  if (newPlanType === 'STANDARD') {
    await enforceStandardLimits(accountId, ownerUserId, sendEmails);
    if (sendEmails && oldPlanType !== 'STANDARD') {
      sendDowngradeToStandardEmail(ownerUserId).catch(console.error);
    }
  }
}

// ─── enforceStandardLimits ────────────────────────────────────────────────────

export async function enforceStandardLimits(
  accountId: number,
  ownerUserId: number,
  sendEmails = true,
): Promise<void> {
  // Remove non-owner active members
  const members = await db.select().from(accountMemberships).where(
    and(
      eq(accountMemberships.accountId, accountId),
      eq(accountMemberships.status, 'active'),
      eq(accountMemberships.role, 'member'),
    )
  );

  for (const member of members) {
    await db.update(accountMemberships)
      .set({ status: 'removed', removedAt: new Date(), removedBy: ownerUserId })
      .where(eq(accountMemberships.id, member.id));

    if (sendEmails && member.userId != null) {
      sendMemberRemovedDueToDowngradeEmail(
        member.userId,
        'ce compte',
        "Le compte est passé en version Standard qui ne permet qu'un seul utilisateur.",
      ).catch(console.error);
    }
  }

  // Cancel pending invitations
  await db.update(accountMemberships)
    .set({ status: 'removed', removedAt: new Date(), removedBy: ownerUserId })
    .where(and(
      eq(accountMemberships.accountId, accountId),
      eq(accountMemberships.status, 'pending'),
    ));

  // Standard n'a pas de second utilisateur Duo (AID-DUO-005).
  await endDuoSharing(ownerUserId);

  // ══════════════════════════════════════════════════════════════════════
  // BIENS AU-DELÀ DU QUOTA : AUCUN N'EST DÉSACTIVÉ (Centre d'aide GAP-11)
  //
  // Les biens au-delà du 2e passaient ici en INACTIF — pendant que
  // `entitlements.canModifyAssets` promettait de tout conserver. Règle
  // unique désormais : rien n'est modifié en base. Tant que le compte
  // dépasse son quota, ses biens restent consultables, exportables,
  // transmissibles et supprimables, et leur modification est refusée
  // (`lib/asset-quota-guard`, 403 ASSET_QUOTA_EXCEEDED). L'utilisateur
  // choisit lui-même quoi supprimer, ou reprend une offre suffisante.
  // ══════════════════════════════════════════════════════════════════════
}

// ─── endDuoSharing ────────────────────────────────────────────────────────────

/**
 * Fin du partage Duo quand l'offre ne le permet plus — AID-DUO-005.
 *
 *   - l'invitation en attente est annulée ;
 *   - le second utilisateur perd l'accès partagé : membership REMOVED
 *     (`left_at`) et offre affichée ramenée à celle de son propre compte ;
 *   - aucun bien n'est supprimé.
 *
 * Sans effet pendant un impayé Duo (UNPAID_RECOVERY) : le membre doit alors
 * pouvoir récupérer des biens vers son propre espace (mode récupération),
 * ce qui suppose qu'il reste membre.
 */
export async function endDuoSharing(ownerUserId: number): Promise<void> {
  const [duo] = await db.select({ id: duoAccounts.id, status: duoAccounts.subscriptionStatus })
    .from(duoAccounts)
    .where(eq(duoAccounts.billingOwnerUserId, ownerUserId))
    .limit(1);
  if (!duo) return;
  if (isDuoUnpaid(duo.status)) return;

  const now = new Date();
  await db.update(duoAccounts).set({
    pendingInviteEmail: null,
    pendingInviteToken: null,
    pendingInviteTokenExpiresAt: null,
    pendingInviteSentAt: null,
    activatedAt: null,
    updatedAt: now,
  }).where(eq(duoAccounts.id, duo.id));

  const members = await db.select({ id: duoMemberships.id, userId: duoMemberships.userId })
    .from(duoMemberships)
    .where(and(eq(duoMemberships.duoId, duo.id), eq(duoMemberships.status, 'ACTIVE')));
  // Même sortie que « Retirer » : membership REMOVED, offre ramenée à celle du
  // compte du membre, demandes de déplacement/suppression en attente annulées
  // et biens déverrouillés — sinon un bien resterait verrouillé sans personne
  // pour valider la demande.
  for (const m of members) {
    if (m.userId === ownerUserId) continue;
    await endMembership({ duoId: duo.id, membershipId: m.id, memberUserId: m.userId, status: 'REMOVED' });
  }
}
