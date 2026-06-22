import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { systemFiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, S3_BUCKET } from '@/lib/s3-client';
import { sanitizeFilename, validateExtension, ALLOWED_MIME_TYPES } from '@/lib/file-validation';

const MAX_FILE_SIZE = 10_000_000; // 10 MB
const PRESIGNED_URL_EXPIRATION = 3600; // 1 hour

export async function POST(request: NextRequest) {
  try {
    // Authentication check - require admin
    await requireAdmin(request);

    const session = await getSession(request);
    if (!session?.userId) {
      return NextResponse.json({ 
        error: 'Authentication required',
        code: 'AUTH_REQUIRED' 
      }, { status: 401 });
    }

    // Parse request body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ 
        error: 'Invalid JSON in request body',
        code: 'INVALID_JSON' 
      }, { status: 400 });
    }

    const { filename, mimeType, size, sha256Hash, fileType } = body;

    // Validate required fields
    if (!filename) {
      return NextResponse.json({ 
        error: 'Filename is required',
        code: 'MISSING_FILENAME' 
      }, { status: 400 });
    }

    if (!mimeType) {
      return NextResponse.json({ 
        error: 'MIME type is required',
        code: 'MISSING_MIME_TYPE' 
      }, { status: 400 });
    }

    if (size === undefined || size === null) {
      return NextResponse.json({ 
        error: 'File size is required',
        code: 'MISSING_SIZE' 
      }, { status: 400 });
    }

    if (!sha256Hash) {
      return NextResponse.json({ 
        error: 'SHA256 hash is required',
        code: 'MISSING_SHA256_HASH' 
      }, { status: 400 });
    }

    if (!fileType) {
      return NextResponse.json({ 
        error: 'File type is required',
        code: 'MISSING_FILE_TYPE' 
      }, { status: 400 });
    }

    // Validate fileType enum
    const validFileTypes = ['LOGO_LIGHT', 'LOGO_DARK', 'SYSTEM_ASSET', 'OTHER'];
    if (!validFileTypes.includes(fileType)) {
      return NextResponse.json({ 
        error: `Invalid file type. Must be one of: ${validFileTypes.join(', ')}`,
        code: 'INVALID_FILE_TYPE' 
      }, { status: 400 });
    }

    // Validate size is integer >= 0 and not 0
    const fileSize = parseInt(size);
    if (isNaN(fileSize) || fileSize < 0) {
      return NextResponse.json({ 
        error: 'File size must be a non-negative integer',
        code: 'INVALID_SIZE' 
      }, { status: 400 });
    }

    if (fileSize === 0) {
      return NextResponse.json({ 
        error: 'File size cannot be zero',
        code: 'ZERO_SIZE' 
      }, { status: 400 });
    }

    // Validate max file size
    if (fileSize > MAX_FILE_SIZE) {
      return NextResponse.json({ 
        error: `File size exceeds maximum allowed size of ${MAX_FILE_SIZE} bytes (10 MB)`,
        code: 'FILE_TOO_LARGE' 
      }, { status: 400 });
    }

    // Validate MIME type
    const isImageMimeType = mimeType.startsWith('image/');
    const isAllowedMimeType = ALLOWED_MIME_TYPES.includes(mimeType);
    
    if (!isAllowedMimeType && !isImageMimeType) {
      return NextResponse.json({ 
        error: `Invalid MIME type. Must be an allowed type or start with 'image/'`,
        code: 'INVALID_MIME_TYPE' 
      }, { status: 400 });
    }

    // Sanitize filename
    const sanitizedFilename = sanitizeFilename(filename);
    if (!sanitizedFilename) {
      return NextResponse.json({ 
        error: 'Invalid filename after sanitization',
        code: 'INVALID_FILENAME' 
      }, { status: 400 });
    }

    // Extract file extension from sanitized filename
    const fileExtension = sanitizedFilename.split('.').pop()?.toLowerCase() || '';
    if (!fileExtension) {
      return NextResponse.json({ 
        error: 'File must have an extension',
        code: 'MISSING_EXTENSION' 
      }, { status: 400 });
    }

    // Validate extension matches MIME type
    const extensionValid = validateExtension(fileExtension, mimeType);
    if (!extensionValid) {
      return NextResponse.json({ 
        error: 'File extension does not match MIME type',
        code: 'EXTENSION_MISMATCH' 
      }, { status: 400 });
    }

    // Check S3 credentials
    if (!S3_BUCKET) {
      console.error('S3 configuration error: S3_BUCKET is not defined');
      return NextResponse.json({ 
        error: 'S3 storage is not configured',
        code: 'S3_NOT_CONFIGURED' 
      }, { status: 500 });
    }

    const s3Region = process.env.OVH_S3_REGION || 'gra';

    // Create initial database record with temporary s3Key
    const now = new Date();
    const tempS3Key = 'temp';

    const newFile = await db.insert(systemFiles)
      .values({
        filename: sanitizedFilename,
        originalFilename: filename,
        mimeType,
        fileExtension,
        size: fileSize,
        sha256Hash,
        fileType,
        s3Key: tempS3Key,
        s3Bucket: S3_BUCKET,
        s3Region,
        uploadStatus: 'PENDING',
        userId: session.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!newFile || newFile.length === 0) {
      return NextResponse.json({ 
        error: 'Failed to create file record',
        code: 'DATABASE_ERROR' 
      }, { status: 500 });
    }

    const fileId = newFile[0].id;

    // Generate real S3 key with fileId
    const timestamp = Date.now();
    const s3Key = `owntrack/system/f_${fileId}/${timestamp}_${sanitizedFilename}`;

    // Update database record with real s3Key
    await db.update(systemFiles)
      .set({
        s3Key,
        updatedAt: new Date(),
      })
      .where(eq(systemFiles.id, fileId));

    // Generate presigned URL
    const putObjectCommand = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: mimeType,
      ContentLength: fileSize,
      Metadata: {
        userId: session.userId.toString(),
        fileId: fileId.toString(),
        sha256: sha256Hash,
        systemFile: 'true',
      },
    });

    const uploadUrl = await getSignedUrl(s3Client, putObjectCommand, {
      expiresIn: PRESIGNED_URL_EXPIRATION,
    });

    return NextResponse.json({
      uploadUrl,
      fileId,
      s3Key,
      expiresIn: PRESIGNED_URL_EXPIRATION,
    }, { status: 201 });

  } catch (error) {
    console.error('POST /api/system/presigned-upload error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error')
    }, { status: 500 });
  }
}