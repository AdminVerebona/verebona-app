import { NextResponse } from 'next/server';
import { runDeadlineReminders } from '@/lib/notifications/scheduled/deadlines';
import { runToProcessDigest } from '@/lib/notifications/scheduled/to-process-digest';
import { runTrialEndingReminders } from '@/lib/notifications/scheduled/trial-ending';
import { isAtOrAfterParisTime } from '@/lib/notifications/time-paris';

/**
 * GET /api/cron/notifications/scheduled-events  (CDC §13.4 / §11.4)
 *
 * Émet les rappels d'échéance à J-7 et le récapitulatif « À traiter », prévus à
 * 8 h 30 Europe/Paris. Le créneau est calculé en heure locale (jamais un UTC
 * fixe) et la déduplication se fait par date locale : la route peut donc être
 * planifiée à une fréquence régulière (ex. tous les 1/4 d'heure le matin) sans
 * risque de doublon, quel que soit le passage heure d'été/heure d'hiver.
 *
 * Protégé par CRON_SECRET. Passer ?force=1 permet de déclencher hors créneau
 * (tests). La livraison des notifications est faite par le dispatcher.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  // Créneau du matin : 8 h 30 Europe/Paris.
  if (!force && !isAtOrAfterParisTime(8, 30)) {
    return NextResponse.json({ ok: true, skipped: 'before_0830_paris' });
  }

  try {
    const deadlines = await runDeadlineReminders();
    const digest = await runToProcessDigest();
    const trialEnding = await runTrialEndingReminders();
    console.info('[cron/scheduled-events]', JSON.stringify({ deadlines, digest, trialEnding }));
    return NextResponse.json({ ok: true, deadlines, digest, trialEnding, processedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[cron/scheduled-events] erreur:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
