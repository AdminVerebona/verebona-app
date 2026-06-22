import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { deadlines, users, assets, adminAuditLog } from '@/db/schema';
import { eq, like, and, gt, desc, gte, lte, or, sql } from 'drizzle-orm';
import { parsePaginationParams, buildPaginationResponse, getCursorId, encodeCursor } from '@/lib/pagination';
import { apiError } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';

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

export async function POST(request: NextRequest) {
  try {
    // ✅ Authentification admin requise
    const adminUserId = await await requireAdmin(request); // Returns userId or throws

    const body = await request.json();
    const { userId, assetId, label, deadlineDate, deadlineType, isDone, doneDate, notes } = body;

    // Validate required fields
    if (!userId || isNaN(parseInt(userId))) {
      return apiError(400, 'INVALID_INPUT', 'userId is required and must be a valid integer');
    }

    if (!assetId || isNaN(parseInt(assetId))) {
      return apiError(400, 'INVALID_INPUT', 'assetId is required and must be a valid integer');
    }

    if (!label || typeof label !== 'string' || label.trim() === '') {
      return apiError(400, 'MISSING_FIELD', 'label is required');
    }

    if (!deadlineDate) {
      return apiError(400, 'MISSING_FIELD', 'deadlineDate is required');
    }

    if (!deadlineType || !VALID_DEADLINE_TYPES.includes(deadlineType)) {
      return apiError(400, 'INVALID_INPUT', `deadlineType must be one of: ${VALID_DEADLINE_TYPES.join(', ')}`);
    }

    // Validate user exists
    const userExists = await db.select()
      .from(users)
      .where(eq(users.id, parseInt(userId)))
      .limit(1);

    if (userExists.length === 0) {
      return apiError(404, 'NOT_FOUND', 'User not found');
    }

    // Validate asset exists
    const assetExists = await db.select()
      .from(assets)
      .where(eq(assets.id, parseInt(assetId)))
      .limit(1);

    if (assetExists.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    // Insert deadline
    const insertData: any = {
      userId: parseInt(userId),
      assetId: parseInt(assetId),
      label: label.trim(),
      deadlineDate,
      deadlineType,
      isDone: isDone ?? false,
      createdAt: new Date()
    };

    if (doneDate) {
      insertData.doneDate = doneDate;
    }

    if (notes) {
      insertData.notes = notes;
    }

    const newDeadline = await db.insert(deadlines)
      .values(insertData)
      .returning();

    // ✅ Get admin email for audit log
    const adminUser = await db.select().from(users).where(eq(users.id, adminUserId)).limit(1);
    
    // ✅ Log audit
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: adminUserId,
      adminEmail: adminUser[0]?.email || 'unknown',
      actionType: 'ASSET_UPDATE',
      targetType: 'DEADLINE',
      targetId: newDeadline[0].id,
      details: `Created deadline: ${label}`,
    });

    return NextResponse.json(newDeadline[0], { status: 201 });

  } catch (error: any) {
    if (error instanceof Response) {
      return error;
    }
    console.error('POST /api/admin/deadlines error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export async function PUT(request: NextRequest) {
  try {
    // ✅ Authentification admin requise
    const adminUserId = await await requireAdmin(request); // Returns userId or throws

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
    }

    const body = await request.json();

    // Check if deadline exists
    const existing = await db.select()
      .from(deadlines)
      .where(eq(deadlines.id, parseInt(id)))
      .limit(1);

    if (existing.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Deadline not found');
    }

    const { label, deadlineDate, deadlineType, isDone, doneDate, notes } = body;

    // Validate deadlineType if provided
    if (deadlineType && !VALID_DEADLINE_TYPES.includes(deadlineType)) {
      return apiError(400, 'INVALID_INPUT', `deadlineType must be one of: ${VALID_DEADLINE_TYPES.join(', ')}`);
    }

    // Prepare update data
    const updateData: any = {};

    if (label !== undefined) {
      if (typeof label !== 'string' || label.trim() === '') {
        return apiError(400, 'INVALID_INPUT', 'label cannot be empty');
      }
      updateData.label = label.trim();
    }

    if (deadlineDate !== undefined) {
      updateData.deadlineDate = deadlineDate;
    }

    if (deadlineType !== undefined) {
      updateData.deadlineType = deadlineType;
    }

    if (isDone !== undefined) {
      updateData.isDone = isDone;
    }

    if (doneDate !== undefined) {
      updateData.doneDate = doneDate;
    }

    if (notes !== undefined) {
      updateData.notes = notes;
    }

    const updated = await db.update(deadlines)
      .set(updateData)
      .where(eq(deadlines.id, parseInt(id)))
      .returning();

    // ✅ Get admin email for audit log
    const adminUser = await db.select().from(users).where(eq(users.id, adminUserId)).limit(1);
    
    // ✅ Log audit
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: adminUserId,
      adminEmail: adminUser[0]?.email || 'unknown',
      actionType: 'ASSET_UPDATE',
      targetType: 'DEADLINE',
      targetId: parseInt(id),
      details: `Updated deadline: ${label || existing[0].label}`,
    });

    return NextResponse.json(updated[0], { status: 200 });

  } catch (error: any) {
    if (error instanceof Response) {
      return error;
    }
    console.error('PUT /api/admin/deadlines error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // ✅ Authentification admin requise
    const adminUserId = await await requireAdmin(request); // Returns userId or throws

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
    }

    // Check if deadline exists
    const existing = await db.select()
      .from(deadlines)
      .where(eq(deadlines.id, parseInt(id)))
      .limit(1);

    if (existing.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Deadline not found');
    }

    const deleted = await db.delete(deadlines)
      .where(eq(deadlines.id, parseInt(id)))
      .returning();

    // ✅ Get admin email for audit log
    const adminUser = await db.select().from(users).where(eq(users.id, adminUserId)).limit(1);
    
    // ✅ Log audit
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: adminUserId,
      adminEmail: adminUser[0]?.email || 'unknown',
      actionType: 'ASSET_DELETE',
      targetType: 'DEADLINE',
      targetId: parseInt(id),
      details: `Deleted deadline: ${existing[0].label}`,
    });

    return NextResponse.json({ 
      message: 'Deadline deleted successfully',
      deadline: deleted[0]
    }, { status: 200 });

  } catch (error: any) {
    if (error instanceof Response) {
      return error;
    }
    console.error('DELETE /api/admin/deadlines error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}