/**
 * Lot 113W (Trello #724) — PÉRIODES MÉTIER : vocabulaire, dates partielles et
 * libellés d'affichage. PUR (aucune dépendance serveur) : lu par le service
 * `services/documents/business-periods`, les routes et les tiroirs (desktop
 * et mobile, même interface).
 *
 * Décisions du ticket appliquées ici :
 *   · une période pertinente sans date → « Période … : non renseignée » ;
 *   · une période passée est affichée telle quelle (« Période couverte : du…
 *     au… ») — jamais « expiré », « dernière période connue » ni un statut
 *     présumé (aucune comparaison avec la date du jour dans ce module) ;
 *   · une seule borne connue → « Début de couverture : … » / « Fin de
 *     couverture : … » — un début connu n'est jamais présenté comme la preuve
 *     d'une couverture en cours ;
 *   · une borne réduite au mois (ou à l'année) est affichée telle quelle :
 *     aucune borne n'est inventée (jamais « 01/03 » pour « mars ») ;
 *   · plusieurs périodes d'une même nature sur un document → « Plusieurs
 *     périodes concernées », détail à part, sans période globale artificielle.
 * Libellés repris À L'IDENTIQUE du ticket pour la couverture ; les autres
 * natures suivent la même forme (textes « à valider par le PO », recette 113W).
 */

/**
 * Natures de période. L'ordre est la priorité par défaut de la période
 * principale (décision 1 ; ordre décidé par le PO le 07/11/2026, 113W2) :
 * Couverture > Validité > Garantie > Prestation > Facturation.
 *
 * Lot 113AA (Trello #725, §2 C) : deux natures AJOUTÉES APRÈS l'arbitrage
 * 113W2, sans en changer l'ordre relatif — EFFET CONTRACTUEL (`CONTRACT` :
 * date d'effet et fin contractuelle d'un contrat, distinctes de la
 * couverture) et RÉALISATION (`REALIZATION` : travaux ou prestation
 * réellement exécutés, jamais la date d'un devis). Elles ne sont qualifiées
 * QUE par T1 (bloc 28, contrat `t1-business-periods-v2`) ; leur rang de repli
 * (en dernier) est « à valider par le PO ». T1 peut toujours désigner la
 * période principale.
 */
export const BUSINESS_PERIOD_KINDS = ['COVERAGE', 'VALIDITY', 'WARRANTY', 'SERVICE', 'BILLING', 'CONTRACT', 'REALIZATION'] as const;
/** Arbitrage 113W2 (décision PO du 07/11/2026), tracé séparément du CDC : ordre des cinq natures initiales. */
export const PRIORITY_ARBITRATION_113W2 = ['COVERAGE', 'VALIDITY', 'WARRANTY', 'SERVICE', 'BILLING'] as const;
export type BusinessPeriodKind = (typeof BUSINESS_PERIOD_KINDS)[number];

export const isBusinessPeriodKind = (v: unknown): v is BusinessPeriodKind =>
  typeof v === 'string' && (BUSINESS_PERIOD_KINDS as readonly string[]).includes(v);

/** Libellés par nature. `period` / `start` / `end` : forme complète, début seul, fin seul. */
export const BUSINESS_PERIOD_LABELS: Record<BusinessPeriodKind, { period: string; start: string; end: string }> = {
  // Ticket #724 (à l'identique).
  COVERAGE: { period: 'Période couverte', start: 'Début de couverture', end: 'Fin de couverture' },
  // À valider par le PO (même forme).
  BILLING: { period: 'Période facturée', start: 'Début de la période facturée', end: 'Fin de la période facturée' },
  VALIDITY: { period: 'Période de validité', start: 'Début de validité', end: 'Fin de validité' },
  WARRANTY: { period: 'Période de garantie', start: 'Début de garantie', end: 'Fin de garantie' },
  SERVICE: { period: 'Période de prestation', start: 'Début de prestation', end: 'Fin de prestation' },
  // Lot 113AA — à valider par le PO (même forme).
  CONTRACT: { period: 'Période contractuelle', start: 'Date d’effet du contrat', end: 'Fin du contrat' },
  REALIZATION: { period: 'Période de réalisation', start: 'Début de réalisation', end: 'Fin de réalisation' },
};

