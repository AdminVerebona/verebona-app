import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { events, assetFiles, eventDocuments } from '@/db/schema';
import { eq, and, gt, isNull, notInArray, sql, or } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';

// Time window for recent documents (in minutes)
const RECENT_DOCUMENTS_WINDOW_MINUTES = 10;

/**
 * GET /api/events/[eventId]/suggestions
 * 
 * Suggests recently uploaded documents that could be associated with this event.
 * 
 * Logic:
 * 1. Find documents uploaded in the last X minutes (default 10)
 * 2. That belong to the same asset as the event
 * 3. That are NOT already associated with any event (or at least not this event)
 * 4. Return them as suggestions
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { eventId: string } }
) {
  try {
    const eventId = parseInt(params.eventId);

    if (isNaN(eventId)) {
      return apiError(400, 'INVALID_ID', 'Valid event ID is required');
    }

    // Get the event details
    const event = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (event.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Event not found');
    }

      const eventAssetId = event[0].assetId as number;
      const eventUserId = event[0].userId as number;

    // Calculate the time threshold (X minutes ago)
    const windowMs = RECENT_DOCUMENTS_WINDOW_MINUTES * 60 * 1000;
    const thresholdDate = new Date(Date.now() - windowMs);

    // Get all document IDs that are already linked to this event
    const linkedDocs = await db
      .select({ fileId: eventDocuments.fileId })
      .from(eventDocuments)
      .where(eq(eventDocuments.eventId, eventId));

    const linkedFileIds = linkedDocs.map(doc => doc.fileId);

    // Find recent documents from the same asset that are not yet linked to this event
    let query = db
      .select({
        id: assetFiles.id,
        fileName: assetFiles.originalFilename,
        mimeType: assetFiles.mimeType,
        fileSize: assetFiles.size,
        documentType: assetFiles.documentType,
        documentDate: assetFiles.documentDate,
        uploadedAt: assetFiles.uploadedAt,
      })
      .from(assetFiles)
      .$dynamic()
      .where(
        and(
          eq(assetFiles.assetId, eventAssetId),
          eq(assetFiles.userId, eventUserId),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt),
          gt(assetFiles.uploadedAt, thresholdDate)
        )
      );

    // Exclude documents already linked to this event
    if (linkedFileIds.length > 0) {
      query = query.where(
        and(
          eq(assetFiles.assetId, eventAssetId),
          eq(assetFiles.userId, eventUserId),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt),
          gt(assetFiles.uploadedAt, thresholdDate),
          notInArray(assetFiles.id, linkedFileIds)
        )
      );
    }

    const recentDocuments = await query.orderBy(assetFiles.uploadedAt);

    // Optional: Filter out documents that are already linked to OTHER events
    // This is optional based on requirements - keeping documents that can be linked to multiple events
    // If you want to exclude documents linked to ANY event, uncomment this:
    /*
    const allLinkedDocs = await db
      .select({ fileId: eventDocuments.fileId })
      .from(eventDocuments);
    
    const allLinkedFileIds = new Set(allLinkedDocs.map(doc => doc.fileId));
    const unlinkedDocuments = recentDocuments.filter(doc => !allLinkedFileIds.has(doc.id));
    */

    return NextResponse.json({
      eventId,
      windowMinutes: RECENT_DOCUMENTS_WINDOW_MINUTES,
      thresholdDate,
      suggestions: recentDocuments,
      count: recentDocuments.length,
    }, { status: 200 });

  } catch (error) {
    console.error('GET /api/events/[eventId]/suggestions error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}
