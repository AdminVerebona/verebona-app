import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { eventDocuments, events, assetFiles } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';

/**
 * GET /api/documents/[id]/events
 * 
 * List all events linked to a specific document
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await getSession(request);
    const { id } = await params;
    const documentId = parseInt(id);

    if (isNaN(documentId)) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'ID de document invalide' },
        { status: 400 }
      );
    }

    // Verify document exists and belongs to user
    const document = await db
      .select()
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.id, documentId),
          eq(assetFiles.userId, userId),
          isNull(assetFiles.deletedAt)
        )
      )
      .limit(1);

    if (document.length === 0) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Document non trouvé' },
        { status: 404 }
      );
    }

    // Get all events linked to this document
    const linkedEvents = await db
      .select({
        id: events.id,
        title: events.title,
        date: events.date,
        eventType: events.categorie, // alias from categorie
        provider: events.provider,
        costCents: events.costCents,
        notes: events.notes,
        assetId: events.assetId,
        createdAt: events.createdAt,
        associationDate: eventDocuments.createdAt,
      })
      .from(eventDocuments)
      .innerJoin(events, eq(eventDocuments.eventId, events.id))
      .where(eq(eventDocuments.fileId, documentId))
      .orderBy(events.date);

    return NextResponse.json({
      documentId,
      events: linkedEvents,
      total: linkedEvents.length,
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('GET /api/documents/[id]/events error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/documents/[id]/events
 * 
 * Associate this document with one or more events
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await getSession(request);
    const { id } = await params;
    const documentId = parseInt(id);

    if (isNaN(documentId)) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'ID de document invalide' },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { eventIds } = body;

    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'eventIds doit être un tableau non vide' },
        { status: 400 }
      );
    }

    // Verify document exists and belongs to user
    const document = await db
      .select()
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.id, documentId),
          eq(assetFiles.userId, userId),
          isNull(assetFiles.deletedAt)
        )
      )
      .limit(1);

    if (document.length === 0) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Document non trouvé' },
        { status: 404 }
      );
    }

    const documentAssetId = document[0].assetId;

    // Verify all events exist, belong to user, and belong to the same asset
    const eventsToLink = await db
      .select()
      .from(events)
      .where(eq(events.userId, userId));

    const validEventIds = eventsToLink
      .filter(e => eventIds.includes(e.id))
      .filter(e => e.assetId === documentAssetId);

    if (validEventIds.length !== eventIds.length) {
      return NextResponse.json(
        {
          error: 'INVALID_INPUT',
          message: `Les événements doivent appartenir au même bien que le document (bien #${documentAssetId})`,
        },
        { status: 400 }
      );
    }

    // Check which events are already linked
    const existingLinks = await db
      .select()
      .from(eventDocuments)
      .where(eq(eventDocuments.fileId, documentId));

    const existingEventIds = new Set(existingLinks.map(link => link.eventId));
    const newEventIds = eventIds.filter((id: number) => !existingEventIds.has(id));

    // Create new associations
    const now = new Date();
    const newAssociations = newEventIds.map((eventId: number) => ({
      eventId,
      fileId: documentId,
      createdAt: now,
    }));

    let createdCount = 0;
    if (newAssociations.length > 0) {
      await db.insert(eventDocuments).values(newAssociations);
      createdCount = newAssociations.length;
    }

    return NextResponse.json({
      message: 'Événements associés avec succès',
      created: createdCount,
      alreadyLinked: existingEventIds.size,
      total: eventIds.length,
    }, { status: 201 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('POST /api/documents/[id]/events error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/documents/[id]/events
 * 
 * Remove event association from document
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await getSession(request);
    const { id } = await params;
    const documentId = parseInt(id);

    if (isNaN(documentId)) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'ID de document invalide' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const eventId = searchParams.get('eventId');

    if (!eventId || isNaN(parseInt(eventId))) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'eventId requis' },
        { status: 400 }
      );
    }

    // Verify document exists and belongs to user
    const document = await db
      .select()
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.id, documentId),
          eq(assetFiles.userId, userId),
          isNull(assetFiles.deletedAt)
        )
      )
      .limit(1);

    if (document.length === 0) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Document non trouvé' },
        { status: 404 }
      );
    }

    // Delete the association
    const deleted = await db
      .delete(eventDocuments)
      .where(
        and(
          eq(eventDocuments.fileId, documentId),
          eq(eventDocuments.eventId, parseInt(eventId))
        )
      )
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Association non trouvée' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      message: 'Association supprimée avec succès',
      documentId,
      eventId: parseInt(eventId),
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('DELETE /api/documents/[id]/events error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}