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
 *   TCO moyen annuel   = TCO total / durée de possession en années
 *                        durée = jours de la date d'achat EFFECTIVE (achat
 *                        consolidé, sinon fiche — jamais la date d'ajout) à
 *                        aujourd'hui (ou à la cession), INCLUS, / 365,25.
 *                        Pas de valeur si la date d'achat est inconnue ou
 *                        incohérente (postérieure à la fin de possession ou à
 *                        aujourd'hui, antérieure à 1900), ni en dessous de
 *                        `TCO_MIN_ANNUALIZED_DAYS` jours de possession
 *                        (extrapolation trompeuse) — décision PO à confirmer.
 *                        Moins d'un an : valeur signalée « extrapolée ».
 *   Dépenses de l'année = Σ des coûts réalisés RETENUS datés dans l'année
 *                        civile (date réelle de la dépense), avoirs,
 *                        remboursements et indemnités de l'année présentés à
 *                        part (net de l'année). Une dépense sans date n'est
 *                        rattachée à aucune année (signalée) ; une dépense
 *                        datée après aujourd'hui n'est comptée dans aucune
 *                        année (non encore réalisée, signalée).
 *
 * Cohérence (testée) : Σ nets des années + non datées + futures = TCO total.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { daysInclusive, isIsoDate, type ReadStatus } from '../finance/engine';
import type { FinancialComponentKind } from '../model';

/** Année moyenne (années bissextiles comprises). */
export const TCO_DAYS_PER_YEAR = 365.25;
/**
 * Durée minimale de possession pour annualiser (jours, ≈ un mois) : en
 * dessous, l'extrapolation d'un achat très récent serait trompeuse (un achat
 * de 300 € possédé 3 jours donnerait ≈ 36 500 €/an). Décision PO à confirmer.
 */
export const TCO_MIN_ANNUALIZED_DAYS = 30;
/** Première année plausible d'une date (avant : date incohérente). */
const PREMIERE_ANNEE = 1900;

export type TcoAnnualAverageStatus = 'COMPUTED' | 'ACQUISITION_DATE_MISSING' | 'ACQUISITION_DATE_INCOHERENT' | 'TOO_RECENT';

export interface TcoYearExpenses {
  year: number;
  /** Premier et dernier jour de la période de calcul (dernier = aujourd'hui pour l'année en cours). */
  periodStart: string;
  periodEnd: string;
  /** Coûts réalisés retenus datés dans l'année (centimes EUR). */
  costsCents: number;
  /** Avoirs, remboursements et indemnités retenus datés dans l'année. */
  creditsCents: number;
  netCents: number;
  /** Nombre de dépenses (coûts) de l'année. */
  count: number;
}

export interface TcoAnnualBucket { count: number; costsCents: number; creditsCents: number }

export interface TcoAnnual {
  average: {
    status: TcoAnnualAverageStatus;
    /** TCO moyen annuel (centimes EUR) ; null si non calculable. */
    cents: number | null;
    /** TCO total utilisé (coût cumulé documenté). */
    totalCents: number;
    /** Jours de possession inclus (null : date d'achat inconnue). */
    days: number | null;
    /** Durée en années (2 décimales). */
    years: number | null;
    start: string | null;
    end: string;
    /** Moins d'un an de possession : valeur extrapolée. */
    extrapolated: boolean;
    minDays: number;
    /** Le TCO total est incomplet (données manquantes) : la moyenne l'est aussi. */
    incomplete: boolean;
  };
  /** Années consultables (croissantes), de l'achat (ou de la première dépense datée) à aujourd'hui ou à la cession. */
  years: TcoYearExpenses[];
  /** Année présentée par défaut : année en cours, ou année de cession. */
  defaultYear: number;
  /** Dépenses retenues sans date : comptées dans le total, rattachées à aucune année. */
  undated: TcoAnnualBucket;
  /** Dépenses retenues datées après aujourd'hui : comptées dans le total, dans aucune année (non encore réalisées). */
  future: TcoAnnualBucket;
}

/** Ligne économique minimale lue (sous-ensemble de `TcoEconomicLine`). */
export interface TcoAnnualLine {
  id: string;
  status: string;
  kind: FinancialComponentKind | null;
  includedCents: number;
  date: string | null;
}

const RETENUE = (s: string) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';
const CREDIT = new Set<FinancialComponentKind>(['REDUCTION', 'REFUND', 'INDEMNITY']);
const anneeDe = (d: string) => Number(d.slice(0, 4));
const datePlausible = (d: string | null | undefined): d is string => isIsoDate(d) && anneeDe(d) >= PREMIERE_ANNEE;

/** Calcul des indicateurs annuels à partir de la trace du moteur TCO (pure, testée L76G-*). */
export function computeTcoAnnual(input: {
  lines: readonly TcoAnnualLine[];
  period: { start: string | null; end: string; endSource: string };
  cumulativeCostCents: number;
  status: ReadStatus;
  today: string;
  disposed: boolean;
}): TcoAnnual {
  const today = input.today.slice(0, 10);
  const anneeCourante = anneeDe(today);

  // ── TCO moyen annuel ───────────────────────────────────────────────────
  const start = input.period.start && isIsoDate(input.period.start) ? input.period.start.slice(0, 10) : null;
  const end = input.period.end.slice(0, 10);
  let status: TcoAnnualAverageStatus = 'COMPUTED';
  let days: number | null = null;
  if (!start) status = 'ACQUISITION_DATE_MISSING';
  else if (!datePlausible(start) || start > end || start > today) status = 'ACQUISITION_DATE_INCOHERENT';
  else {
    days = daysInclusive(start, end);
    if (days < TCO_MIN_ANNUALIZED_DAYS) status = 'TOO_RECENT';
  }
  const ans = days != null ? days / TCO_DAYS_PER_YEAR : null;
  const average: TcoAnnual['average'] = {
    status,
    cents: status === 'COMPUTED' && days ? Math.round((input.cumulativeCostCents * TCO_DAYS_PER_YEAR) / days) : null,
    totalCents: input.cumulativeCostCents,
    days,
    years: ans != null ? Math.round(ans * 100) / 100 : null,
    start,
    end,
    extrapolated: status === 'COMPUTED' && days != null && days < TCO_DAYS_PER_YEAR,
    minDays: TCO_MIN_ANNUALIZED_DAYS,
    incomplete: input.status !== 'COMPLETE',
  };

  // ── Dépenses par année civile (lignes RETENUES par le moteur, une fois chacune) ──
  const parAnnee = new Map<number, TcoYearExpenses>();
  const undated: TcoAnnualBucket = { count: 0, costsCents: 0, creditsCents: 0 };
  const future: TcoAnnualBucket = { count: 0, costsCents: 0, creditsCents: 0 };
  const vues = new Set<string>();
  const annee = (y: number): TcoYearExpenses => {
    let a = parAnnee.get(y);
    if (!a) {
      a = { year: y, periodStart: `${y}-01-01`, periodEnd: y === anneeCourante ? today : `${y}-12-31`, costsCents: 0, creditsCents: 0, netCents: 0, count: 0 };
      parAnnee.set(y, a);
    }
    return a;
  };
  for (const l of input.lines) {
    if (!RETENUE(l.status) || !l.kind || vues.has(l.id)) continue;
    const cout = l.kind === 'REALIZED_COST';
    const credit = CREDIT.has(l.kind);
    if (!cout && !credit) continue; // prix de cession : jamais une dépense
    vues.add(l.id);
    const cible: TcoAnnualBucket = !datePlausible(l.date) ? undated : l.date.slice(0, 10) > today ? future : annee(anneeDe(l.date));
    if (cout) { cible.costsCents += l.includedCents; cible.count += 1; } else cible.creditsCents += l.includedCents;
  }

  // Plage consultable : de l'achat (ou de la première dépense datée) à aujourd'hui, ou à la cession.
  const defaultYear = input.disposed && input.period.endSource !== 'TODAY' ? Math.min(anneeDe(end), anneeCourante) : anneeCourante;
  const bornes = [...parAnnee.keys(), defaultYear];
  if (average.status !== 'ACQUISITION_DATE_MISSING' && start && datePlausible(start) && start <= today) bornes.push(anneeDe(start));
  const premiere = Math.min(...bornes);
  const derniere = Math.max(...bornes);
  const years: TcoYearExpenses[] = [];
  for (let y = premiere; y <= derniere; y++) {
    const a = annee(y);
    a.netCents = a.costsCents - a.creditsCents;
    years.push(a);
  }
  return { average, years, defaultYear, undated, future };
}