/** Lot 113AA — à valider par le PO : durée indéterminée ÉTABLIE par le document (≠ fin inconnue). */
export const OPEN_ENDED_SUFFIX = 'durée indéterminée';

/** Ticket #724 (à l'identique). */
export const SEVERAL_PERIODS_LABEL = 'Plusieurs périodes concernées';
export const NOT_PROVIDED_LABEL = 'non renseignée';
/** À valider par le PO. */
export const COVERAGE_HISTORY_TITLE = 'Périodes de couverture';
export const COVERAGE_HISTORY_EMPTY = 'Aucune période de couverture établie.';
export const PERIOD_CORRECT_ACTION = 'Corriger';
export const PERIOD_SAVED_TOAST = 'Période enregistrée';
export const PERIOD_INVALID_MESSAGE = 'Indiquez une date (JJ/MM/AAAA), un mois (MM/AAAA) ou une année (AAAA) ; la fin ne peut pas précéder le début.';
export const PERIOD_USER_MENTION = 'Corrigée par vous';
/** Carte #766 (E04) — à valider par le PO : case de l'éditeur existant (fin inexistante, ≠ fin inconnue). */
export const PERIOD_OPEN_ENDED_LABEL = 'Durée indéterminée (pas de date de fin)';
/** Carte #766 (E12) — à valider par le PO : création d'une nature que rien ne qualifie pour ce document. */
export const PERIOD_NOT_RELEVANT_MESSAGE = 'Cette période ne s’applique pas à ce document.';
/** Carte #766 (E11) — à valider par le PO : sous-section rattachée à « Notes / Description » (lecture des faits, jamais écrite dans les notes). */
export const PERIOD_DETAIL_TITLE = 'Autres dates et périodes du document';
/** Carte #766 (E09) — à valider par le PO : justificatif à plusieurs périodes facturées, lien avec CETTE dépense non établi. */
export const EXPENSE_PERIOD_UNDETERMINED = 'Période facturée de cette dépense non établie : le justificatif en indique plusieurs.';

// ── Dates partielles ────────────────────────────────────────────────────────

/** AAAA | AAAA-MM | AAAA-MM-JJ (date calendaire valide). */
export type PartialDate = string;

const PARTIAL_RE = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/;

/** Date partielle valide (calendrier réel pour un jour) ? Pure. */
export function isPartialDate(v: unknown): v is PartialDate {
  if (typeof v !== 'string') return false;
  const m = PARTIAL_RE.exec(v);
  if (!m) return false;
  if (!m[3]) return true;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export type PartialPrecision = 'YEAR' | 'MONTH' | 'DAY';
export const precisionOf = (v: PartialDate): PartialPrecision => (v.length === 4 ? 'YEAR' : v.length === 7 ? 'MONTH' : 'DAY');

/** Plus petite date possible (comparaisons seulement, jamais affichée). */
export const lowerBound = (v: PartialDate): string => (v.length === 4 ? `${v}-01-01` : v.length === 7 ? `${v}-01` : v);
/** Plus grande date possible (comparaisons seulement, jamais affichée). */
export const upperBound = (v: PartialDate): string => (v.length === 4 ? `${v}-12-31` : v.length === 7 ? `${v}-31` : v);

/** Bornes ordonnées (début au plus tôt ≤ fin au plus tard) ? Pure. */
export function orderedBounds(start: PartialDate | null, end: PartialDate | null): boolean {
  if (!start || !end) return true;
  return lowerBound(start) <= upperBound(end);
}

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Affichage d'une date partielle : 05/07/2026 · juillet 2026 · 2026. Pure. */
export function formatPartialDate(v: PartialDate): string {
  if (v.length === 4) return v;
  const [y, m, d] = v.split('-');
  if (!d) return `${MOIS[Number(m) - 1]} ${y}`;
  return `${d}/${m}/${y}`;
}

/**
 * Saisie utilisateur → date partielle : « 05/07/2026 », « 07/2026 », « 2026 »,
 * ou déjà ISO (« 2026-07-05 », « 2026-07 »). Vide → null. Illisible → undefined.
 */
export function parsePartialInput(raw: string | null | undefined): PartialDate | null | undefined {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let iso: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  else if ((m = /^(\d{1,2})[/.-](\d{4})$/.exec(s))) iso = `${m[2]}-${m[1].padStart(2, '0')}`;
  else if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) iso = s;
  return iso && isPartialDate(iso) ? iso : undefined;
}

