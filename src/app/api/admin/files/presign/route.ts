import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sanitizeFilename, validateExtension, ALLOWED_MIME_TYPES } from '@/lib/file-validation';
import { requireAdmin, getSession } from '@/lib/auth-guards';
import { s3Client, S3_BUCKET } from '@/lib/s3-client';

const MAX_VIDEO_SIZE = 500_000_000; // 500 MB for videos
const PRESIGNED_URL_EXPIRATION = 3600; // 1 hour

export async function POST(request: NextRequest) {
  try {
    // Verify admin authentication
    await await requireAdmin(request);
    const { userId, currentAccountId } = await getSession(request);

    if (!currentAccountId) {
      return NextResponse.json(
        { error: 'NO_ACCOUNT', message: 'No account selected' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { filename, mimeType, size, sha256Hash, assetId = 0 } = body;

    // Validate required fields
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
        { error: 'MISSING_HASH', message: 'SHA256 hash is required' },
        { status: 400 }
      );
    }

    const sizeInt = parseInt(size);
    if (isNaN(sizeInt) || sizeInt === 0) {
      return NextResponse.json(
        { error: 'INVALID_SIZE', message: 'File size must be a valid positive number' },
        { status: 400 }
      );
    }

    const isVideo = typeof mimeType === 'string' && mimeType.startsWith('video/');
    if (isVideo && sizeInt > MAX_VIDEO_SIZE) {
      return NextResponse.json(
        {
          error: 'FILE_TOO_LARGE',
          message: `Vidéo trop volumineuse (max ${MAX_VIDEO_SIZE / 1_000_000}MB)`,
          maxSize: MAX_VIDEO_SIZE,
          providedSize: sizeInt
        },
        { status: 400 }
      );
    }

    // Validate MIME type - allow images for logos
    if (!ALLOWED_MIME_TYPES.includes(mimeType) && !mimeType.startsWith('image/')) {
      return NextResponse.json(
        { 
          error: 'INVALID_MIME_TYPE',
          message: 'Type de fichier non autorisé',
        },
        { status: 400 }
      );
    }

    // Sanitize filename
    const sanitizedFilename = sanitizeFilename(filename);
    if (!sanitizedFilename) {
      return NextResponse.json(
        { 
          error: 'INVALID_FILENAME',
          message: 'Nom de fichier invalide'
        },
        { status: 400 }
      );
    }

    // Check S3 credentials
    if (!S3_BUCKET) {
      console.error('S3 bucket not configured');
      return NextResponse.json(
        { error: 'S3_NOT_CONFIGURED', message: 'Service de stockage non configuré' },
        { status: 500 }
      );
    }

    // Extract file extension
    const fileExtension = sanitizedFilename.split('.').pop() || '';

    // Create PENDING record in assetFiles table (assetId = 0 for system files)
    const now = new Date();
    const tempS3Key = 'temp';
    
    const newFile = await db.insert(assetFiles)
      .values({
        userId: userId,
        accountId: currentAccountId,
        assetId: assetId, // 0 for system files
        filename: sanitizedFilename,
        originalFilename: filename,
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

    // Generate S3 key for system files: owntrack/system/f_{fileId}/{timestamp}_{filename}
    const timestamp = Date.now();
    const s3Key = `owntrack/system/f_${fileId}/${timestamp}_${sanitizedFilename}`;

    // Update the file record with the real S3 key
    await db.update(assetFiles)
      .set({ s3Key: s3Key })
      .where(eq(assetFiles.id, fileId));

    // Generate presigned URL
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: mimeType,
      ContentLength: sizeInt,
      Metadata: {
        userId: userId.toString(),
        fileId: fileId.toString(),
        sha256: sha256Hash,
        systemFile: 'true',
      },
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGNED_URL_EXPIRATION,
    });


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
    
    console.error('POST /api/admin/files/presign error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}