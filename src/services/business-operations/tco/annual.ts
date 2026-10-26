/**
 * Lot 76G — indicateurs ANNUELS du TCO (ticket P2 « TCO : ajouter les
 * indicateurs annuels »). PUR, sans import serveur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN SECOND MOTEUR
 *
 * Les indicateurs sont DÉRIVÉS des lignes économiques que `computeTco` vient
 * d'examiner (`TcoResult.lines`) : mêmes lignes, mêmes montants retenus
 * (`includedCents`, après dédoublonnage bien / équipements, prorata de
 * cession, exclusions), mêmes catégories. Aucune lecture, aucune règle de
 * qualification ou de dédoublonnage propre ici : une dépense écartée ou
 * dédoublonnée par le moteur ne réapparaît jamais dans une année.
 *
 *   TCO total          = coût cumulé documenté (inchangé, cumulatif).
 *   TCO moyen annuel   = TCO total × 365,25 / jours de possession INCLUS,
 *                        de la date d'acquisition CANONIQUE (achat consolidé,
 *                        sinon fiche : clé, alias, puis colonne historique
 *                        `purchase_date` — jamais la date d'ajout) à la date
 *                        de référence (ou à la cession).
 *                        Lot 81D : AUCUN seuil de durée (le seuil de 30 jours
 *                        du lot 76G est supprimé) ; moins d'un an : « Valeur
 *                        extrapolée sur une durée de possession inférieure à
 *                        un an ». Pas de valeur si la date est absente,
 *                        impossible (29/02/2025), future ou postérieure à la
 *                        cession (motif distinct). Aucune borne d'ancienneté.
 *   Dépenses de l'année = Σ des coûts réalisés RETENUS datés dans l'année
 *                        civile (date réelle de la dépense) = montant BRUT ;
 *                        avoirs, remboursements et indemnités de l'année à
 *                        part ; NET = brut − crédits. Une dépense sans date
 *                        fiable n'est rattachée à aucune année (signalée :
 *                        années « potentiellement incomplètes »).
 *                        Lot 81D : une dépense non réalisée (prévue, ou
 *                        datée après la date de référence) est EXCLUE par le
 *                        moteur partagé : elle ne figure dans AUCUN des trois
 *                        indicateurs (comptée à part, pour information).
 *
 * Chaque ligne retenue reçoit son année (`assign`) : le détail de l'année
 * (sous-tiroir) est exactement la sélection de l'indicateur, sans règle
 * côté interface.
 *
 * Cohérence (testée, `reconciled`) : Σ nets des années + nets non datés = TCO total.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { daysInclusive, isIsoDate, type ReadStatus } from '../finance/engine';
import type { FinancialComponentKind } from '../model';

/** Année moyenne (années bissextiles comprises). */
export const TCO_DAYS_PER_YEAR = 365.25;
/** Lot 81D : libellé d'une moyenne calculée sur moins d'un an de possession. */
const TCO_EXTRAPOLATED_LABEL = 'Valeur extrapolée sur une durée de possession inférieure à un an';

type TcoAnnualAverageStatus = 'COMPUTED' | 'ACQUISITION_DATE_MISSING' | 'ACQUISITION_DATE_INCOHERENT';
/** Lot 81D : motif d'une date d'acquisition incohérente. */
type TcoAcquisitionIncoherence = 'INVALID_DATE' | 'FUTURE' | 'AFTER_DISPOSAL';

interface TcoYearExpenses {
  year: number;
  /** Premier et dernier jour de la période de calcul (dernier = date de référence pour l'année en cours). */
  periodStart: string;
  periodEnd: string;
  /** Coûts réalisés retenus datés dans l'année (centimes EUR) — montant BRUT. */
  costsCents: number;
  /** Avoirs, remboursements et indemnités retenus datés dans l'année. */
  creditsCents: number;
  /** NET de l'année = brut − crédits. */
  netCents: number;
  /** Nombre de dépenses (coûts) de l'année. */
  count: number;
  /** Lot 81D : nombre d'avoirs, remboursements et indemnités de l'année. */
  creditsCount: number;
  /** Lot 81D : des dépenses retenues sans date existent — le montant de l'année n'est pas une absence certaine. */
  possiblyIncomplete: boolean;
}

