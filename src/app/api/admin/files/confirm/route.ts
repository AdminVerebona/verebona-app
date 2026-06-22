import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

export async function POST(request: NextRequest) {
  try {
    // Verify admin authentication
    await await requireAdmin(request);
    const { userId } = await getSession(request);

    const body = await request.json();
    const { fileId } = body;

    if (!fileId) {
      return NextResponse.json(
        { error: 'MISSING_FILE_ID', message: 'File ID is required' },
        { status: 400 }
      );
    }

    const fileIdInt = parseInt(fileId);
    if (isNaN(fileIdInt)) {
      return NextResponse.json(
        { error: 'INVALID_FILE_ID', message: 'File ID must be a valid number' },
        { status: 400 }
      );
    }

    // Get file record
    const fileRecord = await db.select()
      .from(assetFiles)
      .where(eq(assetFiles.id, fileIdInt))
      .limit(1);

    if (fileRecord.length === 0) {
      return NextResponse.json(
        { error: 'FILE_NOT_FOUND', message: 'Fichier introuvable' },
        { status: 404 }
      );
    }

    const file = fileRecord[0];

    // Verify the file is in PENDING status
    if (file.uploadStatus !== 'PENDING') {
      return NextResponse.json(
        { 
          error: 'INVALID_STATUS',
          message: `Le fichier est déjà en statut ${file.uploadStatus}`,
          currentStatus: file.uploadStatus
        },
        { status: 400 }
      );
    }

    // Update file status to COMPLETED
    const now = new Date();
    const updated = await db.update(assetFiles)
      .set({
        uploadStatus: 'COMPLETED',
        updatedAt: now,
      })
      .where(eq(assetFiles.id, fileIdInt))
      .returning();

    if (updated.length === 0) {
      throw new Error('Failed to update file status');
    }


    return NextResponse.json(
      {
        message: 'Upload confirmé avec succès',
        file: updated[0],
      },
      { status: 200 }
    );

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('POST /api/admin/files/confirm error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}
