/**
 * Calendrier des tâches planifiées internes — heures de Paris (lot 25).
 *
 * Module PUR : aucune lecture d'horloge implicite, aucun accès base. Tout
 * calcul prend `now` en paramètre, ce qui rend testables les changements
 * d'heure (dernier dimanche de mars et d'octobre).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * JAMAIS D'HEURE UTC FIXE
 *
 * Un créneau « 8 h 30 » est une heure MURALE de Paris : 06:30 UTC l'été,
 * 07:30 UTC l'hiver. Il est converti en instant à chaque calcul, pour la date
 * locale visée, via `Intl` (`Europe/Paris`) — jamais par un décalage
 * constant.
 *
 * ── PAS DE RATTRAPAGE EN RAFALE ──────────────────────────────────────────
 * La prochaine échéance est toujours calculée APRÈS l'instant présent (fin de
 * l'exécution) : une instance arrêtée trois heures n'exécute pas trois fois
 * une tâche horaire à son retour, mais une seule, puis reprend le rythme.
 * Une tâche à créneau (quotidienne, hebdomadaire, fenêtre du matin) dont le
 * créneau est dépassé au-delà de sa tolérance n'est pas exécutée en retard :
 * elle passe au créneau suivant (`isSlotStillValid`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { addDaysToDateStr, parisNow } from '@/lib/notifications/time-paris';

/** Heure murale de Paris, `[heure, minute]`. */
export type WallTime = readonly [number, number];

export type TaskSchedule =
  /** Toutes les `everyMs`, éventuellement limité à une fenêtre de Paris [from, to[. */
  | { kind: 'interval'; everyMs: number; window?: { from: WallTime; to: WallTime } }
  /** Chaque jour à `at` (Paris) ; créneau manqué de plus de `graceMs` : sauté. */
  | { kind: 'daily'; at: WallTime; graceMs: number }
  /** Chaque semaine, jour ISO `isoDay` (1 = lundi … 7 = dimanche) à `at`. */
  | { kind: 'weekly'; isoDay: number; at: WallTime; graceMs: number }
  /** Au démarrage de chaque instance, puis tant que la tâche le demande. */
  | { kind: 'startup'; delayMs: number; retryMs: number };

const MIN = 60_000;

function minutesOf([h, m]: WallTime): number {
  return h * 60 + m;
}

/** Décalage de Paris par rapport à UTC à l'instant `at`, en minutes (60 ou 120). */
export function parisOffsetMinutes(at: Date): number {
  const p = parisNow(at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(at.getTime() / MIN) * MIN;
  return Math.round((asUtc - truncated) / MIN);
}

/**
 * Instant correspondant à l'heure murale `at` de Paris le jour local
 * `dateStr` (YYYY-MM-DD). Heure inexistante (passage à l'heure d'été, entre
 * 2 h et 3 h) : décalée d'une heure plus tard ; heure ambiguë (passage à
 * l'heure d'hiver) : seconde occurrence. Les créneaux retenus évitent de
 * toute façon la plage 2 h – 3 h.
 */
export function parisWallTimeToDate(dateStr: string, at: WallTime): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const naive = Date.UTC(y, mo - 1, d, at[0], at[1]);
  // Deux passes : le décalage dépend de l'instant cherché.
  const first = naive - parisOffsetMinutes(new Date(naive)) * MIN;
  const second = naive - parisOffsetMinutes(new Date(first)) * MIN;
  return new Date(second);
}

/** Minutes écoulées depuis minuit, heure de Paris. */
export function parisMinutesOfDay(now: Date): number {
  const p = parisNow(now);
  return p.hour * 60 + p.minute;
}

/** `now` est-il dans la fenêtre de Paris [from, to[ ? */
export function inParisWindow(now: Date, window: { from: WallTime; to: WallTime }): boolean {
  const m = parisMinutesOfDay(now);
  return m >= minutesOf(window.from) && m < minutesOf(window.to);
}

