import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, assetFiles } from '@/db/schema';
import { eq, and, isNull, or } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';

/**
 * GET /api/assets/[id]/photos
 * Returns all image-type asset files linked to this asset
 * (via assetId OR linkedAssetId) — used by ThumbnailEditDrawer.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session?.currentAccountId) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    }

    const { id } = await context.params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    // Verify ownership
    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(
        eq(assets.id, assetId),
        eq(assets.accountId, session.currentAccountId),
        isNull(assets.deletedAt)
      ))
      .limit(1);

    if (!asset) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    const photos = await db
      .select({
        id: assetFiles.id,
        mimeType: assetFiles.mimeType,
        originalFilename: assetFiles.originalFilename,
        s3Key: assetFiles.s3Key,
        uploadedAt: assetFiles.uploadedAt,
      })
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.accountId, session.currentAccountId),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt),
          eq(assetFiles.isWebLink, false),
          // Match image MIME types via SQL LIKE
          or(
            eq(assetFiles.assetId, assetId),
            eq(assetFiles.linkedAssetId, assetId)
          )
        )
      )
      .orderBy(assetFiles.uploadedAt);

    // Filter to images only (mimeType starts with "image/")
    const imagePhotos = photos.filter(p => p.mimeType?.startsWith('image/'));

    return NextResponse.json({ photos: imagePhotos });
  } catch (error) {
    console.error('GET /api/assets/[id]/photos error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
