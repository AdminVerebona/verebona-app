/**
 * Lot 111F (ticket P1 « TCO — coût de possession, financement et
 * valorisation », §2, §4, §5) — indicateurs de possession d'un bien. PUR,
 * sans import serveur (règles partagées par le moteur TCO, la route des
 * valorisations, T2 et le BO ; jamais par l'interface).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   Coût total            = coût cumulé retenu par le moteur (acquisition +
 *                           frais d'acquisition + dépenses de possession +
 *                           coût du crédit à date − corrections), estimations
 *                           d'usage (#646) comprises si elles existent (part
 *                           estimée signalée).
 *   Coût annuel moyen     = (coût total − prix d'acquisition DU BIEN) / durée
 *                           de possession (`./annual`) — mêmes lignes.
 *   Coût net estimé       = coût total − dernière valeur estimée ADMISSIBLE
 *                           (`assessValuations`) ; bien vendu : coût total
 *                           (frais de vente réels compris, une fois) − prix de
 *                           cession réalisé. Jamais de frais de revente
 *                           hypothétiques, jamais de dépréciation, jamais le
 *                           prix d'achat ni des travaux comme valeur.
 *   Indicateur non calculable : `cents: null` + motif (« – » et icône
 *   d'information sur la fiche) — jamais une alerte ni un « À traiter ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isIsoDate } from '../finance/engine';
import type { TcoAnnual } from './annual';
import type { TcoFinancing } from './financing';

// ── Valorisations admissibles (§4) ──────────────────────────────────────────

/** Entrée de l'historique de valorisation (`valuationHistory`, valeur en euros). */
export interface ValuationHistoryInput {
  id?: string | null;
  value: number | null;
  /** Date EFFECTIVE de la valorisation (jamais la date d'ajout). */
  date: string | null;
  mode?: string | null;
  source?: string | null;
  currency?: string | null;
  /** Date d'ajout / d'enregistrement (départage seulement, jamais une date de valeur). */
  addedAt?: string | null;
}

/** Motif pour lequel une valorisation n'est pas retenue comme valeur actuelle. */
export type ValuationRejection = 'INVALID_VALUE' | 'UNDATED' | 'CURRENCY' | 'FUTURE' | 'NOT_AFTER_ACQUISITION' | 'ACQUISITION_DATE_UNKNOWN';

export const VALUATION_REJECTION_LABELS: Readonly<Record<ValuationRejection, string>> = {
  INVALID_VALUE: 'Montant invalide',
  UNDATED: 'Date de valorisation inconnue : conservée, non utilisée pour le coût net',
  CURRENCY: 'Devise autre que l’euro : non utilisée',
  FUTURE: 'Datée après aujourd’hui : non utilisée',
  NOT_AFTER_ACQUISITION: 'Antérieure ou égale à la date d’achat : ce n’est pas une valeur actuelle',
  ACQUISITION_DATE_UNKNOWN: 'Date d’achat du bien inconnue : impossible de vérifier que l’estimation est postérieure à l’achat',
};

export interface ValuationAssessment {
  /** Index (dans l'historique fourni) de la valorisation retenue, ou null. */
  retainedIndex: number | null;
  items: Array<{ index: number; admissible: boolean; rejection: ValuationRejection | null }>;
}

/**
 * Admissibilité de chaque valorisation et sélection de la plus récente par
 * DATE DE VALORISATION (jamais par ordre d'ajout ; à date égale, la dernière
 * enregistrée) — datée, montant valide, en euros, non future, STRICTEMENT
 * postérieure à l'acquisition (pure, testée L111F-VAL-*).
 */
