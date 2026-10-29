/**
 * Récurrences d'échéances — T4, calcul DÉTERMINISTE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE DATE NE FAIT JAMAIS UNE RÉCURRENCE
 *
 * Une occurrence future n'est produite que si la récurrence est démontrée par
 * les données du compte :
 *   · EXPLICIT_SOURCE    : mention explicite (« renouvellement annuel »,
 *                          « tous les 12 mois », « 6 mensualités à compter
 *                          du… », « trimestrielles jusqu'au 31/12/2028 ») ;
 *   · HISTORICAL_PATTERN : au moins trois occurrences comparables, à
 *                          intervalles réguliers.
 * Qu'un contrôle technique soit « d'habitude » tous les deux ans ne suffit
 * pas. Le modèle peut aider à LIRE une mention ; les dates sont calculées ici.
 *
 * Génération bornée :
 *   · récurrence ouverte → la PROCHAINE occurrence seulement ;
 *   · échéancier borné (date de fin, nombre d'occurrences) → exactement les
 *     occurrences de la période, rien au-delà ;
 *   · dates explicitement listées → ces dates exactes, sans recalcul.
 *
 * Lot 99D — UN MOT N'EST JAMAIS UNE FIN DE RÉCURRENCE
 *
 * La lecture d'une mention (`parseRecurrenceFr`) ne décide plus aucune fin :
 * « résiliation possible avec deux mois de préavis », « renouvelé sauf
 * résiliation », « dernière échéance », « fin du contrat » ne prouvent rien.
 * L'arrêt d'une série est une FIN QUALIFIÉE (`RecurrenceEnd` : raison, date
 * d'effet, source), établie par l'état contractuel lu dans les données
 * structurées du document (`recurrence-end.ts`) :
 *   · CONFIRMED (état établi ET daté) → plus aucune occurrence APRÈS la date
 *     d'effet ; les occurrences antérieures restent ;
 *   · UNCERTAIN (signal non prouvé, non daté, contradictoire) → tracée,
 *     sans aucun effet sur la génération.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
/** Modes de récurrence (formes de données, sans sémantique métier). */
export const RECURRENCE_MODES = ['EXPLICIT_SOURCE', 'HISTORICAL_PATTERN'] as const;
export type RecurrenceMode = (typeof RECURRENCE_MODES)[number];

/**
 * Lot 99D — raison d'une fin de récurrence QUALIFIÉE :
 *   TERMINATION_EFFECTIVE   résiliation / fin constatée, datée (passée) ;
 *   TERMINATION_SCHEDULED   résiliation constatée à effet futur, datée ;
 *   NO_RENEWAL              durée déterminée sans reconduction, ou
 *                           non-renouvellement confirmé, à une date de fin établie ;
 *   — fins INCERTAINES (jamais appliquées) —
 *   TERMINATION_UNDATED     fin constatée sans date d'effet lisible ;
 *   TERMINATION_UNPROVEN    indice seulement (preuve peu fiable, fin prévue déjà passée) ;
 *   NO_RENEWAL_UNDATED      sans reconduction, mais aucune date de fin établie ;
 *   RENEWAL_CONTRADICTION   reconduction ET non-reconduction lues ;
 *   END_DATE_RENEWAL_UNKNOWN date de fin lue, reconduction inconnue (peut être
 *                           la fin de la période en cours d'un contrat reconductible) ;
 *   LEGACY_KEYWORD_FLAG     ancien indicateur `ended` (mot-clé, avant 99D) relu
 *                           dans un travail ancien : ignoré.
 */
export const RECURRENCE_END_REASONS = [
  'TERMINATION_EFFECTIVE', 'TERMINATION_SCHEDULED', 'NO_RENEWAL',
  'TERMINATION_UNDATED', 'TERMINATION_UNPROVEN', 'NO_RENEWAL_UNDATED', 'RENEWAL_CONTRADICTION', 'END_DATE_RENEWAL_UNKNOWN',
  'LEGACY_KEYWORD_FLAG',
] as const;
export type RecurrenceEndReason = (typeof RECURRENCE_END_REASONS)[number];