interface TcoAnnualBucket { count: number; costsCents: number; creditsCents: number }

export interface TcoAnnual {
  average: {
    status: TcoAnnualAverageStatus;
    /** TCO moyen annuel (centimes EUR) ; null si non calculable. */
    cents: number | null;
    /** TCO total utilisé (coût cumulé documenté). */
    totalCents: number;
    /** Jours de possession inclus (null : date d'achat inconnue ou incohérente). */
    days: number | null;
    /** Durée en années (2 décimales). */
    years: number | null;
    start: string | null;
    end: string;
    /** Moins d'un an de possession : valeur extrapolée. */
    extrapolated: boolean;
    /** Lot 81D : libellé à afficher quand la valeur est extrapolée. */
    extrapolationLabel: string | null;
    /** Lot 81D : motif d'incohérence de la date d'acquisition. */
    incoherence: TcoAcquisitionIncoherence | null;
    /** Le TCO total est incomplet (données manquantes) : la moyenne l'est aussi. */
    incomplete: boolean;
  };
  /** Années consultables (croissantes), de l'achat (ou de la première dépense datée) à la date de référence ou à la cession. */
  years: TcoYearExpenses[];
  /** Année présentée par défaut : année de la date de référence, ou année de cession. */
  defaultYear: number;
  /** Dépenses retenues sans date fiable : comptées dans le total, rattachées à aucune année. */
  undated: TcoAnnualBucket;
  /** Lot 81D : dépenses NON réalisées (prévues, datées après la date de référence) — exclues des trois indicateurs, pour information. */
  notRealized: { count: number; costsCents: number };
  /** Lot 81D : date de référence (date civile Europe/Paris) commune aux trois indicateurs. */
  referenceDate: string;
  /** Lot 81D : Σ nets des années + nets non datés = TCO total (contrôle, sans doublon). */
  reconciled: boolean;
}

/** Ligne économique minimale lue (sous-ensemble de `TcoEconomicLine`). */
interface TcoAnnualLine {
  id: string;
  status: string;
  kind: FinancialComponentKind | null;
  includedCents: number;
  date: string | null;
  reason?: string | null;
  eurCents?: number | null;
}

const RETENUE = (s: string) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';
const CREDIT = new Set<FinancialComponentKind>(['REDUCTION', 'REFUND', 'INDEMNITY']);
const NON_REALISEE = new Set(['NOT_REALIZED', 'FUTURE_DATED']);
const anneeDe = (d: string) => Number(d.slice(0, 4));

