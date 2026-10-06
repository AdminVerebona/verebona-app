/**
 * Événements du matin (CDC Notifications §13.4 / §11.4) : rappels d'échéance
 * à J-7, récapitulatif « À traiter », rappels de fin d'essai — prévus à
 * 8 h 30 Europe/Paris.
 *
 * Traitement partagé par GET /api/cron/notifications/scheduled-events et la
 * tâche planifiée interne `notifications-scheduled-events` (lot 25).
 *
 * Le créneau est calculé en heure locale (jamais un UTC fixe) et la
 * déduplication se fait par date locale (`dedupe_key` unique de l'outbox) :
 * plusieurs passages le même matin, ou un passage interne doublé d'un appel
 * externe, n'envoient rien deux fois.
 */
import { runDeadlineReminders } from './deadlines';
import { runToProcessDigest } from './to-process-digest';
import { runTrialEndingReminders } from './trial-ending';
import { isAtOrAfterParisTime } from '../time-paris';

/** Créneau du matin, heure de Paris. */
export const MORNING_SLOT: readonly [number, number] = [8, 30];

export type MorningEventsResult =
  | { skipped: 'before_0830_paris' }
  | {
      skipped?: undefined;
      deadlines: Awaited<ReturnType<typeof runDeadlineReminders>>;
      digest: Awaited<ReturnType<typeof runToProcessDigest>>;
      trialEnding: Awaited<ReturnType<typeof runTrialEndingReminders>>;
    };

export async function runMorningScheduledEvents(
  opts: { force?: boolean; now?: Date } = {},
): Promise<MorningEventsResult> {
  const now = opts.now ?? new Date();
  if (!opts.force && !isAtOrAfterParisTime(MORNING_SLOT[0], MORNING_SLOT[1], now)) {
    return { skipped: 'before_0830_paris' };
  }
  const deadlines = await runDeadlineReminders();
  const digest = await runToProcessDigest();
  const trialEnding = await runTrialEndingReminders();
  console.info('[scheduled-events]', JSON.stringify({ deadlines, digest, trialEnding }));
  return { deadlines, digest, trialEnding };
}
