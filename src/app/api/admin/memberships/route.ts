import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accountMemberships, accounts, users } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const allMemberships = await db
      .select({
        id: accountMemberships.id,
        accountId: accountMemberships.accountId,
        accountName: accounts.name,
        userId: accountMemberships.userId,
        userEmail: users.email,
        userName: sql<string>`COALESCE(${users.firstName} || ' ' || ${users.lastName}, ${users.email})`,
        role: accountMemberships.role,
        status: accountMemberships.status,
        invitedBy: accountMemberships.invitedBy,
        inviteToken: accountMemberships.inviteToken,
        inviteTokenExpiresAt: accountMemberships.inviteTokenExpiresAt,
        createdAt: accountMemberships.createdAt,
        updatedAt: accountMemberships.updatedAt,
      })
      .from(accountMemberships)
      .leftJoin(accounts, eq(accountMemberships.accountId, accounts.id))
      .leftJoin(users, eq(accountMemberships.userId, users.id))
      .orderBy(sql`${accountMemberships.createdAt} DESC`);

    return NextResponse.json({ memberships: allMemberships });
  } catch (error) {
    console.error('Failed to fetch memberships:', error);
    return NextResponse.json(
      { error: 'Failed to fetch memberships' },
      { status: 500 }
    );
  }
}
