import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { isS3Configured, logS3Error, S3ConfigError, signGetUrl } from '@/lib/s3-config';
import { FileLogger } from '@/lib/file-logger';
import { SessionService } from '@/lib/session-service';
import { contentDisposition, downloadFilename } from '@/lib/download-filename';
import { viewableFileCondition } from '@/services/documents/grouped-sources';

/** Durée de l'URL de téléchargement (s) : immédiatement suivie par le navigateur. */
const DOWNLOAD_URL_TTL_S = 3600;


export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
  const requestId = randomUUID();
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null;
  const userAgent = request.headers.get('user-agent') || null;

  try {
    // Get session with accountId
    const session = await SessionService.getSession(request);
    const accountId = session.currentAccountId;
    const userId = session.userId;

    if (!accountId) {
      return NextResponse.json(
        { error: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      );
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
          // Même garde que view/proxy (APP-PERF-13) : supprimé = introuvable,
          // sauf source secondaire d'un document existant (preuves, 0143).
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
        action: 'DOWNLOAD',
        error: 'FILE_NOT_FOUND',
      });
      return NextResponse.json(
        { error: 'File not found or has been deleted', code: 'FILE_NOT_FOUND' },
        { status: 404 }
      );
    }

    const file = fileRecords[0];

    // Check ownership by accountId
    if (file.accountId !== accountId) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Access denied' },
        { status: 403 }
      );
    }

    if (file.uploadStatus === 'PENDING') {
      FileLogger.blocked({
        requestId,
        ip,
        userAgent,
        userId,
        assetId: file.assetId ?? undefined,
        fileId: fileIdInt,
        filename: file.filename ?? undefined,
        action: 'DOWNLOAD',
        error: 'FILE_PENDING',
      });
      return NextResponse.json(
        { 
          error: 'File upload is still in progress', 
          code: 'FILE_PENDING' 
        },
        { status: 400 }
      );
    }

    if (file.uploadStatus === 'FAILED') {
      FileLogger.blocked({
        requestId,
        ip,
        userAgent,
        userId,
        assetId: file.assetId ?? undefined,
        fileId: fileIdInt,
        filename: file.filename ?? undefined,
        action: 'DOWNLOAD',
        error: 'FILE_FAILED',
      });
      return NextResponse.json(
        { 
          error: 'File upload failed and cannot be downloaded', 
          code: 'FILE_FAILED' 
        },
        { status: 400 }
      );
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
        action: 'DOWNLOAD',
        error: 'FILE_NOT_READY',
      });
      return NextResponse.json(
        { 
          error: 'File is not ready for download', 
          code: 'FILE_NOT_READY' 
        },
        { status: 400 }
      );
    }

    // For web links, return the actual URL directly
    if (file.isWebLink && file.webLinkUrl) {
      return NextResponse.json({
        downloadUrl: file.webLinkUrl,
        filename: file.webLinkTitle || file.originalFilename,
        mimeType: file.mimeType,
        expiresIn: null,
        isWebLink: true,
      }, { status: 200 });
    }

    if (!file.s3Bucket || !file.s3Key || file.s3Bucket === 'weblink') {
      console.error('GET download URL error: Missing S3 configuration for file', fileIdInt);
      FileLogger.error({
        requestId,
        ip,
        userAgent,
        userId,
        assetId: file.assetId ?? undefined,
        fileId: fileIdInt,
        filename: file.filename ?? undefined,
        action: 'DOWNLOAD',
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

    if (!isS3Configured()) {
      console.error('GET download URL error: S3 configuration invalid (voir /api/health)');
      FileLogger.error({
        requestId,
        ip,
        userAgent,
        userId,
        assetId: file.assetId ?? undefined,
        fileId: fileIdInt,
        filename: file.filename ?? undefined,
        action: 'DOWNLOAD',
        error: 'S3_CREDENTIALS_MISSING',
      });
      return NextResponse.json(
        { 
          error: 'Server configuration error', 
          code: 'S3_CREDENTIALS_MISSING' 
        },
        { status: 500 }
      );
    }

    // Nom lisible : titre du document + extension, accents conservés
    // (voir src/lib/download-filename.ts).
      const downloadName = downloadFilename(file);

    const downloadUrl = await signGetUrl({
      bucket: file.s3Bucket,
      key: file.s3Key,
      responseContentDisposition: contentDisposition(downloadName),
      responseContentType: file.mimeType ?? undefined,
      expiresIn: DOWNLOAD_URL_TTL_S,
    });

    // Log success
    FileLogger.success({
      requestId,
      ip,
      userAgent,
      userId,
      assetId: file.assetId ?? undefined,
      fileId: fileIdInt,
      filename: file.filename ?? undefined,
      action: 'DOWNLOAD',
      details: {
        size: file.size,
        mimeType: file.mimeType,
      },
    });

    return NextResponse.json({
      downloadUrl,
      filename: downloadName,
      expiresIn: DOWNLOAD_URL_TTL_S,
    }, { status: 200, headers: { 'Cache-Control': 'private, no-store' } });

  } catch (error) {
    if (error instanceof S3ConfigError) {
      logS3Error('GET /api/files/[id]/download', error);
      return NextResponse.json(
        { error: 'Storage configuration error', code: 'S3_CONFIG_INVALID' },
        { status: 500 }
      );
    }
    console.error('GET /api/files/[id]/download error:', (error as Error)?.name, (error as Error)?.message);
    FileLogger.error({
      requestId,
      ip,
      userAgent,
      userId: 0,
      action: 'DOWNLOAD',
      error: (error as Error).message,
    });
    
    if ((error as Error).message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'UNAUTHORIZED', message: 'Non authentifié' },
        { status: 401 }
      );
    }
    if ((error as Error).message === 'Access denied') {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Accès refusé' },
        { status: 403 }
      );
    }
    
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}