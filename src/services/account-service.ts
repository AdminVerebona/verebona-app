import { db } from '@/db';
import {
  accounts,
  accountMemberships,
  accountAuditLog,
  users,
  duoAccounts,
  duoMemberships,
} from '@/db/schema';
import { eq, and, or } from 'drizzle-orm';
import { duoOfAccount } from '@/services/account/membership.service';
import { DUO_EXIT_MESSAGES, endMembership, isDuoUnpaid } from '@/services/duo/duo-exit.service';
import crypto from 'crypto';
import { emailService } from '@/lib/email/email-service';
import { orderSessionAccounts, withoutArchivedAccounts, type SessionAccountCandidate } from '@/lib/auth/account-suspension';
import { invalidateAccountReadCache, invalidateUserReadCache } from '@/lib/server-cache';
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

interface AccountMembership {
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

interface AccountWithMemberships extends Account {
  memberships: (AccountMembership & { user: { email: string; firstName: string; lastName: string } })[];
  memberCount: number;
}

export class AccountService {
  private static generateInviteToken(): string {
    return crypto.randomBytes(32).toString('hex');
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

  /**
   * Lot 72D (faille de l'audit §1.4) : vrai si `userId` est TITULAIRE actif
   * du compte. Seul le titulaire invite ou retire des membres.
   */
  static async isActiveOwner(accountId: number, userId: number): Promise<boolean> {
    if (!Number.isInteger(accountId) || accountId <= 0) return false;
    const [row] = await db
      .select({ id: accountMemberships.id })
      .from(accountMemberships)
      .where(and(
        eq(accountMemberships.accountId, accountId),
        eq(accountMemberships.userId, userId),
        eq(accountMemberships.role, 'owner'),
        eq(accountMemberships.status, 'active'),
      ))
      .limit(1);
    return !!row;
  }

  static async inviteMember(
    accountId: number,
    email: string,
    invitedBy: number
  ): Promise<{
    success: boolean; error?: string; code?: 'NOT_ACCOUNT_OWNER'; inviteToken?: string;
    /** Lot 74B : faux pour une personne déjà inscrite (aucun parcours d'acceptation hors Duo). */
    notified?: boolean; notice?: 'EXISTING_USER_ACCEPTANCE_UNAVAILABLE';
  }> {
    // ══════════════════════════════════════════════════════════════════════
    // LOT 72D — FAILLE : INVITATION DANS LE COMPTE D'UN TIERS
    //
    // Aucun contrôle ne vérifiait que l'appelant appartenait au compte : tout
    // utilisateur connecté pouvait s'inviter (autre adresse) dans n'importe
    // quel compte partagé ayant une place libre, puis accéder à ses données.
    // Seul le TITULAIRE actif invite (matrice Q14).
    // ══════════════════════════════════════════════════════════════════════
    if (!(await this.isActiveOwner(accountId, invitedBy))) {
      return { success: false, code: 'NOT_ACCOUNT_OWNER', error: 'Seul le titulaire du compte peut inviter un membre.' };
    }

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

    // Lot 72D : un ancien membre (retiré, parti, invitation refusée) a déjà
    // une ligne pour ce compte — (account_id, user_id) est unique, tous
    // statuts confondus : on la RÉACTIVE en invitation au lieu d'en insérer
    // une seconde (l'insertion échouait en 500).
    const [previous] = existingUser
      ? await db
          .select({ id: accountMemberships.id })
          .from(accountMemberships)
          .where(and(eq(accountMemberships.accountId, accountId), eq(accountMemberships.userId, existingUser.id)))
          .limit(1)
      : [];

    if (previous) {
      await db
          .update(accountMemberships)
          .set({
            invitedEmail: email,
            role: 'member',
            status: 'pending',
            invitedBy,
            invitedAt: now,
            joinedAt: null,
            removedAt: null,
            removedBy: null,
            inviteToken,
            inviteTokenExpiresAt,
            updatedAt: now,
          })
          .where(eq(accountMemberships.id, previous.id));
    } else {
      await db.insert(accountMemberships).values(membershipValues);
    }

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

      // ══════════════════════════════════════════════════════════════════
      // LOT 74B (point 5) — LIEN MORT `/mon-compte/partage`
      //
      // L'e-mail et la notification d'invitation d'un utilisateur DÉJÀ
      // inscrit pointaient vers `/mon-compte/partage`, page qui n'a jamais
      // existé (404) : aucun parcours d'acceptation n'existe pour lui hors
      // Premium Duo (le Duo a le sien : `/duo/join/[token]`). L'offre actuelle
      // ne vend aucun compte partagé hors Duo (Premium Pro « Bientôt
      // disponible ») : variante prudente — l'invitation reste enregistrée
      // (route conservée, réservée au titulaire, base de la future offre
      // Pro), mais on n'envoie plus de lien qui mène nulle part. La personne
      // déjà inscrite n'est ni écrite ni notifiée (`notified: false`) ; une
      // personne NON inscrite reçoit toujours le lien d'inscription, qui
      // fonctionne (`/signup?inviteToken=`, adhésion activée à la
      // vérification de l'adresse).
      // ══════════════════════════════════════════════════════════════════
      if (existingUser) {
        return { success: true, inviteToken, notified: false, notice: 'EXISTING_USER_ACCEPTANCE_UNAVAILABLE' };
      }

      try {
        const invitationLink = `${process.env.NEXT_PUBLIC_APP_URL || 'https://app.verebona.fr'}/signup?inviteToken=${inviteToken}`;

        await emailService.send({
          templateCode: 'ACCOUNT_INVITATION',
          to: email,
          variables: {
            inviterName: `${inviter.firstName} ${inviter.lastName}`,
            accountName: account.name,
            role: 'Membre',
            invitationLink,
          },
        });

      } catch (error) {
        console.error('Failed to send invitation email:', error);
      }

      return { success: true, inviteToken, notified: true };
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
    // Seul le propriétaire actif du compte retire un membre (AID-DUO-006 :
    // « retiré par un utilisateur autorisé »). Ce contrôle manquait : tout
    // utilisateur connecté pouvait retirer n'importe quel membre.
    const [ownerMembership] = await db
      .select({ id: accountMemberships.id })
      .from(accountMemberships)
      .where(
        and(
          eq(accountMemberships.accountId, accountId),
          eq(accountMemberships.userId, removedBy),
          eq(accountMemberships.role, 'owner'),
          eq(accountMemberships.status, 'active')
        )
      )
      .limit(1);
    if (!ownerMembership) {
      return { success: false, error: 'Only the account owner can remove a member' };
    }

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

    // Lot 72D : compte porteur d'un Premium Duo — même sortie que « Retirer le
    // second utilisateur » (adhésion + ligne Duo historique, e-mail de fin
    // d'accès, refus pendant un impayé).
    const duoExit = await this.endDuoSideIfAny(accountId, memberUserId, 'REMOVED', removedBy);
    if (duoExit === 'DUO_UNPAID') {
      return { success: false, error: DUO_EXIT_MESSAGES.DUO_UNPAID };
    }

    const now = new Date();
    if (duoExit !== 'DONE') await db
      .update(accountMemberships)
      .set({
        status: 'removed',
        removedAt: now,
        removedBy,
        endedReason: 'removed',
        updatedAt: now,
      })
      .where(eq(accountMemberships.id, membership.id));
    // Lot 54 (SEC-01) : retrait effectif tout de suite. Le jeton du membre est
    // refusé dès sa prochaine requête (droit relu en base à chaque requête,
    // `lib/auth/account-access`) ; les lectures mises en cache pour ce compte
    // et cet utilisateur ne sont plus servies sur cette instance.
    invalidateAccountReadCache(accountId);
    invalidateUserReadCache(memberUserId);

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

    // Lot 72D : départ d'un compte Premium Duo — même sortie que « Quitter le
    // Duo » (adhésion `left` + ligne Duo historique, e-mail de confirmation).
    const duoExit = await this.endDuoSideIfAny(accountId, userId, 'LEFT', null);

    const now = new Date();
    if (duoExit !== 'DONE') await db
      .update(accountMemberships)
      .set({
        status: 'left',
        removedAt: now,
        endedReason: 'left',
        updatedAt: now,
      })
      .where(eq(accountMemberships.id, membership.id));
    // Lot 54 (SEC-01) : départ effectif tout de suite (voir `removeMember`).
    invalidateAccountReadCache(accountId);
    invalidateUserReadCache(userId);

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

  /**
   * Lot 72D : si le compte porte un Premium Duo dont `userId` est membre
   * actif, la sortie passe par `duo-exit` (une seule transaction : adhésion
   * au compte + ligne Duo historique + e-mail). 'NONE' : pas de Duo concerné.
   */
  private static async endDuoSideIfAny(
    accountId: number,
    userId: number,
    status: 'REMOVED' | 'LEFT',
    byUserId: number | null,
  ): Promise<'DONE' | 'NONE' | 'DUO_UNPAID'> {
    const duoId = await duoOfAccount(accountId);
    if (!duoId) return 'NONE';
    const [duo] = await db
      .select({ status: duoAccounts.subscriptionStatus })
      .from(duoAccounts)
      .where(eq(duoAccounts.id, duoId))
      .limit(1);
    const [dm] = await db
      .select({ id: duoMemberships.id })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, duoId), eq(duoMemberships.userId, userId), eq(duoMemberships.status, 'ACTIVE')))
      .limit(1);
    if (!dm) return 'NONE';
    if (status === 'REMOVED' && isDuoUnpaid(duo?.status)) return 'DUO_UNPAID';
    await endMembership({ duoId, membershipId: dm.id, memberUserId: userId, status, byUserId });
    return 'DONE';
  }

