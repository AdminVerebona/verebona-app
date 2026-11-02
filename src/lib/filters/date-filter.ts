/**
 * Filtres temporels de « Mes documents » — lot 103F (ticket « Filtres Mes
 * documents : sections repliables, date du document, date d'ajout »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX DATES QUI NE SE CONFONDENT JAMAIS
 *
 *   · « Date du document » : `asset_files.document_date` (type SQL `DATE`),
 *     la date documentaire de référence (facture émise, contrat signé…).
 *     Posée par T1 (`document.documentDate`, contrat au jour près), ou par
 *     l'utilisateur (tiroir document) ; une correction manuelle est marquée
 *     `user_edited_fields.documentDate` et aucune analyse ne la réécrit.
 *   · « Date d'ajout » : `asset_files.uploaded_at` (`timestamptz NOT NULL
 *     DEFAULT now()`), posée par le serveur à l'entrée du document (dépôt
 *     confirmé, lien web, transmission) et jamais réécrite ensuite.
 *
 * Une facture datée de 2022 importée en 2026 sort donc avec « Date du
 * document : 2022 » ET avec « Date d'ajout : 2026 ».
 *
 * ── PÉRIODES CALENDAIRES EXPLICITES, BORNES INCLUSIVES ───────────────────
 *
 * Un raccourci est résolu en DEUX JOURS (`YYYY-MM-DD`) au moment où il est
 * choisi, dans le fuseau de présentation (`DATE_FILTER_TIME_ZONE`) :
 *
 *   Ce mois             1er jour du mois → dernier jour du mois
 *   Cette année         01/01 → 31/12 de l'année en cours
 *   Année précédente    01/01 → 31/12 de l'année précédente
 *   12 derniers mois    période GLISSANTE : du lendemain du même jour un an
 *                       plus tôt (29/02 → 28/02 si l'année n'est pas
 *                       bissextile) jusqu'à aujourd'hui inclus — exactement
 *                       douze mois, sans recouvrir le jour d'il y a un an
 *   Période personnalisée « Du » et/ou « Au » ; une seule borne possible
 *
 * Le serveur ne reçoit que des jours. Pour la date d'ajout (horodatage), un
 * jour est l'intervalle [00:00, 24:00[ de Paris : `uploaded_at >= Du 00:00
 * Paris` et `uploaded_at < (Au + 1 jour) 00:00 Paris`, changements d'heure
 * compris — jamais un découpage UTC qui ferait glisser un ajout de 00:30 la
 * veille.
 *
 * ── « SANS DATE » ET DATES PARTIELLES ─────────────────────────────────────
 *
 * « Sans date » (date du document seulement) retient les documents dont la
 * date est absente. Le contrat T1 n'accepte qu'un jour complet : une date
 * partielle (mois / année sans jour) ou illisible est ÉCARTÉE à la lecture
 * (`tolerant-output.ts`, normalisation `normalizeDateValue`) et n'est jamais
 * complétée d'un jour inventé — le document est alors « Sans date ». La
 * colonne étant un `DATE`, la granularité persistée est toujours le jour.
 *
 * Règle de correspondance d'une valeur partielle (si une source en
 * fournissait un jour) : `partialDateMatchesRange` — une valeur « 2024-03 »
 * couvre le 01/03 au 31/03/2024 et correspond à une période qui CHEVAUCHE
 * cet intervalle. Testée, pour qu'aucune évolution n'invente de jour.
 *
 * Fichier sans dépendance serveur : partagé par l'écran, le contrat de la
 * route et le service.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Fuseau de présentation des dates (bornes « Du » / « Au », raccourcis). */
export const DATE_FILTER_TIME_ZONE = 'Europe/Paris';

export type DatePreset = 'thisMonth' | 'thisYear' | 'lastYear' | 'last12Months' | 'custom' | 'none';

/** Raccourcis proposés, dans l'ordre d'affichage (« Sans date » : date du document seulement). */
export const DATE_PRESETS: ReadonlyArray<{ value: DatePreset; label: string }> = [
  { value: 'thisMonth', label: 'Ce mois' },
  { value: 'thisYear', label: 'Cette année' },
  { value: 'lastYear', label: 'Année précédente' },
  { value: 'last12Months', label: '12 derniers mois' },
  { value: 'custom', label: 'Période personnalisée' },
  { value: 'none', label: 'Sans date' },
];

/**
 * Valeur d'un filtre temporel. `from` / `to` : jours `YYYY-MM-DD`, bornes
 * incluses, l'une ou l'autre facultative. `preset: 'none'` : « Sans date »
 * (aucune borne). Absent : aucune restriction.
 */
