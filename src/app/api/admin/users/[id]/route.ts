import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, assets, assetFiles, events, deadlines, subscriptionHistory, accounts, accountMemberships } from '@/db/schema';
import { eq, and, sql, isNull, desc, inArray } from 'drizzle-orm';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';
import { logAdminAction } from '@/lib/admin-audit';
import {
  ADMIN_ROLES,
  isActiveAdmin,
  isAdminRole,
  setUserAdminStatus,
  UserAdminError,
} from '@/services/admin/user-admin.service';
import { parseUserId, invalidUserId, userAdminErrorResponse } from './_shared';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
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

    // USR-A09 / UX-003 : l'interface désactive, avec son motif, le retrait du
    // statut admin et la désactivation du dernier administrateur actif. Le
    // serveur refuse de toute façon (409 LAST_ADMIN).
    const activeAdminRows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.role, [...ADMIN_ROLES]), eq(users.status, 'ACTIVE')));
    const adminStatus = {
      isAdmin: isAdminRole(user.role),
      isLastActiveAdmin: isActiveAdmin(user) && activeAdminRows.length <= 1,
    };

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
      adminStatus,
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

/**
 * PUT /api/admin/users/[id] — statut administrateur UNIQUEMENT.
 *
 * CDC Back-Office V1 SEC-004 / USR-A08 / USR-A09 / USR-A10 : le BO ne modifie
 * jamais l'identité (nom, prénom, société, e-mail, langue), ni l'offre, ni le
 * statut par ce biais. Le seul changement admis est l'octroi ou le retrait du
 * statut administrateur : `{ "isAdmin": boolean }`. Tout autre champ est
 * refusé (400) plutôt qu'ignoré, pour qu'un client obsolète ne croie pas avoir
 * modifié quelque chose.
 *
 * Le retrait du dernier administrateur actif est refusé (409 LAST_ADMIN, en
 * transaction). Le retrait révoque les sessions de la cible.
 *
 * DELETE a été supprimé : la suppression passe par la fiche Compte et le
 * workflow unique de suppression (ACC-A14).
 */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const userId = parseUserId((await context.params).id);
  if (!userId) return invalidUserId();

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const extraFields = body ? Object.keys(body).filter((k) => k !== 'isAdmin') : [];
  if (!body || typeof body.isAdmin !== 'boolean' || extraFields.length > 0) {
    return NextResponse.json(
      {
        error: 'READ_ONLY_FIELDS',
        code: 'READ_ONLY_FIELDS',
        message:
          "Seul le statut administrateur est modifiable depuis le back-office (corps attendu : { isAdmin: boolean }).",
        rejectedFields: extraFields,
      },
      { status: 400 },
    );
  }
  const makeAdmin = body.isAdmin;

  try {
    const change = await setUserAdminStatus(userId, makeAdmin);
    if (change.changed) {
      await logAdminAction({
        adminId,
        action: 'USER_ADMIN_ROLE_CHANGE',
        targetType: 'USER',
        targetId: userId,
        result: 'SUCCESS',
        before: change.before,
        after: change.after,
        details: { sessionsRevoked: !makeAdmin },
      });
    }
    return NextResponse.json({ success: true, role: change.after.role, changed: change.changed });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    const denied = error instanceof UserAdminError;
    await logAdminAction({
      adminId,
      action: 'USER_ADMIN_ROLE_CHANGE',
      targetType: 'USER',
      targetId: userId,
      result: denied ? 'DENIED' : 'FAILURE',
      after: { isAdmin: makeAdmin },
      details: { error: denied ? error.code : (error as Error).message },
    });
    if (denied) return userAdminErrorResponse(error);
    console.error('[admin/users PUT] échec :', error);
    return NextResponse.json(
      { error: 'ROLE_CHANGE_FAILED', code: 'ROLE_CHANGE_FAILED', message: 'Le changement de statut administrateur a échoué.' },
      { status: 500 },
    );
  }
}
