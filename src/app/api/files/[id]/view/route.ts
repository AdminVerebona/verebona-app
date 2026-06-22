import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { FileLogger } from '@/lib/file-logger';
import { SessionService } from '@/lib/session-service';

const s3Client = new S3Client({
  region: process.env.OVH_S3_REGION || 'gra',
  endpoint: process.env.OVH_S3_ENDPOINT || 'https://s3.gra.io.cloud.ovh.net',
  credentials: {
    accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: false,
});

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
          isNull(assetFiles.deletedAt)
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
      return NextResponse.json(
        { error: 'File not found or has been deleted', code: 'FILE_NOT_FOUND' },
        { status: 404 }
      );
    }

    const file = fileRecords[0];

    // Check ownership by accountId (not userId)
    if (file.accountId !== accountId) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Access denied' },
        { status: 403 }
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
      const command = new GetObjectCommand({
        Bucket: file.s3Bucket ?? undefined,
        Key: file.s3Key ?? undefined,
        ResponseContentDisposition: 'inline',
        ResponseContentType: file.mimeType ?? undefined,
      });

    const viewUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

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
      expiresIn: 3600,
    }, { status: 200 });

  } catch (error) {
    console.error('GET /api/files/[id]/view error:', error);
    FileLogger.error({
      requestId,
      ip,
      userAgent,
      userId: 0,
      action: 'VIEW',
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
