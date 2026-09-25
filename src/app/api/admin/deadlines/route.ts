/**
 * CDC Back-Office V1 — LECTURE SEULE.
 * GEN-001 / SEC-003 : aucune création, modification ni suppression d'échéance depuis le BO.
 * Les handlers POST, PUT et DELETE ont été supprimés ; seule la consultation reste.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { deadlines, users, assets } from '@/db/schema';
import { eq, like, and, gt, desc, gte, lte, or } from 'drizzle-orm';
import { parsePaginationParams, getCursorId, encodeCursor } from '@/lib/pagination';
import { requireAdmin } from '@/lib/auth-guards';

const VALID_DEADLINE_TYPES = ['ENTRETIEN', 'CONTROLE_TECHNIQUE', 'ASSURANCE', 'GARANTIE', 'ADMINISTRATIF', 'AUTRE'] as const;

export async function GET(request: NextRequest) {
  try {
    // ✅ Authentification admin requise
    await requireAdmin(request); // Throws if not admin

    const { searchParams } = new URL(request.url);
    const { limit, cursor } = parsePaginationParams(searchParams);
    
    const search = searchParams.get('search');
    const userId = searchParams.get('userId');
    const assetId = searchParams.get('assetId');
    const deadlineType = searchParams.get('deadlineType');
    const isDoneParam = searchParams.get('isDone');
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');

    const conditions = [];

    // Cursor condition
    const cursorId = getCursorId(cursor);
    if (cursorId !== null) {
      conditions.push(gt(deadlines.id, cursorId));
    }

    if (userId && !isNaN(parseInt(userId))) {
      conditions.push(eq(deadlines.userId, parseInt(userId)));
    }

    if (assetId && !isNaN(parseInt(assetId))) {
      conditions.push(eq(deadlines.assetId, parseInt(assetId)));
    }

    if (search) {
      conditions.push(
        or(
          like(deadlines.label, `%${search}%`),
          like(deadlines.notes, `%${search}%`)
        )
      );
    }

    if (deadlineType && VALID_DEADLINE_TYPES.includes(deadlineType as any)) {
      conditions.push(eq(deadlines.deadlineType, deadlineType));
    }

    if (isDoneParam !== null) {
      const isDoneValue = isDoneParam === 'true';
      conditions.push(eq(deadlines.isDone, isDoneValue));
    }

    if (dateFrom) {
      conditions.push(gte(deadlines.deadlineDate, dateFrom));
    }

    if (dateTo) {
      conditions.push(lte(deadlines.deadlineDate, dateTo));
    }

    // ✅ Join avec users et assets pour avoir les infos complètes
    let query = db
      .select({
        id: deadlines.id,
        userId: deadlines.userId,
        assetId: deadlines.assetId,
        label: deadlines.label,
        deadlineDate: deadlines.deadlineDate,
        deadlineType: deadlines.deadlineType,
        isDone: deadlines.isDone,
        doneDate: deadlines.doneDate,
        notes: deadlines.notes,
        createdAt: deadlines.createdAt,
        // User info
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        // Asset info
        assetName: assets.name,
        assetCategory: assets.category,
      })
      .from(deadlines)
      .leftJoin(users, eq(deadlines.userId, users.id))
      .leftJoin(assets, eq(deadlines.assetId, assets.id))
      .$dynamic();

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const results = await query
      .orderBy(desc(deadlines.deadlineDate), desc(deadlines.id))
      .limit(limit + 1);

    const hasMore = results.length > limit;
    const data = results.slice(0, limit);
    const lastItem = data[data.length - 1];

    return NextResponse.json({
      data,
      hasMore,
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem.id) : null,
    }, { status: 200 });

    } catch (error: any) {
      console.error('GET /api/admin/deadlines error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

