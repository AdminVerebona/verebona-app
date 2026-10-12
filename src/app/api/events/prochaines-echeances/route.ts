/**
 * @deprecated LEGACY — Gel du domaine Events
 * Prochaines échéances legacy sur events. Remplacée par /api/agenda.
 * Voir /api/events/route.ts pour critères de suppression.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { events, assets } from '@/db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

/**
 * GET /api/events/prochaines-echeances
 * 
 * Returns upcoming events (planned events with future dates).
 * 
 * Lot 49 (SEC-02) : TOUJOURS bornée au compte actif de la session. Le
 * `userId` de l'URL n'est qu'un filtre À L'INTÉRIEUR du compte, jamais une
 * preuve d'autorisation ; le bien joint est celui du compte.
 *
 * Query params:
 * - userId (optional): filter by user (within the active account)
 * - limit (optional): max number of results (default: 10, max: 50)
 * - daysAhead (optional): only events in the next X days (default: no limit)
 */
export async function GET(request: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    const accountId = session.currentAccountId;
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const limitParam = searchParams.get('limit');
    const daysAheadParam = searchParams.get('daysAhead');

    // Parse and validate limit
    let limit = 10; // default
    if (limitParam) {
      const parsed = parseInt(limitParam);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 50) {
        limit = parsed;
      }
    }

    // Calculate date threshold
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    // Build conditions
    const conditions = [
      eq(events.accountId, accountId),
      eq(events.statut, 'planifie'),
      gte(events.date, todayStr),
    ];

    if (userId && !isNaN(parseInt(userId))) {
      conditions.push(eq(events.userId, parseInt(userId)));
    }

    // Optional: filter by days ahead
    if (daysAheadParam) {
      const daysAhead = parseInt(daysAheadParam);
      if (!isNaN(daysAhead) && daysAhead > 0) {
        const maxDate = new Date(today);
        maxDate.setDate(maxDate.getDate() + daysAhead);
        const maxDateStr = maxDate.toISOString().split('T')[0];
          conditions.push(lte(events.date, maxDateStr));
      }
    }

    // Query events with asset details
    const results = await db
      .select({
        event: events,
        asset: {
          id: assets.id,
          name: assets.name,
          category: assets.category,
        },
      })
      .from(events)
        .leftJoin(assets, and(eq(events.assetId, assets.id), eq(assets.accountId, accountId)))
      .where(and(...conditions))
      .orderBy(events.date)
      .limit(limit);

    // Add derived fields
    const eventsWithFlags = results.map(({ event, asset }) => {
        const eventDate = new Date(event.date ?? '');
      const diffTime = eventDate.getTime() - today.getTime();
      const daysUntil = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      // Calculate urgency level
      let urgency: 'urgent' | 'soon' | 'upcoming' = 'upcoming';
      if (daysUntil <= 7) {
        urgency = 'urgent';
      } else if (daysUntil <= 30) {
        urgency = 'soon';
      }

      return {
        ...event,
        asset,
        daysUntil,
        urgency,
      };
    });

    return NextResponse.json({
      count: eventsWithFlags.length,
      limit,
      data: eventsWithFlags,
    }, { status: 200 });

  } catch (error) {
    console.error('GET /api/events/prochaines-echeances error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
