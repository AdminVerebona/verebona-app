import { NextResponse } from 'next/server';
import { runMorningScheduledEvents } from '@/lib/notifications/scheduled/morning-events';

/**
 * GET /api/cron/notifications/scheduled-events  (CDC §13.4 / §11.4)
 *
 * Émet les rappels d'échéance à J-7 et le récapitulatif « À traiter », prévus à
 * 8 h 30 Europe/Paris. Le créneau est calculé en heure locale (jamais un UTC
 * fixe) et la déduplication se fait par date locale : la route peut donc être
 * planifiée à une fréquence régulière (ex. tous les 1/4 d'heure le matin) sans
 * risque de doublon, quel que soit le passage heure d'été/heure d'hiver.
 *
 * Lot 25 : planifiée DANS l'application (tâche interne
 * `notifications-scheduled-events`, toutes les 15 min à partir de 8 h 30) ;
 * cette route ne sert plus qu'au déclenchement manuel.
 *
 * Protégé par CRON_SECRET. Passer ?force=1 permet de déclencher hors créneau
 * (tests). La livraison des notifications est faite par le dispatcher.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  // Secret non configuré : refus. Sans ce garde, l'en-tête littéral
  // « Bearer undefined » suffisait à déclencher la tâche.
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  try {
    const result = await runMorningScheduledEvents({ force });
    if (result.skipped) return NextResponse.json({ ok: true, skipped: result.skipped });
    return NextResponse.json({ ok: true, ...result, processedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[cron/scheduled-events] erreur:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
