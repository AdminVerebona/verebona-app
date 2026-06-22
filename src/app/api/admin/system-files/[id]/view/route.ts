import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { systemFiles } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, S3_BUCKET } from '@/lib/s3-client';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Extract and validate ID
    const { id } = await params;
    const fileId = parseInt(id);

    if (!fileId || isNaN(fileId)) {
      return NextResponse.json(
        { 
          error: 'Valid file ID is required',
          code: 'INVALID_FILE_ID'
        },
        { status: 400 }
      );
    }

    // Query database for file
    const files = await db
      .select()
      .from(systemFiles)
      .where(and(eq(systemFiles.id, fileId), isNull(systemFiles.deletedAt)))
      .limit(1);

    if (files.length === 0) {
      // Check if file exists but is deleted
      const deletedFiles = await db
        .select()
        .from(systemFiles)
        .where(eq(systemFiles.id, fileId))
        .limit(1);

      if (deletedFiles.length > 0 && deletedFiles[0].deletedAt) {
        return NextResponse.json(
          { 
            error: 'File has been deleted',
            code: 'FILE_DELETED'
          },
          { status: 410 }
        );
      }

      return NextResponse.json(
        { 
          error: 'File not found',
          code: 'FILE_NOT_FOUND'
        },
        { status: 404 }
      );
    }

    const file = files[0];

    // Auth check: Allow public access for logos, require admin for others
    const isPublic = file.fileType === 'LOGO_LIGHT' || file.fileType === 'LOGO_DARK';
    
    if (!isPublic) {
      try {
        await requireAdmin(request);
      } catch (error) {
        return NextResponse.json(
          { error: 'Unauthorized', code: 'UNAUTHORIZED' },
          { status: 401 }
        );
      }
    }

    // Validate upload status
    if (file.uploadStatus === 'PENDING') {
      return NextResponse.json(
        { 
          error: 'File upload is still pending',
          code: 'FILE_PENDING'
        },
        { status: 400 }
      );
    }

    if (file.uploadStatus === 'FAILED') {
      return NextResponse.json(
        { 
          error: 'File upload failed',
          code: 'FILE_UPLOAD_FAILED'
        },
        { status: 400 }
      );
    }

    // Validate S3 configuration
    if (!s3Client || !S3_BUCKET) {
      console.error('S3 configuration missing');
      return NextResponse.json(
        { 
          error: 'Storage service is not configured',
          code: 'S3_NOT_CONFIGURED'
        },
        { status: 500 }
      );
    }

    if (!file.s3Key || !file.s3Bucket) {
      console.error('File missing S3 metadata:', { fileId, s3Key: file.s3Key, s3Bucket: file.s3Bucket });
      return NextResponse.json(
        { 
          error: 'File storage metadata is missing',
          code: 'MISSING_S3_METADATA'
        },
        { status: 500 }
      );
    }

    // Generate presigned URL for viewing
    const command = new GetObjectCommand({
      Bucket: file.s3Bucket,
      Key: file.s3Key,
      ResponseContentDisposition: 'inline',
      ResponseContentType: file.mimeType || 'application/octet-stream'
    });

    const viewUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600 // 1 hour
    });

    // Redirect to the signed S3 URL so it works as an image source
    return NextResponse.redirect(viewUrl);

  } catch (error) {
    console.error('GET /api/admin/system-files/[id]/view error:', error);
    
    // Handle S3-specific errors
    if (error instanceof Error) {
      if (error.name === 'NoSuchKey') {
        return NextResponse.json(
          { 
            error: 'File not found in storage',
            code: 'S3_FILE_NOT_FOUND'
          },
          { status: 404 }
        );
      }
      
      if (error.name === 'AccessDenied') {
        return NextResponse.json(
          { 
            error: 'Access denied to storage service',
            code: 'S3_ACCESS_DENIED'
          },
          { status: 403 }
        );
      }
    }

    return NextResponse.json(
      { 
        error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'),
        code: 'INTERNAL_ERROR'
      },
      { status: 500 }
    );
  }
}