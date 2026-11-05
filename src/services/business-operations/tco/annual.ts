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
 *   Lot 111F (ticket P1 « coût de possession, financement et valorisation »,
 *   remplace la formule des lots 76G / 81D, #540, #559) :
 *   Coût annuel moyen  = (TCO total − prix d'acquisition DU BIEN) ÷ durée en
 *                        ANNÉES ANNIVERSAIRES (`ownershipDuration`, décision
 *                        PO du 05/11) — le prix d'achat n'est
 *                        JAMAIS annualisé ; frais d'acquisition, financement
 *                        (intérêts, assurance, frais) et toutes les dépenses de
 *                        possession (travaux, remplacements compris) restent
 *                        au numérateur, sans amortissement. Prix d'achat
 *                        attendu mais inconnu : non calculé
 *                        (ACQUISITION_PRICE_UNKNOWN, jamais un prix fictif).
 *   (ancien libellé)   = TCO total × 365,25 / jours de possession INCLUS,
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
 *                        Lot 107C : date de départ = date d'achat DU bien
 *                        (`./acquisition-start` : saisie utilisateur
 *                        prioritaire, jamais la plus ancienne ACQUISITION) ;
 *                        contradiction sans autorité → non calculée
 *                        (ACQUISITION_DATE_UNDETERMINED).
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

/** Année moyenne (années bissextiles comprises) — conservée pour les consommateurs historiques ; la moyenne annuelle utilise `ownershipDuration`. */
export const TCO_DAYS_PER_YEAR = 365.25;

/**
 * Lot 111F (décision PO du 05/11) — durée de possession en ANNÉES ANNIVERSAIRES :
 * nombre d'années pleines entre la date d'acquisition et la date de fin (dates
 * civiles Europe/Paris), puis le reste en jours rapporté au nombre de jours de
 * l'année anniversaire en cours. 5 années pleines = exactement 5.
 * 29 février : dans une année non bissextile, l'anniversaire est le 28 février.
 * Même jour (achat aujourd'hui) : 1 jour, jamais une durée nulle.
 * Représentation rationnelle exacte (aucun flottant dans le calcul d'un montant).
 */
export interface TcoOwnershipDuration {
  fullYears: number;
  /** Jours écoulés depuis le dernier anniversaire. */
  remainderDays: number;
  /** Jours de l'année anniversaire en cours (365 ou 366). */
  yearDays: number;
}

const estBissextile = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const jourUtc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
/** Anniversaire n de la date `start` (AAAA-MM-JJ) en millisecondes UTC ; 29/02 → 28/02 en année non bissextile. */
function anniversaire(y: number, m: number, d: number, n: number): number {
  const an = y + n;
  return jourUtc(an, m, m === 2 && d === 29 && !estBissextile(an) ? 28 : d);
}

/** Durée de possession en années anniversaires (pure, testée L111F-DUR-*) ; null si `end` < `start`. */
export function ownershipDuration(start: string, end: string): TcoOwnershipDuration | null {
  const [y, m, d] = start.slice(0, 10).split('-').map(Number);
  const [ye, me, de] = end.slice(0, 10).split('-').map(Number);
  const fin = jourUtc(ye, me, de);
  if (fin < jourUtc(y, m, d)) return null;
  let n = Math.max(0, ye - y);
  while (n > 0 && anniversaire(y, m, d, n) > fin) n -= 1;
  const debut = anniversaire(y, m, d, n);
  const suivant = anniversaire(y, m, d, n + 1);
  const yearDays = Math.round((suivant - debut) / 86_400_000);
  const remainderDays = Math.round((fin - debut) / 86_400_000);
  // Achat le jour même : un jour de possession (jamais une division par zéro).
  return n === 0 && remainderDays === 0 ? { fullYears: 0, remainderDays: 1, yearDays } : { fullYears: n, remainderDays, yearDays };
}

/** Durée en années (décimale, affichage seulement). */
export const durationYears = (x: TcoOwnershipDuration): number => x.fullYears + x.remainderDays / x.yearDays;

/** Montant annualisé (centimes, arrondi) = montant ÷ durée, calcul rationnel exact. */
export function annualizeCents(amountCents: number, x: TcoOwnershipDuration): number {
  return Math.round((amountCents * x.yearDays) / (x.fullYears * x.yearDays + x.remainderDays));
}
/** Lot 81D : libellé d'une moyenne calculée sur moins d'un an de possession. */
const TCO_EXTRAPOLATED_LABEL = 'Valeur extrapolée sur une durée de possession inférieure à un an';

// Lot 107C : ACQUISITION_DATE_UNDETERMINED — dates d'achat du bien contradictoires sans autorité décisive.
// Lot 111F : ACQUISITION_PRICE_UNKNOWN — prix d'achat du bien attendu mais inconnu (jamais soustrait un prix fictif).
type TcoAnnualAverageStatus = 'COMPUTED' | 'ACQUISITION_DATE_MISSING' | 'ACQUISITION_DATE_INCOHERENT' | 'ACQUISITION_DATE_UNDETERMINED' | 'ACQUISITION_PRICE_UNKNOWN';
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
    /** Lot 111F : coût annuel moyen de possession (centimes EUR), prix d'achat du bien exclu ; null si non calculable. */
    cents: number | null;
    /** TCO total utilisé (coût cumulé documenté). */
    totalCents: number;
    /** Lot 111F : prix d'acquisition du bien retiré du numérateur (null : inconnu). */
    acquisitionPriceCents: number | null;
    /** Lot 111F : numérateur = TCO total − prix d'acquisition du bien (null : non calculable). */
    ownershipCostsCents: number | null;
    /** Jours de possession inclus (null : date d'achat inconnue ou incohérente). */
    days: number | null;
    /** Lot 111F : durée en années anniversaires (années pleines + reste en jours / jours de l'année anniversaire). */
    duration: TcoOwnershipDuration | null;
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
    /**
     * Lot 107C : nature de la date de départ — achat du bien (« Depuis l'achat
     * du bien le… ») ou début de possession (location, prêt, don).
     */
    startKind: 'PURCHASE' | 'POSSESSION';
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
  period: { start: string | null; end: string; endSource: string; startRejected?: string | null; startStatus?: string; startKind?: 'PURCHASE' | 'POSSESSION' };
  cumulativeCostCents: number;
  /**
   * Lot 111F : prix d'acquisition du bien (centimes EUR) retiré du numérateur
   * de la moyenne ; 0 sans achat (location, prêt, don) ; null : attendu mais
   * inconnu → moyenne non calculée.
   */
  acquisitionPriceCents: number | null;
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
  // Lot 107C : contradiction sans autorité — jamais une moyenne précise trompeuse, motif distinct de « date absente ».
  else if (!start && input.period.startStatus === 'UNDETERMINED') status = 'ACQUISITION_DATE_UNDETERMINED';
  else if (!start) status = 'ACQUISITION_DATE_MISSING';
  else if (start > today) { status = 'ACQUISITION_DATE_INCOHERENT'; incoherence = 'FUTURE'; }
  else if (start > end) { status = 'ACQUISITION_DATE_INCOHERENT'; incoherence = 'AFTER_DISPOSAL'; }
  else days = daysInclusive(start, end);
  if (status === 'COMPUTED' && !(days && days > 0)) { status = 'ACQUISITION_DATE_INCOHERENT'; incoherence = 'AFTER_DISPOSAL'; days = null; }
  // Lot 111F : prix d'achat attendu mais inconnu — jamais un prix fictif soustrait (la durée reste restituée).
  const prixAchat = input.acquisitionPriceCents;
  if (status === 'COMPUTED' && (prixAchat == null || !Number.isSafeInteger(prixAchat))) status = 'ACQUISITION_PRICE_UNKNOWN';
  const numerateur = status === 'COMPUTED' ? input.cumulativeCostCents - (prixAchat as number) : null;
  // Lot 111F : durée en années anniversaires (une seule fonction, partagée par le TCO, T2 et le diagnostic BO).
  const duree = days != null && start ? ownershipDuration(start, end) : null;
  const ans = duree ? durationYears(duree) : null;
  const extrapolated = status === 'COMPUTED' && duree != null && duree.fullYears < 1;
  const average: TcoAnnual['average'] = {
    status,
    cents: status === 'COMPUTED' && duree && numerateur != null ? annualizeCents(numerateur, duree) : null,
    totalCents: input.cumulativeCostCents,
    acquisitionPriceCents: prixAchat ?? null,
    ownershipCostsCents: numerateur,
    days,
    duration: duree,
    years: ans != null ? Math.round(ans * 100) / 100 : null,
    start: status === 'COMPUTED' || incoherence !== 'INVALID_DATE' ? start : null,
    end,
    extrapolated,
    extrapolationLabel: extrapolated ? TCO_EXTRAPOLATED_LABEL : null,
    incoherence,
    incomplete: input.status !== 'COMPLETE',
    startKind: input.period.startKind ?? 'PURCHASE',
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
