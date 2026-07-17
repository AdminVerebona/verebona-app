import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, assets, adminAuditLog, accounts, accountMemberships } from '@/db/schema';
import { eq, desc, count, sql, gte, and, inArray } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: process.env.OVH_S3_REGION || 'gra',
  endpoint: process.env.OVH_S3_ENDPOINT || 'https://s3.gra.io.cloud.ovh.net',
  credentials: {
    accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true,
});

const bucketName = process.env.OVH_S3_BUCKET || 'verebona-files';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoISO = thirtyDaysAgo.toISOString();

    const [
      totalUsersResult,
      activeUsersResult,
      totalAssetsResult,
      recentSignupsResult,
      totalAccountsResult,
        premiumAccountsResult,
        standardAccountsResult,
        usersWithoutAccountResult,
        totalMembershipsResult,
        activeMembershipsResult,
        pendingMembershipsResult,
        backupResult,
        premiumAccountsWith2UsersResult,
      ] = await Promise.all([
        db.select({ count: count() }).from(users),
        db.select({ count: count() })
          .from(users)
          .where(eq(users.status, 'ACTIVE')),
        db.select({ count: count() }).from(assets),
        db.select({ count: count() })
          .from(users)
          .where(gte(users.createdAt, thirtyDaysAgo)),
        db.select({ count: count() }).from(accounts),
        // Premium = tous les plans payants
        db.select({ count: count() })
          .from(accounts)
          .where(inArray(accounts.planType, ['PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO'])),
        // Standard = STANDARD uniquement
        db.select({ count: count() })
          .from(accounts)
          .where(eq(accounts.planType, 'STANDARD')),
        db.select({ count: count() })
          .from(users)
          .where(
            and(
              sql`NOT EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.ownerUserId} = ${users.id})`,
              sql`NOT EXISTS (SELECT 1 FROM ${accountMemberships} WHERE ${accountMemberships.userId} = ${users.id} AND ${accountMemberships.status} = 'active')`
            )
          ),
      db.select({ count: count() }).from(accountMemberships),
      db.select({ count: count() })
        .from(accountMemberships)
        .where(eq(accountMemberships.status, 'active')),
      db.select({ count: count() })
        .from(accountMemberships)
        .where(eq(accountMemberships.status, 'pending')),
      Promise.race([
        s3Client.send(new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: 'backups/',
          MaxKeys: 100,
        })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
      ]).catch(err => {
        console.error('Dashboard S3 error:', err);
        return null;
      }),
      // Comptes premium avec ≥ 2 membres — inclus dans le Promise.all pour paralléliser
      // Comptes PREMIUM_DUO avec ≥ 2 membres actifs
      db.select({
          accountId: accountMemberships.accountId,
          memberCount: count()
        })
        .from(accountMemberships)
        .leftJoin(accounts, eq(accountMemberships.accountId, accounts.id))
        .where(
          and(
            eq(accounts.planType, 'PREMIUM_DUO'),
            eq(accountMemberships.status, 'active')
          )
        )
        .groupBy(accountMemberships.accountId)
        .having(sql`COUNT(*) >= 2`),
    ]);

    // Process backup status
    let backupStatus = null;
    if (backupResult && backupResult.Contents) {
      const backups = backupResult.Contents
        .filter(obj => obj.Key && obj.Key.endsWith('.json'))
        .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

      if (backups.length > 0) {
        const lastModified = backups[0].LastModified;
        if (lastModified) {
          const now = new Date();
          const hours = Math.round((now.getTime() - lastModified.getTime()) / (1000 * 60 * 60));
          backupStatus = {
            status: hours > 48 ? 'error' : hours > 24 ? 'warning' : 'ok',
            lastBackupDate: lastModified.toISOString(),
            hoursSinceLastBackup: hours
          };
        }
      }
    }

      const stats = {
        totalUsers: totalUsersResult[0].count,
        activeUsers: activeUsersResult[0].count,
        totalAssets: totalAssetsResult[0].count,
        recentSignups: recentSignupsResult[0].count,
        totalAccounts: totalAccountsResult[0].count,
        premiumAccounts: premiumAccountsResult[0].count,
        standardAccounts: standardAccountsResult[0].count,
        usersWithoutAccount: usersWithoutAccountResult[0].count,
        totalMemberships: totalMembershipsResult[0].count,
        activeMemberships: activeMembershipsResult[0].count,
        pendingMemberships: pendingMembershipsResult[0].count,
        premiumAccountsWith2Users: (premiumAccountsWith2UsersResult as { accountId: number; memberCount: number }[]).length
      };

    // Fetch last 10 users (excluding passwordHash)
    const lastUsers = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      createdAt: users.createdAt
    })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(10);

    // Fetch last 10 audit log entries (graceful fallback if table missing)
    let lastAuditLogs: any[] = [];
    try {
      lastAuditLogs = await db.select()
        .from(adminAuditLog)
        .orderBy(desc(adminAuditLog.timestamp))
        .limit(10);
    } catch (auditErr) {
      console.error('Admin audit log query failed (table may not exist):', auditErr);
    }

    return NextResponse.json({
      stats,
      lastUsers,
      lastAuditLogs,
      backupStatus
    });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Auth errors → proper 401/403
    if (['INVALID_TOKEN', 'AUTH_REQUIRED', 'INSUFFICIENT_PERMISSIONS', 'ACCOUNT_SUSPENDED'].includes(message)) {
      const { SessionService } = await import('@/lib/session-service');
      return SessionService.handleSessionError(error);
    }
    console.error('GET admin dashboard error:', message, error);
    return NextResponse.json(
      { error: message, code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}
