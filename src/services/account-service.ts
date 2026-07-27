import { db } from '@/db';
import {
  accounts,
  accountMemberships,
  accountAuditLog,
  users,
} from '@/db/schema';
import { eq, and, or } from 'drizzle-orm';
import crypto from 'crypto';
import { emailService } from '@/lib/email/email-service';
import { emit } from '@/lib/notifications';
import type { PlanType, SubscriptionTier, SubscriptionStatus, MembershipRole, MembershipStatus } from '@/types/domain';

export interface Account {
  id: number;
  name: string;
  ownerUserId: number;
  planType: PlanType;
  subscriptionTier: SubscriptionTier;
  subscriptionStatus: SubscriptionStatus;
  maxMembers: number;
  isActive: boolean;
}

export interface AccountMembership {
  id: number;
  accountId: number;
  userId: number;
  role: MembershipRole;
  status: MembershipStatus;
  invitedBy: number | null;
  invitedAt: Date | null;
  joinedAt: Date | null;
  removedAt: Date | null;
  inviteToken: string | null;
}

export interface AccountWithMemberships extends Account {
  memberships: (AccountMembership & { user: { email: string; firstName: string; lastName: string } })[];
  memberCount: number;
}

export class AccountService {
  private static generateInviteToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  static async getUserAccounts(userId: number): Promise<AccountWithMemberships[]> {
    const memberships = await db
      .select({
        membership: accountMemberships,
        account: accounts,
        user: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        }
      })
      .from(accountMemberships)
      .innerJoin(accounts, eq(accountMemberships.accountId, accounts.id))
      .leftJoin(users, eq(accountMemberships.userId, users.id))
      .where(
        and(
          eq(accountMemberships.userId, userId),
          or(
            eq(accountMemberships.status, 'active'),
            eq(accountMemberships.status, 'ACTIVE')
          )
        )
      );

    const accountsWithMemberships: AccountWithMemberships[] = [];

    for (const { account, membership, user } of memberships) {
      const allMemberships = await db
        .select({
          membership: accountMemberships,
          user: {
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          }
        })
        .from(accountMemberships)
        .innerJoin(users, eq(accountMemberships.userId, users.id))
        .where(eq(accountMemberships.accountId, account.id));

      accountsWithMemberships.push({
          ...account,
          planType: account.planType as PlanType,
          subscriptionTier: account.subscriptionTier as SubscriptionTier,
          subscriptionStatus: account.subscriptionStatus as SubscriptionStatus,
          memberships: (allMemberships.map(m => ({
            ...m.membership,
            userId: m.membership.userId ?? 0,
            user: m.user,
          })) as unknown) as (AccountMembership & { user: { email: string; firstName: string; lastName: string } })[],
          memberCount: allMemberships.filter(m => m.membership.status === 'active').length,
        });
    }