/** Calcul des indicateurs annuels à partir de la trace du moteur TCO (pure, testée L76G-* / L81D-*). */
export function computeTcoAnnual(input: {
  lines: readonly TcoAnnualLine[];
  period: { start: string | null; end: string; endSource: string; startRejected?: string | null };
  cumulativeCostCents: number;
  status: ReadStatus;
  today: string;
  disposed: boolean;
  /** Lot 81D : année attribuée à chaque ligne retenue (null : sans date fiable). */
  assign?: (lineId: string, year: number | null) => void;
}): TcoAnnual {
  const today = input.today.slice(0, 10);
  const anneeCourante = anneeDe(today);

  // ── TCO moyen annuel (aucun seuil de durée) ────────────────────────────
  const brut = input.period.start;
  const start = isIsoDate(brut) ? brut.slice(0, 10) : null;
  const end = input.period.end.slice(0, 10);
  let status: TcoAnnualAverageStatus = 'COMPUTED';
  let incoherence: TcoAcquisitionIncoherence | null = null;
  let days: number | null = null;
  if (!start && (input.period.startRejected || brut)) { status = 'ACQUISITION_DATE_INCOHERENT'; incoherence = 'INVALID_DATE'; }
  else if (!start) status = 'ACQUISITION_DATE_MISSING';
  else if (start > today) { status = 'ACQUISITION_DATE_INCOHERENT'; incoherence = 'FUTURE'; }
  else if (start > end) { status = 'ACQUISITION_DATE_INCOHERENT'; incoherence = 'AFTER_DISPOSAL'; }
  else days = daysInclusive(start, end);
  if (status === 'COMPUTED' && !(days && days > 0)) { status = 'ACQUISITION_DATE_INCOHERENT'; incoherence = 'AFTER_DISPOSAL'; days = null; }
  const ans = days != null ? days / TCO_DAYS_PER_YEAR : null;
  const extrapolated = status === 'COMPUTED' && days != null && days < TCO_DAYS_PER_YEAR;
  const average: TcoAnnual['average'] = {
    status,
    cents: status === 'COMPUTED' && days ? Math.round((input.cumulativeCostCents * TCO_DAYS_PER_YEAR) / days) : null,
    totalCents: input.cumulativeCostCents,
    days,
    years: ans != null ? Math.round(ans * 100) / 100 : null,
    start: status === 'COMPUTED' || incoherence !== 'INVALID_DATE' ? start : null,
    end,
    extrapolated,
    extrapolationLabel: extrapolated ? TCO_EXTRAPOLATED_LABEL : null,
    incoherence,
    incomplete: input.status !== 'COMPLETE',
  };

  // ── Dépenses par année civile (lignes RETENUES par le moteur, une fois chacune) ──
  const parAnnee = new Map<number, TcoYearExpenses>();
  const undated: TcoAnnualBucket = { count: 0, costsCents: 0, creditsCents: 0 };
  const notRealized = { count: 0, costsCents: 0 };
  const vues = new Set<string>();
  const annee = (y: number): TcoYearExpenses => {
    let a = parAnnee.get(y);
    if (!a) {
      a = { year: y, periodStart: `${y}-01-01`, periodEnd: y === anneeCourante ? today : `${y}-12-31`, costsCents: 0, creditsCents: 0, netCents: 0, count: 0, creditsCount: 0, possiblyIncomplete: false };
      parAnnee.set(y, a);
    }
    return a;
  };
  for (const l of input.lines) {
    if (!RETENUE(l.status)) {
      // Information : dépenses non réalisées, exclues des trois indicateurs par le moteur partagé.
      if (l.reason && NON_REALISEE.has(l.reason) && !vues.has(`nr:${l.id}`)) {
        vues.add(`nr:${l.id}`);
        notRealized.count += 1;
        if (l.kind === 'REALIZED_COST' && l.eurCents != null) notRealized.costsCents += l.eurCents;
      }
      continue;
    }
    if (!l.kind || vues.has(l.id)) continue;
    const cout = l.kind === 'REALIZED_COST';
    const credit = CREDIT.has(l.kind);
    if (!cout && !credit) continue; // prix de cession : jamais une dépense
    vues.add(l.id);
    // Défense : une ligne retenue datée après la date de référence n'est rattachée à aucune année (le moteur l'exclut).
    const jour = isIsoDate(l.date) && l.date.slice(0, 10) <= today ? l.date.slice(0, 10) : null;
    const cible: TcoAnnualBucket & { creditsCount?: number } = jour ? annee(anneeDe(jour)) : undated;
    input.assign?.(l.id, jour ? anneeDe(jour) : null);
    if (cout) { cible.costsCents += l.includedCents; cible.count += 1; } else {
      cible.creditsCents += l.includedCents;
      if (cible !== undated) (cible as TcoYearExpenses).creditsCount += 1;
    }
  }

  // Plage consultable : de l'achat (ou de la première dépense datée) à la date de référence, ou à la cession.
  const defaultYear = input.disposed && input.period.endSource !== 'TODAY' ? Math.min(anneeDe(end), anneeCourante) : anneeCourante;
  const bornes = [...parAnnee.keys(), defaultYear];
  if (start && start <= today) bornes.push(anneeDe(start));
  const premiere = Math.min(...bornes);
  const derniere = Math.max(...bornes);
  const years: TcoYearExpenses[] = [];
  const incomplete = undated.count > 0 || undated.creditsCents > 0;
  for (let y = premiere; y <= derniere; y++) {
    const a = annee(y);
    a.netCents = a.costsCents - a.creditsCents;
    a.possiblyIncomplete = incomplete;
    years.push(a);
  }
  const reconciled = years.reduce((n, y) => n + y.netCents, 0) + undated.costsCents - undated.creditsCents === input.cumulativeCostCents;
  return { average, years, defaultYear, undated, notRealized, referenceDate: today, reconciled };
}
