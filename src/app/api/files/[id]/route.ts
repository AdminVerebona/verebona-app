import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { FileLogger } from '@/lib/file-logger';
import { ApiErrors } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { accessErrorResponse, sessionErrorToResponse } from '@/lib/auth/session-errors';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
  const requestId = randomUUID();
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null;
  const userAgent = request.headers.get('user-agent') || null;

  try {
    // Authentication avec JWT - get full session with accountId
    const session = await SessionService.getSession(request);
    const accountId = session.currentAccountId;

    if (!accountId) {
      return ApiErrors.unauthorized();
    }

    // Validate file ID
    const fileId = parseInt(params.id);
    if (!fileId || isNaN(fileId)) {
      FileLogger.blocked({
        requestId,
        ip,
        userAgent,
        userId: session.userId,
        action: 'QUOTA_CHECK',
        error: 'INVALID_FILE_ID',
      });
      return ApiErrors.invalidInput('Valid file ID is required');
    }

    // Get file
    const [file] = await db
      .select()
      .from(assetFiles)
      .where(eq(assetFiles.id, fileId))
      .limit(1);

    if (!file) {
      FileLogger.blocked({
        requestId,
        ip,
        userAgent,
        userId: session.userId,
        fileId,
        action: 'QUOTA_CHECK',
        error: 'FILE_NOT_FOUND',
      });
      return ApiErrors.notFound('File');
    }

    // Fichier d'un autre compte : 404 comme view/download/proxy — son
    // existence n'est pas confirmée (lot 24, APP-PERF-20).
    if (file.accountId !== accountId) {
      return accessErrorResponse('not-found', requestId, { code: 'FILE_NOT_FOUND', message: 'Document introuvable ou supprimé.' });
    }

    // Lot 34C : jamais de motif technique d'analyse vers l'application ;
    // statut fonctionnel calculé sur l'état réel (job de file, document).
    const { toUserFiles } = await import('@/services/ai/processing-status/processing-status.service');
    const [projete] = await toUserFiles([file]);
    return NextResponse.json(projete, { status: 200 });
  } catch (error) {
    // Refus de session (absente, invalide, révoquée…) ou vérification
    // impossible : 401/403/503 du contrat commun (APP-PERF-20), non
    // journalisés comme panne. Les comparaisons à « Unauthorized » /
    // « Access denied » ne correspondaient à aucun code levé : un refus
    // normal devenait un 500.
    if (isSessionError(error)) return sessionErrorResponse(error, requestId);
    FileLogger.error({
      requestId,
      ip,
      userAgent,
      userId: 0,
      action: 'QUOTA_CHECK',
      error: (error as Error)?.message ?? String(error),
    });
    // Erreur inattendue : 500 journalisé avec `requestId`, sans détail technique au client.
    return sessionErrorToResponse(error, requestId, 'GET /api/files/[id]');
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
  const requestId = randomUUID();
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null;
  const userAgent = request.headers.get('user-agent') || null;

  try {
    // Authentication avec JWT - récupérer la session complète
    const session = await SessionService.getSession(request);
    const accountId = session.currentAccountId;
    const userId = session.userId;
    const isAdmin = session.role === 'ADMIN';

    if (!accountId) {
      return ApiErrors.unauthorized();
    }

    // Validate file ID
    const fileId = parseInt(params.id);
    if (!fileId || isNaN(fileId)) {
      FileLogger.blocked({
        requestId,
        ip,
        userAgent,
        userId,
        action: 'DELETE',
        error: 'INVALID_FILE_ID',
      });
      return ApiErrors.invalidInput('Valid file ID is required');
    }

    // Get file
    const [file] = await db
      .select()
      .from(assetFiles)
      .where(eq(assetFiles.id, fileId))
      .limit(1);

    if (!file) {
      FileLogger.blocked({
        requestId,
        ip,
        userAgent,
        userId,
        fileId,
        action: 'DELETE',
        error: 'FILE_NOT_FOUND',
      });
      return ApiErrors.notFound('File');
    }

    // Check ownership by accountId (bypass for admins)
    // Passe-droit administrateur conservé ; sinon 404 (existence non confirmée).
    if (!isAdmin && file.accountId !== accountId) {
      return accessErrorResponse('not-found', requestId, { code: 'FILE_NOT_FOUND', message: 'Document introuvable ou supprimé.' });
    }

    // Check if already deleted
    if (file.deletedAt) {
      FileLogger.blocked({
        requestId,
        ip,
        userAgent,
        userId,
        assetId: file.assetId ?? undefined,
        fileId,
        filename: file.filename ?? undefined,
        action: 'DELETE',
        error: 'FILE_ALREADY_DELETED',
      });
      return ApiErrors.resourceDeleted('File');
    }

    // Soft delete
    const now = new Date();
    const [deletedFile] = await db
      .update(assetFiles)
      .set({
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(assetFiles.id, fileId))
      .returning();

    // Log success
    FileLogger.success({
      requestId,
      ip,
      userAgent,
      userId,
      assetId: file.assetId ?? undefined,
      fileId,
      filename: file.filename ?? undefined,
      action: 'DELETE',
      details: {
        size: file.size,
        s3Key: file.s3Key,
        deletedByAdmin: isAdmin,
        fileOwner: file.userId,
      },
    });

    // CDC Assistant §25.7 : événement métier (caches de l'assistant, §31.4).
    if (file.accountId) await emitBusinessEvent({ type: 'DOCUMENT_DELETED', accountId: file.accountId, entityId: fileId });

    // CDC 15 T3-03 : preuves du document retirées, biens touchés réconciliés
    // (ne lève jamais).
    if (file.accountId) {
      const { onDocumentsDeleted } = await import('@/services/ai/evidence/document-evidence-lifecycle');
      await onDocumentsDeleted({ accountId: file.accountId, userId, fileIds: [fileId] });
    }

    return NextResponse.json(
      {
        success: true,
        message: 'File deleted successfully',
        file: {
          id: deletedFile.id,
          filename: deletedFile.filename,
          originalFilename: deletedFile.originalFilename,
          deletedAt: deletedFile.deletedAt,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    // Refus de session (absente, invalide, révoquée…) ou vérification
    // impossible : 401/403/503 du contrat commun (APP-PERF-20), non
    // journalisés comme panne. Les comparaisons à « Unauthorized » /
    // « Access denied » ne correspondaient à aucun code levé : un refus
    // normal devenait un 500.
    if (isSessionError(error)) return sessionErrorResponse(error, requestId);
    FileLogger.error({
      requestId,
      ip,
      userAgent,
      userId: 0,
      action: 'DELETE',
      error: (error as Error)?.message ?? String(error),
    });
    // Erreur inattendue : 500 journalisé avec `requestId`, sans détail technique au client.
    return sessionErrorToResponse(error, requestId, 'DELETE /api/files/[id]');
  }
}