    return accountsWithMemberships;
  }

  static async getAccountById(accountId: number): Promise<AccountWithMemberships | null> {
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) return null;

    const allMemberships = await db
      .select({
        membership: accountMemberships,
        user: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        }
      })
      .from(accountMemberships)
      .innerJoin(users, eq(accountMemberships.userId, users.id))
      .where(eq(accountMemberships.accountId, accountId));

      return {
        ...account,
        planType: account.planType as PlanType,
        subscriptionTier: account.subscriptionTier as SubscriptionTier,
        subscriptionStatus: account.subscriptionStatus as SubscriptionStatus,
        memberships: (allMemberships.map(m => ({
          ...m.membership,
          userId: m.membership.userId ?? 0,
          user: m.user,
        })) as unknown) as (AccountMembership & { user: { email: string; firstName: string; lastName: string } })[],
        memberCount: allMemberships.filter(m => m.membership.status === 'active').length,
      };
  }

  static async canInviteMembers(accountId: number): Promise<{ allowed: boolean; reason?: string }> {
    const account = await this.getAccountById(accountId);
    if (!account) {
      return { allowed: false, reason: 'Account not found' };
    }

    if (account.planType !== 'PREMIUM_DUO' && account.planType !== 'PREMIUM_PRO') {
      return { allowed: false, reason: 'Le partage de compte nécessite un abonnement Premium Duo ou Premium Pro.' };
    }

    const activeMemberCount = account.memberCount;
    if (activeMemberCount >= account.maxMembers) {
      return { 
        allowed: false, 
        reason: `Maximum members (${account.maxMembers}) reached for your plan` 
      };
    }

    return { allowed: true };
  }

  static async inviteMember(
    accountId: number,
    email: string,
    invitedBy: number
  ): Promise<{ success: boolean; error?: string; inviteToken?: string }> {
    const canInvite = await this.canInviteMembers(accountId);
    if (!canInvite.allowed) {
      return { success: false, error: canInvite.reason };
    }

    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existingUser) {
      const [existingMembership] = await db
        .select()
        .from(accountMemberships)
        .where(
          and(
            eq(accountMemberships.accountId, accountId),
            eq(accountMemberships.userId, existingUser.id)
          )
        )
        .limit(1);

      if (existingMembership) {
        if (existingMembership.status === 'active') {
          return { success: false, error: 'User is already a member of this account' };
        }
        if (existingMembership.status === 'pending') {
          return { success: false, error: 'User already has a pending invitation' };
        }
      }
    }

    const inviteToken = this.generateInviteToken();
    const inviteTokenExpiresAt = new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)); // 7 days
    const now = new Date();

    const membershipValues: any = {
      accountId,
      invitedEmail: email,
      role: 'member',
      status: 'pending',
      invitedBy,
      invitedAt: now,
      inviteToken,
      inviteTokenExpiresAt,
      createdAt: now,
      updatedAt: now,
    };

    if (existingUser) {
      membershipValues.userId = existingUser.id;
    }

    const [membership] = await db
      .insert(accountMemberships)
      .values(membershipValues)
      .returning();

      const [inviter] = await db
        .select()
        .from(users)
        .where(eq(users.id, invitedBy))
        .limit(1);

      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);

        await db.insert(accountAuditLog).values({
          accountId,
          userId: invitedBy,
          userEmail: inviter.email,
          actionType: 'MEMBER_INVITED',
          targetUserId: existingUser?.id || null,
          targetUserEmail: email,
          details: JSON.stringify({ role: 'member', inviteToken, userExists: !!existingUser }),
          timestamp: now,
        });

      try {
        const invitationLink = existingUser 
          ? `${process.env.NEXT_PUBLIC_APP_URL || 'https://app.verebona.fr'}/mon-compte/partage?inviteToken=${inviteToken}`
          : `${process.env.NEXT_PUBLIC_APP_URL || 'https://app.verebona.fr'}/signup?inviteToken=${inviteToken}`;
        
        await emailService.send({
          templateCode: 'ACCOUNT_INVITATION',
          to: email,
          variables: {
            inviterName: `${inviter.firstName} ${inviter.lastName}`,
            accountName: account.name,
            role: 'Membre',
            invitationLink,
          },
          userId: existingUser?.id ?? undefined,
        });

      } catch (error) {
        console.error('Failed to send invitation email:', error);
      }

      if (existingUser) {
        try {
          await emit({
            type: 'ACCOUNT_INVITATION',
            recipientUserIds: [existingUser.id],
            accountId: account.id,
            entityType: 'account_membership',
            entityId: membership.id,
            payload: {
              inviterName: `${inviter.firstName} ${inviter.lastName}`,
              accountName: account.name,
              inviteToken,
            },
            dedupeKey: `account-invitation:${membership.id}`,
          });
        } catch (notifError) {
          console.error('Failed to create ACCOUNT_INVITATION notification:', notifError);
        }
      }

      return { success: true, inviteToken };
  }

  static async acceptInvite(
    inviteToken: string,
    userId: number
  ): Promise<{ success: boolean; error?: string; accountId?: number }> {
    const [membership] = await db
      .select()
      .from(accountMemberships)
      .where(eq(accountMemberships.inviteToken, inviteToken))
      .limit(1);

    if (!membership) {
      return { success: false, error: 'Invalid invite token' };
    }

    if (membership.userId !== userId) {
      return { success: false, error: 'This invite is for a different user' };
    }

    if (membership.status !== 'pending') {
      return { success: false, error: 'This invite has already been accepted or cancelled' };
    }

    if (membership.inviteTokenExpiresAt && membership.inviteTokenExpiresAt.getTime() < Date.now()) {
      return { success: false, error: 'This invite has expired' };
    }

    const now = new Date();
    await db
      .update(accountMemberships)
      .set({
        status: 'active',
        joinedAt: now,
        inviteToken: null,
        inviteTokenExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(accountMemberships.id, membership.id));

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    await db.insert(accountAuditLog).values({
      accountId: membership.accountId,
      userId,
      userEmail: user.email,
      actionType: 'MEMBER_JOINED',
      targetUserId: userId,
      targetUserEmail: user.email,
      details: JSON.stringify({ role: membership.role }),
      timestamp: now,
    });

    return { success: true, accountId: membership.accountId };
  }

  static async removeMember(
    accountId: number,
    memberUserId: number,
    removedBy: number
  ): Promise<{ success: boolean; error?: string; removedUserId?: number; shouldRedirect?: boolean }> {
    const [membership] = await db
      .select()
      .from(accountMemberships)
      .where(
        and(
          eq(accountMemberships.accountId, accountId),
          eq(accountMemberships.userId, memberUserId),
          eq(accountMemberships.status, 'active')
        )
      )
      .limit(1);

    if (!membership) {
      return { success: false, error: 'Membership not found' };
    }

    if (membership.role === 'owner') {
      return { success: false, error: 'Cannot remove the account owner. Transfer ownership first.' };
    }

    const now = new Date();
    await db
      .update(accountMemberships)
      .set({
        status: 'removed',
        removedAt: now,
        removedBy,
        updatedAt: now,
      })
      .where(eq(accountMemberships.id, membership.id));

    const [remover] = await db
      .select()
      .from(users)
      .where(eq(users.id, removedBy))
      .limit(1);

    const [member] = await db
      .select()
      .from(users)
      .where(eq(users.id, memberUserId))
      .limit(1);

    await db.insert(accountAuditLog).values({
      accountId,
      userId: removedBy,
      userEmail: remover.email,
      actionType: 'MEMBER_REMOVED',
      targetUserId: memberUserId,
      targetUserEmail: member.email,
      details: JSON.stringify({ role: membership.role }),
      timestamp: now,
    });

    return { success: true };
  }

  static async leaveAccount(
    accountId: number,
    userId: number
  ): Promise<{ success: boolean; error?: string; shouldRedirect?: boolean }> {
    const [membership] = await db
      .select()
      .from(accountMemberships)
      .where(
        and(
          eq(accountMemberships.accountId, accountId),
          eq(accountMemberships.userId, userId),
          eq(accountMemberships.status, 'active')
        )
      )
      .limit(1);

    if (!membership) {
      return { success: false, error: 'You are not a member of this account' };
    }

    if (membership.role === 'owner') {
      return { success: false, error: 'Account owner cannot leave. Transfer ownership or delete the account.' };
    }

    const now = new Date();
    await db
      .update(accountMemberships)
      .set({
        status: 'removed',
        removedAt: now,
        updatedAt: now,
      })
      .where(eq(accountMemberships.id, membership.id));

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    await db.insert(accountAuditLog).values({
      accountId,
      userId,
      userEmail: user.email,
      actionType: 'MEMBER_LEFT',
      targetUserId: userId,
      targetUserEmail: user.email,
      details: JSON.stringify({ role: membership.role }),
      timestamp: now,
    });

    const remainingMemberships = await db
      .select()
      .from(accountMemberships)
      .where(
        and(
          eq(accountMemberships.userId, userId),
          eq(accountMemberships.status, 'active')
        )
      );

    const shouldRedirect = remainingMemberships.length === 0;

    return { success: true, shouldRedirect };
  }

  static async hasAccountAccess(
    userId: number,
    accountId: number
  ): Promise<{ hasAccess: boolean; role?: 'owner' | 'member' }> {
    const [membership] = await db
      .select()
      .from(accountMemberships)
      .where(
        and(
          eq(accountMemberships.userId, userId),
          eq(accountMemberships.accountId, accountId),
          eq(accountMemberships.status, 'active')
        )
      )
      .limit(1);

    if (!membership) {
      return { hasAccess: false };
    }

    return { hasAccess: true, role: membership.role as 'owner' | 'member' };
  }

  static async getUserDefaultAccount(userId: number): Promise<Account | null> {
    const memberships = await db
      .select({
        account: accounts,
        role: accountMemberships.role,
      })
      .from(accountMemberships)
      .innerJoin(accounts, eq(accountMemberships.accountId, accounts.id))
      .where(
        and(
          eq(accountMemberships.userId, userId),
          or(
            eq(accountMemberships.status, 'active'),
            eq(accountMemberships.status, 'ACTIVE')
          )
        )
      );

    if (!memberships.length) return null;

    // Priorité : owner/admin en premier, puis les autres
    const sorted = memberships.sort((a, b) => {
      const aIsAdmin = a.role === 'owner' || a.role === 'admin';
      const bIsAdmin = b.role === 'owner' || b.role === 'admin';
      return aIsAdmin ? -1 : bIsAdmin ? 1 : 0;
    });

    return sorted[0].account as Account;
  }

    static async transferOwnership(
      accountId: number,
      newOwnerId: number,
      currentOwnerId: number
    ): Promise<{ success: boolean; error?: string }> {
      const account = await this.getAccountById(accountId);
      if (!account) {
        return { success: false, error: 'Account not found' };
      }

      const currentOwnerMembership = account.memberships.find(
        m => m.userId === currentOwnerId && m.role === 'owner' && m.status === 'active'
      );

      if (!currentOwnerMembership) {
        return { success: false, error: 'You are not the account owner' };
      }

      const newOwnerMembership = account.memberships.find(
        m => m.userId === newOwnerId && m.status === 'active'
      );

      if (!newOwnerMembership) {
        return { success: false, error: 'New owner must be an active member of the account' };
      }

      if (newOwnerMembership.role === 'owner') {
        return { success: false, error: 'This user is already the owner' };
      }

      const now = new Date();

      await db
        .update(accountMemberships)
        .set({
          role: 'member',
          updatedAt: now,
        })
        .where(eq(accountMemberships.id, currentOwnerMembership.id));

      await db
        .update(accountMemberships)
        .set({
          role: 'owner',
          updatedAt: now,
        })
        .where(eq(accountMemberships.id, newOwnerMembership.id));

      await db
        .update(accounts)
        .set({
          ownerUserId: newOwnerId,
          updatedAt: now,
        })
        .where(eq(accounts.id, accountId));

      const [currentOwner] = await db
        .select()
        .from(users)
        .where(eq(users.id, currentOwnerId))
        .limit(1);

      const [newOwner] = await db
        .select()
        .from(users)
        .where(eq(users.id, newOwnerId))
        .limit(1);

      await db.insert(accountAuditLog).values({
        accountId,
        userId: currentOwnerId,
        userEmail: currentOwner.email,
        actionType: 'OWNER_TRANSFERRED',
        targetUserId: newOwnerId,
        targetUserEmail: newOwner.email,
        details: JSON.stringify({ 
          previousOwnerId: currentOwnerId,
          newOwnerId,
        }),
        timestamp: now,
      });

      return { success: true };
    }
  }
