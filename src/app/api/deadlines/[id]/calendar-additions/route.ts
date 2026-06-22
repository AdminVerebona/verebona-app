/** @deprecated LEGACY — Gel deadlines. Voir /api/deadlines/route.ts pour contexte. */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { calendarAdditions, deadlines } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: idStr } = await params;
    const id = parseInt(idStr);

    if (isNaN(id)) {
      return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
    }

    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const body = await request.json();
    const { provider, dismiss } = body;

    if (!dismiss && (!provider || !['ics', 'google', 'outlook'].includes(provider))) {
      return apiError(400, 'INVALID_INPUT', 'Valid provider is required (ics, google, or outlook)');
    }

    // Verify deadline belongs to account
    const deadline = await db.select()
      .from(deadlines)
      .where(
        and(
          eq(deadlines.id, id),
          eq(deadlines.accountId, session.currentAccountId!)
        )
      )
      .limit(1);

    if (deadline.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Deadline not found');
    }

    const now = new Date();

    const existing = await db.select()
      .from(calendarAdditions)
      .where(
        and(
          eq(calendarAdditions.deadlineId, id),
          eq(calendarAdditions.userId, session.userId!)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      const updateData: any = { updatedAt: now };
      if (dismiss) {
        updateData.dismissedAt = now;
      } else {
        updateData.lastAddedAt = now;
        updateData.provider = provider;
        updateData.dismissedAt = null;
      }

      await db.update(calendarAdditions)
        .set(updateData)
        .where(eq(calendarAdditions.id, existing[0].id));
      
      return NextResponse.json({ success: true, action: 'updated' });
    } else {
      if (dismiss) {
        // Can't dismiss what wasn't added yet, but we'll just ignore or create with dismissed state
        await db.insert(calendarAdditions).values({
          accountId: session.currentAccountId!,
          userId: session.userId!,
          deadlineId: id,
          provider: provider || 'ics', // default if missing for some reason
          dismissedAt: now,
          lastAddedAt: now, // mark as added at same time to avoid "needs update" immediately
          createdAt: now,
          updatedAt: now,
        });
      } else {
        await db.insert(calendarAdditions).values({
          accountId: session.currentAccountId!,
          userId: session.userId!,
          deadlineId: id,
          provider,
          lastAddedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      
      return NextResponse.json({ success: true, action: 'created' }, { status: 201 });
    }

  } catch (error: any) {
    console.error('Track calendar addition error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + error.message);
  }
}
