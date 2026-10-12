/**
 * @deprecated LEGACY — GEL ACTIF. Voir /api/events/route.ts pour contexte de migration.
 *
 * Lot 49 (SEC-02) : lecture, mise à jour et suppression bornées au compte
 * actif DANS le SQL ; le bien joint est celui du compte (une association
 * incorrecte en base n'affiche jamais le nom d'un bien d'un autre compte).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { events, assets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

const VALID_CATEGORIES = ['achat', 'vente', 'entretien', 'reparation', 'sinistre', 'controle', 'garantie', 'autre'] as const;
const VALID_STATUTS = ['planifie', 'realise', 'annule'] as const;

// GET /api/events/[eventId] - Get single event
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    // Auth check with accountId
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session || !session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const { eventId: rawEventId } = await params;
    const eventId = parseInt(rawEventId);

    if (isNaN(eventId)) {
      return apiError(400, 'INVALID_ID', 'Valid event ID is required');
    }

    const event = await db
      .select({
        id: events.id,
        title: events.title,
        date: events.date,
        categorie: events.categorie,
        statut: events.statut,
        important: events.important,
        provider: events.provider,
        costCents: events.costCents,
        description: events.description,
        notes: events.notes,
        userId: events.userId,
        accountId: events.accountId,
        assetId: events.assetId,
        createdAt: events.createdAt,
        assetName: assets.name,
      })
      .from(events)
      .leftJoin(assets, and(eq(events.assetId, assets.id), eq(assets.accountId, session.currentAccountId)))
      .where(and(eq(events.id, eventId), eq(events.accountId, session.currentAccountId)))
      .limit(1);

    // Événement d'un autre compte ou inexistant : même réponse.
    if (event.length === 0) {
      return apiError(404, 'EVENT_NOT_FOUND', 'Event not found');
    }

    const { assetName, assetId, ...rest } = event[0];

    // Transform important from number to boolean for frontend
    const eventData = {
      ...rest,
      assetId,
      important: !!rest.important,
      asset: assetId != null && assetName != null ? { id: assetId, name: assetName } : null,
    };

    return NextResponse.json(eventData, { status: 200 });
  } catch (error) {
    console.error('GET event error:', error);
    return apiError(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}

// PATCH /api/events/[eventId] - Update event
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    // Auth check with accountId
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session || !session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const { eventId: rawEventId } = await params;
    const eventId = parseInt(rawEventId);

    if (isNaN(eventId)) {
      return apiError(400, 'INVALID_ID', 'Valid event ID is required');
    }

    // Check if event exists and belongs to account
    const existingEvent = await db
      .select()
      .from(events)
      // Lot 49 : lu DANS le compte actif — un événement d'un autre compte
      // reçoit la même réponse qu'un événement inexistant (rien n'est révélé).
      .where(and(eq(events.id, eventId), eq(events.accountId, session.currentAccountId)))
      .limit(1);

    if (existingEvent.length === 0) {
      return apiError(404, 'EVENT_NOT_FOUND', 'Event not found');
    }

    const body = await request.json();
    const { 
      title,
      date,
      categorie,
      statut,
      important,
      provider, 
      costCents, 
      description,
      notes,
      assetId,
    } = body;

    const updates: any = {};

    if (title !== undefined) {
      if (!title || title.trim() === '') {
        return apiError(400, 'INVALID_INPUT', 'title cannot be empty');
      }
      updates.title = title.trim();
    }

    if (date !== undefined) {
      if (!date) {
        return apiError(400, 'INVALID_INPUT', 'date cannot be empty');
      }
      updates.date = date;
    }

    if (categorie !== undefined) {
      if (!VALID_CATEGORIES.includes(categorie as typeof VALID_CATEGORIES[number])) {
        return apiError(400, 'INVALID_INPUT', `categorie must be one of: ${VALID_CATEGORIES.join(', ')}`);
      }
      updates.categorie = categorie.trim();
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

    if (provider !== undefined) {
      updates.provider = provider ? provider.trim() : null;
    }

    if (costCents !== undefined) {
      if (costCents !== null && costCents !== '') {
        const costInt = typeof costCents === 'number' ? costCents : parseInt(costCents);
        if (isNaN(costInt) || costInt < 0) {
          return apiError(400, 'INVALID_INPUT', 'costCents must be a positive integer');
        }
        updates.costCents = costInt;
      } else {
        updates.costCents = null;
      }
    }

    if (description !== undefined) {
      updates.description = description ? description.trim() : null;
    }

    if (notes !== undefined) {
      updates.notes = notes ? notes.trim() : null;
    }

    if (assetId !== undefined) {
      const assetIdInt = parseInt(assetId);
      if (isNaN(assetIdInt)) {
        return apiError(400, 'INVALID_INPUT', 'assetId must be a valid number');
      }

      // Validate assetId exists AND belongs to same account
      const assetExists = await db
        .select()
        .from(assets)
        .where(and(
          eq(assets.id, assetIdInt),
          eq(assets.accountId, session.currentAccountId)
        ))
        .limit(1);

      if (assetExists.length === 0) {
        return apiError(404, 'ASSET_NOT_FOUND', 'Asset not found');
      }

      updates.assetId = assetIdInt;
    }

    if (Object.keys(updates).length === 0) {
      return apiError(400, 'NO_UPDATES', 'No fields to update');
    }

    const updatedEvent = await db
      .update(events)
      .set(updates)
      .where(and(eq(events.id, eventId), eq(events.accountId, session.currentAccountId)))
      .returning();
    if (updatedEvent.length === 0) {
      return apiError(404, 'EVENT_NOT_FOUND', 'Event not found');
    }

    // Transform important from number to boolean for frontend
    const eventData = {
      ...updatedEvent[0],
      important: !!updatedEvent[0].important,
    };

    return NextResponse.json(eventData, { status: 200 });
  } catch (error) {
    console.error('PATCH event error:', error);
    return apiError(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}

// DELETE /api/events/[eventId] - Delete event
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    // Auth check with accountId
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session || !session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const { eventId: rawEventId } = await params;
    const eventId = parseInt(rawEventId);

    if (isNaN(eventId)) {
      return apiError(400, 'INVALID_ID', 'Valid event ID is required');
    }

    // Check if event exists
    const existingEvent = await db
      .select()
      .from(events)
      // Lot 49 : lu DANS le compte actif — un événement d'un autre compte
      // reçoit la même réponse qu'un événement inexistant (rien n'est révélé).
      .where(and(eq(events.id, eventId), eq(events.accountId, session.currentAccountId)))
      .limit(1);

    if (existingEvent.length === 0) {
      return apiError(404, 'EVENT_NOT_FOUND', 'Event not found');
    }

    await db
      .delete(events)
      .where(and(eq(events.id, eventId), eq(events.accountId, session.currentAccountId)));

    return NextResponse.json(
      { 
        success: true,
        message: 'Event deleted successfully',
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('DELETE event error:', error);
    return apiError(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}
