import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and, isNull, sql, or } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';

const MAX_FILES_PER_USER = 1000;

export async function GET(request: NextRequest) {
  try {
    // ✅ CORRECTION: Utiliser getSession() au lieu de lire x-user-id
    const { userId } = await getSession(request);

    // Count total files and sum total size for user
    const result = await db
      .select({
        totalFiles: sql<number>`COUNT(*)`,
        totalSize: sql<number>`COALESCE(SUM(${assetFiles.size}), 0)`,
      })
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.userId, userId),
          isNull(assetFiles.deletedAt),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus))
        )
      );

    const totalFiles = Number(result[0]?.totalFiles || 0);
    const totalSize = Number(result[0]?.totalSize || 0);

    const quotaExceeded = totalFiles >= MAX_FILES_PER_USER;

    return NextResponse.json(
      {
        userId,
        totalFiles,
        totalSize,
        maxFiles: MAX_FILES_PER_USER,
        maxSize: null,
        quotaExceeded,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('GET /api/files/quota error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}