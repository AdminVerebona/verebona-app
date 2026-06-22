/**
 * POST /api/dashboard/a-traiter/documents/[id]/ignore
 * CDC : marque un document comme ignoré (isIgnored = true).
 * Action définitive jusqu'à réactivation manuelle.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    const accountId = session.currentAccountId;
    if (!accountId) {
      return NextResponse.json({ error: 'No account selected' }, { status: 400 });
    }

    const { id: rawId } = await params;
    const fileId = parseInt(rawId);
    if (isNaN(fileId)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    const [updated] = await db
      .update(assetFiles)
      .set({ isIgnored: true })
      .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId)))
      .returning({ id: assetFiles.id });

    if (!updated) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('POST /api/dashboard/a-traiter/documents/[id]/ignore error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
