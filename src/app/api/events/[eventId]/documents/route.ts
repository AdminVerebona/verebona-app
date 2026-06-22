import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { eventDocuments, events, assetFiles } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';

export async function GET(
  request: NextRequest,
  { params }: { params: { eventId: string } }
) {
  try {
    const eventId = parseInt(params.eventId);

    if (isNaN(eventId)) {
      return apiError(400, 'INVALID_ID', 'Valid event ID is required');
    }

    // Check if event exists
    const eventExists = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (eventExists.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Event not found');
    }

    // Get linked documents with file details
    const linkedDocs = await db
      .select({
        id: eventDocuments.id,
        eventId: eventDocuments.eventId,
        fileId: eventDocuments.fileId,
        createdAt: eventDocuments.createdAt,
        file: assetFiles,
      })
      .from(eventDocuments)
      .innerJoin(assetFiles, eq(eventDocuments.fileId, assetFiles.id))
      .where(eq(eventDocuments.eventId, eventId));

    return NextResponse.json({
      data: linkedDocs,
      count: linkedDocs.length,
    }, { status: 200 });
  } catch (error) {
    console.error('GET /api/events/[eventId]/documents error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { eventId: string } }
) {
  try {
    const eventId = parseInt(params.eventId);

    if (isNaN(eventId)) {
      return apiError(400, 'INVALID_ID', 'Valid event ID is required');
    }

    // Check if event exists
    const eventExists = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (eventExists.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Event not found');
    }

    const body = await request.json();
    const { fileIds } = body;

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return apiError(400, 'INVALID_INPUT', 'fileIds array is required');
    }

    // Validate all file IDs exist
    const filesExist = await db
      .select({ id: assetFiles.id })
      .from(assetFiles)
      .where(inArray(assetFiles.id, fileIds));

    if (filesExist.length !== fileIds.length) {
      return apiError(404, 'NOT_FOUND', 'One or more files not found');
    }

    // Insert links (ignore duplicates)
    const insertPromises = fileIds.map(async (fileId) => {
      // Check if link already exists
      const existing = await db
        .select()
        .from(eventDocuments)
        .where(
          and(
            eq(eventDocuments.eventId, eventId),
            eq(eventDocuments.fileId, fileId)
          )
        )
        .limit(1);

      if (existing.length === 0) {
        return db
          .insert(eventDocuments)
          .values({
            eventId,
            fileId,
            createdAt: new Date(),
          })
          .returning();
      }
      return existing;
    });

    const results = await Promise.all(insertPromises);
    const created = results.flat();

    return NextResponse.json({
      message: 'Documents linked successfully',
      data: created,
      count: created.length,
    }, { status: 201 });
  } catch (error) {
    console.error('POST /api/events/[eventId]/documents error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { eventId: string } }
) {
  try {
    const eventId = parseInt(params.eventId);
    const { searchParams } = new URL(request.url);
    const fileId = searchParams.get('fileId');

    if (isNaN(eventId)) {
      return apiError(400, 'INVALID_ID', 'Valid event ID is required');
    }

    if (!fileId || isNaN(parseInt(fileId))) {
      return apiError(400, 'INVALID_ID', 'Valid file ID is required');
    }

    const fileIdInt = parseInt(fileId);

    // Check if link exists
    const existing = await db
      .select()
      .from(eventDocuments)
      .where(
        and(
          eq(eventDocuments.eventId, eventId),
          eq(eventDocuments.fileId, fileIdInt)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Link not found');
    }

    // Delete link
    await db
      .delete(eventDocuments)
      .where(
        and(
          eq(eventDocuments.eventId, eventId),
          eq(eventDocuments.fileId, fileIdInt)
        )
      );

    return NextResponse.json({
      message: 'Document unlinked successfully',
    }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/events/[eventId]/documents error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}
