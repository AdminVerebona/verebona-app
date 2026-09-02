import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, S3_BUCKET } from '@/lib/s3-client';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
  try {
    // Verify admin authentication
    await await requireAdmin(request);

    const fileId = parseInt(params.id);
    if (isNaN(fileId)) {
      return NextResponse.json(
        { error: 'INVALID_FILE_ID', message: 'Invalid file ID' },
        { status: 400 }
      );
    }

    // Get file record
    const fileRecord = await db.select()
      .from(assetFiles)
      .where(eq(assetFiles.id, fileId))
      .limit(1);

    if (fileRecord.length === 0) {
      return NextResponse.json(
        { error: 'FILE_NOT_FOUND', message: 'Fichier introuvable' },
        { status: 404 }
      );
    }

    const file = fileRecord[0];

    // Check if file is soft-deleted
    if (file.deletedAt) {
      return NextResponse.json(
        { error: 'FILE_DELETED', message: 'Fichier supprimé' },
        { status: 410 }
      );
    }

    // Check if upload is completed
    if (file.uploadStatus !== 'COMPLETED') {
      return NextResponse.json(
        { 
          error: 'FILE_NOT_READY',
          message: `Fichier non disponible (statut: ${file.uploadStatus})`,
          status: file.uploadStatus
        },
        { status: 400 }
      );
    }

    // Get file from S3
    const command = new GetObjectCommand({
      Bucket: file.s3Bucket || S3_BUCKET,
      Key: file.s3Key ?? undefined,
    });

    const s3Response = await s3Client.send(command);

    if (!s3Response.Body) {
      throw new Error('No file body in S3 response');
    }

    // Convert stream to buffer
    const chunks: Uint8Array[] = [];
    const reader = s3Response.Body.transformToWebStream().getReader();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks);

    // Return file with appropriate headers
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type': file.mimeType ?? 'application/octet-stream',
          'Content-Length': buffer.length.toString(),
          'Content-Disposition': `inline; filename="${encodeURIComponent(file.filename ?? 'file')}"`,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('GET /api/admin/files/[id]/view error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}