/** Jour ISO (1 = lundi … 7 = dimanche) d'une date locale YYYY-MM-DD. */
function isoDayOf(dateStr: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** Prochaine occurrence de `at` (Paris) strictement après `now`. */
export function nextDailyAt(now: Date, at: WallTime): Date {
  const today = parisNow(now).dateStr;
  for (let i = 0; i < 3; i++) {
    const cand = parisWallTimeToDate(addDaysToDateStr(today, i), at);
    if (cand.getTime() > now.getTime()) return cand;
  }
  /* istanbul ignore next — inatteignable : demain est toujours après maintenant */
  return parisWallTimeToDate(addDaysToDateStr(today, 1), at);
}

/** Prochaine occurrence du jour ISO `isoDay` à `at` (Paris), strictement après `now`. */
export function nextWeeklyAt(now: Date, isoDay: number, at: WallTime): Date {
  const today = parisNow(now).dateStr;
  for (let i = 0; i < 9; i++) {
    const day = addDaysToDateStr(today, i);
    if (isoDayOf(day) !== isoDay) continue;
    const cand = parisWallTimeToDate(day, at);
    if (cand.getTime() > now.getTime()) return cand;
  }
  /* istanbul ignore next */
  return parisWallTimeToDate(addDaysToDateStr(today, 7), at);
}

/**
 * Prochaine exécution après `now` (fin de la précédente).
 * `null` : aucune (tâche de démarrage sans suite demandée).
 */
export function computeNextRun(
  schedule: TaskSchedule,
  now: Date,
  opts: { again?: boolean } = {},
): Date | null {
  switch (schedule.kind) {
    case 'interval': {
      const cand = new Date(now.getTime() + schedule.everyMs);
      const w = schedule.window;
      if (!w || inParisWindow(cand, w)) return cand;
      // Hors fenêtre : prochaine ouverture (aujourd'hui si elle est à venir).
      return nextDailyAt(now, w.from);
    }
    case 'daily':
      return nextDailyAt(now, schedule.at);
    case 'weekly':
      return nextWeeklyAt(now, schedule.isoDay, schedule.at);
    case 'startup':
      return opts.again ? new Date(now.getTime() + schedule.retryMs) : null;
  }
}

/**
 * Première échéance d'une tâche jamais exécutée (ou dont le calendrier a
 * changé). Les tâches à intervalle partent après un court délai de mise en
 * route ; les autres attendent leur premier créneau.
 */
export function computeFirstRun(schedule: TaskSchedule, now: Date, startupDelayMs: number): Date {
  switch (schedule.kind) {
    case 'interval': {
      const cand = new Date(now.getTime() + startupDelayMs);
      const w = schedule.window;
      if (!w || inParisWindow(cand, w)) return cand;
      return nextDailyAt(now, w.from);
    }
    case 'startup':
      return new Date(now.getTime() + schedule.delayMs);
    default:
      return computeNextRun(schedule, now) as Date;
  }
}

/**
 * Un créneau échu à `dueAt` peut-il encore être exécuté à `now` ?
 * Faux : on saute au créneau suivant sans exécuter (pas d'envoi de rappels
 * matinaux à 23 h après un redémarrage, pas de rafale).
 */
export function isSlotStillValid(schedule: TaskSchedule, dueAt: Date, now: Date): boolean {
  switch (schedule.kind) {
    case 'interval':
      return !schedule.window || inParisWindow(now, schedule.window);
    case 'daily':
    case 'weekly':
      return now.getTime() - dueAt.getTime() <= schedule.graceMs;
    case 'startup':
      return true;
  }
}

/** Signature stable : un calendrier modifié au déploiement recalcule l'échéance. */
export function scheduleSignature(schedule: TaskSchedule): string {
  return JSON.stringify(schedule);
}

const DAYS = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const hhmm = ([h, m]: WallTime) => `${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}`;

/** Fréquence lisible (écran Exploitation). */
export function describeSchedule(schedule: TaskSchedule): string {
  switch (schedule.kind) {
    case 'interval': {
      const min = Math.round(schedule.everyMs / MIN);
      const every = min % 60 === 0 ? (min === 60 ? 'toutes les heures' : `toutes les ${min / 60} h`)
        : min === 1 ? 'toutes les minutes' : `toutes les ${min} min`;
      return schedule.window ? `${every}, de ${hhmm(schedule.window.from)} à ${hhmm(schedule.window.to)} (Paris)` : every;
    }
    case 'daily':
      return `chaque jour à ${hhmm(schedule.at)} (Paris)`;
    case 'weekly':
      return `chaque ${DAYS[schedule.isoDay]} à ${hhmm(schedule.at)} (Paris)`;
    case 'startup':
      return 'au démarrage, puis tant qu’il reste des demandes';
  }
}