export function assessValuations(history: readonly ValuationHistoryInput[], ctx: { asOf: string; acquisitionDate: string | null }): ValuationAssessment {
  const asOf = ctx.asOf.slice(0, 10);
  const achat = isIsoDate(ctx.acquisitionDate) ? ctx.acquisitionDate.slice(0, 10) : null;
  const items = history.map((v, index) => {
    let rejection: ValuationRejection | null = null;
    if (typeof v.value !== 'number' || !Number.isFinite(v.value) || v.value < 0) rejection = 'INVALID_VALUE';
    else if (!isIsoDate(v.date)) rejection = 'UNDATED';
    else if (v.currency && String(v.currency).trim().toUpperCase() !== 'EUR') rejection = 'CURRENCY';
    else if (v.date.slice(0, 10) > asOf) rejection = 'FUTURE';
    else if (!achat) rejection = 'ACQUISITION_DATE_UNKNOWN';
    else if (v.date.slice(0, 10) <= achat) rejection = 'NOT_AFTER_ACQUISITION';
    return { index, admissible: rejection === null, rejection };
  });
  const ok = items.filter((x) => x.admissible).sort((a, b) => {
    const va = history[a.index]; const vb = history[b.index];
    return va.date!.slice(0, 10).localeCompare(vb.date!.slice(0, 10)) || String(va.addedAt ?? '').localeCompare(String(vb.addedAt ?? '')) || a.index - b.index;
  });
  return { retainedIndex: ok.length ? ok[ok.length - 1].index : null, items };
}

// ── Prix d'acquisition du bien (§2) ─────────────────────────────────────────

interface AcquisitionLine {
  status: string;
  kind: string | null;
  category: string | null;
  includedCents: number;
  composition?: { feesMinor: number; currency: string } | null;
}

/**
 * Prix d'acquisition DU BIEN retiré du coût annuel moyen (valeur historique,
 * pure) : lignes retenues du poste « Acquisition », sans les frais compris dans
 * le net de l'achat (lot 109D) ; plafonné au prix du bien saisi / extrait sur
 * la fiche s'il est connu (un prix global frais inclus garde ses frais au
 * numérateur). Sans achat (location, prêt, don) : 0. Achat attendu mais
 * inconnu : null (aucun prix fictif).
 */
export function assetAcquisitionPrice(input: {
  lines: readonly AcquisitionLine[];
  acquisitionStatus: 'DOCUMENTED' | 'MISSING' | 'NOT_APPLICABLE';
  assetPriceEurCents: number | null;
}): number | null {
  if (input.acquisitionStatus === 'NOT_APPLICABLE') return 0;
  if (input.acquisitionStatus === 'MISSING') return null;
  let total = 0;
  for (const l of input.lines) {
    if ((l.status !== 'RETAINED_DIRECT' && l.status !== 'RETAINED_CONSOLIDATED') || l.category !== 'ACQUISITION' || l.kind !== 'REALIZED_COST') continue;
    const frais = l.composition && l.composition.currency.toUpperCase() === 'EUR' && l.composition.feesMinor > 0 ? Math.min(l.composition.feesMinor, l.includedCents) : 0;
    total += l.includedCents - frais;
  }
  return input.assetPriceEurCents != null && input.assetPriceEurCents >= 0 ? Math.min(total, input.assetPriceEurCents) : total;
}

// ── Indicateurs de la fiche (§5) ────────────────────────────────────────────

export interface TcoIndicatorValuation {
  cents: number;
  date: string;
  mode: string | null;
  source: string | null;
  /** Ancienneté informative (jamais alarmante), ex. « il y a 2 ans ». */
  ageLabel: string;
}

export interface TcoIndicators {
  total: {
    cents: number;
    documentedCents: number;
    estimatedShareCents: number;
    financingToDateCents: number;
    info: string;
  };
  annualAverage: {
    /** Valeur affichée (estimations d'usage comprises si le total les inclut) ; null : « – ». */
    cents: number | null;
    documentedCents: number | null;
    estimatedShareCents: number;
    unavailableReason: string | null;
    info: string;
  };
  net: {
    kind: 'ESTIMATED' | 'FINAL';
    cents: number | null;
    documentedCents: number | null;
    valuation: TcoIndicatorValuation | null;
    realizedPriceCents: number | null;
    disposalFeesCents: number;
    unavailableReason: string | null;
    info: string;
  };
  financing: TcoFinancing;
}

