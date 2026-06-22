import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, assets, assetFiles, events, deadlines, adminAuditLog, subscriptionHistory, accounts, accountMemberships, assetTransmissions, duoAccounts, duoMemberships } from '@/db/schema';
import { eq, and, sql, isNull, desc, inArray } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAdmin(request);

    const userId = params.id;
    if (!userId || isNaN(parseInt(userId))) {
      return NextResponse.json({ 
        error: 'Valid ID is required',
        code: 'INVALID_ID'
      }, { status: 400 });
    }

    const userIdParam = parseInt(userId);

    // Fetch user by id
    const userResultFinal = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
      company: users.company,
      planType: users.planType,
      isActive: users.isActive,
      locale: users.locale,
      role: users.role,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
      .from(users)
      .where(eq(users.id, userIdParam))
      .limit(1);

    if (userResultFinal.length === 0) {
      return NextResponse.json({ 
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      }, { status: 404 });
    }

    const user = userResultFinal[0];

    // Find all accounts where this user is a member
    const userAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .innerJoin(accountMemberships, eq(accounts.id, accountMemberships.accountId))
      .where(eq(accountMemberships.userId, userIdParam));
    
    const accountIds = userAccounts.map(a => a.id);

    // Fetch user's assets (from all accounts they belong to)
    const userAssets = accountIds.length > 0 
      ? await db
          .select({
            id: assets.id,
            name: assets.name,
            category: assets.category,
            createdAt: assets.createdAt,
          })
          .from(assets)
          .where(sql`${assets.accountId} IN (${sql.join(accountIds)})`)
      : [];

    // Get counts for stats
    const documentsCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(assetFiles)
      .where(and(
        accountIds.length > 0 ? sql`${assetFiles.accountId} IN (${sql.join(accountIds)})` : sql`1=0`,
        isNull(assetFiles.deletedAt)
      ));
    const documentsCount = Number(documentsCountResult[0]?.count ?? 0);

    const eventsCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(events)
      .where(eq(events.userId, userIdParam));
    const eventsCount = Number(eventsCountResult[0]?.count ?? 0);

    const deadlinesCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deadlines)
      .where(eq(deadlines.userId, userIdParam));
    const deadlinesCount = Number(deadlinesCountResult[0]?.count ?? 0);

    // Fetch subscription history
    const subHistory = await db
      .select()
      .from(subscriptionHistory)
      .where(eq(subscriptionHistory.userId, userIdParam))
      .orderBy(desc(subscriptionHistory.createdAt))
      .limit(50);

    // Find the primary account (owned by the user) for subscription details
    const primaryAccountResult = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        planType: accounts.planType,
        stripeCustomerId: accounts.stripeCustomerId,
        stripeSubscriptionId: accounts.stripeSubscriptionId,
        subscriptionTier: accounts.subscriptionTier,
        premiumUntil: accounts.premiumUntil,
        proUntil: accounts.proUntil,
      })
      .from(accounts)
      .where(eq(accounts.ownerUserId, userIdParam))
      .limit(1);

    const account = primaryAccountResult[0] || null;

    // Find account this user is a member of (if not owner)
    const memberAccountResult = account ? null : await db
      .select({
        id: accounts.id,
        name: accounts.name,
        planType: accounts.planType,
      })
      .from(accounts)
      .innerJoin(accountMemberships, eq(accounts.id, accountMemberships.accountId))
      .where(eq(accountMemberships.userId, userIdParam))
      .limit(1);

    const linkedAccount = account ?? memberAccountResult?.[0] ?? null;

    return NextResponse.json({
      user: {
        ...user,
        stripeCustomerId: account?.stripeCustomerId || null,
        stripeSubscriptionId: account?.stripeSubscriptionId || null,
        subscriptionTier: account?.subscriptionTier || 'free',
        premiumUntil: account?.premiumUntil || null,
        proUntil: account?.proUntil || null,
      },
      account: linkedAccount,
      assets: userAssets,
      stats: {
        documentsCount,
        eventsCount,
        deadlinesCount,
      },
      subscriptionHistory: subHistory,
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET error:', error);
    return SessionService.handleSessionError(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
      const adminUserId = await await requireAdmin(request);

      const adminUserResult = await db
        .select()
        .from(users)
        .where(eq(users.id, adminUserId))
        .limit(1);

      if (adminUserResult.length === 0) {
        return NextResponse.json(
          { error: 'Admin user not found', code: 'ADMIN_NOT_FOUND' },
          { status: 404 }
        );
      }

      const adminUser = adminUserResult[0];
      const userId = params.id;
      const targetUserId = parseInt(userId);

    const targetUserResult = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (targetUserResult.length === 0) {
      return NextResponse.json(
        { error: 'User not found', code: 'USER_NOT_FOUND' },
        { status: 404 }
      );
    }

    const targetUser = targetUserResult[0];
    const body = await request.json();
    const { firstName, lastName, username, company, planType, locale, status, role } = body;

    const updateData: any = {
      updatedAt: new Date(),
    };

    const changedFields: string[] = [];
    if (firstName !== undefined && firstName !== targetUser.firstName) {
      updateData.firstName = firstName.trim();
      changedFields.push('firstName');
    }
    if (lastName !== undefined && lastName !== targetUser.lastName) {
      updateData.lastName = lastName.trim();
      changedFields.push('lastName');
    }
    if (username !== undefined && username !== targetUser.username) {
      updateData.username = username ? username.trim() : null;
      changedFields.push('username');
    }
    if (company !== undefined && company !== targetUser.company) {
      updateData.company = company || null;
      changedFields.push('company');
    }
    if (planType !== undefined && planType !== targetUser.planType) {
      updateData.planType = planType;
      changedFields.push('planType');
    }
    if (locale !== undefined && locale !== targetUser.locale) {
      updateData.locale = locale;
      changedFields.push('locale');
    }
    if (status !== undefined && status !== targetUser.status) {
      updateData.status = status;
      changedFields.push('status');
    }
    if (role !== undefined && role !== targetUser.role) {
      updateData.role = role;
      changedFields.push('role');
    }

    if (changedFields.length === 0) {
      const { passwordHash, ...userWithoutPassword } = targetUser;
      return NextResponse.json(userWithoutPassword, { status: 200 });
    }

    const updatedUser = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, targetUserId))
      .returning();

    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: adminUserId,
      adminEmail: adminUser.email,
      actionType: 'USER_UPDATE',
      targetType: 'USER',
      targetId: targetUserId,
      details: JSON.stringify({
        changedFields,
        previousValues: Object.fromEntries(
          changedFields.map(field => [field, targetUser[field as keyof typeof targetUser]])
        ),
        newValues: Object.fromEntries(
          changedFields.map(field => [field, updateData[field]])
        ),
      }),
    });

    const { passwordHash, ...userWithoutPassword } = updatedUser[0];
    return NextResponse.json(userWithoutPassword, { status: 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('PUT error:', error);
    return SessionService.handleSessionError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
      const adminUserId = await await requireAdmin(request);

      const adminUserResult = await db
        .select()
        .from(users)
        .where(eq(users.id, adminUserId))
      .limit(1);

    if (adminUserResult.length === 0) {
      return NextResponse.json({ error: 'Admin user not found' }, { status: 404 });
    }

    const adminUser = adminUserResult[0];
    const targetUserId = parseInt(params.id);

    const body = await request.json();
    if (body.confirmId !== targetUserId) {
      return NextResponse.json({ error: 'Confirmation ID mismatch' }, { status: 400 });
    }

    const [targetUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Nullify assetTransmissions user FKs (no onDelete clause on these columns)
    await db.execute(sql`UPDATE asset_transmissions SET initiator_user_id = NULL WHERE initiator_user_id = ${targetUserId}`);
    await db.execute(sql`UPDATE asset_transmissions SET recipient_user_id = NULL WHERE recipient_user_id = ${targetUserId}`);

    // Find owned account and nullify assetTransmissions duplicatedAssetId FK before cascade
    const [ownedAccount] = await db.select({ id: accounts.id })
      .from(accounts).where(eq(accounts.ownerUserId, targetUserId)).limit(1);

    if (ownedAccount) {
      const accountAssets = await db.select({ id: assets.id })
        .from(assets).where(eq(assets.accountId, ownedAccount.id));
      if (accountAssets.length > 0) {
        const assetIds = accountAssets.map(a => a.id);
        await db.update(assetTransmissions).set({ duplicatedAssetId: null })
          .where(inArray(assetTransmissions.duplicatedAssetId, assetIds));
      }

      // Delete duo data linked to this owner
      const duoList = await db.select({ id: duoAccounts.id })
        .from(duoAccounts).where(eq(duoAccounts.billingOwnerUserId, targetUserId));
      for (const duo of duoList) {
        await db.delete(duoMemberships).where(eq(duoMemberships.duoId, duo.id));
        await db.delete(duoAccounts).where(eq(duoAccounts.id, duo.id));
      }

      // Delete the account (cascades memberships, assets, audit logs, etc.)
      await db.delete(accounts).where(eq(accounts.id, ownedAccount.id));
    }

    const deletedUser = await db
      .delete(users)
      .where(eq(users.id, targetUserId))
      .returning();

    const deletedRecord = deletedUser[0] ?? targetUser;
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: adminUserId,
      adminEmail: adminUser.email,
      actionType: 'USER_DELETE',
      targetType: 'USER',
      targetId: targetUserId,
      details: JSON.stringify({
        userEmail: deletedRecord.email,
        userName: `${deletedRecord.firstName} ${deletedRecord.lastName}`,
      }),
    });

    const { passwordHash, ...userWithoutPassword } = deletedRecord;
    return NextResponse.json({
      message: 'User deleted successfully',
      deletedUser: userWithoutPassword,
    }, { status: 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('DELETE error:', error);
    return SessionService.handleSessionError(error);
  }
}
