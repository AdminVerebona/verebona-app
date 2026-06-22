import { NextResponse } from 'next/server';
import { db } from '@/db';
import { pendingBlobDeletions } from '@/db/schema';
import { eq, and, isNull, lt } from 'drizzle-orm';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

/**
 * GET /api/cron/purge-blobs
 * Cron quotidien pour supprimer physiquement les fichiers du storage (OVH S3)
 * après la période de rétention de 30 jours (Soft Delete).
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const results = {
    processed: 0,
    errors: 0,
    already_gone: 0,
  };

  try {
    const pending = await db
      .select()
      .from(pendingBlobDeletions)
      .where(
        and(
          isNull(pendingBlobDeletions.processedAt),
          lt(pendingBlobDeletions.scheduledFor, now)
        )
      )
      .limit(50); // Batch de 50 pour éviter les timeouts

    if (pending.length === 0) {
      return NextResponse.json({ success: true, message: 'No blobs to purge' });
    }

    const s3Client = new S3Client({
      region: process.env.OVH_S3_REGION || 'gra',
      endpoint: process.env.OVH_S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY!,
      },
    });

    for (const item of pending) {
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: process.env.OVH_S3_BUCKET,
          Key: item.storagePath,
        }));
        
        await db
          .update(pendingBlobDeletions)
          .set({ processedAt: now })
          .where(eq(pendingBlobDeletions.id, item.id));
        
        results.processed++;
      } catch (error: any) {
        // Si le fichier n'existe plus (404), on considère comme purgé
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
          await db
            .update(pendingBlobDeletions)
            .set({ processedAt: now })
            .where(eq(pendingBlobDeletions.id, item.id));
          results.already_gone++;
        } else {
          console.error(`[Purge Error] Failed to delete ${item.storagePath}:`, error);
          await db
            .update(pendingBlobDeletions)
            .set({ errorMessage: error.message })
            .where(eq(pendingBlobDeletions.id, item.id));
          results.errors++;
        }
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error('[Purge Cron Error]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
