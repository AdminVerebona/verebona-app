import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { FileLogger } from '@/lib/file-logger';
import { ApiErrors } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

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

    // Check ownership by accountId (not userId)
    if (file.accountId !== accountId) {
      return ApiErrors.forbidden();
    }

    return NextResponse.json(file, { status: 200 });
  } catch (error) {
    console.error('GET file error:', error);
    FileLogger.error({
      requestId,
      ip,
      userAgent,
      userId: 0,
      action: 'QUOTA_CHECK',
      error: (error as Error).message,
    });
    
    if ((error as Error).message === 'Unauthorized') {
      return ApiErrors.unauthorized();
    }
    if ((error as Error).message === 'Access denied') {
      return ApiErrors.forbidden();
    }
    
    return ApiErrors.internalError((error as Error).message);
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
    if (!isAdmin && file.accountId !== accountId) {
      return ApiErrors.forbidden();
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
    console.error('DELETE file error:', error);
    FileLogger.error({
      requestId,
      ip,
      userAgent,
      userId: 0,
      action: 'DELETE',
      error: (error as Error).message,
    });
    
    if ((error as Error).message === 'Unauthorized') {
      return ApiErrors.unauthorized();
    }
    if ((error as Error).message === 'Access denied') {
      return ApiErrors.forbidden();
    }
    
    return ApiErrors.internalError((error as Error).message);
  }
}