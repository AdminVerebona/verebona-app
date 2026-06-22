/**
 * @deprecated LEGACY — Gel du domaine Events
 * Vue calendrier legacy sur events. Remplacée par /api/agenda.
 * Voir /api/events/route.ts pour critères de suppression.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { events, assets } from '@/db/schema';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

/**
 * GET /api/events/agenda
 * 
 * Returns events within a date range [startDate, endDate] with optional filters.
 * 
 * Query params:
 * - startDate (optional): YYYY-MM-DD - if not provided, no start date filter
 * - endDate (optional): YYYY-MM-DD - if not provided, no end date filter
 * - assetId (optional): filter by asset (can be multiple comma-separated)
 * - categorie (optional): filter by category (can be multiple comma-separated)
 * - statut (optional): filter by status (can be multiple comma-separated)
 */
export async function GET(request: NextRequest) {
  try {
    // Auth check with proper error handling
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const assetId = searchParams.get('assetId');
    const categorie = searchParams.get('categorie');
    const statut = searchParams.get('statut');

    // Validate date format if provided
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (startDate && !dateRegex.test(startDate)) {
      return apiError(400, 'INVALID_FORMAT', 'startDate must be in format YYYY-MM-DD');
    }
    if (endDate && !dateRegex.test(endDate)) {
      return apiError(400, 'INVALID_FORMAT', 'endDate must be in format YYYY-MM-DD');
    }

    // Build conditions - filter by accountId (not userId)
    const conditions = [
      eq(events.accountId, session.currentAccountId!),
    ];

    // Add date filters only if provided
    if (startDate) {
      conditions.push(gte(events.date, startDate));
    }
    if (endDate) {
      conditions.push(lte(events.date, endDate));
    }

    // Handle multiple assetIds
    if (assetId) {
      const assetIds = assetId.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      if (assetIds.length > 0) {
        conditions.push(inArray(events.assetId as any, assetIds));
      }
    }

    // Handle multiple categories
    if (categorie) {
      const categories = categorie.split(',').map(c => c.trim());
      if (categories.length > 0) {
        conditions.push(inArray(events.categorie, categories));
      }
    }

    // Handle multiple statuts
    if (statut) {
      const statuts = statut.split(',').map(s => s.trim());
      if (statuts.length > 0) {
        conditions.push(inArray(events.statut, statuts));
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
      .leftJoin(assets, eq(events.assetId, assets.id))
      .where(and(...conditions))
      .orderBy(events.date);

    // Calculate derived fields for each event
    const eventsWithFlags = results.map(({ event, asset }) => {
        const eventDate = new Date(event.date ?? '');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      eventDate.setHours(0, 0, 0, 0);

      const estFutur = eventDate >= today;
      const estPasse = eventDate < today;
      const estEnRetard = event.statut === 'planifie' && eventDate < today;
      const estEcheance = event.statut === 'planifie' && eventDate >= today;

      return {
        ...event,
        asset,
        estFutur,
        estPasse,
        estEnRetard,
        estEcheance,
      };
    });

    return NextResponse.json({
      startDate: startDate || null,
      endDate: endDate || null,
      count: eventsWithFlags.length,
      data: eventsWithFlags,
    }, { status: 200 });

  } catch (error) {
    console.error('GET /api/events/agenda error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}