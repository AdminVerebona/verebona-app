/**
 * Rappels d'échéance — RÈGLES (pures, testées sans base) — lot 113AH, carte
 * Trello #732 « Rattraper les rappels J−7 manqués après création ou
 * modification d'un événement ».
 *
 * Paramètres centralisés (aucune valeur en dur ailleurs) et calculs de délai
 * en jours CALENDAIRES Europe/Paris (changements d'heure et minuit compris :
 * l'arithmétique porte sur des dates locales AAAA-MM-JJ, jamais sur des
 * durées de 24 h).
 *
 *   · fenêtre du rappel : de AUJOURD'HUI (J+0) à J+7 inclus ;
 *   · J+0 RETENU (choix 113AH) tant que l'échéance n'est pas passée : sans
 *     heure, la journée entière ; avec une heure, jusqu'à cette heure. Motif :
 *     une échéance du jour ajoutée par T4 / une projection / l'autre membre
 *     Duo est précisément celle qu'on ne doit pas oublier ; le texte dit
 *     « aujourd'hui », jamais « dans 7 jours » ;
 *   · plage d'envoi 8 h 30 – 21 h (Paris) : hors de cette plage, rien n'est
 *     mis en file — le passage de 8 h 30 rattrape (pas de notification la nuit,
 *     comme le rappel du matin d'origine) ;
 *   · après une écriture, envoi différé de 2 min : des sauvegardes successives
 *     d'un même événement, ou plusieurs événements créés ensemble, partent en
 *     UNE notification ;
 *   · anti-rafale : un même événement n'est rappelé à un même destinataire
 *     qu'une fois par période de 12 h après un changement de date (le
 *     rattrapage périodique reprend ensuite s'il est toujours à venir).
 */
import { addDaysToDateStr, parisNow } from '../time-paris';

/** Rappel « normal » : 7 jours avant l'échéance (CDC §7.1). */
export const DEADLINE_REMINDER_LEAD_DAYS = 7;
/** Plage d'envoi (heure de Paris) des rappels et rattrapages. */
export const DEADLINE_REMINDER_SEND_WINDOW: { readonly from: readonly [number, number]; readonly to: readonly [number, number] } = {
  from: [8, 30],
  to: [21, 0],
};
/** Délai entre l'écriture d'un événement et l'envoi de son rappel (regroupement, anti-rafale). */
export const DEADLINE_REMINDER_WRITE_DELAY_MS = 2 * 60_000;
/** Intervalle minimal entre deux rappels d'un même événement à un même destinataire (changement de date). */
export const DEADLINE_REMINDER_DATE_CHANGE_COOLDOWN_MS = 12 * 60 * 60_000;
/** Un rappel resté « en cours d'envoi » sans aucune livraison au-delà de ce délai est remis en file. */
export const DEADLINE_REMINDER_STUCK_AFTER_MS = 60 * 60_000;
/** Préfixe des clés d'outbox des rappels par événement (113AH) ; `deadline:j7:` = ancien rappel groupé par date. */
export const DEADLINE_REMINDER_KEY_PREFIX = 'deadline:v2:';
export const LEGACY_DEADLINE_KEY_PREFIX = 'deadline:j7:';

/** Nombre de jours calendaires de `from` à `to` (dates locales AAAA-MM-JJ). */
export function calendarDaysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** Délai réel, en jours calendaires Europe/Paris, entre maintenant et l'échéance. */
export function daysUntilDeadline(dueDate: string, now: Date = new Date()): number {
  return calendarDaysBetween(parisNow(now).dateStr, dueDate);
}

/** Bornes de la fenêtre du rappel (dates locales). */
export function deadlineReminderRange(now: Date = new Date()): { today: string; last: string } {
  const today = parisNow(now).dateStr;
  return { today, last: addDaysToDateStr(today, DEADLINE_REMINDER_LEAD_DAYS) };
}

/** Heure de Paris « HH:MM » (comparaison avec `start_time` d'une échéance du jour). */
export function parisClock(now: Date = new Date()): string {
  const p = parisNow(now);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Vrai dans la plage d'envoi 8 h 30 – 21 h (Paris). */
export function isWithinDeadlineSendWindow(now: Date = new Date()): boolean {
  const p = parisNow(now);
  const m = p.hour * 60 + p.minute;
  const [fh, fm] = DEADLINE_REMINDER_SEND_WINDOW.from;
  const [th, tm] = DEADLINE_REMINDER_SEND_WINDOW.to;
  return m >= fh * 60 + fm && m < th * 60 + tm;
}

/**
 * Une échéance est-elle éligible à un rappel MAINTENANT ? (règle de référence ;
 * la même condition est écrite en SQL dans `deadlines.ts`, et vérifiée par les
 * tests). Catégorie « action » seule (inchangé), date certaine ou
 * prévisionnelle, de J+0 à J+7 ; le jour même, l'heure n'est pas passée.
 */
export function isDeadlineReminderEligible(
  item: { homeCategory: string | null; startDate: string | null; startTime?: string | null },
  now: Date = new Date(),
): boolean {
  if (item.homeCategory !== 'action' || !item.startDate) return false;
  const d = daysUntilDeadline(item.startDate, now);
  if (d < 0 || d > DEADLINE_REMINDER_LEAD_DAYS) return false;
  if (d === 0 && item.startTime) return item.startTime.slice(0, 5) > parisClock(now);
  return true;
}

/** « dans 7 jours », « dans 3 jours », « demain », « aujourd'hui ». */
export function deadlineDelayLabel(daysUntil: number): string {
  if (daysUntil <= 0) return 'aujourd’hui';
  if (daysUntil === 1) return 'demain';
  return `dans ${daysUntil} jours`;
}

/**
 * Titre du rappel (cloche, push, variable `title` de l'e-mail). Sans délai
 * connu (ligne mise en file avant 113AH) : 7 jours, comme à l'origine.
 * Les textes à 7 jours sont inchangés.
 */
export function deadlineReminderTitle(p: { count: number; forecastCount?: number; daysUntil?: number }): string {
  const delai = deadlineDelayLabel(typeof p.daysUntil === 'number' ? p.daysUntil : DEADLINE_REMINDER_LEAD_DAYS);
  const fc = p.forecastCount ?? 0;
  if (p.count > 1) {
    return `${p.count} échéances ${delai}${fc ? ` (dont ${fc} prévisionnelle${fc > 1 ? 's' : ''})` : ''}`;
  }
  return fc ? `Échéance prévisionnelle ${delai}` : `Échéance ${delai}`;
}
