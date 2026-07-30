/**
 * Jours fériés français et calcul du délai de rétractation.
 *
 * CDC rétractation §3.1, article L. 221-19 du Code de la consommation,
 * critère d'acceptation n°14, scénario de recette n°6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS PIÈGES QUE CE MODULE ÉVITE
 *
 * 1. LE FUSEAU. Le §3.1 fait finir le délai « à 23 h 59 min 59 s ». Cette
 *    heure est parisienne. Calculer en UTC décalerait l'échéance d'une ou
 *    deux heures — soit, deux fois par an, d'un jour entier. Tout le calcul
 *    se fait donc en date civile française, et seule la conversion finale
 *    produit un instant UTC.
 *
 * 2. LA DATE DE DÉPART. « Le jour de conclusion n'est pas compté. Le délai
 *    court à partir de 00 h 00 le lendemain. » Ajouter simplement quatorze
 *    jours à l'horodatage de conclusion donne un résultat faux d'un jour dès
 *    que le contrat est conclu en soirée.
 *
 * 3. LA PROROGATION EN CHAÎNE. Un 14ᵉ jour tombant le samedi 8 mai 2027
 *    (férié) reporte au lundi 10. Reporter d'un seul jour ne suffit pas :
 *    il faut avancer jusqu'au premier jour réellement ouvrable.
 *
 * Ce module est PUR : aucune base, aucune horloge implicite. C'est ce qui le
 * rend vérifiable sur des dates réelles, passées comme futures.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Durée du droit de rétractation, en jours calendaires (§3.1). */
export const WITHDRAWAL_PERIOD_DAYS = 14;

/**
 * Périmètre des jours fériés retenus.
 *
 * ⚠️ DÉCISION MÉTIER NON TRANCHÉE. L'Alsace-Moselle compte deux jours fériés
 * supplémentaires (Vendredi saint, 26 décembre) et les départements d'outre-mer
 * en ont d'autres encore. Une prorogation ALLONGE le délai, donc favorise le
 * consommateur : les inclure est prudent, les omettre est exact pour la très
 * grande majorité des clients.
 *
 * Le défaut est `metropole` — les onze jours fériés nationaux. À confirmer
 * avec le conseil juridique ; le changement tient en un paramètre.
 */
export type HolidayScope = 'metropole' | 'alsace-moselle';

/** Date civile, indépendante de tout fuseau. */
export interface CivilDate {
  year: number;
  /** 1 à 12. */
  month: number;
  /** 1 à 31. */
  day: number;
}

/* ── Pâques ────────────────────────────────────────────────────────────── */

/**
 * Dimanche de Pâques (calendrier grégorien), algorithme de Meeus/Jones/Butcher.
 *
 * Quatre des onze jours fériés en dépendent : lundi de Pâques, Ascension,
 * lundi de Pentecôte — et le Vendredi saint en Alsace-Moselle.
 */
export function easterSunday(year: number): CivilDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

/* ── Arithmétique de dates civiles ─────────────────────────────────────── */

/** Convertit une date civile en instant UTC à midi — sans risque de bascule. */
function toUtcNoon(date: CivilDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day, 12, 0, 0));
}

function fromUtcNoon(instant: Date): CivilDate {
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  };
}

/** Ajoute un nombre de jours à une date civile. */
export function addDays(date: CivilDate, days: number): CivilDate {
  const instant = toUtcNoon(date);
  instant.setUTCDate(instant.getUTCDate() + days);
  return fromUtcNoon(instant);
}

/** Jour de la semaine : 0 = dimanche, 6 = samedi. */
export function dayOfWeek(date: CivilDate): number {
  return toUtcNoon(date).getUTCDay();
}

/** `AAAA-MM-JJ`, pour comparaison et journalisation. */
export function formatCivilDate(date: CivilDate): string {
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return `${date.year}-${mm}-${dd}`;
}

