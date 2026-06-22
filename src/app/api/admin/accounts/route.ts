import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accounts, users, accountMemberships, assets, duoAccounts } from '@/db/schema';
import { eq, count, sql, inArray } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const allAccounts = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        ownerId: accounts.ownerUserId,
        createdAt: accounts.createdAt,
        ownerEmail: users.email,
        ownerName: sql<string>`COALESCE(${users.firstName} || ' ' || ${users.lastName}, ${users.email})`,
        planType: accounts.planType,
        subscriptionStatus: accounts.subscriptionStatus,
        stripeCustomerId: accounts.stripeCustomerId,
        premiumUntil: accounts.premiumUntil,
        duoAccountId: accounts.duoAccountId,
        duoStatus: duoAccounts.subscriptionStatus,
      })
      .from(accounts)
      .leftJoin(users, eq(accounts.ownerUserId, users.id))
      .leftJoin(duoAccounts, eq(accounts.duoAccountId, duoAccounts.id));

    // Remplace le pattern N+1 (2 requêtes × N accounts) par 2 requêtes agrégées globales
    const accountIds = allAccounts.map(a => a.id);

    const [memberCountRows, assetCountRows] = accountIds.length > 0
      ? await Promise.all([
          db.select({ accountId: accountMemberships.accountId, cnt: count() })
            .from(accountMemberships)
            .where(sql`${accountMemberships.accountId} = ANY(${sql.raw(`ARRAY[${accountIds.join(',')}]::int[]`)}) AND ${accountMemberships.status} = 'active'`)
            .groupBy(accountMemberships.accountId),
          db.select({ accountId: assets.accountId, cnt: count() })
            .from(assets)
            .where(inArray(assets.accountId, accountIds))
            .groupBy(assets.accountId),
        ])
      : [[], []];

    const memberCountMap: Record<number, number> = {};
    const assetCountMap: Record<number, number> = {};
    for (const r of memberCountRows) if (r.accountId) memberCountMap[r.accountId] = Number(r.cnt);
    for (const r of assetCountRows) if (r.accountId) assetCountMap[r.accountId] = Number(r.cnt);

    // Normalise les anciens plans vers le nouveau modèle commercial
    const normalizePlan = (p: string | null) => {
      if (!p) return 'STANDARD';
      return p.toUpperCase();
    };

    const accountsWithStats = allAccounts.map(account => ({
      ...account,
      planType: normalizePlan(account.planType),
      memberCount: memberCountMap[account.id] ?? 0,
      assetCount: assetCountMap[account.id] ?? 0,
    }));

    return NextResponse.json({ accounts: accountsWithStats });
  } catch (error) {
    const errMsg = (error as Error).message;
    if (['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED', 'INSUFFICIENT_PERMISSIONS'].includes(errMsg)) {
      return SessionService.handleSessionError(error);
    }
    console.error('Failed to fetch accounts:', error);
    return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 });
  }
}