/** Provenance d'une fin qualifiée (traçabilité ; extrait borné à 200 caractères). */
export interface RecurrenceEndSource {
  /** T1_FACT : fait T1 persisté du document ; LEGACY : ancien indicateur. */
  kind: 'T1_FACT' | 'LEGACY';
  /** Clé du fait (canonique ou lue) qui porte la preuve. */
  fieldKey?: string | null;
  /** Confiance du fait. */
  confidence?: string | null;
  excerpt?: string | null;
  /** Fait de DATE DE FIN structuré qui date l'arrêt, quand la clause elle-même n'est pas datée. */
  dateFieldKey?: string | null;
  sourceFileId?: number | null;
}

/** Lot 99D — fin de récurrence QUALIFIÉE (remplace l'ancien booléen `ended`). */
export interface RecurrenceEnd {
  status: 'CONFIRMED' | 'UNCERTAIN';
  reason: RecurrenceEndReason;
  /** Date d'effet (AAAA-MM-JJ) : aucune occurrence APRÈS. Toujours présente si CONFIRMED. */
  effectiveDate: string | null;
  source: RecurrenceEndSource;
}

export interface RecurrenceSpec {
  mode: RecurrenceMode;
  frequency: RecurrenceFrequency;
  /** Nombre d'unités entre deux occurrences (tous les 2 ans → yearly / 2). */
  interval: number;
  startDate?: string | null;
  endDate?: string | null;
  occurrenceCount?: number | null;
  /** Dates explicitement listées par la source (prioritaires sur le calcul). */
  dates?: string[] | null;
  /** Passage de la source qui établit la récurrence. */
  excerpt?: string | null;
  /**
   * Lot 99D — fin QUALIFIÉE (raison, date d'effet, source). Seule une fin
   * CONFIRMED et datée borne la série ; UNCERTAIN est tracée sans effet.
   */
  end?: RecurrenceEnd | null;
  /**
   * @deprecated Lot 99D — ancien indicateur posé sur la seule présence d'un mot
   * (« résiliation »…). N'est plus jamais écrit ; relu dans un travail ancien,
   * il est IGNORÉ (tracé `LEGACY_KEYWORD_FLAG`).
   */
  ended?: boolean;
}

/** Plafond absolu d'un échéancier borné (sécurité contre une série infinie). */
const MAX_BOUNDED_OCCURRENCES = 120;

const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’]/g, "'");

const MOIS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8,
  septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Date française (« 15/01/2027 », « 15 janvier 2027 », « 1er mars 2027 ») → ISO. */
export function parseFrDate(s: string): string | null {
  const m = plain(s);
  const n = m.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (n) return iso(Number(n[3]), Number(n[2]), Number(n[1]));
  const t = m.match(/\b(\d{1,2})(?:er)?\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})\b/);
  if (t) return iso(Number(t[3]), MOIS[t[2]], Number(t[1]));
  const i = m.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return i ? i[0] : null;
}

const DATE_RE = /(\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}(?:er)?\s+(?:janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+\d{4}|\d{4}-\d{2}-\d{2})/;

/**
 * Lit une mention EXPLICITE de récurrence dans un texte (extrait de preuve).
 * Rend `null` sans mention : aucune périodicité n'est supposée.
 */
