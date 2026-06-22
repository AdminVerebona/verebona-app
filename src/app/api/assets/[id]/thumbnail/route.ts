import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, assetFiles } from '@/db/schema';
import { eq, and, or, isNull } from 'drizzle-orm';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SessionService } from '@/lib/session-service';
import { s3Client, S3_BUCKET } from '@/lib/s3-client';
import sharp from 'sharp';

// Server-side signed URL cache — 55 min TTL (S3 URLs expire after 60 min)
const THUMB_CACHE = new Map<string, { url: string; exp: number }>();
const THUMB_CACHE_TTL_MS = 55 * 60 * 1000;

/**
 * Extract the S3 key from a stored thumbnailUrl.
 * Handles both formats in the DB:
 *   path-style:    https://s3.gra.io.cloud.ovh.net/{bucket}/{key}
 *   virtual-host:  https://{bucket}.s3.gra.io.cloud.ovh.net/{key}
 *   raw key:       verebona/u_1/a_5/...  (no http prefix)
 */
function extractS3Key(thumbnailUrl: string, bucket: string): string | null {
  // Raw key — no protocol
  if (!thumbnailUrl.startsWith('http')) return thumbnailUrl;

  try {
    const url = new URL(thumbnailUrl);

    // Virtual-hosted: hostname starts with bucket name
    if (url.hostname.startsWith(`${bucket}.`)) {
      // pathname is /{key}
      return url.pathname.replace(/^\//, '');
    }

    // Path-style: pathname is /{bucket}/{key}
    const withoutLeading = url.pathname.replace(/^\//, '');
    const slashIdx = withoutLeading.indexOf('/');
    if (slashIdx === -1) return null;
    return withoutLeading.substring(slashIdx + 1);
  } catch {
    return null;
  }
}

/**
 * GET /api/assets/[id]/thumbnail
 * Returns a signed URL for the asset thumbnail.
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

    const [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);

    if (!asset) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    if (asset.accountId !== session.currentAccountId) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    if (!asset.thumbnailUrl) {
      return NextResponse.json({ error: 'NO_THUMBNAIL' }, { status: 404 });
    }

    const bucket = S3_BUCKET!;
    const s3Key = extractS3Key(asset.thumbnailUrl, bucket);
    if (!s3Key) {
      return NextResponse.json({ error: 'INVALID_URL' }, { status: 500 });
    }

    const cacheKey = `${session.currentAccountId}-${assetId}`;
    const cached = THUMB_CACHE.get(cacheKey);
    if (cached && Date.now() < cached.exp) {
      return NextResponse.json({ url: cached.url, expiresIn: 3600 }, {
        status: 200,
        headers: { 'Cache-Control': 'private, max-age=3300, stale-while-revalidate=300' },
      });
    }

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ResponseContentDisposition: 'inline',
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    THUMB_CACHE.set(cacheKey, { url, exp: Date.now() + THUMB_CACHE_TTL_MS });

    return NextResponse.json({ url, expiresIn: 3600 }, {
      status: 200,
      headers: { 'Cache-Control': 'private, max-age=3300, stale-while-revalidate=300' },
    });

  } catch (error) {
    console.error('GET /api/assets/[id]/thumbnail error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

/**
 * PUT /api/assets/[id]/thumbnail
 * JSON body  { fileId: number }   — promote an existing image file
 * Form-data  { file: File }       — upload a new image directly
 */
export async function PUT(
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

    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId)))
      .limit(1);

    if (!asset) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    const bucket = S3_BUCKET!;
    const contentType = request.headers.get('content-type') ?? '';

    // ── Option A: promote an existing assetFile ────────────────────────────
    if (contentType.includes('application/json')) {
      const { fileId } = await request.json() as { fileId: number };
      if (!fileId) return NextResponse.json({ error: 'MISSING_FILE_ID' }, { status: 400 });

      const [file] = await db
        .select()
        .from(assetFiles)
        .where(and(
          eq(assetFiles.id, fileId),
          eq(assetFiles.accountId, session.currentAccountId),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
        ))
        .limit(1);

      if (!file?.s3Key) return NextResponse.json({ error: 'FILE_NOT_FOUND' }, { status: 404 });
      if (!file.mimeType?.startsWith('image/')) return NextResponse.json({ error: 'NOT_AN_IMAGE' }, { status: 400 });

      // Store the raw s3Key as thumbnailUrl — GET knows how to sign it
      await db.update(assets)
        .set({ thumbnailUrl: file.s3Key, updatedAt: new Date() })
        .where(eq(assets.id, assetId));

      // Return a fresh signed URL so the UI can display it immediately
      const command = new GetObjectCommand({ Bucket: bucket, Key: file.s3Key, ResponseContentDisposition: 'inline' });
      const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

      return NextResponse.json({ thumbnailUrl: file.s3Key, signedUrl }, { status: 200 });
    }

    // ── Option B: direct upload ────────────────────────────────────────────
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      if (!file) return NextResponse.json({ error: 'MISSING_FILE' }, { status: 400 });
      if (!file.type.startsWith('image/')) return NextResponse.json({ error: 'NOT_AN_IMAGE' }, { status: 400 });
      if (file.size > 5 * 1024 * 1024) return NextResponse.json({ error: 'FILE_TOO_LARGE' }, { status: 400 });

      const arrayBuffer = await file.arrayBuffer();
      const sharpInstance = sharp(Buffer.from(arrayBuffer));
      const { width, height } = await sharpInstance.metadata();
      const needsResize = (width ?? 0) > 800 || (height ?? 0) > 800;
      const optimized = await (needsResize
        ? sharpInstance.resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        : sharpInstance
      ).webp({ quality: 82 }).toBuffer();

      const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
      const s3Key = `verebona/u_${session.userId}/a_${assetId}/thumbnail/${Date.now()}_${baseName}.webp`;

      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        ContentType: 'image/webp',
        ContentLength: optimized.byteLength,
        Body: optimized,
      }));

      await db.update(assets)
        .set({ thumbnailUrl: s3Key, updatedAt: new Date() })
        .where(eq(assets.id, assetId));

      const command = new GetObjectCommand({ Bucket: bucket, Key: s3Key, ResponseContentDisposition: 'inline' });
      const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

      return NextResponse.json({ thumbnailUrl: s3Key, signedUrl }, { status: 200 });
    }

    return NextResponse.json({ error: 'UNSUPPORTED_CONTENT_TYPE' }, { status: 415 });

  } catch (error) {
    console.error('PUT /api/assets/[id]/thumbnail error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