/** Valeur d'un champ de saisie depuis une date partielle (forme française). */
export function partialToInput(v: PartialDate | null): string {
  if (!v) return '';
  if (v.length === 4) return v;
  const [y, m, d] = v.split('-');
  return d ? `${d}/${m}/${y}` : `${m}/${y}`;
}

// ── Libellés ────────────────────────────────────────────────────────────────

export interface PeriodBounds {
  start: PartialDate | null;
  end: PartialDate | null;
  /**
   * Lot 113AA : la durée indéterminée est ÉTABLIE (écrite) — la fin n'existe
   * pas. Distincte d'une fin INCONNUE (`end` null, `openEnded` faux).
   */
  openEnded?: boolean;
}

/**
 * Libellé d'UNE période (pure) :
 *   deux bornes        « Période couverte : du 01/04/2025 au 31/03/2026 »
 *                      (mois / année : « de mars 2026 à juin 2026 ») ;
 *   même mois / année  « Période facturée : février 2026 » (mois seul) ;
 *   début seul         « Début de couverture : 01/04/2025 » ;
 *   fin seule          « Fin de couverture : 31/03/2026 » ;
 *   aucune             « Période couverte : non renseignée ».
 */
export function periodLine(kind: BusinessPeriodKind, b: PeriodBounds): string {
  const l = BUSINESS_PERIOD_LABELS[kind];
  const { start, end } = b;
  if (start && end) {
    // Lot 113AA : une RÉALISATION à une date (travaux exécutés le…) s'affiche par cette seule date.
    if (start === end && (precisionOf(start) !== 'DAY' || kind === 'REALIZATION')) return `${l.period} : ${formatPartialDate(start)}`;
    const jour = precisionOf(start) === 'DAY' && precisionOf(end) === 'DAY';
    return jour
      ? `${l.period} : du ${formatPartialDate(start)} au ${formatPartialDate(end)}`
      : `${l.period} : de ${formatPartialDate(start)} à ${formatPartialDate(end)}`;
  }
  if (start && b.openEnded) return `${l.start} : ${formatPartialDate(start)} (${OPEN_ENDED_SUFFIX})`;
  if (start) return `${l.start} : ${formatPartialDate(start)}`;
  if (end) return `${l.end} : ${formatPartialDate(end)}`;
  if (b.openEnded) return `${l.period} : ${OPEN_ENDED_SUFFIX}`;
  return `${l.period} : ${NOT_PROVIDED_LABEL}`;
}

/** Libellé de la période principale d'un document : une seule ligne, ou « Plusieurs périodes concernées ». */
export function principalLine(kind: BusinessPeriodKind, segments: readonly PeriodBounds[]): string {
  if (segments.length > 1) return SEVERAL_PERIODS_LABEL;
  return periodLine(kind, segments[0] ?? { start: null, end: null });
}

// ── Carte #766 : identité et étendue PROUVÉE d'une période ───────────────────

/**
 * Carte #766 (E10) — même fait de période ? Mêmes bornes ET même modalité de fin : une fin INCONNUE
 * (`end` nul) et une durée indéterminée ÉTABLIE (`openEnded`) ont les mêmes bornes stockées mais pas le
 * même sens — jamais confondues. Pure.
 */
export function samePeriodBounds(a: PeriodBounds, b: PeriodBounds): boolean {
  return a.start === b.start && a.end === b.end && (a.end === null && a.openEnded === true) === (b.end === null && b.openEnded === true);
}

/** Jeton de fin d'une empreinte : la date, `INDEFINITE` (durée indéterminée établie) ou vide (inconnue). Pure. */
export const endToken = (b: PeriodBounds): string => b.end ?? (b.openEnded ? 'INDEFINITE' : '');

