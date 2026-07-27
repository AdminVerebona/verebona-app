import { NextResponse } from 'next/server';
import { processPending } from '@/lib/notifications';

/**
 * GET /api/cron/notifications/dispatch  (CDC §13.4)
 *
 * Traite les événements dus de l'outbox de notifications : résout les canaux
 * selon les préférences et les règles obligatoires, rend le contenu, envoie et
 * journalise chaque livraison. Idempotent et concurrence-safe (réclamation
 * `FOR UPDATE SKIP LOCKED`) : deux exécutions simultanées n'envoient pas deux
 * fois la même notification.
 *
 * Protégé par CRON_SECRET (header Authorization: Bearer <secret>).
 * Fréquence conseillée : < 1 minute (§11.4).
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 500);

  try {
    const summary = await processPending(limit);
    if (summary.claimed > 0) {
      console.info('[cron/notifications/dispatch]', JSON.stringify(summary));
    }
    return NextResponse.json({ ok: true, ...summary, processedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[cron/notifications/dispatch] erreur:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
