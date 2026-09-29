import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvents } from '@/services/verebona-assistant/events/business-events';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    const { userId } = session;
    const accountId = session.currentAccountId;
    if (!accountId) {
      return NextResponse.json(
        { error: 'NO_ACCOUNT', message: 'Aucun compte sélectionné' },
        { status: 400 }
      );
    }
    const body = await request.json();
    const { documentIds } = body;

    // Validate input
    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'documentIds doit être un tableau non vide' },
        { status: 400 }
      );
    }

    // Convert to numbers and validate
    const validIds = documentIds
      .map(id => parseInt(id))
      .filter(id => !isNaN(id));

    if (validIds.length === 0) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'Aucun ID valide fourni' },
        { status: 400 }
      );
    }

    // Soft delete only files belonging to the user that are not already deleted
    const now = new Date();
    const deleted = await db
      .update(assetFiles)
      .set({
        deletedAt: now,
        updatedAt: now
      })
      .where(
        and(
          inArray(assetFiles.id, validIds),
          eq(assetFiles.userId, userId),
          eq(assetFiles.accountId, accountId),
          isNull(assetFiles.deletedAt)
        )
      )
      .returning();

    // CDC Assistant §25.7, §31.7 : un événement par document supprimé, une
    // seule invalidation pour la demande (bus en lot).
    await emitBusinessEvents(deleted.map((d) => ({ type: 'DOCUMENT_DELETED' as const, accountId, entityId: d.id })));

    // CDC 15 T3-03 : preuves des documents retirées, biens touchés réconciliés.
    if (deleted.length) {
      const { onDocumentsDeleted } = await import('@/services/ai/evidence/document-evidence-lifecycle');
      await onDocumentsDeleted({ accountId, userId, fileIds: deleted.map((d) => d.id) });
    }
    return NextResponse.json({
      success: true,
      deleted: deleted.length,
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('POST /api/documents/bulk-delete error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}