const eurFr = (c: number) => `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const dateFr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const ansFr = (a: number) => `${a.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} an${a >= 2 ? 's' : ''}`;

/** Ancienneté informative d'une estimation (pure). */
export function valuationAgeLabel(date: string, today: string): string {
  const [y1, m1, d1] = date.slice(0, 10).split('-').map(Number);
  const [y2, m2, d2] = today.slice(0, 10).split('-').map(Number);
  const mois = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  if (mois < 1) return 'ce mois-ci';
  if (mois < 12) return `il y a ${mois} mois`;
  const ans = Math.floor(mois / 12);
  return `il y a ${ans} an${ans > 1 ? 's' : ''}`;
}

const MOTIF_MOYENNE: Readonly<Record<Exclude<TcoAnnual['average']['status'], 'COMPUTED'>, string>> = {
  ACQUISITION_DATE_MISSING: 'Date d’achat du bien inconnue : renseignez-la sur la fiche pour calculer la moyenne.',
  ACQUISITION_DATE_UNDETERMINED: 'Date d’achat du bien incertaine (plusieurs dates se contredisent) : confirmez-la sur la fiche pour calculer la moyenne.',
  ACQUISITION_DATE_INCOHERENT: 'Date d’achat du bien incohérente (impossible, future ou postérieure à la cession) : moyenne non calculée.',
  ACQUISITION_PRICE_UNKNOWN: 'Prix d’achat du bien inconnu : la moyenne n’est pas calculée, pour ne jamais soustraire un prix fictif. Renseignez le prix d’achat sur la fiche.',
};

/** Indicateurs de possession (pure, testée L111F-IND-*). */
export function computeOwnershipIndicators(input: {
  today: string;
  disposed: boolean;
  annual: TcoAnnual;
  cumulativeCostCents: number;
  estimatedComplementCents: number;
  averageWithEstimatesCents: number | null;
  financing: TcoFinancing;
  valuation: { cents: number; date: string; mode: string | null; source: string | null } | null;
  valuationAssessment: ValuationAssessment;
  netEstimatedCents: number | null;
  netFinalCents: number | null;
  realizedPriceCents: number | null;
  disposalFeesCents: number;
}): TcoIndicators {
  const estime = Math.max(0, input.estimatedComplementCents);
  const totalAffiche = input.cumulativeCostCents + estime;
  const a = input.annual.average;

  // ── Coût total ──
  const total: TcoIndicators['total'] = {
    cents: totalAffiche, documentedCents: input.cumulativeCostCents, estimatedShareCents: estime, financingToDateCents: input.financing.costToDateCents,
    info: [
      'Prix d’achat du bien, frais d’acquisition, dépenses de possession (entretien, réparations, travaux, assurances, taxes, usage…) et coût du crédit à date, sans double comptage, moins les avoirs et remboursements. Le capital emprunté n’est jamais ajouté au prix d’achat.',
      estime > 0 ? `Dont ${eurFr(estime)} estimés à partir de vos forfaits d’usage (périodes écoulées sans justificatif suffisant).` : '',
    ].filter(Boolean).join(' '),
  };

  // ── Coût annuel moyen de possession ──
  const moyenneDoc = a.status === 'COMPUTED' ? a.cents : null;
  const moyenneAffichee = moyenneDoc == null ? null : estime > 0 && input.averageWithEstimatesCents != null ? input.averageWithEstimatesCents : moyenneDoc;
  const duree = a.duration == null ? '' : a.duration.fullYears < 1 ? `${a.days} jour${(a.days ?? 0) > 1 ? 's' : ''}` : ansFr(a.years ?? 0);
  const annualAverage: TcoIndicators['annualAverage'] = {
    cents: moyenneAffichee, documentedCents: moyenneDoc,
    estimatedShareCents: moyenneDoc != null && moyenneAffichee != null ? Math.max(0, moyenneAffichee - moyenneDoc) : 0,
    unavailableReason: a.status === 'COMPUTED' ? null : MOTIF_MOYENNE[a.status],
    info: a.status === 'COMPUTED'
      ? [
        `(Coût total${estime > 0 ? ' estimations incluses' : ''} − prix d’achat du bien ${eurFr(a.acquisitionPriceCents ?? 0)}) ÷ ${duree} de possession${a.start ? ` depuis le ${dateFr(a.start)}` : ''}.`,
        'Le prix d’achat n’est pas annualisé ; frais d’acquisition, entretien, réparations, gros travaux, remplacements, assurances, taxes et coût du crédit sont inclus.',
        a.extrapolationLabel ? `${a.extrapolationLabel}.` : '',
      ].filter(Boolean).join(' ')
      : MOTIF_MOYENNE[a.status],
  };

  // ── Coût net estimé / final ──
  let net: TcoIndicators['net'];
  if (input.disposed) {
    net = {
      kind: 'FINAL', cents: input.netFinalCents == null ? null : input.netFinalCents + estime, documentedCents: input.netFinalCents, valuation: null,
      realizedPriceCents: input.realizedPriceCents, disposalFeesCents: input.disposalFeesCents,
      unavailableReason: input.netFinalCents == null ? 'Prix de vente réalisé non documenté : le résultat final n’est pas établi.' : null,
      info: input.netFinalCents == null
        ? 'Prix de vente réalisé non documenté : le résultat final n’est pas établi.'
        : `Coût total (frais de vente réellement établis compris, une seule fois) − prix de vente réalisé ${eurFr(input.realizedPriceCents ?? 0)}.`,
    };
  } else if (input.valuation && input.netEstimatedCents != null) {
    const v = input.valuation;
    const age = valuationAgeLabel(v.date, input.today);
    net = {
      kind: 'ESTIMATED', cents: input.netEstimatedCents + estime, documentedCents: input.netEstimatedCents,
      valuation: { ...v, ageLabel: age }, realizedPriceCents: null, disposalFeesCents: 0, unavailableReason: null,
      info: `Coût total − dernière valeur estimée ${eurFr(v.cents)} (estimation du ${dateFr(v.date)}, ${age}). Aucun frais de revente hypothétique n’est déduit.`,
    };
  } else {
    const rejets = new Set(input.valuationAssessment.items.map((x) => x.rejection).filter(Boolean));
    const motif = !input.valuationAssessment.items.length
      ? 'Aucune estimation de valeur postérieure à l’achat : ajoutez une estimation datée (Valorisation) pour obtenir le coût net estimé. Le prix d’achat n’est jamais une valeur actuelle.'
      : rejets.has('ACQUISITION_DATE_UNKNOWN')
        ? 'Date d’achat du bien inconnue : impossible de vérifier qu’une estimation est postérieure à l’achat, le coût net n’est pas calculé.'
        : rejets.has('NOT_AFTER_ACQUISITION')
          ? 'Aucune estimation postérieure à l’achat : une estimation antérieure ou égale à la date d’achat n’est pas une valeur actuelle.'
          : rejets.has('UNDATED')
            ? 'Estimation sans date de valorisation : conservée, mais non utilisée pour le coût net. Indiquez sa date.'
            : 'Aucune estimation admissible (datée, en euros, non future, postérieure à l’achat) : coût net non calculé.';
    net = { kind: 'ESTIMATED', cents: null, documentedCents: null, valuation: null, realizedPriceCents: null, disposalFeesCents: 0, unavailableReason: motif, info: motif };
  }
  return { total, annualAverage, net, financing: input.financing };
}
