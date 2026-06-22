import { db } from '@/db';
import { 
  duoAccounts, duoMemberships, assets, assetMoveRequests, assetDeleteRequests, 
  notifications, users, accounts, accountMemberships 
} from '@/db/schema';
import { eq, and, or, isNull, ne, sql } from 'drizzle-orm';
import type { 
  DuoSubscriptionStatus, DuoMembershipStatus, AssetLockState, 
  MoveRequestStatus, DeleteRequestStatus, ResolutionMode, ResolvedByType 
} from '@/types/duo';

export class DuoService {
  
  static async getDuoByUserId(userId: number) {
    const membership = await db
      .select({
        duoId: duoMemberships.duoId,
        membershipStatus: duoMemberships.status,
        slot: duoMemberships.slot,
      })
      .from(duoMemberships)
      .where(
        and(
          eq(duoMemberships.userId, userId),
          or(
            eq(duoMemberships.status, 'ACTIVE'),
            eq(duoMemberships.status, 'INVITED')
          )
        )
      )
      .limit(1);
    
    if (!membership[0]) return null;
    
    const duo = await db
      .select()
      .from(duoAccounts)
      .where(eq(duoAccounts.id, membership[0].duoId))
      .limit(1);
    
    return duo[0] || null;
  }

  static async getDuoMembers(duoId: number) {
    return db
      .select({
        id: duoMemberships.id,
        userId: duoMemberships.userId,
        status: duoMemberships.status,
        slot: duoMemberships.slot,
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
      })
      .from(duoMemberships)
      .innerJoin(users, eq(users.id, duoMemberships.userId))
      .where(eq(duoMemberships.duoId, duoId));
  }

  static async getOtherDuoMember(duoId: number, currentUserId: number) {
    const members = await db
      .select({
        userId: duoMemberships.userId,
        status: duoMemberships.status,
        userFirstName: users.firstName,
        userLastName: users.lastName,
      })
      .from(duoMemberships)
      .innerJoin(users, eq(users.id, duoMemberships.userId))
      .where(
        and(
          eq(duoMemberships.duoId, duoId),
          ne(duoMemberships.userId, currentUserId),
          eq(duoMemberships.status, 'ACTIVE')
        )
      )
      .limit(1);
    
    return members[0] || null;
  }