export function parseRecurrenceFr(text: string): RecurrenceSpec | null {
  const m = plain(text);
  let frequency: RecurrenceFrequency | null = null;
  let interval = 1;

  const tous = m.match(/\btous les (\d+|deux|trois|quatre|six|douze)\s+(jours|semaines|mois|ans|annees)\b/);
  const nombre: Record<string, number> = { deux: 2, trois: 3, quatre: 4, six: 6, douze: 12 };
  if (tous) {
    interval = Number(tous[1]) || nombre[tous[1]] || 1;
    const u = tous[2];
    frequency = u === 'jours' ? 'daily' : u === 'semaines' ? 'weekly' : u === 'mois' ? 'monthly' : 'yearly';
    if (frequency === 'monthly' && interval % 12 === 0) { frequency = 'yearly'; interval /= 12; }
  } else if (/\b(bisannuel\w*|biennal\w*)\b/.test(m)) { frequency = 'yearly'; interval = 2; }
  else if (/\b(annuel\w*|chaque annee|tous les ans|par an)\b/.test(m)) { frequency = 'yearly'; interval = 1; }
  else if (/\b(semestriel\w*|chaque semestre)\b/.test(m)) { frequency = 'monthly'; interval = 6; }
  else if (/\b(trimestriel\w*|chaque trimestre)\b/.test(m)) { frequency = 'monthly'; interval = 3; }
  else if (/\b(mensuel\w*|chaque mois|tous les mois|mensualites?)\b/.test(m)) { frequency = 'monthly'; interval = 1; }
  else if (/\b(hebdomadaire\w*|chaque semaine)\b/.test(m)) { frequency = 'weekly'; interval = 1; }
  if (!frequency) return null;

  const spec: RecurrenceSpec = { mode: 'EXPLICIT_SOURCE', frequency, interval, excerpt: text.slice(0, 300) };

  const periode = m.match(new RegExp(`\\bdu ${DATE_RE.source} au ${DATE_RE.source}`));
  if (periode) { spec.startDate = parseFrDate(periode[1]); spec.endDate = parseFrDate(periode[2]); }
  const jusqu = m.match(new RegExp(`\\bjusqu'?(?:au| au| a)? ${DATE_RE.source}`));
  if (jusqu && !spec.endDate) spec.endDate = parseFrDate(jusqu[1]);
  const compter = m.match(new RegExp(`\\b(?:a compter du|a partir du|des le|debut le) ${DATE_RE.source}`));
  if (compter && !spec.startDate) spec.startDate = parseFrDate(compter[1]);
  const pendant = m.match(/\bpendant (\d+) (mois|ans)\b/);
  if (pendant) {
    const moisTotal = Number(pendant[1]) * (pendant[2] === 'ans' ? 12 : 1);
    const pas = frequency === 'monthly' ? interval : frequency === 'yearly' ? interval * 12 : null;
    if (pas) spec.occurrenceCount = Math.floor(moisTotal / pas);
  }
  const compte = m.match(/\b(\d+)\s+(mensualites|echeances|versements|paiements|prelevements|occurrences)\b/);
  if (compte) spec.occurrenceCount = Number(compte[1]);
  // Lot 99D : aucune fin n'est déduite d'un mot (résiliation, fin du contrat,
  // dernière échéance…) — la clause reste dans `excerpt` ; la fin éventuelle
  // est qualifiée à part (`recurrence-end.ts`) à partir de l'état contractuel.
  return spec;
}

/** Ajoute n unités à une date ISO (fin de mois bornée, jour d'origine conservé). */
export function addInterval(dateIso: string, frequency: RecurrenceFrequency, n: number): string {
  const [y, mo, d] = dateIso.split('-').map(Number);
  if (frequency === 'daily' || frequency === 'weekly') {
    const t = Date.UTC(y, mo - 1, d) + n * (frequency === 'daily' ? 1 : 7) * 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
  }
  const totalMonths = (y * 12 + (mo - 1)) + (frequency === 'monthly' ? n : n * 12);
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return iso(ny, nm, Math.min(d, last));
}

/**
 * Occurrences à produire pour une récurrence établie.
 *
 * @param reference occurrence connue (dernier entretien, première échéance)
 * @param today     les occurrences passées ne sont pas « prévisionnelles »
 */
export function computeOccurrences(spec: RecurrenceSpec, reference: string, today: string): string[] {
  // Lot 99D : seule une fin CONFIRMÉE et datée borne la série (l'ancien `ended` est ignoré).
  const fin = confirmedEndDate(spec);
  // Dates listées par la source : conservées telles quelles, sans recalcul (rien après la fin).
  if (spec.dates && spec.dates.length > 0) {
    return [...new Set(spec.dates)].sort().filter((d) => !fin || d <= fin).slice(0, MAX_BOUNDED_OCCURRENCES);
  }
  const start = spec.startDate ?? reference;
  const borne = spec.endDate ?? null;
  const nombre = spec.occurrenceCount ?? null;

  if (borne || nombre) {
    // Échéancier borné : exactement la période ou le nombre prévus.
    const out: string[] = [];
    for (let k = 0; k < MAX_BOUNDED_OCCURRENCES; k += 1) {
      const d = addInterval(start, spec.frequency, k * spec.interval);
      if (borne && d > borne) break;
      if (fin && d > fin) break;
      if (nombre && out.length >= nombre) break;
      out.push(d);
    }
    return out;
  }

  // Récurrence ouverte : la prochaine occurrence seulement (à venir), jamais après la fin confirmée.
  for (let k = 1; k <= 1000; k += 1) {
    const d = addInterval(reference, spec.frequency, k * spec.interval);
    if (fin && d > fin) return [];
    if (d >= today) return [d];
  }
  return [];
}

