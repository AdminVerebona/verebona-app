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
 * ══════════════════════════════════════════════════════════════════════════
 */

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type RecurrenceMode = 'EXPLICIT_SOURCE' | 'HISTORICAL_PATTERN';

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
  /** Fin explicite (résiliation, dernière échéance) : plus aucune occurrence. */
  ended?: boolean;
}

/** Plafond absolu d'un échéancier borné (sécurité contre une série infinie). */
export const MAX_BOUNDED_OCCURRENCES = 120;

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
  if (/\b(resili\w*|derniere echeance|fin du contrat|ne sera pas renouvel\w*)\b/.test(m)) spec.ended = true;
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
  if (spec.ended) return [];
  // Dates listées par la source : conservées telles quelles, sans recalcul.
  if (spec.dates && spec.dates.length > 0) {
    return [...new Set(spec.dates)].sort().slice(0, MAX_BOUNDED_OCCURRENCES);
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
      if (nombre && out.length >= nombre) break;
      out.push(d);
    }
    return out;
  }

  // Récurrence ouverte : la prochaine occurrence seulement (à venir).
  for (let k = 1; k <= 1000; k += 1) {
    const d = addInterval(reference, spec.frequency, k * spec.interval);
    if (d >= today) return [d];
  }
  return [];
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
  const borne = spec.endDate ? ` jusqu’au ${spec.endDate}` : spec.occurrenceCount ? ` (${spec.occurrenceCount} occurrences)` : '';
  return `${base}${borne}`;
}
