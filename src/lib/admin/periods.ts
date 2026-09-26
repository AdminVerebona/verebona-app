/**
 * Périodes du Dashboard — CDC Back-Office V1 §4.1 (DASH-003, DASH-004, DASH-005).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PÉRIODES CALENDAIRES, EN HEURE DE PARIS
 *
 * DASH-003 : Mois / Trimestre / Semestre / Année, Mois par défaut. Ce sont des
 * périodes CALENDAIRES (septembre, T3, S2, 2026), pas des fenêtres glissantes
 * de 30/90 jours : « le mois de septembre » doit donner le même chiffre quel
 * que soit le jour où on le consulte, une fois le mois clos. Les bornes sont
 * calculées en Europe/Paris (minuit local), sinon une inscription du 1er à
 * 00 h 30 tomberait dans le mois précédent.
 *
 * DASH-004 : la comparaison se fait à la période immédiatement précédente de
 * même nature (septembre ↔ août, T3 ↔ T2…).
 *
 * PÉRIODE EN COURS : elle n'est pas terminée. Pour ne pas comparer quelques
 * jours de septembre à tout le mois d'août :
 *   - les FLUX (inscriptions, CA…) sont comptés de `start` à `asOf` (= now) et
 *     comparés à la même durée écoulée depuis le début de la période
 *     précédente (`prevFlowEnd`) — « durée équivalente » ;
 *   - les STOCKS (comptes, abonnements actifs…) sont pris à `asOf` et comparés
 *     au stock à la FIN de la période précédente (DASH-005).
 * Une période close a `asOf = end` et `prevFlowEnd = prevEnd`.
 *
 * Convention : intervalles semi-ouverts [start, end).
 * ══════════════════════════════════════════════════════════════════════════
 */

export type PeriodKind = 'month' | 'quarter' | 'semester' | 'year';

export const PERIOD_KINDS: readonly PeriodKind[] = ['month', 'quarter', 'semester', 'year'];

/** DASH-003 : Mois par défaut. */
export const DEFAULT_PERIOD_KIND: PeriodKind = 'month';

export const PERIOD_KIND_LABELS: Record<PeriodKind, string> = {
  month: 'Mois',
  quarter: 'Trimestre',
  semester: 'Semestre',
  year: 'Année',
};

/** Nombre de mois d'une période. */
const MONTHS: Record<PeriodKind, number> = { month: 1, quarter: 3, semester: 6, year: 12 };

/** Nombre de périodes affichées dans les graphiques d'évolution. */
export const SERIES_LENGTH: Record<PeriodKind, number> = { month: 12, quarter: 8, semester: 6, year: 5 };

const TZ = 'Europe/Paris';

export interface ResolvedPeriod {
  kind: PeriodKind;
  /** Libellé lisible : « septembre 2026 », « T3 2026 », « S2 2026 », « 2026 ». */
  label: string;
  /** Référence stable pour la navigation (`?ref=`) : premier jour, YYYY-MM-DD. */
  ref: string;
  start: Date;
  end: Date;
  /** Borne effective des calculs : `end`, ou `now` si la période est en cours. */
  asOf: Date;
  /** La période n'est pas terminée. */
  inProgress: boolean;
  /** La période n'a pas commencé : aucune donnée possible. */
  future: boolean;
  prevStart: Date;
  prevEnd: Date;
  /** Fin de la fenêtre de flux comparable dans la période précédente (DASH-004). */
  prevFlowEnd: Date;
  prevLabel: string;
  /** Référence de la période précédente / suivante (navigation). */
  prevRef: string;
  nextRef: string;
}

/** Année et mois (1-12) locaux à Paris d'un instant. */
export function parisYearMonth(d: Date): { year: number; month: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  return { year: Number(parts.year), month: Number(parts.month) };
}

/** Décalage (ms) de Paris par rapport à UTC à un instant donné. */
function parisOffsetMs(at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Minuit à Paris le 1er du mois (`month` 1-12, débordement accepté : 13 = janvier
 * suivant). Deux passes : le décalage dépend de l'instant (heure d'été).
 */
export function parisMonthStart(year: number, month: number): Date {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  const naive = Date.UTC(y, m - 1, 1);
  let t = naive - parisOffsetMs(new Date(naive));
  t = naive - parisOffsetMs(new Date(t));
  return new Date(t);
}