export function civilDatesEqual(a: CivilDate, b: CivilDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/* ── Calendrier ────────────────────────────────────────────────────────── */

export interface PublicHoliday {
  date: CivilDate;
  label: string;
}

/**
 * Les jours fériés d'une année donnée.
 *
 * Calculés, jamais lus dans une table : une table figée cesserait d'être
 * juste dès l'année suivante, et personne ne s'en apercevrait avant qu'une
 * échéance ne tombe au mauvais jour.
 */
export function listPublicHolidays(
  year: number,
  scope: HolidayScope = 'metropole',
): PublicHoliday[] {
  const easter = easterSunday(year);

  const holidays: PublicHoliday[] = [
    { date: { year, month: 1, day: 1 }, label: 'Jour de l’An' },
    { date: addDays(easter, 1), label: 'Lundi de Pâques' },
    { date: { year, month: 5, day: 1 }, label: 'Fête du Travail' },
    { date: { year, month: 5, day: 8 }, label: 'Victoire 1945' },
    { date: addDays(easter, 39), label: 'Ascension' },
    { date: addDays(easter, 50), label: 'Lundi de Pentecôte' },
    { date: { year, month: 7, day: 14 }, label: 'Fête nationale' },
    { date: { year, month: 8, day: 15 }, label: 'Assomption' },
    { date: { year, month: 11, day: 1 }, label: 'Toussaint' },
    { date: { year, month: 11, day: 11 }, label: 'Armistice 1918' },
    { date: { year, month: 12, day: 25 }, label: 'Noël' },
  ];

  if (scope === 'alsace-moselle') {
    holidays.push(
      { date: addDays(easter, -2), label: 'Vendredi saint' },
      { date: { year, month: 12, day: 26 }, label: 'Saint-Étienne' },
    );
  }

  return holidays.sort((a, b) => formatCivilDate(a.date).localeCompare(formatCivilDate(b.date)));
}

/** Ce jour est-il férié ? */
export function isPublicHoliday(date: CivilDate, scope: HolidayScope = 'metropole'): boolean {
  return listPublicHolidays(date.year, scope).some((h) => civilDatesEqual(h.date, date));
}

/**
 * Ce jour est-il ouvrable au sens du L. 221-19 ?
 *
 * L'article vise « un samedi, un dimanche ou un jour férié ou chômé ». Le
 * samedi est donc exclu, alors qu'il reste un jour ouvrable au sens du droit
 * du travail — d'où le nom, volontairement rattaché à cet article et non à
 * une notion générale.
 */
export function isBusinessDay(date: CivilDate, scope: HolidayScope = 'metropole'): boolean {
  const weekday = dayOfWeek(date);
  if (weekday === 0 || weekday === 6) return false;
  return !isPublicHoliday(date, scope);
}

/**
 * Premier jour ouvrable à partir de la date donnée, incluse.
 *
 * Boucle bornée : une succession de vingt jours non ouvrables n'existe pas,
 * mais une boucle non bornée sur une donnée corrompue bloquerait un serveur.
 */
export function nextBusinessDay(date: CivilDate, scope: HolidayScope = 'metropole'): CivilDate {
  let candidate = date;
  for (let i = 0; i < 20; i += 1) {
    if (isBusinessDay(candidate, scope)) return candidate;
    candidate = addDays(candidate, 1);
  }
  throw new Error(
    `Aucun jour ouvrable trouvé dans les 20 jours suivant ${formatCivilDate(date)}.`,
  );
}

/* ── Conversion fuseau ─────────────────────────────────────────────────── */

const PARIS_TZ = 'Europe/Paris';

/** Date civile française correspondant à un instant. */
export function toParisCivilDate(instant: Date): CivilDate {
  // `en-CA` produit `AAAA-MM-JJ`, format le plus simple à découper.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: PARIS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  const [year, month, day] = formatted.split('-').map(Number);
  return { year, month, day };
}

/** Décalage de Paris par rapport à UTC, en minutes, à un instant donné. */
function parisOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PARIS_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * Instant UTC correspondant à 23 h 59 min 59 s, heure de Paris, un jour donné.
 *
 * Le décalage est résolu par approximations successives : il dépend de
 * l'instant, et l'instant dépend du décalage. Deux passes suffisent, y compris
 * les jours de changement d'heure.
 */
export function parisEndOfDay(date: CivilDate): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, 23, 59, 59);
  let instant = new Date(naive);
  for (let i = 0; i < 2; i += 1) {
    const offset = parisOffsetMinutes(instant);
    instant = new Date(naive - offset * 60_000);
  }
  return instant;
}

/* ── Délai de rétractation ─────────────────────────────────────────────── */

export interface WithdrawalDeadline {
  /** Dernier jour, après prorogation éventuelle. */
  deadlineDate: CivilDate;
  /** Instant limite : 23 h 59 min 59 s, heure de Paris. */
  deadlineAt: Date;
  /** 14ᵉ jour avant prorogation, conservé pour la traçabilité. */
  nominalDate: CivilDate;
  /** L'échéance a-t-elle été reportée ? */
  deferred: boolean;
  /** Motif du report, lorsqu'il y en a un. */
  deferralReason?: 'samedi' | 'dimanche' | string;
}

/**
 * Calcule l'échéance du droit de rétractation (§3.1).
 *
 * @param concludedAt instant de conclusion du contrat payant. Le §3.1 précise
 *   que cette date « ne doit pas être recalculée à partir de données Stripe
 *   susceptibles d'être modifiées ultérieurement » : elle est donc fournie par
 *   l'appelant, qui la lit dans `contract_concluded_at`.
 */
export function computeWithdrawalDeadline(
  concludedAt: Date,
  scope: HolidayScope = 'metropole',
): WithdrawalDeadline {
  // Le jour de conclusion n'est pas compté : le délai court dès le lendemain.
  // Le 14ᵉ jour du délai est donc le 14ᵉ jour après celui de la conclusion.
  const concludedOn = toParisCivilDate(concludedAt);
  const nominalDate = addDays(concludedOn, WITHDRAWAL_PERIOD_DAYS);

  const deadlineDate = nextBusinessDay(nominalDate, scope);
  const deferred = !civilDatesEqual(nominalDate, deadlineDate);

  let deferralReason: string | undefined;
  if (deferred) {
    const weekday = dayOfWeek(nominalDate);
    if (weekday === 6) deferralReason = 'samedi';
    else if (weekday === 0) deferralReason = 'dimanche';
    else {
      deferralReason = listPublicHolidays(nominalDate.year, scope)
        .find((h) => civilDatesEqual(h.date, nominalDate))?.label ?? 'jour férié';
    }
  }

  return {
    deadlineDate,
    deadlineAt: parisEndOfDay(deadlineDate),
    nominalDate,
    deferred,
    deferralReason,
  };
}

/** Le droit de rétractation est-il encore ouvert à cet instant ? */
export function isWithinWithdrawalPeriod(
  concludedAt: Date,
  now: Date = new Date(),
  scope: HolidayScope = 'metropole',
): boolean {
  return now.getTime() <= computeWithdrawalDeadline(concludedAt, scope).deadlineAt.getTime();
}
