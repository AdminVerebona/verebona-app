import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, substructures, equipments } from '@/db/schema';
import { eq, and, isNull, desc, lt, inArray, or } from 'drizzle-orm';
import { parsePaginationParams, buildPaginationResponse, getCursorId } from '@/lib/pagination';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { logS3Error, signGetUrl } from '@/lib/s3-config';
import { isThumbnailCandidate } from '@/services/documents/thumbnails/thumbnail-spec';

// GET /api/files - List files for current account (FIXED: use accountId)
export async function GET(request: NextRequest) {
  try {
    // Get session with accountId
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session || !session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const { searchParams } = new URL(request.url);
    const { limit, cursor } = parsePaginationParams(searchParams);
    const assetId = searchParams.get('assetId');
    const uploadStatus = searchParams.get('uploadStatus');

    // Build conditions array - FIXED: use accountId instead of userId
    const currentAccountId = session.currentAccountId;
    const conditions: ReturnType<typeof eq>[] = [
      eq(assetFiles.accountId, currentAccountId),
      isNull(assetFiles.deletedAt),
    ];

    // Cursor pagination
    const cursorId = getCursorId(cursor);
    if (cursorId !== null) {
      conditions.push(lt(assetFiles.id, cursorId));
    }

    // Filter by assetId — include files attached via substructureId or equipmentId
    if (assetId) {
      const assetIdInt = parseInt(assetId);
      if (!isNaN(assetIdInt)) {
        // Load sub-IDs for broader scope (same logic as buildAssetSnapshot)
        const [subIds, equipIds] = await Promise.all([
          db.select({ id: substructures.id }).from(substructures).where(eq(substructures.assetId, assetIdInt)).then(r => r.map(s => s.id)),
          db.select({ id: equipments.id }).from(equipments).where(and(eq(equipments.assetId, assetIdInt), isNull(equipments.archivedAt))).then(r => r.map(e => e.id)),
        ]);

        const scopeCondition = subIds.length > 0 && equipIds.length > 0
          ? or(eq(assetFiles.assetId, assetIdInt), inArray(assetFiles.substructureId, subIds), inArray(assetFiles.equipmentId, equipIds))
          : subIds.length > 0
          ? or(eq(assetFiles.assetId, assetIdInt), inArray(assetFiles.substructureId, subIds))
          : equipIds.length > 0
          ? or(eq(assetFiles.assetId, assetIdInt), inArray(assetFiles.equipmentId, equipIds))
          : eq(assetFiles.assetId, assetIdInt);

        conditions.push(scopeCondition!);
      }
    }

    // Filter by uploadStatus
    if (uploadStatus && ['PENDING', 'COMPLETED', 'FAILED'].includes(uploadStatus)) {
      conditions.push(eq(assetFiles.uploadStatus, uploadStatus));
    }

    // Execute query with accountId filter
    const results = await db
      .select()
      .from(assetFiles)
      .where(and(...conditions))
      .orderBy(desc(assetFiles.id))
      .limit(limit + 1);

    const paginatedResponse = buildPaginationResponse(results, limit);

    // URL signées des images (configuration S3 canonique, APP-PERF-26).
    // Un échec de signature n'est plus masqué : il est journalisé (typé, sans
    // secret) et signalé par `previewError`. `thumbnailUrl` désigne la
    // miniature autorisée (APP-PERF-06/27), à préférer pour les listes.
    let signatureKo: string | null = null;
    const itemsWithPreviews = await Promise.all(
      paginatedResponse.data.map(async (file: any) => {
        const isImage = file.mimeType?.startsWith('image/');
        let previewUrl: string | null = null;
        let previewError: string | undefined;
        if (isImage && file.s3Key && !signatureKo) {
          try {
            previewUrl = await signGetUrl({ bucket: file.s3Bucket, key: file.s3Key, responseContentDisposition: 'inline' });
          } catch (e) {
            signatureKo = logS3Error('GET /api/files (signature aperçu)', e).kind;
          }
        }
        if (isImage && file.s3Key && !previewUrl && signatureKo) previewError = `S3_${signatureKo}`;
        const thumbnailUrl = isThumbnailCandidate(file) ? `/api/files/${file.id}/thumbnail` : null;
        return { ...file, previewUrl, thumbnailUrl, ...(previewError ? { previewError } : {}) };
      })
    );

    return NextResponse.json({ ...paginatedResponse, data: itemsWithPreviews }, { status: 200 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('GET /api/files error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}