/** Premier mois (1-12) de la période de `kind` contenant le mois `month`. */
function firstMonthOf(kind: PeriodKind, month: number): number {
  const size = MONTHS[kind];
  return Math.floor((month - 1) / size) * size + 1;
}

const MONTH_NAMES = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

const SHORT_MONTH_NAMES = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
];

function labelOf(kind: PeriodKind, year: number, firstMonth: number): string {
  switch (kind) {
    case 'month': return `${MONTH_NAMES[firstMonth - 1]} ${year}`;
    case 'quarter': return `T${(firstMonth - 1) / 3 + 1} ${year}`;
    case 'semester': return `S${(firstMonth - 1) / 6 + 1} ${year}`;
    case 'year': return String(year);
  }
}

/** Libellé court pour un axe de graphique (« sept. 26 », « T3 26 »…). */
export function shortLabelOf(kind: PeriodKind, start: Date): string {
  const { year, month } = parisYearMonth(start);
  const yy = String(year).slice(2);
  switch (kind) {
    case 'month': return `${SHORT_MONTH_NAMES[month - 1]} ${yy}`;
    case 'quarter': return `T${(month - 1) / 3 + 1} ${yy}`;
    case 'semester': return `S${(month - 1) / 6 + 1} ${yy}`;
    case 'year': return String(year);
  }
}

function refOf(year: number, month: number): string {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** Valide un type de période reçu en paramètre ; repli sur Mois (DASH-003). */
export function parsePeriodKind(value: string | null | undefined): PeriodKind {
  return (PERIOD_KINDS as readonly string[]).includes(value ?? '') ? (value as PeriodKind) : DEFAULT_PERIOD_KIND;
}

/**
 * Date de référence `YYYY-MM-DD` (ou `YYYY-MM`) → année / mois. Invalide ou
 * absente → mois courant à Paris.
 */
export function parseRef(value: string | null | undefined, now: Date = new Date()): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value ?? '');
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (year >= 2000 && year <= 2100 && month >= 1 && month <= 12) return { year, month };
  }
  return parisYearMonth(now);
}

/**
 * Période calendaire de `kind` contenant le mois de référence, et sa
 * précédente (DASH-004).
 */
export function resolvePeriod(
  kind: PeriodKind,
  ref: { year: number; month: number },
  now: Date = new Date(),
): ResolvedPeriod {
  const size = MONTHS[kind];
  const first = firstMonthOf(kind, ref.month);
  const start = parisMonthStart(ref.year, first);
  const end = parisMonthStart(ref.year, first + size);
  const prevStart = parisMonthStart(ref.year, first - size);
  const prevEnd = start;

  const future = now.getTime() < start.getTime();
  const inProgress = !future && now.getTime() < end.getTime();
  const asOf = inProgress ? now : end;
  // Durée équivalente : même temps écoulé depuis le début de la période
  // précédente, sans jamais en dépasser la fin (février est plus court que mars).
  const elapsed = asOf.getTime() - start.getTime();
  const prevFlowEnd = inProgress
    ? new Date(Math.min(prevStart.getTime() + Math.max(0, elapsed), prevEnd.getTime()))
    : prevEnd;

  const prevYm = parisYearMonth(prevStart);
  return {
    kind,
    label: labelOf(kind, ref.year, first),
    ref: refOf(ref.year, first),
    start,
    end,
    asOf,
    inProgress,
    future,
    prevStart,
    prevEnd,
    prevFlowEnd,
    prevLabel: labelOf(kind, prevYm.year, prevYm.month),
    prevRef: refOf(ref.year, first - size),
    nextRef: refOf(ref.year, first + size),
  };
}

export interface SeriesBucket {
  label: string;
  start: Date;
  /** Fin effective (bornée à `now` pour la période en cours). */
  end: Date;
}

/**
 * Les `SERIES_LENGTH[kind]` périodes se terminant par la période choisie,
 * pour les graphiques d'évolution (§4.2.2). La dernière est bornée à `asOf`.
 */
export function seriesBuckets(period: ResolvedPeriod): SeriesBucket[] {
  const n = SERIES_LENGTH[period.kind];
  const size = MONTHS[period.kind];
  const { year, month } = parisYearMonth(period.start);
  const buckets: SeriesBucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = parisMonthStart(year, month - i * size);
    const e = parisMonthStart(year, month - i * size + size);
    buckets.push({
      label: shortLabelOf(period.kind, s),
      start: s,
      end: i === 0 ? period.asOf : e,
    });
  }
  return buckets;
}
