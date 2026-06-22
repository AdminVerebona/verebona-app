/**
 * POST /api/documents/[id]/fusion
 * Gère l'action de fusion :
 *   action = "dismiss" → ignorer la suggestion (fusionIgnoredWith)
 *   action = "merge"   → supprimer le fichier candidat + conserver le nouveau
 *   action = "replace" → supprimer le nouveau + conserver le candidat (c'est le vrai doc)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request);
    const { id: rawId } = await params;
    const accountId = session.currentAccountId;

    if (!accountId) {
      return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });
    }

    const assetFileId = parseInt(rawId);
    if (isNaN(assetFileId)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    const body = await request.json();
    const { action, candidateFileId } = body;

    if (!action || !candidateFileId) {
      return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
    }

    if (!['dismiss', 'merge', 'replace'].includes(action)) {
      return NextResponse.json({ error: 'INVALID_ACTION' }, { status: 400 });
    }

    // Verify ownership of both files
    const [file] = await db.select()
      .from(assetFiles)
      .where(and(eq(assetFiles.id, assetFileId), eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)))
      .limit(1);

    const [candidate] = await db.select()
      .from(assetFiles)
      .where(and(eq(assetFiles.id, candidateFileId), eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)))
      .limit(1);

    if (!file) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'Fichier principal introuvable' }, { status: 404 });
    }
    if (!candidate) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'Fichier candidat introuvable' }, { status: 404 });
    }

    const now = new Date();

    if (action === 'dismiss') {
      // Mutual ignore — add each file id to the other's fusionIgnoredWith
      const fileIgnored: number[] = [...((file.fusionIgnoredWith as number[] | null) ?? [])];
      if (!fileIgnored.includes(candidateFileId)) fileIgnored.push(candidateFileId);

      const candidateIgnored: number[] = [...((candidate.fusionIgnoredWith as number[] | null) ?? [])];
      if (!candidateIgnored.includes(assetFileId)) candidateIgnored.push(assetFileId);

      await Promise.all([
        db.update(assetFiles)
          .set({ fusionIgnoredWith: fileIgnored, updatedAt: now })
          .where(eq(assetFiles.id, assetFileId)),
        db.update(assetFiles)
          .set({ fusionIgnoredWith: candidateIgnored, updatedAt: now })
          .where(eq(assetFiles.id, candidateFileId)),
      ]);

      return NextResponse.json({ success: true, action: 'dismissed' });
    }

    if (action === 'merge') {
      // Delete the candidate, keep the new file
      await db.update(assetFiles)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(assetFiles.id, candidateFileId));

      return NextResponse.json({ success: true, action: 'merged', keptFileId: assetFileId, deletedFileId: candidateFileId });
    }

    if (action === 'replace') {
      // Delete the newly uploaded file, keep the candidate
      await db.update(assetFiles)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(assetFiles.id, assetFileId));

      return NextResponse.json({ success: true, action: 'replaced', keptFileId: candidateFileId, deletedFileId: assetFileId });
    }

    return NextResponse.json({ error: 'UNKNOWN_ACTION' }, { status: 400 });

  } catch (error) {
    if (error instanceof Response) return error;
    console.error('POST /api/documents/[id]/fusion error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
