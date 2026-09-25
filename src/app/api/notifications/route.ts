import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifyAccessToken } from '@/lib/jwt';
import { db } from '@/db';
import { notifications } from '@/db/schema';
import { eq, and, isNull, desc, sql, inArray } from 'drizzle-orm';

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
    const rawLimit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;

    // Liste et compteur en parallèle : la cloche attendait les deux requêtes
    // l'une après l'autre (index composites : migration 0165).
    const [notifs, unreadCountResult] = await Promise.all([
      db
        .select()
        .from(notifications)
        .where(
          unreadOnly
            ? and(eq(notifications.userId, payload.userId), isNull(notifications.readAt))
            : eq(notifications.userId, payload.userId)
        )
        .orderBy(desc(notifications.createdAt))
        .limit(limit),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, payload.userId), isNull(notifications.readAt))),
    ]);

    const unreadCount = Number(unreadCountResult[0]?.count ?? 0);

    return NextResponse.json({ 
      notifications: notifs.map(n => ({
        id: n.id,
        type: n.type,
        payload: n.payloadJson ? JSON.parse(n.payloadJson) : null,
        // Contenu rendu par le catalogue à l'émission : filet de sécurité de
        // la cloche pour un type qu'elle ne sait pas libeller (au lieu de
        // « Nouvelle notification »).
        title: n.title ?? null,
        body: n.body ?? null,
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
      const ids = notificationIds.filter((id: unknown): id is number => Number.isSafeInteger(id));
      if (ids.length > 0) {
        await db
          .update(notifications)
          .set({ readAt: now })
          .where(and(inArray(notifications.id, ids), eq(notifications.userId, payload.userId)));
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
