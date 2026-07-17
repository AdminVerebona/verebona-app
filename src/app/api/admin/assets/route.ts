import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, users, assetTypes, accounts } from '@/db/schema';
import { eq, like, and, desc, isNull, sql } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get('search');
    const accountSearch = searchParams.get('accountSearch');
    const category = searchParams.get('category');
    const statusParam = searchParams.get('status');
    const userIdParam = searchParams.get('userId');
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20'), 100);
    const offset = (page - 1) * limit;

    const conditions = [isNull(assets.deletedAt)];

    if (search) conditions.push(like(assets.name, `%${search}%`));
    if (category) conditions.push(eq(assets.category, category));
    if (statusParam) conditions.push(eq(assets.status, statusParam));
    if (accountSearch) conditions.push(like(accounts.name, `%${accountSearch}%`));
    if (userIdParam) {
      const userId = parseInt(userIdParam);
      if (!isNaN(userId)) conditions.push(eq(accounts.ownerUserId, userId));
    }

    const where = and(...conditions);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(assets)
      .leftJoin(accounts, eq(assets.accountId, accounts.id))
      .where(where);

    const results = await db
      .select({
        id: assets.id,
        userId: assets.userId,
        accountId: assets.accountId,
        category: assets.category,
        subtype: assets.subtype,
        name: assets.name,
        purchaseDate: assets.purchaseDate,
        purchasePrice: assets.purchasePriceCents,
        status: assets.status,
        notes: assets.notes,
        createdAt: assets.createdAt,
        updatedAt: assets.updatedAt,
        ownerEmail: users.email,
        ownerFirstName: users.firstName,
        ownerLastName: users.lastName,
        accountName: accounts.name,
        categoryLabel: assetTypes.label,
      })
      .from(assets)
      .leftJoin(accounts, eq(assets.accountId, accounts.id))
      .leftJoin(users, eq(assets.userId, users.id))
      .leftJoin(assetTypes, eq(assets.category, assetTypes.code))
      .where(where)
      .orderBy(desc(assets.createdAt))
      .limit(limit)
      .offset(offset);

    const mappedResults = results.map(row => ({
      id: row.id,
      userId: row.userId,
      accountId: row.accountId,
      category: row.category ?? '',
      categoryLabel: row.categoryLabel ?? row.category ?? 'Type inconnu',
      subtype: row.subtype ?? null,
      name: row.name ?? 'Sans nom',
      purchaseDate: row.purchaseDate ?? null,
      purchasePrice: row.purchasePrice ? (row.purchasePrice / 100).toFixed(2) : null,
      status: row.status ?? 'EN_SERVICE',
      notes: row.notes ?? null,
      accountName: row.accountName ?? null,
      createdAt: row.createdAt ?? new Date().toISOString(),
      updatedAt: row.updatedAt ?? new Date().toISOString(),
      owner: {
        email: row.ownerEmail ?? 'inconnu@inconnu.com',
        firstName: row.ownerFirstName ?? 'Utilisateur',
        lastName: row.ownerLastName ?? 'supprimé',
      },
    }));

    return NextResponse.json({ assets: mappedResults, total: Number(total), page, limit }, { status: 200 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg === 'INSUFFICIENT_PERMISSIONS') return NextResponse.json({ error: msg }, { status: 403 });
    if (['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED'].includes(msg)) return NextResponse.json({ error: msg }, { status: 401 });
    console.error('GET admin assets error:', error);
    return NextResponse.json({ error: 'INTERNAL_SERVER_ERROR', message: msg }, { status: 500 });
  }
}