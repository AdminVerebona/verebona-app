import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifyAccessToken } from '@/lib/jwt';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users, accounts, accountMemberships, duoAccounts, duoMemberships } from '@/db/schema';
import { eq, and, or } from 'drizzle-orm';
import { serverCacheGet, serverCacheSet } from '@/lib/server-cache';
import { deleteUserNotificationData } from '@/lib/notifications/account-cleanup';

export async function GET(request: NextRequest) {
  try {
    const token = extractAccessToken(request);

    if (!token) {
      return NextResponse.json(
        { error: 'AUTH_REQUIRED', message: 'Authentification requise' },
        { status: 401 }
      );
    }

    const payload = await verifyAccessToken(token);

    if (!payload) {
      return NextResponse.json(
        { error: 'INVALID_TOKEN', message: 'Token invalide ou expiré' },
        { status: 401 }
      );
    }

    if (payload.status === 'SUSPENDED' || payload.status === 'DELETED') {
      return NextResponse.json(
        { error: 'ACCOUNT_SUSPENDED', message: 'Compte suspendu ou supprimé' },
        { status: 403 }
      );
    }

    // Cache serveur 30s : /api/users/me est appelé sur chaque page dashboard
    const cacheKey = `users:me:${payload.userId}`;
    const cached = serverCacheGet<object>(cacheKey);
    if (cached) {
      const meResponse = NextResponse.json(cached);
      meResponse.headers.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
      return meResponse;
    }

    const [userRows, duoMembershipData] = await Promise.all([
      db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          username: users.username,
          company: users.company,
          role: users.role,
          planType: users.planType,
          status: users.status,
          hasSeenUploadNotice: users.hasSeenUploadNotice,
          accountName: accounts.name,
          accountId: accounts.id,
          subscriptionStatus: accounts.subscriptionStatus,
          pastDueGraceStartedAt: accounts.pastDueGraceStartedAt,
          pastDueGraceEndsAt: accounts.pastDueGraceEndsAt,
        })
        .from(users)
        .leftJoin(accountMemberships, and(
          eq(accountMemberships.userId, users.id),
          or(eq(accountMemberships.status, 'active'), eq(accountMemberships.status, 'ACTIVE'))
        ))
        .leftJoin(accounts, eq(accounts.id, accountMemberships.accountId))
        .where(eq(users.id, payload.userId))
        .limit(1),
      db
        .select({
          duoId: duoMemberships.duoId,
          membershipStatus: duoMemberships.status,
          slot: duoMemberships.slot,
          duoSubscriptionStatus: duoAccounts.subscriptionStatus,
          duoActivatedAt: duoAccounts.activatedAt,
          graceDeadlineAt: duoAccounts.graceDeadlineAt,
          billingOwnerUserId: duoAccounts.billingOwnerUserId,
        })
        .from(duoMemberships)
        .innerJoin(duoAccounts, eq(duoAccounts.id, duoMemberships.duoId))
        .where(
          and(
            eq(duoMemberships.userId, payload.userId),
            or(
              eq(duoMemberships.status, 'ACTIVE'),
              eq(duoMemberships.status, 'INVITED')
            )
          )
        )
        .limit(1),
    ]);

    const [userData] = userRows;

    if (!userData) {
      return NextResponse.json(
        { error: 'USER_NOT_FOUND', message: 'Utilisateur introuvable' },
        { status: 404 }
      );
    }

    const duoInfo = duoMembershipData[0] || null;

    // users.planType est la source de vérité : STANDARD | PREMIUM | PREMIUM_DUO | PREMIUM_PRO
    const effectivePlan = userData.planType ? userData.planType.toUpperCase() : 'STANDARD';

    const duoEntitlement = effectivePlan === 'PREMIUM_DUO';

    const isDuoGuest = duoInfo && duoInfo.billingOwnerUserId !== payload.userId;
    const rawSubscriptionStatus = isDuoGuest
      ? duoInfo.duoSubscriptionStatus
      : userData.subscriptionStatus;

    let finalSubscriptionStatus = rawSubscriptionStatus || 'NONE';

    if (!isDuoGuest && userData.subscriptionStatus === 'PAST_DUE_GRACE' && userData.pastDueGraceEndsAt && userData.accountId) {
      const now = new Date();
      if (now > userData.pastDueGraceEndsAt) {
        await db
          .update(accounts)
          .set({ subscriptionStatus: 'EXPIRED', updatedAt: now })
          .where(eq(accounts.id, userData.accountId));
        finalSubscriptionStatus = 'EXPIRED';
      }
    }

    const meResponse = NextResponse.json({
      id: userData.id,
      email: userData.email,
      firstName: userData.firstName,
      lastName: userData.lastName,
      username: userData.username ?? null,
      company: userData.company ?? null,
      accountName: userData.accountName,
      role: userData.role,
      hasSeenUploadNotice: userData.hasSeenUploadNotice ?? false,
      subscription: {
        plan: effectivePlan,
        status: finalSubscriptionStatus,
      },
      subscription_status: finalSubscriptionStatus,
      duoId: duoInfo?.duoId ?? null,
      duoStatus: duoInfo?.duoSubscriptionStatus ?? null,
      duoRole: duoInfo ? (duoInfo.billingOwnerUserId === payload.userId ? 'BILLING_OWNER' : 'MEMBER') : null,
      duoActivatedAt: duoInfo?.duoActivatedAt ?? null,
      graceDeadlineAt: duoInfo?.graceDeadlineAt ?? null,
      isInRecovery: duoInfo?.duoSubscriptionStatus === 'UNPAID_RECOVERY',
      duoEntitlement,
      effectivePlan,
    });
    const responseBody = await meResponse.json();
    serverCacheSet(cacheKey, responseBody, 30_000);
    meResponse.headers.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
    return meResponse;
  } catch (error) {
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await SessionService.getSession(req);

    const body = await req.json().catch(() => ({}));
    const { confirmation } = body as { confirmation?: string };

    if (confirmation !== 'SUPPRIMER MON COMPTE') {
      return NextResponse.json({ error: 'INVALID_CONFIRMATION' }, { status: 400 });
    }

    // Soft-delete: mark user as DELETED and anonymise PII
    const deletedAt = new Date();

    // RGPD (§19.4) : supprimer explicitement les données de notification,
    // car l'anonymisation ne déclenche pas les cascades FK.
    try {
      await deleteUserNotificationData(session.userId);
    } catch (err) {
      console.error('[users/me DELETE] purge notifications échouée:', err);
    }

    await db.update(users).set({
      status: 'DELETED',
      email: `deleted_${session.userId}_${Date.now()}@deleted.invalid`,
      firstName: 'Compte',
      lastName: 'Supprimé',
      username: null,
      passwordHash: '',
      updatedAt: deletedAt,
    }).where(eq(users.id, session.userId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }

    const body = await req.json();
    const { firstName, lastName, username, company } = body;

    if (!firstName?.trim() || !lastName?.trim()) {
      return NextResponse.json({ error: 'Le prénom et le nom sont requis' }, { status: 400 });
    }

    await db.update(users).set({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      username: username?.trim() || null,
      company: company?.trim() || null,
      updatedAt: new Date(),
    }).where(eq(users.id, session.userId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
