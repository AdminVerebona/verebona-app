/**
 * POST /api/documents/[id]/notify-analyzed
 * Creates a bell notification for a completed document analysis.
 * Called by the client only when the DocumentDrawer was closed during analysis,
 * meaning the user left the drawer and needs to be informed via the notification bell.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { assetFiles, notifications } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request);
    const { id: rawId } = await params;
    const accountId = session.currentAccountId;

    if (!accountId) {
      return NextResponse.json({ error: 'No account' }, { status: 400 });
    }

    const assetFileId = parseInt(rawId);
    if (isNaN(assetFileId)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    // Verify file belongs to account
    const [file] = await db.select({ id: assetFiles.id, retainedTitle: assetFiles.retainedTitle, originalFilename: assetFiles.originalFilename }).from(assetFiles).where(
      and(eq(assetFiles.id, assetFileId), eq(assetFiles.accountId, accountId))
    ).limit(1);

    if (!file) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const documentTitle = file.retainedTitle || file.originalFilename || undefined;

    await db.insert(notifications).values({
      userId: session.userId,
      type: 'DOCUMENT_ANALYZED',
      payloadJson: JSON.stringify({ assetFileId, analysedCount: 1, failedCount: 0, documentTitle }),
      dedupeKey: `document_analyzed_file_${assetFileId}_${Date.now()}`,
      mustDeliver: true,
      createdAt: new Date(),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('POST /api/documents/[id]/notify-analyzed error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
