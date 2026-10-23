/**
 * Période de lecture des exécutions métier — lot 83C (SEM-02, BO-05, R60). PUR.
 *
 * RÈGLE UNIQUE (récapitulatifs, listes, détail, et demain cartes et exports P3) :
 *   · champ temporel : date de référence de l'exécution = FIN (dernier
 *     résultat) si l'issue est finale, sinon dernière activité
 *     (`mapping#referenceAt`) ;
 *   · bornes : [from, to[ — début inclus, fin exclue, en instants UTC ;
 *   · par défaut : les 7 derniers jours glissants ([maintenant − 7 j, maintenant]) ;
 *   · dates saisies (AAAA-MM-JJ) : jours CIVILS de Paris (Europe/Paris,
 *     heure d'été comprise) — `from` à 00:00, `to` jusqu'à 24:00 inclus ;
 *   · une exécution est comptée une seule fois, avec son issue ACTUELLE ;
 *     l'instant de lecture est rendu avec chaque réponse.
 */

export const DEFAULT_PERIOD_DAYS = 7;
export const MAX_PERIOD_DAYS = 90;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Décalage de Paris (minutes, UTC+x) à un instant donné. */
export function parisOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const g = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Instant UTC de 00:00 (heure de Paris) du jour civil donné. */
export function parisMidnight(day: string): Date {
  const naif = new Date(`${day}T00:00:00Z`);
  let d = new Date(naif.getTime() - parisOffsetMinutes(naif) * 60_000);
  const corrige = parisOffsetMinutes(d);
  if (corrige !== parisOffsetMinutes(naif)) d = new Date(naif.getTime() - corrige * 60_000);
  return d;
}

/** Jour civil de Paris suivant (AAAA-MM-JJ). */
function lendemain(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface BusinessPeriod {
  from: Date;
  to: Date;
  /** Description de la règle, rendue telle quelle (BO-05 : documenter le champ, le fuseau, les bornes). */
  rule: string;
}

export const PERIOD_RULE = 'date de référence = fin de l’exécution (dernier résultat) si elle est finale, sinon dernière activité ; '
  + 'bornes [début inclus, fin exclue[ en UTC ; jours saisis = jours civils Europe/Paris ; issue actuelle, chaque exécution comptée une fois';

/**
 * Période d'une requête : `days` (1 à 90, défaut 7, glissants jusqu'à
 * maintenant) ou `from` / `to` (AAAA-MM-JJ, jours de Paris). Valeurs
 * illisibles : défaut. `to` antérieur à `from` : inversés.
 */
export function periodFromQuery(p: { days?: string | null; from?: string | null; to?: string | null }, now: Date = new Date()): BusinessPeriod {
  const from = p.from && DAY.test(p.from) ? p.from : null;
  const to = p.to && DAY.test(p.to) ? p.to : null;
  if (from || to) {
    let a = from ? parisMidnight(from) : new Date(now.getTime() - DEFAULT_PERIOD_DAYS * 86_400_000);
    let b = to ? parisMidnight(lendemain(to)) : now;
    if (b < a) [a, b] = [b, a];
    if (b.getTime() - a.getTime() > MAX_PERIOD_DAYS * 86_400_000) a = new Date(b.getTime() - MAX_PERIOD_DAYS * 86_400_000);
    return { from: a, to: b, rule: PERIOD_RULE };
  }
  const n = p.days && /^\d{1,3}$/.test(p.days) ? Math.min(MAX_PERIOD_DAYS, Math.max(1, Number(p.days))) : DEFAULT_PERIOD_DAYS;
  return { from: new Date(now.getTime() - n * 86_400_000), to: new Date(now.getTime() + 1), rule: PERIOD_RULE };
}
