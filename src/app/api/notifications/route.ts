import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifySessionAccessToken } from '@/lib/auth/session-guard';
import { db } from '@/db';
import { notifications, notificationOutbox } from '@/db/schema';
import { eq, and, isNull, desc, sql, inArray, notInArray, type SQL } from 'drizzle-orm';
import { NOTIFICATION_CATALOG } from '@/lib/notifications/catalog';
import { bellRetiredTypes } from '@/lib/notifications/retired-channels';

/**
 * Lot 101B : types dont la cloche est SUPPRIMÉE au catalogue (informations de
 * sécurité : e-mail obligatoire seul). Leurs lignes déjà persistées — lues ou
 * non, d'avant le déploiement ou réémises — restent en base pour l'audit
 * (purge normale à 12 mois) mais ne sont plus servies : ni liste, ni pastille,
 * ni toast d'arrivée, sur le Web comme dans l'application mobile.
 */
const HIDDEN_BELL_TYPES = bellRetiredTypes(NOTIFICATION_CATALOG);

/** Lignes de cloche servies à l'utilisateur (les types supprimés exclus). */
function visibleTo(userId: number, ...more: SQL[]): SQL | undefined {
  return and(
    eq(notifications.userId, userId),
    ...(HIDDEN_BELL_TYPES.length > 0 ? [notInArray(notifications.type, HIDDEN_BELL_TYPES)] : []),
    ...more,
  );
}

export async function GET(request: NextRequest) {
  try {
    const token = extractAccessToken(request);
    if (!token) {
      return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    }

    const payload = await verifySessionAccessToken(token, request);
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
        .select({ n: notifications, accountId: notificationOutbox.accountId })
        .from(notifications)
        // Lot 72D (Q7) : compte émetteur, pour rouvrir le bon espace au clic.
        .leftJoin(notificationOutbox, eq(notificationOutbox.id, notifications.outboxId))
        .where(
          unreadOnly
            ? visibleTo(payload.userId, isNull(notifications.readAt))
            : visibleTo(payload.userId)
        )
        .orderBy(desc(notifications.createdAt))
        .limit(limit),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(visibleTo(payload.userId, isNull(notifications.readAt))),
    ]);

    const unreadCount = Number(unreadCountResult[0]?.count ?? 0);

    return NextResponse.json({ 
      notifications: notifs.map(({ n, accountId }) => ({
        id: n.id,
        accountId: accountId ?? null,
        type: n.type,
        // Lot 34C : le motif technique d'un échec d'analyse (`errorReason`,
        // lignes historiques) ne quitte jamais le serveur.
        payload: n.payloadJson ? sansMotifTechnique(JSON.parse(n.payloadJson)) : null,
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

    const payload = await verifySessionAccessToken(token, request);
    if (!payload) {
      return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 401 });
    }

    const body = await request.json();
    const { notificationIds, markAllRead } = body;

    const now = new Date();

    if (markAllRead) {
      // Lot 101B : « Tout lu » ne touche que ce que l'utilisateur voit — les
      // cloches de sécurité retirées gardent leur état d'origine (audit).
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(visibleTo(payload.userId, isNull(notifications.readAt)));
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

/** Charge utile d'une notification sans motif technique (lot 34C). */
function sansMotifTechnique(p: unknown): unknown {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
  const { errorReason: _ignore, ...reste } = p as Record<string, unknown>;
  return reste;
}
