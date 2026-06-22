/**
 * Shared plan enforcement logic called by both the Stripe webhook and the admin PATCH.
 * Any plan change that needs to propagate across accounts/users/duo must go through here.
 */

import { db } from '@/db';
import { accounts, users, accountMemberships, assets, duoAccounts, duoMemberships, subscriptionHistory } from '@/db/schema';
import { eq, and, asc } from 'drizzle-orm';
import {
  sendDowngradeToStandardEmail,
  sendMemberRemovedDueToDowngradeEmail,
} from '@/lib/email/billing-emails';

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
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Apply a plan change and propagate it everywhere:
 *  - accounts row
 *  - users.planType for the owner
 *  - duo_accounts status when relevant
 *  - subscription_history audit entry
 *  - standard limits enforcement (member removal, asset deactivation)
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
    // Leaving PREMIUM_DUO: cancel duo_accounts
    await db.update(duoAccounts).set({ subscriptionStatus: 'CANCELED', updatedAt: new Date() })
      .where(eq(duoAccounts.id, duo.id));
    // Also reset users.planType for all active duo members (slot 1)
    const duoMembers = await db.select({ userId: duoMemberships.userId })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, duo.id), eq(duoMemberships.status, 'ACTIVE')));
    for (const m of duoMembers) {
      if (m.userId !== ownerUserId) {
        await db.update(users).set({ planType: 'STANDARD', updatedAt: new Date() })
          .where(eq(users.id, m.userId));
      }
    }
  }

  // 4. Subscription history audit
  await db.insert(subscriptionHistory).values({
    userId: ownerUserId,
    accountId,
    oldTier: oldPlanType,
    newTier: newPlanType,
    oldPremiumUntil: null,
    newPremiumUntil: newPremiumUntil,
    source,
    createdAt: new Date(),
  });

  // 5. Standard enforcement: remove excess members, deactivate excess assets
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

  // Deactivate assets beyond Standard limit (2)
  const allAssets = await db.select({ id: assets.id }).from(assets)
    .where(eq(assets.accountId, accountId))
    .orderBy(asc(assets.createdAt));

  for (const asset of allAssets.slice(2)) {
    await db.update(assets).set({ status: 'INACTIF', updatedAt: new Date() })
      .where(eq(assets.id, asset.id));
  }
}
