import { NextResponse } from 'next/server';
import { runNotificationPurge } from '@/lib/notifications/scheduled/purge';

/**
 * GET /api/cron/notifications/purge  (CDC §13.4 / §19.3)
 * Applique la politique de rétention. Protégé par CRON_SECRET.
 * Fréquence conseillée : une fois par jour.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runNotificationPurge();
    console.info('[cron/notifications/purge]', JSON.stringify(result));
    return NextResponse.json({ ok: true, ...result, processedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[cron/notifications/purge] erreur:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
