import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getS3Config, logS3Error, S3ConfigError, signGetUrl } from '@/lib/s3-config';
import { FileLogger } from '@/lib/file-logger';
import { getSession, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { accessErrorResponse, sessionErrorToResponse } from '@/lib/auth/session-errors';
import { viewableFileCondition } from '@/services/documents/grouped-sources';

/**
 * Lecture directe (APP-PERF-13) : droits contrôlés ici, puis URL signée de
 * la configuration S3 canonique (APP-PERF-26). Durée : `OVH_S3_SIGNED_URL_TTL_S`
 * (3600 s par défaut) — le visualiseur PDF relit l'URL par plages pendant
 * la consultation ; au-delà, le client redemande une URL, ce qui refait le
 * contrôle de droits.
 */
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
  const requestId = randomUUID();
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null;
  const userAgent = request.headers.get('user-agent') || null;

  try {
    // Garde de session commune (révocation comprise) ; refus typés du
    // contrat `lib/auth/session-errors` (APP-PERF-20, lot 24).
    const session = await getSession(request);
    const accountId = session.currentAccountId;
    const userId = session.userId;

    if (!accountId) {
      return accessErrorResponse('no-account', requestId, { headers: NO_STORE });
    }

    const fileId = parseInt(params.id);
    if (isNaN(fileId)) {
      return NextResponse.json(
        { error: 'INVALID_ID', message: 'ID fichier invalide' },
        { status: 400 }
      );
    }

    const fileIdInt = fileId;

    const fileRecords = await db
      .select()
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.id, fileIdInt),
          // Supprimé = introuvable, SAUF source secondaire d'un document
          // existant : elle reste consultable depuis ses preuves (0143).
          viewableFileCondition,
        )
      )
      .limit(1);

    if (fileRecords.length === 0) {
      FileLogger.blocked({
        requestId,
        ip,
        userAgent,
        userId,
        action: 'VIEW',
        error: 'FILE_NOT_FOUND',
      });
      return accessErrorResponse('not-found', requestId, {
        code: 'FILE_NOT_FOUND', message: 'Document introuvable ou supprimé.', headers: NO_STORE,
      });
    }

    const file = fileRecords[0];

    // Fichier d'un autre compte : 404, comme le proxy et les miniatures
    // (`services/documents/file-access`) — son existence n'est pas confirmée.
    if (file.accountId !== accountId) {
      FileLogger.blocked({ requestId, ip, userAgent, userId, fileId: fileIdInt, action: 'VIEW', error: 'FILE_NOT_FOUND' });
      return accessErrorResponse('not-found', requestId, {
        code: 'FILE_NOT_FOUND', message: 'Document introuvable ou supprimé.', headers: NO_STORE,
      });
    }

    if (file.uploadStatus !== 'COMPLETED' && file.uploadStatus !== null) {
      FileLogger.blocked({
        requestId,
        ip,
        userAgent,
        userId,
        assetId: file.assetId ?? undefined,
        fileId: fileIdInt,
        filename: file.filename ?? undefined,
        action: 'VIEW',
        error: 'FILE_NOT_READY',
      });
      return NextResponse.json(
        { 
          error: 'File is not ready for viewing', 
          code: 'FILE_NOT_READY' 
        },
        { status: 400 }
      );
    }

    // For web links, return the actual URL directly without S3
    if (file.isWebLink && file.webLinkUrl) {
      return NextResponse.json({
        viewUrl: file.webLinkUrl,
        filename: file.webLinkTitle || file.originalFilename,
        mimeType: file.mimeType,
        expiresIn: null,
        isWebLink: true,
      }, { status: 200 });
    }

    if (!file.s3Bucket || !file.s3Key || file.s3Bucket === 'weblink') {
      console.error('GET view URL error: Missing S3 configuration for file', fileIdInt);
      FileLogger.error({
        requestId,
        ip,
        userAgent,
        userId,
        assetId: file.assetId ?? undefined,
        fileId: fileIdInt,
        filename: file.filename ?? undefined,
        action: 'VIEW',
        error: 'S3_CONFIG_MISSING',
      });
      return NextResponse.json(
        { 
          error: 'File storage configuration is incomplete', 
          code: 'S3_CONFIG_MISSING' 
        },
        { status: 500 }
      );
    }

    // Use inline disposition for viewing in browser
    const expiresIn = getS3Config().signedUrlTtlSeconds;
    const viewUrl = await signGetUrl({
      bucket: file.s3Bucket,
      key: file.s3Key,
      responseContentDisposition: 'inline',
      responseContentType: file.mimeType ?? undefined,
      expiresIn,
    });

    FileLogger.success({
      requestId,
      ip,
      userAgent,
      userId,
      assetId: file.assetId ?? undefined,
      fileId: fileIdInt,
      filename: file.filename ?? undefined,
      action: 'VIEW',
      details: {
        size: file.size,
        mimeType: file.mimeType,
      },
    });

    return NextResponse.json({
      viewUrl,
      filename: file.originalFilename,
      mimeType: file.mimeType,
      expiresIn,
    }, { status: 200, headers: NO_STORE });

  } catch (error) {
    // Refus de session (absente, invalide, révoquée…) ou vérification
    // impossible : 401/403/503 du contrat commun, non journalisés comme panne.
    if (isSessionError(error)) return sessionErrorResponse(error, requestId);
    if (error instanceof S3ConfigError) {
      logS3Error('GET /api/files/[id]/view', error);
      return NextResponse.json(
        { error: 'Storage configuration error', code: 'S3_CONFIG_INVALID', requestId },
        { status: 500, headers: { 'x-request-id': requestId } }
      );
    }
    FileLogger.error({
      requestId,
      ip,
      userAgent,
      userId: 0,
      action: 'VIEW',
      error: (error as Error)?.message ?? String(error),
    });
    // Erreur inattendue : 500 journalisé avec `requestId`, sans détail technique au client.
    return sessionErrorToResponse(error, requestId, 'files/view');
  }
}
