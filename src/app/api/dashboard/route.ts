import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, assets, adminAuditLog, accounts, accountMemberships } from '@/db/schema';
import { eq, desc, count, sql, gte, and, inArray } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';


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

    // ══════════════════════════════════════════════════════════════════════
    // INDICATEUR DE SAUVEGARDE RETIRÉ
    //
    // Il lisait `backups/*.json` sur S3 — les fichiers du mécanisme maison,
    // supprimé au profit de l'add-on PostgreSQL de Scalingo.
    //
    // Le conserver afficherait « système critique » en permanence, puisque
    // plus aucun fichier n'est écrit là : une alerte qui ne correspond à
    // rien finit par être ignorée, y compris quand elle a raison.
    //
    // L'état réel des sauvegardes se lit dans la console Scalingo, onglet
    // Backups de l'add-on, où figurent aussi le téléchargement et la
    // restauration.
    // ══════════════════════════════════════════════════════════════════════

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
        // `backupStatus` retiré : voir le commentaire plus haut.
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
