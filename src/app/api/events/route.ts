/**
 * @deprecated LEGACY — Migration inachevée vers Agenda
 *
 * ⚠️  GEL ACTIF — Aucune nouvelle dépendance à cette route n'est autorisée.
 *
 * Cette route fait partie du système "events legacy" qui doit être migré vers
 * le système Agenda unifié (src/app/api/agenda/**).
 *
 * Critères de suppression (tous requis) :
 *  - aucun fetch ou apiClient n'appelle /api/events
 *  - aucun composant métier n'importe les composants events legacy
 *  - aucun flux utilisateur actif ne crée/édite/lit un event legacy
 *  - les données legacy restantes sont migrées ou neutralisées
 *
 * Voir : docs/CDC_V3_Structure_Donnees.md — Agenda unifié cible
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { events, users, assets, calendarAdditions } from '@/db/schema';
import { eq, like, and, gt, desc } from 'drizzle-orm';
import { parsePaginationParams, buildPaginationResponse, getCursorId } from '@/lib/pagination';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

const VALID_CATEGORIES = ['achat', 'vente', 'entretien', 'reparation', 'sinistre', 'controle', 'garantie', 'autre'] as const;
const VALID_STATUTS = ['planifie', 'realise', 'annule'] as const;

// Helper: Calculate default status based on date
function calculateDefaultStatut(dateEvenement: string): 'planifie' | 'realise' {
  const eventDate = new Date(dateEvenement);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  eventDate.setHours(0, 0, 0, 0);
  
  return eventDate >= today ? 'planifie' : 'realise';
}

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
    const id = searchParams.get('id');

    // Single event by ID
    if (id) {
      if (!id || isNaN(parseInt(id))) {
        return apiError(400, 'INVALID_ID', 'Valid ID is required');
      }

      const event = await db
          .select()
          .from(events)
          .where(
            and(
              eq(events.id, parseInt(id)),
              eq(events.accountId, session.currentAccountId!)
            )
          )
          .limit(1);

      if (event.length === 0) {
        return apiError(404, 'EVENT_NOT_FOUND', 'Event not found');
      }

      // Check if calendar update is needed
      const addition = await db.select()
        .from(calendarAdditions)
        .where(
          and(
            eq(calendarAdditions.eventId, parseInt(id)),
            eq(calendarAdditions.userId, session.userId!)
          )
        )
        .limit(1);

      let needsCalendarUpdate = false;
      if (addition.length > 0) {
        const lastAddedAt = addition[0].lastAddedAt;
        const updatedAt = event[0].updatedAt;
        const dismissedAt = addition[0].dismissedAt;

        if (updatedAt && lastAddedAt) {
          const lastAdded = new Date(lastAddedAt).getTime();
          const updated = new Date(updatedAt).getTime();
          
          if (updated > lastAdded) {
            if (!dismissedAt || updated > new Date(dismissedAt).getTime()) {
              needsCalendarUpdate = true;
            }
          }
        }
      }

      return NextResponse.json({
        ...event[0],
        needsCalendarUpdate
      }, { status: 200 });
    }

    // List events with cursor-based pagination
    const { limit, cursor } = parsePaginationParams(searchParams);
    const search = searchParams.get('search');
    const assetId = searchParams.get('assetId');
    const categorie = searchParams.get('categorie');
    const statut = searchParams.get('statut');

      // CRITICAL: Always filter by authenticated user's account
      if (!session.currentAccountId) {
        return apiError(401, 'UNAUTHORIZED', 'No account selected');
      }
      const conditions = [eq(events.accountId, session.currentAccountId)];

    // Cursor condition (for pagination)
    const cursorId = getCursorId(cursor);
    if (cursorId !== null) {
      conditions.push(gt(events.id, cursorId));
    }

    if (assetId) {
      conditions.push(eq(events.assetId, parseInt(assetId)));
    }

    if (categorie) {
      conditions.push(eq(events.categorie, categorie));
    }

    if (statut) {
      conditions.push(eq(events.statut, statut));
    }

    if (search) {
      conditions.push(like(events.title, `%${search}%`));
    }

      // Fetch events with asset details
      const results = await db
        .select({
          id: events.id,
          title: events.title,
          date: events.date,
          categorie: events.categorie,
          statut: events.statut,
          important: events.important,
          description: events.description,
          provider: events.provider,
          costCents: events.costCents,
          notes: events.notes,
          assetId: events.assetId,
          substructureId: events.substructureId,
          equipmentId: events.equipmentId,
          accountId: events.accountId,
          createdAt: events.createdAt,
          asset: {
            id: assets.id,
            name: assets.name,
          },
        })
      .from(events)
      .leftJoin(assets, eq(events.assetId, assets.id))
      .where(and(...conditions))
      .orderBy(desc(events.date))
      .limit(limit + 1);

    const paginatedResponse = buildPaginationResponse(results, limit);

    return NextResponse.json(paginatedResponse, { status: 200 });
  } catch (error) {
    console.error('GET error:', error);
    return apiError(500, 'INTERNAL_SERVER_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}

export async function POST(request: NextRequest) {
  try {
    // Auth check
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
    // Canonical field names: title, categorie, date (matches Drizzle schema JS properties)
    // Also accept legacy aliases for backwards compat
    const title: string | undefined = body.title ?? body.titre;
    const categorie: string | undefined = body.categorie ?? body.eventType;
    const date: string | undefined = body.date ?? body.dateEvenement;
    const { assetId, statut, important, substructureId, equipmentId, provider, costCents, notes, description } = body;

    if (!session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'No account selected');
    }
    const accountId = session.currentAccountId;

    if (!categorie) {
      return apiError(400, 'MISSING_FIELD', 'categorie is required');
    }
    if (!title || title.trim() === '') {
      return apiError(400, 'MISSING_FIELD', 'title is required');
    }
    if (!VALID_CATEGORIES.includes(categorie as typeof VALID_CATEGORIES[number])) {
      return apiError(400, 'INVALID_INPUT', `categorie must be one of: ${VALID_CATEGORIES.join(', ')}`);
    }

    const finalStatut = statut || (date ? calculateDefaultStatut(date) : 'realise');
    if (!VALID_STATUTS.includes(finalStatut as typeof VALID_STATUTS[number])) {
      return apiError(400, 'INVALID_INPUT', `statut must be one of: ${VALID_STATUTS.join(', ')}`);
    }

    if (assetId) {
      const assetExists = await db.select().from(assets)
        .where(and(eq(assets.id, parseInt(assetId)), eq(assets.accountId, accountId)))
        .limit(1);
      if (assetExists.length === 0) {
        return apiError(404, 'NOT_FOUND', 'Asset not found or does not belong to you');
      }
    }

    if (costCents !== undefined && costCents !== null && costCents !== '') {
      const costInt = parseInt(costCents);
      if (isNaN(costInt) || costInt < 0) {
        return apiError(400, 'INVALID_INPUT', 'costCents must be a positive integer');
      }
    }

    const now = new Date();
    const [newEvent] = await db.insert(events).values({
      accountId,
      userId: session.userId,
      assetId: assetId ? parseInt(assetId) : null,
      categorie: categorie.trim(),
      title: title.trim(),
      date: date || null,
      substructureId: substructureId ? parseInt(substructureId) : null,
      equipmentId: equipmentId ? parseInt(equipmentId) : null,
      statut: finalStatut,
      important: important ? true : false,
      provider: provider ? provider.trim() : null,
      costCents: costCents ? parseInt(costCents) : null,
      notes: notes || null,
      description: description || null,
      createdAt: now,
      updatedAt: now,
    }).returning();

    return NextResponse.json(newEvent, { status: 201 });
  } catch (error) {
    console.error('POST error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}

export async function PUT(request: NextRequest) {
  try {
    // Auth check
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'No account selected');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
    }

    // Check if event exists and belongs to account
    const existingEvent = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.id, parseInt(id)),
          eq(events.accountId, session.currentAccountId)
        )
      )
      .limit(1);

    if (existingEvent.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Event not found or does not belong to your account');
    }

    const body = await request.json();
    // Canonical field names: title, categorie, date — with legacy aliases
    const title: string | undefined = body.title ?? body.titre;
    const categorie: string | undefined = body.categorie ?? body.eventType;
    const date: string | undefined = body.date ?? body.dateEvenement;
    const { statut, important, substructureId, equipmentId, provider, costCents, notes, description } = body;

    const updates: any = {
      updatedAt: new Date(),
    };

    if (categorie !== undefined) {
      if (!VALID_CATEGORIES.includes(categorie as typeof VALID_CATEGORIES[number])) {
        return apiError(400, 'INVALID_INPUT', `categorie must be one of: ${VALID_CATEGORIES.join(', ')}`);
      }
      updates.categorie = categorie.trim();
    }

    if (title !== undefined) {
      if (title.trim() === '') {
        return apiError(400, 'INVALID_INPUT', 'title cannot be empty');
      }
      updates.title = title.trim();
    }

    if (date !== undefined) {
      updates.date = date || null;
    }

    if (statut !== undefined) {
      if (!VALID_STATUTS.includes(statut as typeof VALID_STATUTS[number])) {
        return apiError(400, 'INVALID_INPUT', `statut must be one of: ${VALID_STATUTS.join(', ')}`);
      }
      updates.statut = statut;
    }

    if (important !== undefined) {
      updates.important = important ? 1 : 0;
    }

    if (substructureId !== undefined) {
      updates.substructureId = substructureId ? parseInt(substructureId) : null;
    }

    if (equipmentId !== undefined) {
      updates.equipmentId = equipmentId ? parseInt(equipmentId) : null;
    }

    if (provider !== undefined) {
      updates.provider = provider ? provider.trim() : null;
    }

    if (costCents !== undefined) {
      if (costCents !== null && costCents !== '') {
        const costInt = parseInt(costCents);
        if (isNaN(costInt) || costInt < 0) {
          return apiError(400, 'INVALID_INPUT', 'costCents must be a positive integer');
        }
        updates.costCents = costInt;
      } else {
        updates.costCents = null;
      }
    }

    if (notes !== undefined) {
      updates.notes = notes || null;
    }

    if (description !== undefined) {
      updates.description = description || null;
    }

    // Build SET clause dynamically using raw SQL to avoid schema mismatch
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: any[] = [];
    let paramIdx = 1;

    const columnMap: Record<string, string> = {
      categorie: 'categorie',
      title: 'titre',
      date: 'date_evenement',
      statut: 'statut',
      important: 'important',
      substructureId: 'substructure_id',
      equipmentId: 'equipment_id',
      provider: 'provider',
      costCents: 'cost_cents',
      notes: 'notes',
      description: 'description',
    };

    for (const [key, col] of Object.entries(columnMap)) {
      if (key in updates) {
        setClauses.push(`${col} = $${paramIdx++}`);
        values.push(updates[key] ?? null);
      }
    }

    values.push(parseInt(id));
    const sql = `UPDATE events SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    const result = await db.$client.unsafe(sql, values);

    if (result.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Event not found');
    }

    return NextResponse.json(result[0], { status: 200 });
  } catch (error) {
    console.error('PUT error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Auth check
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'No account selected');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
    }

    // Check if event exists and belongs to account
    const existingEvent = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.id, parseInt(id)),
          eq(events.accountId, session.currentAccountId)
        )
      )
      .limit(1);

    if (existingEvent.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Event not found or does not belong to your account');
    }

    const deleted = await db
      .delete(events)
      .where(eq(events.id, parseInt(id)))
      .returning();

    return NextResponse.json(
      { 
        message: 'Event deleted successfully',
        event: deleted[0]
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('DELETE error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}