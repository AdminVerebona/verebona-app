import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifyAccessToken } from '@/lib/jwt';
import { db } from '@/db';
import { notifications } from '@/db/schema';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  try {
    const token = extractAccessToken(request);
    if (!token) {
      return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    }

    const payload = await verifyAccessToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 401 });
    }

    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get('unread') === 'true';
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    let query = db
      .select()
      .from(notifications)
      .where(
        unreadOnly
          ? and(eq(notifications.userId, payload.userId), isNull(notifications.readAt))
          : eq(notifications.userId, payload.userId)
      )
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    const notifs = await query;

    const unreadCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, payload.userId),
          isNull(notifications.readAt)
        )
      );

    const unreadCount = unreadCountResult[0]?.count ?? 0;

    return NextResponse.json({ 
      notifications: notifs.map(n => ({
        id: n.id,
        type: n.type,
        payload: n.payloadJson ? JSON.parse(n.payloadJson) : null,
        createdAt: n.createdAt,
        readAt: n.readAt,
        mustDeliver: n.mustDeliver ?? false,
      })),
      unreadCount 
    });
  } catch (error) {
    console.error('[NOTIFICATIONS] Error:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const token = extractAccessToken(request);
    if (!token) {
      return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    }

    const payload = await verifyAccessToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 401 });
    }

    const body = await request.json();
    const { notificationIds, markAllRead } = body;

    const now = new Date();

    if (markAllRead) {
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(
          and(
            eq(notifications.userId, payload.userId),
            isNull(notifications.readAt)
          )
        );
    } else if (notificationIds && Array.isArray(notificationIds)) {
      for (const id of notificationIds) {
        await db
          .update(notifications)
          .set({ readAt: now })
          .where(
            and(
              eq(notifications.id, id),
              eq(notifications.userId, payload.userId)
            )
          );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[NOTIFICATIONS_MARK_READ] Error:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
