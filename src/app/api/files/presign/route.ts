import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, assets } from '@/db/schema';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sanitizeFilename, validateExtension, ALLOWED_MIME_TYPES } from '@/lib/file-validation';
import { generateS3Key } from '@/lib/s3-naming';
import { rateLimiter } from '@/lib/rate-limiter';
import { getSession } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';
import { s3Client, S3_BUCKET } from '@/lib/s3-client';

// Constants
const MAX_FILE_SIZE_VIDEO = 500_000_000; // 500 MB for videos
const MAX_FILES_PER_USER = 1000;
const MAX_FILES_PER_ASSET = 100;
const PRESIGNED_URL_EXPIRATION = 3600; // 1 hour

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
      const { userId, currentAccountId } = session;
      
      if (!currentAccountId) {
        return NextResponse.json(
          { error: 'NO_ACCOUNT', message: 'No account selected' },
          { status: 401 }
        );
      }
      

    // Rate limiting - CORRECTION: utiliser check() au lieu de checkLimit()
    const rateLimit = rateLimiter.check(`presign:${userId}`);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Limite de ${rateLimit.limit} requêtes par minute atteinte`,
          remaining: rateLimit.remaining,
          resetAt: rateLimit.resetAt,
        },
        { status: 429 }
      );
    }

    // Parse request body
    const body = await request.json();
    const { assetId, filename, mimeType, size, sha256Hash } = body;

    // Validate required fields - assetId is now optional (can be 0 or null)
    if (!filename) {
      return NextResponse.json(
        { error: 'MISSING_FILENAME', message: 'Filename is required' },
        { status: 400 }
      );
    }

    if (!mimeType) {
      return NextResponse.json(
        { error: 'MISSING_MIME_TYPE', message: 'MIME type is required' },
        { status: 400 }
      );
    }

    if (size === undefined || size === null) {
      return NextResponse.json(
        { error: 'MISSING_SIZE', message: 'File size is required' },
        { status: 400 }
      );
    }

    if (!sha256Hash) {
      return NextResponse.json(
        { error: 'MISSING_HASH', message: 'sha256Hash is required for integrity verification' },
        { status: 400 }
      );
    }

    // Parse assetId - null or 0 means unassigned
    let assetIdInt: number | null = null;
    if (assetId && assetId !== 0) {
      assetIdInt = parseInt(assetId);
      if (isNaN(assetIdInt)) {
        return NextResponse.json(
          { error: 'INVALID_ASSET_ID', message: 'Asset ID must be a valid number' },
          { status: 400 }
        );
      }
    }

    // Validate size is a number
    const sizeInt = parseInt(size);
    if (isNaN(sizeInt)) {
      return NextResponse.json(
        { error: 'INVALID_SIZE', message: 'File size must be a valid number' },
        { status: 400 }
      );
    }

    // ✅ CORRECTION CRITIQUE: Validation fichier vide (0 bytes)
    if (sizeInt === 0) {
      return NextResponse.json(
        { 
          error: 'FILE_EMPTY',
          message: 'Les fichiers de taille 0 bytes sont refusés'
        },
        { status: 400 }
      );
    }

    // Validate file size — only videos have a cap (500 MB); other documents are unlimited
    const isVideo = typeof mimeType === 'string' && mimeType.startsWith('video/');
    if (isVideo && sizeInt > MAX_FILE_SIZE_VIDEO) {
      return NextResponse.json(
        {
          error: 'FILE_TOO_LARGE',
          message: `Vidéo trop volumineuse (max ${MAX_FILE_SIZE_VIDEO / 1_000_000}MB)`,
          maxSize: MAX_FILE_SIZE_VIDEO,
          providedSize: sizeInt
        },
        { status: 400 }
      );
    }

    // Validate MIME type - strict server-side check
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      return NextResponse.json(
        { 
          error: 'INVALID_MIME_TYPE',
          message: 'Type de fichier non autorisé. Seuls les documents, images et fichiers texte sont autorisés.',
          allowedTypes: ALLOWED_MIME_TYPES
        },
        { status: 400 }
      );
    }

    // Sanitize filename - strict ASCII-safe
    const sanitizedFilename = sanitizeFilename(filename);
    if (!sanitizedFilename) {
      return NextResponse.json(
        { 
          error: 'INVALID_FILENAME',
          message: 'Nom de fichier invalide. Le nom doit être ASCII-safe, max 255 caractères, et ne peut contenir de séquences de traversée de chemin ou d\'extensions dangereuses.'
        },
        { status: 400 }
      );
    }

    // Validate extension matches MIME type
    if (!validateExtension(sanitizedFilename, mimeType)) {
      return NextResponse.json(
        { 
          error: 'EXTENSION_MIME_MISMATCH',
          message: 'L\'extension du fichier ne correspond pas au type MIME déclaré'
        },
        { status: 400 }
      );
    }

      // Validate asset exists and user has access - only if assetId is provided
      if (assetIdInt) {
        const asset = await db.select()
          .from(assets)
          .where(
            and(
              eq(assets.id, assetIdInt),
              eq(assets.accountId, currentAccountId)
            )
          )
          .limit(1);

        if (asset.length === 0) {
          return NextResponse.json(
            { error: 'ASSET_NOT_FOUND', message: 'Bien introuvable ou accès refusé' },
            { status: 404 }
          );
        }
      }

    // Check S3 credentials
    if (!S3_BUCKET) {
      console.error('S3 bucket not configured');
      return NextResponse.json(
        { error: 'S3_NOT_CONFIGURED', message: 'Service de stockage non configuré' },
        { status: 500 }
      );
    }

      // Quota checks - count total files for account (where deletedAt is null)
      const accountFileCount = await db.select({ count: sql<number>`count(*)` })
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.accountId, currentAccountId),
            isNull(assetFiles.deletedAt),
            or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus))
          )
        );

      const totalFiles = Number(accountFileCount[0]?.count || 0);
      if (totalFiles >= MAX_FILES_PER_USER) {
        return NextResponse.json(
          { 
            error: 'ACCOUNT_FILE_QUOTA_EXCEEDED',
            message: `Limite de fichiers atteinte (${MAX_FILES_PER_USER} fichiers)`,
            currentCount: totalFiles,
            maxAllowed: MAX_FILES_PER_USER
          },
          { status: 400 }
        );
      }



    // Check files per asset - only if assetId is provided
    if (assetIdInt) {
      const assetFileCount = await db.select({ count: sql<number>`count(*)` })
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.assetId, assetIdInt),
            isNull(assetFiles.deletedAt)
          )
        );

      const assetFilesCount = Number(assetFileCount[0]?.count || 0);
      if (assetFilesCount >= MAX_FILES_PER_ASSET) {
        return NextResponse.json(
          { 
            error: 'ASSET_FILE_QUOTA_EXCEEDED',
            message: `Limite de fichiers par bien atteinte (${MAX_FILES_PER_ASSET} fichiers)`,
            currentCount: assetFilesCount,
            maxAllowed: MAX_FILES_PER_ASSET
          },
          { status: 400 }
        );
      }
    }

    // Extract file extension
    const fileExtension = sanitizedFilename.split('.').pop() || '';

    // Create PENDING record in assetFiles table to get fileId
    const now = new Date();
    const tempS3Key = 'temp'; // Temporary value, will be updated after getting fileId
    
      const newFile = await db.insert(assetFiles)
        .values({
          userId: userId,
          accountId: currentAccountId,
          assetId: assetIdInt, // Can be null for unassigned files
          filename: sanitizedFilename,
          originalFilename: filename,
          retainedTitle: filename, // nom du fichier = titre par défaut
          mimeType: mimeType,
          fileExtension: fileExtension,
          size: sizeInt,
          sha256Hash: sha256Hash,
          s3Key: tempS3Key,
          s3Bucket: S3_BUCKET,
          s3Region: process.env.OVH_S3_REGION || 'gra',
          uploadStatus: 'PENDING',
          uploadedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

    if (newFile.length === 0) {
      throw new Error('Failed to create file record');
    }

    const fileId = newFile[0].id;

    // Generate S3 key using normalized format - supports null assetId
    const timestamp = Date.now();
    const s3Key = generateS3Key({
      userId: userId,
      assetId: assetIdInt,
      fileId: fileId,
      timestamp: timestamp,
      sanitizedFilename: sanitizedFilename,
    });

    // Update the file record with the real S3 key
    await db.update(assetFiles)
      .set({ s3Key: s3Key })
      .where(eq(assetFiles.id, fileId));

    // Generate presigned URL
    // NOTE: ContentLength intentionally omitted — signing it causes browsers to fail
    // when they upload via fetch(url, { body: File }) without an explicit Content-Length
    // header (OVH S3 rejects the PUT because the signed length doesn't match chunked transfer).
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: mimeType,
      Metadata: {
        userId: userId.toString(),
        assetId: assetIdInt ? assetIdInt.toString() : 'unassigned',
        fileId: fileId.toString(),
        sha256: sha256Hash,
      },
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGNED_URL_EXPIRATION,
    });

    // Return success response
    return NextResponse.json(
      {
        uploadUrl,
        fileId: fileId,
        s3Key,
        expiresIn: PRESIGNED_URL_EXPIRATION,
      },
      { status: 201 }
    );

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    const errMsg = (error as Error).message;
    if (errMsg === 'AUTH_REQUIRED' || errMsg === 'INVALID_TOKEN' || errMsg === 'ACCOUNT_SUSPENDED') {
      return SessionService.handleSessionError(error);
    }

    console.error('POST /api/files/presign error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}