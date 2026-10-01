/**
 * Interprétation des dates — CDC §4.4.3, étape 2.
 *
 * DÉTERMINISTE, sans appel modèle. Les dates ont déjà été extraites avec leur
 * preuve par l'usage 1 : il ne reste qu'à les qualifier.
 *
 * Supprime le double traitement de l'existant, où `extract_agenda_v1` puis
 * `agenda_detect_v1` analysaient la même information.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DateQualification =
  /** Date exploitable pour une création automatique. */
  | 'explicit'
  /** Date valide mais trop lointaine ou trop ancienne pour être utile. */
  | 'out_of_range'
  /** Date invalide ou non normalisable. */
  | 'invalid';

export interface InterpretedDate {
  qualification: DateQualification;
  iso: string | null;
  /** Nombre de jours par rapport à aujourd'hui. Négatif si passé. */
  daysFromNow: number | null;
}

/** Au-delà de 20 ans, une échéance relève de l'erreur d'extraction. */
const MAX_FUTURE_YEARS = 20;
/** Une échéance de plus de 5 ans dans le passé n'a plus d'intérêt en agenda. */
const MAX_PAST_YEARS = 5;

export function interpretDate(raw: string | null | undefined, now = new Date()): InterpretedDate {
  if (!raw || !ISO_DATE.test(raw)) {
    return { qualification: 'invalid', iso: null, daysFromNow: null };
  }

  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return { qualification: 'invalid', iso: null, daysFromNow: null };
  }

  // Contrôle de cohérence calendaire : `2026-02-31` passe le format mais pas
  // la conversion — JavaScript le décale au 3 mars, ce qui serait une valeur
  // fausse silencieuse.
  if (date.toISOString().slice(0, 10) !== raw) {
    return { qualification: 'invalid', iso: null, daysFromNow: null };
  }

  const daysFromNow = Math.round((date.getTime() - now.getTime()) / 86_400_000);
  const years = daysFromNow / 365.25;

  if (years > MAX_FUTURE_YEARS || years < -MAX_PAST_YEARS) {
    return { qualification: 'out_of_range', iso: raw, daysFromNow };
  }

  return { qualification: 'explicit', iso: raw, daysFromNow };
}

/** Une échéance est-elle dépassée ? Sert au réconciliateur de statut. */
export function isPastDue(iso: string, now = new Date()): boolean {
  const d = interpretDate(iso, now);
  return d.qualification !== 'invalid' && (d.daysFromNow ?? 0) < 0;
}

// ── Ambiguïté temporelle (CDC 15 §26, R5) ───────────────────────────────────

/**
 * Pourquoi la date retenue par l'extraction n'est pas certaine :
 *   · DAY_MONTH_ORDER : l'extrait porte une date numérique dont les deux
 *     premiers nombres sont ≤ 12 et différents (« 03/04/2027 ») — lue jj/mm
 *     ou mm/jj, les deux dates sont valides — ET l'extraction a retenu la
 *     lecture mm/jj, contraire à la convention française. Une date lue jj/mm
 *     n'est pas signalée : sinon presque toute date française (jour ≤ 12)
 *     déclencherait un appel modèle ;
 *   · RELATIVE_MENTION : l'échéance n'est donnée que par une mention relative
 *     (« avant fin mars », « dans six mois », « sous 30 jours »), sans date
 *     complète dans l'extrait — la date ISO est une déduction.
 */
export interface TemporalAmbiguity {
  kind: 'DAY_MONTH_ORDER' | 'RELATIVE_MENTION';
  /** Dates candidates (ISO, triées) ; une seule pour une mention relative. */
  dates: string[];
  /** Fragment de l'extrait qui porte l'ambiguïté. */
  mention: string;
}

const MOIS = 'janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre';
const DATE_NUMERIQUE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g;
const DATE_COMPLETE = new RegExp(`\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}(er)? (${MOIS}) \\d{4}\\b`);
const RELATIVES: RegExp[] = [
  new RegExp(`\\b(avant|d'ici|au plus tard|vers|courant|debut|fin|mi)[ -](la fin |fin |debut |de |d')*(${MOIS})\\b`),
  /\b(dans|sous|d'ici) (\d+|un|une|deux|trois|quatre|six|douze) (jours?|semaines?|mois|ans?|annees?)\b/,
  /\b(l'an prochain|l'annee prochaine|le mois prochain|en fin d'annee|avant la fin de l'annee)\b/,
];

const plainFr = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");

function isoValide(y: number, m: number, d: number): string | null {
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Ambiguïté de la date `iso` au vu de son extrait (pure, testée). `null` :
 * la date est certaine (date complète non ambiguë, ou aucun extrait).
 * Ne modifie jamais `interpretDate` : le comportement historique reste le
 * même tant que l'appelant n'exploite pas ce signal (T4 master + enabled).
 */
export function detectTemporalAmbiguity(iso: string | null | undefined, excerpt: string | null | undefined): TemporalAmbiguity | null {
  if (!iso || !ISO_DATE.test(iso) || !excerpt) return null;
  const m = plainFr(excerpt);

  for (const hit of m.matchAll(DATE_NUMERIQUE)) {
    const a = Number(hit[1]);
    const b = Number(hit[2]);
    const y = hit[3].length === 2 ? 2000 + Number(hit[3]) : Number(hit[3]);
    if (a > 12 || b > 12 || a === b || a === 0 || b === 0) continue;
    const jjmm = isoValide(y, b, a);
    const mmjj = isoValide(y, a, b);
    // Lecture française retenue (ou date sans rapport) : rien d'ambigu à trancher.
    if (!jjmm || !mmjj || iso !== mmjj) continue;
    return { kind: 'DAY_MONTH_ORDER', dates: [jjmm, mmjj].sort(), mention: hit[0] };
  }

  if (DATE_COMPLETE.test(m)) return null;
  for (const re of RELATIVES) {
    const hit = m.match(re);
    if (hit) return { kind: 'RELATIVE_MENTION', dates: [iso], mention: hit[0] };
  }
  return null;
}
