import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { systemFiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

export async function POST(request: NextRequest) {
  try {
    // Authentication check
    await requireAdmin(request);

    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ 
        error: 'Authentication required',
        code: 'AUTH_REQUIRED' 
      }, { status: 401 });
    }

    // Parse request body
    let body;
    try {
      body = await request.json();
    } catch (error) {
      return NextResponse.json({ 
        error: 'Invalid JSON in request body',
        code: 'INVALID_JSON' 
      }, { status: 400 });
    }

    const { fileId } = body;

    // Validate fileId
    if (!fileId) {
      return NextResponse.json({ 
        error: 'fileId is required',
        code: 'MISSING_FILE_ID' 
      }, { status: 400 });
    }

    const parsedFileId = parseInt(fileId);
    if (isNaN(parsedFileId)) {
      return NextResponse.json({ 
        error: 'fileId must be a valid integer',
        code: 'INVALID_FILE_ID' 
      }, { status: 400 });
    }

    // Check if file exists
    const existingFile = await db.select()
      .from(systemFiles)
      .where(eq(systemFiles.id, parsedFileId))
      .limit(1);

    if (existingFile.length === 0) {
      return NextResponse.json({ 
        error: 'File not found',
        code: 'FILE_NOT_FOUND' 
      }, { status: 404 });
    }

    const file = existingFile[0];

    // Verify uploadStatus is PENDING
    if (file.uploadStatus !== 'PENDING') {
      return NextResponse.json({ 
        error: `Cannot confirm upload. File status is ${file.uploadStatus}, expected PENDING`,
        code: 'INVALID_UPLOAD_STATUS',
        currentStatus: file.uploadStatus
      }, { status: 400 });
    }

    // Update file status to COMPLETED
    const updated = await db.update(systemFiles)
      .set({
        uploadStatus: 'COMPLETED',
        uploadedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(systemFiles.id, parsedFileId))
      .returning();

    if (updated.length === 0) {
      return NextResponse.json({ 
        error: 'Failed to update file status',
        code: 'UPDATE_FAILED' 
      }, { status: 500 });
    }

    const updatedFile = updated[0];

    // Return success response with file URL
    return NextResponse.json({
      success: true,
      file: updatedFile,
      fileUrl: `/api/admin/system-files/${parsedFileId}/view`
    }, { status: 200 });

  } catch (error) {
    console.error('POST error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'),
      code: 'INTERNAL_ERROR'
    }, { status: 500 });
  }
}