/** Dernier jour réel d'une borne de fin partielle (mois : 28 à 31 ; année : 31/12). Pure. */
export function lastDayOf(v: PartialDate): string {
  if (v.length === 7) {
    const [y, m] = v.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  return upperBound(v);
}

const DAY_MS = 86_400_000;
const dayNumber = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS;

/**
 * Carte #766 (E06, E05) — ce que les bornes PROUVENT de deux périodes :
 *   · `DISJOINT` : non-chevauchement prouvé (au plus `toleranceDays` jours communs) — soit les quatre
 *     bornes sont connues, soit la fin connue de l'une précède le début connu de l'autre ;
 *   · `OVERLAP`  : chevauchement prouvé (quatre bornes connues, plus de `toleranceDays` jours communs) ;
 *   · `UNKNOWN`  : une borne manquante empêche de conclure — l'ABSENCE de preuve de chevauchement n'est
 *     jamais une preuve de non-chevauchement.
 * Une durée indéterminée établie n'a pas de fin : elle ne prouve aucun chevauchement à elle seule (fin
 * traitée comme non bornée — jamais une contradiction fabriquée avec une attestation annuelle).
 * `days` : jours communs quand les quatre bornes sont connues, sinon null. Pure.
 */
export type BoundsProof = 'DISJOINT' | 'OVERLAP' | 'UNKNOWN';
export function boundsProof(a: PeriodBounds, b: PeriodBounds, toleranceDays = 0): { proof: BoundsProof; days: number | null } {
  const sa = a.start ? dayNumber(lowerBound(a.start)) : null;
  const ea = a.end ? dayNumber(lastDayOf(a.end)) : null;
  const sb = b.start ? dayNumber(lowerBound(b.start)) : null;
  const eb = b.end ? dayNumber(lastDayOf(b.end)) : null;
  if (sa !== null && ea !== null && sb !== null && eb !== null) {
    const days = Math.max(0, Math.min(ea, eb) - Math.max(sa, sb) + 1);
    return { proof: days > toleranceDays ? 'OVERLAP' : 'DISJOINT', days };
  }
  // Fin connue de l'une avant le début connu de l'autre : ordre prouvé, quelles que soient les bornes manquantes.
  if (ea !== null && sb !== null && ea - sb + 1 <= toleranceDays) return { proof: 'DISJOINT', days: null };
  if (eb !== null && sa !== null && eb - sa + 1 <= toleranceDays) return { proof: 'DISJOINT', days: null };
  return { proof: 'UNKNOWN', days: null };
}

// ── Carte #766 (E09) : période facturée d'UNE dépense ────────────────────────

/** Période propre à une ligne de dépense (jours ISO), telle que T1 / T3 l'ont établie. */
export interface ExpenseLineOwnPeriod { start: string | null; end: string | null }

/** Lignes de dépense dont la période propre peut être lue (composante financière, montant d'un justificatif). Pure. */
export const expenseLineHasReadablePeriod = (lineId: string): boolean => /^(c:\d{1,15}|doc:\d{1,10}:\d{1,15}:\d{1,3})$/.test(lineId);

/**
 * Carte #766 (E09) — période(s) facturée(s) à afficher pour UNE dépense (pure) :
 *   · le justificatif porte au plus une période facturée : c'est la sienne (inchangé) ;
 *   · il en porte plusieurs (facture récapitulative) : seulement celle qui CONTIENT la période propre de
 *     la ligne (établie par T1 / T3), si elle est unique ;
 *   · sinon (ligne sans période propre, aucune ou plusieurs périodes correspondantes) : aucune période
 *     n'est associée — `undetermined` : l'incertitude est affichée plutôt qu'une association fausse.
 * Aucune règle d'imputation : le coût de possession n'est ni lu ni modifié.
 */
export function expenseBillingPeriods<T extends PeriodBounds>(billing: readonly T[], own: ExpenseLineOwnPeriod | null | undefined): { periods: T[]; undetermined: boolean } {
  if (billing.length <= 1) return { periods: [...billing], undetermined: false };
  const debut = own?.start ?? own?.end ?? null;
  const fin = own?.end ?? own?.start ?? null;
  if (!debut || !fin) return { periods: [], undetermined: true };
  const contient = billing.filter((b) => !!b.start && !!b.end && lowerBound(b.start) <= debut.slice(0, 10) && lastDayOf(b.end) >= fin.slice(0, 10));
  return contient.length === 1 ? { periods: contient, undetermined: false } : { periods: [], undetermined: true };
}

/** Clé de tri chronologique (bornes inconnues en dernier). Pure. */
export function chronoKey(b: PeriodBounds): string {
  return `${b.start ? lowerBound(b.start) : b.end ? lowerBound(b.end) : '9999-99-99'}|${b.end ? upperBound(b.end) : '9999-99-99'}`;
}
