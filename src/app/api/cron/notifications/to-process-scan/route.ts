import { NextResponse } from 'next/server';
import { runToProcessScan } from '@/lib/notifications/scheduled/to-process-scan';

/**
 * GET /api/cron/notifications/to-process-scan  (CDC §13.4 / §11.4)
 *
 * Compare la vue « À traiter » à l'état persistant pour notifier les nouveaux
 * éléments actifs (immédiat). Idempotent (déduplication par item + cycle).
 * Protégé par CRON_SECRET. Fréquence conseillée : toutes les 5 à 15 minutes.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runToProcessScan();
    if (result.created > 0 || result.resolved > 0) {
      console.info('[cron/to-process-scan]', JSON.stringify(result));
    }
    return NextResponse.json({ ok: true, ...result, processedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[cron/to-process-scan] erreur:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