  /**
   * Comptes dont l'utilisateur est membre actif, dans un ordre STABLE
   * (titulaire, puis administrateur, puis membre ; puis ancienneté ; puis id).
   * Voir `lib/auth/account-suspension.ts` : l'ancien tri n'était pas total et
   * dépendait de l'ordre des lignes renvoyées par la base.
   */
  static async getUserSessionAccounts(userId: number): Promise<SessionAccountCandidate<Account>[]> {
    const memberships = await db
      .select({
        account: accounts,
        role: accountMemberships.role,
        membershipId: accountMemberships.id,
        joinedAt: accountMemberships.joinedAt,
        createdAt: accountMemberships.createdAt,
        lastSelectedAt: accountMemberships.lastSelectedAt,
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

    return orderSessionAccounts(
      memberships.map((m) => ({
        account: m.account as Account,
        role: m.role,
        membershipId: m.membershipId,
        joinedAt: m.joinedAt ?? null,
        createdAt: m.createdAt ?? null,
        lastSelectedAt: m.lastSelectedAt ?? null,
      })),
    );
  }

  /**
   * Compte « par défaut » : le premier compte NON suspendu dans l'ordre
   * stable ci-dessus ; à défaut (tous suspendus), le premier — les appelants
   * qui ouvrent une session contrôlent la suspension via
   * `resolveSessionAccount`.
   */
  static async getUserDefaultAccount(userId: number): Promise<Account | null> {
    const ordered = await this.getUserSessionAccounts(userId);
    if (!ordered.length) return null;
    // Lot 72D : dernier espace choisi d'abord ; compte archivé écarté s'il y en a un autre.
    const candidates = withoutArchivedAccounts(ordered);
    return (candidates.find((c) => c.account.isActive !== false) ?? candidates[0]).account;
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
