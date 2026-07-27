/**
 * Calculs de date/heure en Europe/Paris (CDC §11.4 / §7.1 / §7.3).
 *
 * Jamais d'heure UTC fixe pour 8 h 30 : le fuseau `Europe/Paris` est appliqué
 * via `Intl`, ce qui gère automatiquement les changements d'heure (CET/CEST).
 */

export interface ParisParts {
  year: number; month: number; day: number;
  hour: number; minute: number;
  /** Date locale au format YYYY-MM-DD. */
  dateStr: string;
}

export function parisNow(now: Date = new Date()): ParisParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute),
    dateStr: `${p.year}-${p.month}-${p.day}`,
  };
}

/** Date locale Europe/Paris du jour, au format YYYY-MM-DD. */
export function todayParisDateStr(now: Date = new Date()): string {
  return parisNow(now).dateStr;
}

/** Ajoute `n` jours calendaires à une date YYYY-MM-DD (arithmétique sûre). */
export function addDaysToDateStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** Vrai si l'heure locale Europe/Paris a atteint hh:mm (créneau du matin). */
export function isAtOrAfterParisTime(hour: number, minute: number, now: Date = new Date()): boolean {
  const p = parisNow(now);
  return p.hour > hour || (p.hour === hour && p.minute >= minute);
}
