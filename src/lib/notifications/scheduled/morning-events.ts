/**
 * Événements planifiés des notifications (CDC Notifications §13.4 / §11.4) :
 * rappels d'échéance, récapitulatif « À traiter », rappels de fin d'essai.
 *
 * Traitement partagé par GET /api/cron/notifications/scheduled-events et la
 * tâche planifiée interne `notifications-scheduled-events` (lot 25), toutes
 * les 15 min de 8 h 30 à 21 h (Paris) :
 *   · rappels d'échéance (lot 113AH, #732) : À CHAQUE passage — rappel normal
 *     à J+7 au passage de 8 h 30, et rattrapage des échéances éligibles non
 *     couvertes (J+0 … J+7 : création après 11 h, reprise après panne…) ;
 *     couverture par événement × destinataire (`deadlines.ts`) ;
 *   · récapitulatif et fin d'essai : seulement de 8 h 30 à 11 h, comme avant
 *     (jamais d'envoi tardif ; déduplication par date locale).
 *
 * Le créneau est calculé en heure locale (jamais un UTC fixe) : plusieurs
 * passages, ou un passage interne doublé d'un appel externe, n'envoient
 * rien deux fois.
 */
import { runDeadlineReminders } from './deadlines';
import { runToProcessDigest } from './to-process-digest';
import { runTrialEndingReminders } from './trial-ending';
import { isAtOrAfterParisTime } from '../time-paris';
import { isWithinDeadlineSendWindow } from './deadline-reminder-policy';

/** Créneau du matin, heure de Paris. */
export const MORNING_SLOT: readonly [number, number] = [8, 30];
const EMPTY_DEADLINES_RESULT: Awaited<ReturnType<typeof runDeadlineReminders>> = {
  targetDate: '', from: '', accounts: 0, recipients: 0, covered: 0, notifications: 0, emitted: 0, merged: 0, recovered: 0, reconciled: 0, errors: 0,
};
/** Fin des passages du récapitulatif et des rappels de fin d'essai (inchangée : 11 h). */
export const MORNING_SLOT_END: readonly [number, number] = [11, 0];

type MorningEventsResult =
  | { skipped: 'before_0830_paris' }
  | {
      skipped?: undefined;
      deadlines: Awaited<ReturnType<typeof runDeadlineReminders>> | { skipped: 'outside_send_window' };
      digest: Awaited<ReturnType<typeof runToProcessDigest>> | { skipped: 'after_1100_paris' };
      trialEnding: Awaited<ReturnType<typeof runTrialEndingReminders>> | { skipped: 'after_1100_paris' };
    };

export async function runMorningScheduledEvents(
  opts: { force?: boolean; now?: Date } = {},
): Promise<MorningEventsResult> {
  const now = opts.now ?? new Date();
  if (!opts.force && !isAtOrAfterParisTime(MORNING_SLOT[0], MORNING_SLOT[1], now)) {
    return { skipped: 'before_0830_paris' };
  }
  // Un échec des rappels d'échéance (base indisponible, migration 1625 pas
  // encore appliquée) n'empêche ni le récapitulatif ni la fin d'essai ; il
  // est compté en erreur (passage « en échec », repris au suivant).
  const deadlines = opts.force || isWithinDeadlineSendWindow(now)
    ? await runDeadlineReminders(now).catch((e: Error) => {
      console.error('[scheduled-events] rappels d’échéance :', e.message);
      return { ...EMPTY_DEADLINES_RESULT, errors: 1 };
    })
    : { skipped: 'outside_send_window' as const };
  const matin = opts.force || !isAtOrAfterParisTime(MORNING_SLOT_END[0], MORNING_SLOT_END[1], now);
  const digest = matin ? await runToProcessDigest() : { skipped: 'after_1100_paris' as const };
  const trialEnding = matin ? await runTrialEndingReminders() : { skipped: 'after_1100_paris' as const };
  console.info('[scheduled-events]', JSON.stringify({ deadlines, digest, trialEnding }));
  return { deadlines, digest, trialEnding };
}