  static async countActiveMembers(duoId: number): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(duoMemberships)
      .where(
        and(
          eq(duoMemberships.duoId, duoId),
          eq(duoMemberships.status, 'ACTIVE')
        )
      );
    return result[0]?.count ?? 0;
  }

  static async updateActivatedAt(duoId: number) {
    const activeCount = await this.countActiveMembers(duoId);
    
    if (activeCount === 2) {
      await db
        .update(duoAccounts)
        .set({ 
          activatedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(duoAccounts.id, duoId));
    } else {
      await db
        .update(duoAccounts)
        .set({ 
          activatedAt: null,
          updatedAt: new Date()
        })
        .where(eq(duoAccounts.id, duoId));
    }
  }

  static async createMoveRequest(params: {
    assetId: number;
    duoId: number;
    targetAccountId: number;
    initiatorUserId: number;
    validatorUserId: number;
    assetLabel: string;
    targetUserDisplay: string;
    initiatorUserDisplay: string;
  }) {
    const now = new Date();
    
    await db.transaction(async (tx) => {
      const existingPending = await tx
        .select()
        .from(assetMoveRequests)
        .where(
          and(
            eq(assetMoveRequests.assetId, params.assetId),
            eq(assetMoveRequests.status, 'PENDING')
          )
        )
        .limit(1);
      
      if (existingPending.length > 0) {
        throw new Error('PENDING_REQUEST_EXISTS');
      }

      const existingDeletePending = await tx
        .select()
        .from(assetDeleteRequests)
        .where(
          and(
            eq(assetDeleteRequests.assetId, params.assetId),
            eq(assetDeleteRequests.status, 'PENDING')
          )
        )
        .limit(1);
      
      if (existingDeletePending.length > 0) {
        throw new Error('PENDING_DELETE_REQUEST_EXISTS');
      }

      await tx
        .update(assets)
        .set({ lockState: 'PENDING_MOVE', updatedAt: now })
        .where(eq(assets.id, params.assetId));

      await tx.insert(assetMoveRequests).values({
        assetId: params.assetId,
        duoId: params.duoId,
        targetAccountId: params.targetAccountId,
        initiatorUserId: params.initiatorUserId,
        validatorUserId: params.validatorUserId,
        status: 'PENDING',
        copyJobStatus: 'NONE',
        assetLabelSnapshot: params.assetLabel,
        targetUserSnapshot: params.targetUserDisplay,
        initiatorUserSnapshot: params.initiatorUserDisplay,
        createdAt: now,
      });

      await tx.insert(notifications).values({
        userId: params.validatorUserId,
        type: 'DUO_MOVE_REQUEST',
        payloadJson: JSON.stringify({
          assetId: params.assetId,
          assetLabel: params.assetLabel,
          initiator: params.initiatorUserDisplay,
        }),
        dedupeKey: `move_request_${params.assetId}_${now}`,
        mustDeliver: false,
        createdAt: now,
      });
    });
  }

  static async createDeleteRequest(params: {
    assetId: number;
    duoId: number;
    initiatorUserId: number;
    validatorUserId: number;
    assetLabel: string;
    initiatorUserDisplay: string;
  }) {
    const now = new Date();
    
    await db.transaction(async (tx) => {
      const existingPending = await tx
        .select()
        .from(assetDeleteRequests)
        .where(
          and(
            eq(assetDeleteRequests.assetId, params.assetId),
            eq(assetDeleteRequests.status, 'PENDING')
          )
        )
        .limit(1);
      
      if (existingPending.length > 0) {
        throw new Error('PENDING_REQUEST_EXISTS');
      }

      const existingMovePending = await tx
        .select()
        .from(assetMoveRequests)
        .where(
          and(
            eq(assetMoveRequests.assetId, params.assetId),
            eq(assetMoveRequests.status, 'PENDING')
          )
        )
        .limit(1);
      
      if (existingMovePending.length > 0) {
        throw new Error('PENDING_MOVE_REQUEST_EXISTS');
      }

      await tx
        .update(assets)
        .set({ lockState: 'PENDING_DELETE', updatedAt: now })
        .where(eq(assets.id, params.assetId));

      await tx.insert(assetDeleteRequests).values({
        assetId: params.assetId,
        duoId: params.duoId,
        initiatorUserId: params.initiatorUserId,
        validatorUserId: params.validatorUserId,
        status: 'PENDING',
        assetLabelSnapshot: params.assetLabel,
        initiatorUserSnapshot: params.initiatorUserDisplay,
        createdAt: now,
      });

      await tx.insert(notifications).values({
        userId: params.validatorUserId,
        type: 'DUO_DELETE_REQUEST',
        payloadJson: JSON.stringify({
          assetId: params.assetId,
          assetLabel: params.assetLabel,
          initiator: params.initiatorUserDisplay,
        }),
        dedupeKey: `delete_request_${params.assetId}_${now}`,
        mustDeliver: false,
        createdAt: now,
      });
    });
  }

  static async respondToMoveRequest(params: {
    requestId: number;
    action: 'ACCEPT' | 'REFUSE';
    resolutionMode?: ResolutionMode;
    resolvedByUserId: number;
    resolvedByType: ResolvedByType;
  }) {
    const now = new Date();

    return db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(assetMoveRequests)
        .where(eq(assetMoveRequests.id, params.requestId))
        .limit(1);

      if (!request) {
        throw new Error('REQUEST_NOT_FOUND');
      }

      if (request.status !== 'PENDING') {
        throw new Error('REQUEST_ALREADY_RESOLVED');
      }

      if (params.action === 'ACCEPT') {
        await tx
          .update(assets)
          .set({ 
            accountId: request.targetAccountId,
            duoId: null,
            lockState: 'NONE',
            updatedAt: now
          })
          .where(eq(assets.id, request.assetId));

        await tx
          .update(assetMoveRequests)
          .set({
            status: 'ACCEPTED',
            resolutionMode: params.resolutionMode || 'MOVE_ONLY',
            resolvedAt: now,
            resolvedByUserId: params.resolvedByUserId,
            resolvedByType: params.resolvedByType,
          })
          .where(eq(assetMoveRequests.id, params.requestId));

        await tx.insert(notifications).values({
          userId: request.initiatorUserId,
          type: 'DUO_MOVE_ACCEPTED',
          payloadJson: JSON.stringify({
            assetLabel: request.assetLabelSnapshot,
            resolutionMode: params.resolutionMode || 'MOVE_ONLY',
          }),
          dedupeKey: `move_accepted_${params.requestId}_${now}`,
          mustDeliver: false,
          createdAt: now,
        });

        return { status: 'ACCEPTED', resolutionMode: params.resolutionMode || 'MOVE_ONLY' };
      } else {
        await tx
          .update(assets)
          .set({ lockState: 'NONE', updatedAt: now })
          .where(eq(assets.id, request.assetId));

        await tx
          .update(assetMoveRequests)
          .set({
            status: 'REFUSED',
            resolvedAt: now,
            resolvedByUserId: params.resolvedByUserId,
            resolvedByType: params.resolvedByType,
          })
          .where(eq(assetMoveRequests.id, params.requestId));

        await tx.insert(notifications).values({
          userId: request.initiatorUserId,
          type: 'DUO_MOVE_REFUSED',
          payloadJson: JSON.stringify({
            assetLabel: request.assetLabelSnapshot,
          }),
          dedupeKey: `move_refused_${params.requestId}_${now}`,
          mustDeliver: false,
          createdAt: now,
        });

        return { status: 'REFUSED' };
      }
    });
  }

  static async respondToDeleteRequest(params: {
    requestId: number;
    action: 'ACCEPT' | 'REFUSE';
    resolvedByUserId: number;
    resolvedByType: ResolvedByType;
  }) {
    const now = new Date();

    return db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(assetDeleteRequests)
        .where(eq(assetDeleteRequests.id, params.requestId))
        .limit(1);

      if (!request) {
        throw new Error('REQUEST_NOT_FOUND');
      }

      if (request.status !== 'PENDING') {
        throw new Error('REQUEST_ALREADY_RESOLVED');
      }

      if (params.action === 'ACCEPT') {
        await tx
          .update(assets)
          .set({ 
            deletedAt: now,
            lockState: 'NONE',
            updatedAt: now
          })
          .where(eq(assets.id, request.assetId));

        await tx
          .update(assetDeleteRequests)
          .set({
            status: 'ACCEPTED',
            resolvedAt: now,
            resolvedByUserId: params.resolvedByUserId,
            resolvedByType: params.resolvedByType,
          })
          .where(eq(assetDeleteRequests.id, params.requestId));

        await tx.insert(notifications).values({
          userId: request.initiatorUserId,
          type: 'DUO_DELETE_ACCEPTED',
          payloadJson: JSON.stringify({
            assetLabel: request.assetLabelSnapshot,
          }),
          dedupeKey: `delete_accepted_${params.requestId}_${now}`,
          mustDeliver: false,
          createdAt: now,
        });

        return { status: 'ACCEPTED' };
      } else {
        await tx
          .update(assets)
          .set({ lockState: 'NONE', updatedAt: now })
          .where(eq(assets.id, request.assetId));

        await tx
          .update(assetDeleteRequests)
          .set({
            status: 'REFUSED',
            resolvedAt: now,
            resolvedByUserId: params.resolvedByUserId,
            resolvedByType: params.resolvedByType,
          })
          .where(eq(assetDeleteRequests.id, params.requestId));

        await tx.insert(notifications).values({
          userId: request.initiatorUserId,
          type: 'DUO_DELETE_REFUSED',
          payloadJson: JSON.stringify({
            assetLabel: request.assetLabelSnapshot,
          }),
          dedupeKey: `delete_refused_${params.requestId}_${now}`,
          mustDeliver: false,
          createdAt: now,
        });

        return { status: 'REFUSED' };
      }
    });
  }

  static async leaveDuo(params: {
    duoId: number;
    userId: number;
  }) {
    const now = new Date();

    return db.transaction(async (tx) => {
      await tx
        .update(duoMemberships)
        .set({
          status: 'LEFT',
          slot: null,
          leftAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(duoMemberships.duoId, params.duoId),
            eq(duoMemberships.userId, params.userId)
          )
        );

      const pendingMoveRequests = await tx
        .select()
        .from(assetMoveRequests)
        .where(
          and(
            eq(assetMoveRequests.duoId, params.duoId),
            eq(assetMoveRequests.validatorUserId, params.userId),
            eq(assetMoveRequests.status, 'PENDING')
          )
        );

      for (const request of pendingMoveRequests) {
        await tx
          .update(assets)
          .set({ 
            accountId: request.targetAccountId,
            duoId: null,
            lockState: 'NONE',
            updatedAt: now
          })
          .where(eq(assets.id, request.assetId));

        await tx
          .update(assetMoveRequests)
          .set({
            status: 'ACCEPTED',
            resolutionMode: 'MOVE_ONLY',
            resolvedAt: now,
            resolvedByUserId: params.userId,
            resolvedByType: 'SYSTEM',
          })
          .where(eq(assetMoveRequests.id, request.id));
      }

      const pendingDeleteRequests = await tx
        .select()
        .from(assetDeleteRequests)
        .where(
          and(
            eq(assetDeleteRequests.duoId, params.duoId),
            eq(assetDeleteRequests.validatorUserId, params.userId),
            eq(assetDeleteRequests.status, 'PENDING')
          )
        );

      for (const request of pendingDeleteRequests) {
        await tx
          .update(assets)
          .set({ lockState: 'NONE', updatedAt: now })
          .where(eq(assets.id, request.assetId));

        await tx
          .update(assetDeleteRequests)
          .set({
            status: 'REFUSED',
            resolvedAt: now,
            resolvedByUserId: params.userId,
            resolvedByType: 'SYSTEM',
          })
          .where(eq(assetDeleteRequests.id, request.id));
      }

      const activeCount = await tx
        .select({ count: sql<number>`count(*)` })
        .from(duoMemberships)
        .where(
          and(
            eq(duoMemberships.duoId, params.duoId),
            eq(duoMemberships.status, 'ACTIVE')
          )
        );

      if ((activeCount[0]?.count ?? 0) < 2) {
        await tx
          .update(duoAccounts)
          .set({ activatedAt: null, updatedAt: now })
          .where(eq(duoAccounts.id, params.duoId));
      }
    });
  }

  static async getInbox(params: { duoId: number; userId: number }) {
    const moveRequests = await db
      .select({
        id: assetMoveRequests.id,
        assetId: assetMoveRequests.assetId,
        assetLabelSnapshot: assetMoveRequests.assetLabelSnapshot,
        initiatorUserSnapshot: assetMoveRequests.initiatorUserSnapshot,
        targetUserSnapshot: assetMoveRequests.targetUserSnapshot,
        createdAt: assetMoveRequests.createdAt,
      })
      .from(assetMoveRequests)
      .where(
        and(
          eq(assetMoveRequests.duoId, params.duoId),
          eq(assetMoveRequests.validatorUserId, params.userId),
          eq(assetMoveRequests.status, 'PENDING')
        )
      );

    const deleteRequests = await db
      .select({
        id: assetDeleteRequests.id,
        assetId: assetDeleteRequests.assetId,
        assetLabelSnapshot: assetDeleteRequests.assetLabelSnapshot,
        initiatorUserSnapshot: assetDeleteRequests.initiatorUserSnapshot,
        createdAt: assetDeleteRequests.createdAt,
      })
      .from(assetDeleteRequests)
      .where(
        and(
          eq(assetDeleteRequests.duoId, params.duoId),
          eq(assetDeleteRequests.validatorUserId, params.userId),
          eq(assetDeleteRequests.status, 'PENDING')
        )
      );

    const inbox = [
      ...moveRequests.map(r => ({
        request_id: r.id,
        type: 'MOVE' as const,
        asset_id: r.assetId,
        asset_label_snapshot: r.assetLabelSnapshot,
        initiator_display: r.initiatorUserSnapshot,
        target_display: r.targetUserSnapshot,
        created_at: r.createdAt,
        actions_allowed: ['ACCEPT', 'REFUSE'] as ('ACCEPT' | 'REFUSE')[],
      })),
      ...deleteRequests.map(r => ({
        request_id: r.id,
        type: 'DELETE' as const,
        asset_id: r.assetId,
        asset_label_snapshot: r.assetLabelSnapshot,
        initiator_display: r.initiatorUserSnapshot,
        target_display: null,
        created_at: r.createdAt,
        actions_allowed: ['ACCEPT', 'REFUSE'] as ('ACCEPT' | 'REFUSE')[],
      })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return inbox;
  }

  static async getRecoveryAssets(duoId: number) {
    return db
      .select({
        id: assets.id,
        label: assets.name,
        lock_state: assets.lockState,
      })
      .from(assets)
      .where(
        and(
          eq(assets.duoId, duoId),
          isNull(assets.deletedAt)
        )
      );
  }

  static async countAssetsForAccount(accountId: number): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(assets)
      .where(
        and(
          eq(assets.accountId, accountId),
          isNull(assets.deletedAt)
        )
      );
    return result[0]?.count ?? 0;
  }

  static async getUserAccount(userId: number) {
    const membership = await db
      .select({
        accountId: accountMemberships.accountId,
        accountName: accounts.name,
      })
      .from(accountMemberships)
      .innerJoin(accounts, eq(accounts.id, accountMemberships.accountId))
      .where(
        and(
          eq(accountMemberships.userId, userId),
          eq(accountMemberships.status, 'active')
        )
      )
      .limit(1);
    
    return membership[0] || null;
  }

  static async getUserDisplayName(userId: number): Promise<string> {
    const [user] = await db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    
    if (!user) return 'Utilisateur inconnu';
    
    if (user.firstName || user.lastName) {
      return `${user.firstName || ''} ${user.lastName || ''}`.trim();
    }
    return user.email;
  }
}
