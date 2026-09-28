/**
 * Heure de Paris pour les dossiers : date de génération imprimée (« 28/09/2026
 * à 09:14 », PDF-TXT-007) et date du jour des échéances relatives.
 */

const PARIS = 'Europe/Paris';

function parts(d: Date): Record<string, string> {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
}

/** `YYYY-MM-DD` à Paris. */
export function parisDate(d: Date = new Date()): string {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** ISO avec décalage de Paris : `2026-09-28T09:14:00+02:00`. */
export function parisIso(d: Date = new Date()): string {
  const p = parts(d);
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMin = Math.round((local - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
