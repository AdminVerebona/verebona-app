import { NextResponse } from 'next/server';
import { purgePendingBlobs } from '@/services/storage/blob-purge.service';

/**
 * GET /api/cron/purge-blobs
 * Traite la file `pending_blob_deletions` (suppression physique des objets
 * OVH S3). Même traitement que la tâche quotidienne interne `daily-blob-purge`
 * (daily-maintenance-scheduler) : ordre `scheduled_for`, lots successifs,
 * backoff et exclusion après MAX_ATTEMPTS échecs (blob-purge.service).
 * Idempotent : un déclenchement externe en plus est sans effet.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  // Secret non configuré : refus. Sans ce garde, l'en-tête littéral
  // « Bearer undefined » suffisait à déclencher la tâche.
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const results = await purgePendingBlobs();
    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error('[Purge Cron Error]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