/**
 * Fenêtre (jours) d'une occurrence dans sa série : une occurrence déjà
 * présente dans la même période EST cette occurrence (moteur T4 ; reprise
 * 99D). Extrait tel quel de `forecastsFor`.
 */
export function occurrenceWindowDays(spec: Pick<RecurrenceSpec, 'frequency' | 'interval'>): number {
  return spec.frequency === 'yearly' ? 45 * spec.interval
    : spec.frequency === 'monthly' ? Math.min(10 * spec.interval, 40)
    : spec.frequency === 'weekly' ? 2 : 0;
}

/** Lot 99D — date d'effet d'une fin CONFIRMÉE et datée, sinon null (fin incertaine : aucun effet). */
export function confirmedEndDate(spec: Pick<RecurrenceSpec, 'end'>): string | null {
  const e = spec.end;
  return e && e.status === 'CONFIRMED' && e.effectiveDate && /^\d{4}-\d{2}-\d{2}$/.test(e.effectiveDate) ? e.effectiveDate : null;
}

/**
 * Lot 99D — borne effective d'une série : la plus proche entre la fin de
 * l'échéancier énoncé (`endDate`) et la date d'effet d'une fin confirmée.
 */
export function effectiveSeriesBound(spec: Pick<RecurrenceSpec, 'end' | 'endDate'>): string | null {
  const fin = confirmedEndDate(spec);
  const borne = spec.endDate ?? null;
  return fin && borne ? (fin < borne ? fin : borne) : fin ?? borne;
}

/**
 * Lot 99D — fin à TRACER (BO, diagnostic) : la fin qualifiée, sinon l'ancien
 * indicateur relu (incertain, ignoré), sinon null.
 */
export function recurrenceEndForTrace(spec: Pick<RecurrenceSpec, 'end' | 'ended'>): RecurrenceEnd | null {
  if (spec.end) return spec.end;
  return spec.ended ? { status: 'UNCERTAIN', reason: 'LEGACY_KEYWORD_FLAG', effectiveDate: null, source: { kind: 'LEGACY' } } : null;
}

/** Écart en jours entre deux dates ISO. */
const jours = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Périodicités reconnaissables dans un historique, avec leur tolérance. */
const PERIODES: Array<{ frequency: RecurrenceFrequency; interval: number; days: number; tolerance: number }> = [
  { frequency: 'yearly', interval: 2, days: 730, tolerance: 20 },
  { frequency: 'yearly', interval: 1, days: 365, tolerance: 12 },
  { frequency: 'monthly', interval: 6, days: 182, tolerance: 8 },
  { frequency: 'monthly', interval: 3, days: 91, tolerance: 5 },
  { frequency: 'monthly', interval: 1, days: 30, tolerance: 3 },
];

/**
 * Récurrence inférée d'un historique d'occurrences COMPARABLES (même objet,
 * même nature — filtrées par l'appelant). Au moins trois dates, et tous les
 * écarts dans la même périodicité ; sinon rien.
 */
export function inferHistoricalRecurrence(dates: string[], minOccurrences = 3): RecurrenceSpec | null {
  const d = [...new Set(dates)].sort();
  if (d.length < minOccurrences) return null;
  const ecarts = d.slice(1).map((x, i) => jours(d[i], x));
  for (const p of PERIODES) {
    if (ecarts.every((e) => Math.abs(e - p.days) <= p.tolerance)) {
      return { mode: 'HISTORICAL_PATTERN', frequency: p.frequency, interval: p.interval, excerpt: `historique : ${d.join(', ')}` };
    }
  }
  return null;
}

export function describeRecurrence(spec: RecurrenceSpec): string {
  const u = spec.frequency === 'yearly' ? 'an' : spec.frequency === 'monthly' ? 'mois' : spec.frequency === 'weekly' ? 'semaine' : 'jour';
  const base = spec.interval === 1 ? `chaque ${u}` : `tous les ${spec.interval} ${u === 'an' ? 'ans' : u === 'mois' ? 'mois' : `${u}s`}`;
  // Lot 99D : une fin confirmée borne aussi la règle affichée.
  const fin = effectiveSeriesBound(spec);
  const borne = fin ? ` jusqu’au ${fin}` : spec.occurrenceCount ? ` (${spec.occurrenceCount} occurrences)` : '';
  return `${base}${borne}`;
}