export interface DateFilterValue {
  preset: DatePreset;
  from?: string;
  to?: string;
}

/** Les deux filtres temporels des documents. */
export type DateFilterDim = 'documentDate' | 'addedDate';

export const DATE_FILTER_TITLES: Record<DateFilterDim, string> = {
  documentDate: 'Date du document',
  addedDate: "Date d'ajout",
};

// ── Jours calendaires (arithmétique sans fuseau) ────────────────────────

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Jour calendaire valide `YYYY-MM-DD` (29/02 seulement les années bissextiles). */
export function isValidDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y >= 1900 && y <= 2999 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

function day(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parts(value: string): [number, number, number] {
  const m = DAY_RE.exec(value)!;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Jour suivant (fin de mois, fin d'année, 29/02 compris). */
export function nextDay(value: string): string {
  const [y, m, d] = parts(value);
  if (d < daysInMonth(y, m)) return day(y, m, d + 1);
  if (m < 12) return day(y, m + 1, 1);
  return day(y + 1, 1, 1);
}

/** « Aujourd'hui » dans le fuseau de présentation, `YYYY-MM-DD`. */
export function todayIn(now: Date = new Date(), timeZone: string = DATE_FILTER_TIME_ZONE): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Bornes d'un raccourci pour le jour `today` (fuseau de présentation). */
export function presetRange(preset: Exclude<DatePreset, 'custom' | 'none'>, today: string): { from: string; to: string } {
  const [y, m, d] = parts(today);
  switch (preset) {
    case 'thisMonth': return { from: day(y, m, 1), to: day(y, m, daysInMonth(y, m)) };
    case 'thisYear': return { from: day(y, 1, 1), to: day(y, 12, 31) };
    case 'lastYear': return { from: day(y - 1, 1, 1), to: day(y - 1, 12, 31) };
    case 'last12Months': {
      // Même jour un an plus tôt (29/02 → 28/02), puis le lendemain.
      const anneeAvant = y - 1;
      const jour = Math.min(d, daysInMonth(anneeAvant, m));
      return { from: nextDay(day(anneeAvant, m, jour)), to: today };
    }
  }
}

export type DateRangeError = 'INVALID_DAY' | 'START_AFTER_END';

/** Contrôle d'une période saisie : jours valides, début ≤ fin (bornes égales admises). */
export function validateDateRange(from?: string | null, to?: string | null): DateRangeError | null {
  if ((from && !isValidDay(from)) || (to && !isValidDay(to))) return 'INVALID_DAY';
  if (from && to && from > to) return 'START_AFTER_END';
  return null;
}

export const DATE_RANGE_ERROR_TEXT: Record<DateRangeError, string> = {
  INVALID_DAY: 'Saisissez une date valide.',
  START_AFTER_END: 'La date de début doit précéder la date de fin.',
};

/**
 * Filtre à partir d'un choix de l'écran. `null` : aucune restriction
 * (« Toutes les dates », période personnalisée vide) ou saisie refusée.
 */
export function makeDateFilter(
  preset: DatePreset,
  today: string,
  custom: { from?: string | null; to?: string | null } = {},
): DateFilterValue | null {
  if (preset === 'none') return { preset: 'none' };
  if (preset === 'custom') {
    const from = custom.from || undefined;
    const to = custom.to || undefined;
    if (!from && !to) return null;
    if (validateDateRange(from, to)) return null;
    return { preset: 'custom', ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }
  return { preset, ...presetRange(preset, today) };
}

/** Lecture défensive (instantané de retour, paramètres) ; `undefined` si inexploitable. */
export function parseDateFilter(raw: unknown, allowNone: boolean): DateFilterValue | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const preset = DATE_PRESETS.some((p) => p.value === o.preset) ? (o.preset as DatePreset) : 'custom';
  if (preset === 'none') return allowNone ? { preset: 'none' } : undefined;
  const from = isValidDay(o.from) ? o.from : undefined;
  const to = isValidDay(o.to) ? o.to : undefined;
  if (!from && !to) return undefined;
  if (from && to && from > to) return undefined;
  return { preset, ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

export function isDateFilterActive(f: DateFilterValue | null | undefined): f is DateFilterValue {
  return !!f && (f.preset === 'none' || !!f.from || !!f.to);
}

// ── Paramètres de la route ───────────────────────────────────────────────

/** Noms des paramètres de `GET /api/v2/documents`. */
export const DATE_FILTER_PARAMS: Record<DateFilterDim, { from: string; to: string; none?: string }> = {
  documentDate: { from: 'docFrom', to: 'docTo', none: 'docNone' },
  addedDate: { from: 'addedFrom', to: 'addedTo' },
};

/** Écrit un filtre dans une chaîne de requête (bornes seulement : le raccourci est résolu). */
export function writeDateFilterParams(q: URLSearchParams, dim: DateFilterDim, f: DateFilterValue | null | undefined): void {
  if (!isDateFilterActive(f)) return;
  const names = DATE_FILTER_PARAMS[dim];
  if (f.preset === 'none') {
    if (names.none) q.set(names.none, '1');
    return;
  }
  if (f.from) q.set(names.from, f.from);
  if (f.to) q.set(names.to, f.to);
}

/**
 * Lecture d'un filtre depuis la requête. `error` : période refusée (jour
 * invalide, début après la fin) — la route répond 400 plutôt que d'élargir
 * en silence le résultat à « toutes les dates ».
 */
export function readDateFilterParams(p: URLSearchParams, dim: DateFilterDim): { filter?: DateFilterValue; error?: DateRangeError } {
  const names = DATE_FILTER_PARAMS[dim];
  if (names.none && p.get(names.none) === '1') return { filter: { preset: 'none' } };
  const from = p.get(names.from) || undefined;
  const to = p.get(names.to) || undefined;
  if (!from && !to) return {};
  const error = validateDateRange(from, to);
  if (error) return { error };
  return { filter: { preset: 'custom', ...(from ? { from } : {}), ...(to ? { to } : {}) } };
}

// ── Textes ───────────────────────────────────────────────────────────────

/** `2026-03-01` → `01/03/2026`. */
export function formatDayFr(value: string): string {
  if (!isValidDay(value)) return value;
  const [y, m, d] = parts(value);
  return `${pad(d)}/${pad(m)}/${y}`;
}

/** Résumé d'une période : « 01/01/2024 – 31/12/2024 », « Depuis le … », « Jusqu'au … », « Sans date ». */
export function dateFilterSummary(f: DateFilterValue): string {
  if (f.preset === 'none') return 'Sans date';
  if (f.from && f.to) return f.from === f.to ? `Le ${formatDayFr(f.from)}` : `${formatDayFr(f.from)} – ${formatDayFr(f.to)}`;
  if (f.from) return `Depuis le ${formatDayFr(f.from)}`;
  if (f.to) return `Jusqu'au ${formatDayFr(f.to)}`;
  return '';
}

/** Libellé de la pastille « Filtré par … » : « Date du document : 01/01/2024 – 31/12/2024 ». */
export function dateFilterChipLabel(dim: DateFilterDim, f: DateFilterValue): string {
  return `${DATE_FILTER_TITLES[dim]} : ${dateFilterSummary(f)}`;
}

// ── Règle des dates partielles ───────────────────────────────────────────

/**
 * Intervalle réellement connu d'une valeur de date : jour, mois (`YYYY-MM`)
 * ou année (`YYYY`). `null` : illisible. Aucun jour n'est inventé : un mois
 * couvre tous ses jours, une année tous les siens.
 */
export function partialDateInterval(value: string | null | undefined): { from: string; to: string; granularity: 'day' | 'month' | 'year' } | null {
  if (!value) return null;
  if (isValidDay(value)) return { from: value, to: value, granularity: 'day' };
  const mois = /^(\d{4})-(\d{2})$/.exec(value);
  if (mois) {
    const [y, m] = [Number(mois[1]), Number(mois[2])];
    if (m < 1 || m > 12) return null;
    return { from: day(y, m, 1), to: day(y, m, daysInMonth(y, m)), granularity: 'month' };
  }
  const annee = /^(\d{4})$/.exec(value);
  if (annee) return { from: day(Number(annee[1]), 1, 1), to: day(Number(annee[1]), 12, 31), granularity: 'year' };
  return null;
}

/**
 * Une valeur (jour, mois ou année) correspond-elle au filtre ? Jour : bornes
 * incluses. Valeur partielle : CHEVAUCHEMENT de son intervalle connu avec la
 * période. Valeur absente ou illisible : seulement « Sans date ».
 */
export function partialDateMatchesRange(value: string | null | undefined, f: DateFilterValue | null | undefined): boolean {
  if (!isDateFilterActive(f)) return true;
  const interval = partialDateInterval(value);
  if (f.preset === 'none') return interval === null;
  if (!interval) return false;
  return (!f.from || interval.to >= f.from) && (!f.to || interval.from <= f.to);
}
