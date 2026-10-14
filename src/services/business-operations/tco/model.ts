/**
 * Coût total de possession (TCO) — règles PURES (lot 54D, ticket §3 ;
 * CDC Opérations V1 C17, C18, B17).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE TCO N'EST PAS UNE SECONDE SOURCE DE VÉRITÉ
 *
 * Il consomme les composantes CONSOLIDÉES par T3 (Opérations actives, liens
 * biens et équipements), `valuationHistory`, les dates d'acquisition et de
 * cession établies, et les forfaits d'usage (budgets, jamais des coûts
 * réels). Il ne lit aucun PDF, ne crée aucune Opération, ne persiste aucun
 * total : il est recalculé à chaque lecture (donc après toute consolidation,
 * correction, fusion, invalidation, remboursement, valorisation ou cession).
 * Toutes les règles économiques viennent du moteur partagé
 * (`finance/engine.ts`) — aucune règle propre ici.
 *
 *   Coût cumulé documenté = Σ coûts réalisés − Σ réductions − Σ remboursements
 *                           − Σ indemnités attribuables
 *   En possession         : coût net estimé = cumulé − valeur actuelle FIABLE
 *                           (sans valeur fiable : cumulé seul, aucune
 *                           dépréciation inventée)
 *   Après cession         : coût net final = cumulé − prix de cession RÉALISÉ
 *                           (PROCEED ; frais de cession déjà dans les coûts) ;
 *                           prix réalisé absent : simulation PROVISOIRE au prix
 *                           souhaité, clairement différenciée.
 *   Peut être négatif (aucun plancher).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../model';
import {
  checkLedger, daysInclusive, evaluateComponent, isIsoDate, summarizeLedger, UNKNOWN_CURRENCY,
  type ExclusionReason, type LedgerAnomaly, type LedgerComponent, type LedgerEntry, type ReadStatus,
} from '../finance/engine';

// ── Entrées ────────────────────────────────────────────────────────────────

export interface TcoOperation {
  id: number;
  typeCode: BusinessOperationTypeCode | null;
  status: string;
  parentOperationId: number | null;
  realizedDate: string | null;
  startDate: string | null;
  plannedDate: string | null;
  /** Biens de l'Opération (liens actifs, et bien parent des équipements liés). */
  assetIds: number[];
  label: string;
  components: LedgerComponent[];
  documents: Array<{ fileId: number; title: string; role: string | null }>;
}

export const USAGE_BUDGET_CATEGORIES = ['FUEL', 'CHARGING', 'TOLLS', 'OTHER'] as const;
export type UsageBudgetCategory = (typeof USAGE_BUDGET_CATEGORIES)[number];
export const USAGE_BUDGET_PERIODICITIES = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export type UsageBudgetPeriodicity = (typeof USAGE_BUDGET_PERIODICITIES)[number];

export const USAGE_BUDGET_CATEGORY_LABELS: Readonly<Record<UsageBudgetCategory, string>> = {
  FUEL: 'Carburant', CHARGING: 'Recharge électrique', TOLLS: 'Péages', OTHER: 'Autre dépense d’usage',
};
export const USAGE_BUDGET_PERIODICITY_LABELS: Readonly<Record<UsageBudgetPeriodicity, string>> = {
  MONTHLY: 'par mois', QUARTERLY: 'par trimestre', YEARLY: 'par an',
};

/** Forfait d'usage (budget estimé) — jamais un coût réalisé, jamais une Opération (§3.5). */
export interface UsageBudget {
  id: number;
  assetId: number;
  category: UsageBudgetCategory;
  label: string | null;
  amountMinor: number;
  currency: string;
  periodicity: UsageBudgetPeriodicity;
  validFrom: string | null;
  validTo: string | null;
}

export interface TcoInput {
  assetId: number;
  today: string;
  operations: readonly TcoOperation[];
  /** Bien parent de chaque équipement du bien (composantes ciblant un équipement). */
  equipmentAssets?: ReadonlyMap<number, number>;
  /** Date d'acquisition saisie sur la fiche (date réelle ; jamais la date d'ajout dans Verebona). */
  assetAcquisitionDate: string | null;
  /** Date de cession saisie sur la fiche (repli si la Cession n'est pas datée). */
  assetSaleDate: string | null;
  /** Statut de la fiche (VENDU, TRANSMIS…). */
  assetStatus: string | null;
  /** Historique de valorisation (`valuationHistory`, valeurs en euros). */
  valuationHistory: ReadonlyArray<{ value: number | null; date: string | null; mode?: string | null; source?: string | null; currency?: string | null }>;
  /** Prix souhaité (informations commerciales), centimes. */
  desiredSalePriceCents: number | null;
  budgets: readonly UsageBudget[];
  /** Lecture des Opérations complète (faux : garde-fou de volume atteint). */
  readComplete: boolean;
}

// ── Sortie ─────────────────────────────────────────────────────────────────

export type TcoCategory = 'ACQUISITION' | 'MAINTENANCE' | 'CONTRACTS' | 'FINANCING' | 'CLAIMS' | 'DISPOSAL' | 'OTHER';

export const TCO_CATEGORY_LABELS: Readonly<Record<TcoCategory, string>> = {
  ACQUISITION: 'Acquisition', MAINTENANCE: 'Entretien, réparations et travaux', CONTRACTS: 'Contrats et assurances',
  FINANCING: 'Financement (intérêts et frais)', CLAIMS: 'Sinistres', DISPOSAL: 'Frais de cession', OTHER: 'Autres coûts',
};

export type TcoWarning =
  | 'ACQUISITION_DATE_MISSING' | 'ACQUISITION_COST_MISSING' | 'UNCONVERTED_AMOUNTS' | 'UNALLOCATED_AMOUNTS'
  | 'NO_RELIABLE_VALUATION' | 'DISPOSAL_PRICE_MISSING' | 'DISPOSAL_DATE_MISSING' | 'PARTIAL_READ' | 'PRORATA_APPLIED';

export interface TcoResult {
  assetId: number;
  status: ReadStatus;
  disposed: boolean;
  period: { start: string | null; startSource: 'OPERATION' | 'ASSET_DATA' | null; end: string; endSource: 'TODAY' | 'OPERATION' | 'ASSET_DATA'; days: number | null };
  summary: {
    /** Coût cumulé documenté (C17), centimes EUR. */
    cumulativeCostCents: number;
    currentValue: { cents: number; date: string; mode: string | null; source: string | null } | null;
    /** En possession, avec valeur fiable. */
    netEstimatedCents: number | null;
    /** Après cession, avec prix réalisé. */
    netFinalCents: number | null;
  };
  breakdown: Array<{ category: TcoCategory; label: string; costsCents: number; count: number }>;
  reductionsCents: number;
  refundsCents: number;
  indemnitiesCents: number;
  disposal: {
    desiredPriceCents: number | null;
    estimatedValueCents: number | null;
    realizedPriceCents: number | null;
    feesCents: number;
    /** FINAL : prix réalisé ; PROVISIONAL : simulation au prix souhaité ; NONE. */
    resultKind: 'FINAL' | 'PROVISIONAL' | 'NONE';
    provisionalNetCents: number | null;
  };
  usage: {
    items: Array<UsageBudget & { annualEquivalentMinor: number; activeNow: boolean }>;
    /** Σ des équivalents annuels des forfaits EUR actifs (estimation, jamais un coût réel). */
    annualEstimateCents: number;
    /** Forfaits dans une autre devise : jamais additionnés en euros. */
    otherCurrencies: Array<{ currency: string; annualEquivalentMinor: number }>;
  };
  reliability: {
    operationsCounted: number;
    documents: Array<{ fileId: number; title: string }>;
    excluded: Array<{ componentId: number; operationId: number; reason: ExclusionReason; kind: FinancialComponentKind; amountMinor: number; currency: string; label: string }>;
    unconverted: Array<{ currency: string; amountMinor: number; kind: FinancialComponentKind }>;
    unallocated: { count: number; eurCents: number };
    anomalies: LedgerAnomaly[];
    warnings: TcoWarning[];
  };
  /** Trace complète (justification de chaque total, §4.4). */
  entries: Array<LedgerEntry & { category: TcoCategory | null }>;
}

// ── Règles ─────────────────────────────────────────────────────────────────

const latest = (dates: Array<string | null | undefined>): string | null => dates.filter(isIsoDate).map((d) => d.slice(0, 10)).sort().pop() ?? null;
const earliest = (dates: Array<string | null | undefined>): string | null => dates.filter(isIsoDate).map((d) => d.slice(0, 10)).sort()[0] ?? null;

/** Catégorie TCO d'une Opération (une intervention enfant d'un sinistre est un coût de sinistre). */
export function tcoCategoryOf(op: Pick<TcoOperation, 'typeCode' | 'parentOperationId'>, parentType: BusinessOperationTypeCode | null): TcoCategory {
  if (op.typeCode === 'CLAIM' || parentType === 'CLAIM') return 'CLAIMS';
  switch (op.typeCode) {
    case 'ACQUISITION': return 'ACQUISITION';
    case 'INTERVENTION': return 'MAINTENANCE';
    case 'CONTRACT': return 'CONTRACTS';
    case 'FINANCING': return 'FINANCING';
    case 'DISPOSAL': return 'DISPOSAL';
    default: return 'OTHER';
  }
}

/** Équivalent annuel d'un forfait (unités mineures, entier). */
export function annualEquivalent(b: Pick<UsageBudget, 'amountMinor' | 'periodicity'>): number {
  return b.periodicity === 'MONTHLY' ? b.amountMinor * 12 : b.periodicity === 'QUARTERLY' ? b.amountMinor * 4 : b.amountMinor;
}

const budgetActif = (b: Pick<UsageBudget, 'validFrom' | 'validTo'>, day: string) =>
  (!b.validFrom || b.validFrom.slice(0, 10) <= day) && (!b.validTo || b.validTo.slice(0, 10) >= day);

/**
 * Valeur actuelle FIABLE (C18) : la dernière valorisation DATÉE, en euros,
 * de montant positif, non postérieure à la date de calcul. Sans date, en autre
 * devise ou absente : `null` (aucune dépréciation inventée).
 */
export function reliableValuation(history: TcoInput['valuationHistory'], asOf: string): TcoResult['summary']['currentValue'] {
  const ok = history
    .filter((v) => typeof v.value === 'number' && Number.isFinite(v.value) && v.value >= 0 && isIsoDate(v.date) && v.date!.slice(0, 10) <= asOf
      && (!v.currency || String(v.currency).toUpperCase() === 'EUR'))
    .sort((a, b) => a.date!.localeCompare(b.date!));
  const v = ok[ok.length - 1];
  return v ? { cents: Math.round((v.value as number) * 100), date: v.date!.slice(0, 10), mode: v.mode ?? null, source: v.source ?? null } : null;
}

/** Calcul du TCO d'un bien (pure, testée — scénarios FIN-A à FIN-H). */
export function computeTco(input: TcoInput): TcoResult {
  const scope = new Set([input.assetId]);
  const ops = input.operations;
  const typeParId = new Map(ops.map((o) => [o.id, o.typeCode]));
  const warnings = new Set<TcoWarning>();

  // Cession effective : Opération DISPOSAL réalisée (date), sinon fiche.
  const cessions = ops.filter((o) => o.typeCode === 'DISPOSAL' && o.status === 'REALIZED');
  const disposedStatus = input.assetStatus === 'VENDU' || input.assetStatus === 'TRANSMIS';
  const disposed = cessions.length > 0 || disposedStatus;
  const dateCessionOp = latest(cessions.map((o) => o.realizedDate ?? o.startDate));
  const dateCession = dateCessionOp ?? (disposed ? (isIsoDate(input.assetSaleDate) ? input.assetSaleDate.slice(0, 10) : null) : null);
  if (disposed && !dateCession) warnings.add('DISPOSAL_DATE_MISSING');

  // Acquisition : date réelle (Opération ACQUISITION, sinon fiche) — jamais la date d'ajout.
  const achats = ops.filter((o) => o.typeCode === 'ACQUISITION' && o.status === 'REALIZED');
  const dateAchatOp = earliest(achats.map((o) => o.realizedDate ?? o.startDate));
  const start = dateAchatOp ?? (isIsoDate(input.assetAcquisitionDate) ? input.assetAcquisitionDate.slice(0, 10) : null);
  if (!start) warnings.add('ACQUISITION_DATE_MISSING');
  const end = dateCession ?? input.today;

  const entries: TcoResult['entries'] = [];
  for (const op of ops) {
    const category = tcoCategoryOf(op, op.parentOperationId != null ? (typeParId.get(op.parentOperationId) ?? null) : null);
    const hasRefund = op.components.some((c) => c.kind === 'REFUND');
    for (const c of op.components) {
      const e = evaluateComponent(c, {
        scope, operationAssetIds: op.assetIds, operationStatus: op.status, equipmentAssets: input.equipmentAssets,
        disposalDate: dateCession, isDisposalOperation: op.typeCode === 'DISPOSAL', hasRefund,
        fallbackDate: op.realizedDate ?? op.startDate ?? op.plannedDate,
      });
      if (e.prorata) warnings.add('PRORATA_APPLIED');
      entries.push({ ...e, category: e.effect === 'COST' ? category : null });
    }
  }
  const totals = summarizeLedger(entries);

  // Postes du détail (coûts réalisés retenus, par catégorie).
  const postes = new Map<TcoCategory, { costsCents: number; ops: Set<number> }>();
  for (const e of entries) {
    if (!e.included || e.effect !== 'COST' || !e.category) continue;
    const p = postes.get(e.category) ?? { costsCents: 0, ops: new Set<number>() };
    p.costsCents += e.includedEurMinor;
    p.ops.add(e.operationId);
    postes.set(e.category, p);
  }
  const ordre: TcoCategory[] = ['ACQUISITION', 'MAINTENANCE', 'CONTRACTS', 'FINANCING', 'CLAIMS', 'DISPOSAL', 'OTHER'];
  const breakdown = ordre.filter((c) => postes.has(c)).map((c) => ({ category: c, label: TCO_CATEGORY_LABELS[c], costsCents: postes.get(c)!.costsCents, count: postes.get(c)!.ops.size }));
  if (!postes.has('ACQUISITION')) warnings.add('ACQUISITION_COST_MISSING');

  const cumul = totals.netCostEurMinor;
  const anomalies = checkLedger(entries, {
    totalEurMinor: cumul,
    postsEurMinor: [...breakdown.map((b) => b.costsCents), -totals.reductionsEurMinor, -totals.refundsEurMinor, -totals.indemnitiesEurMinor],
  });

  // Cession : prix réalisé (PROCEED attribuable, EUR établi), frais déjà dans les coûts.
  const proceedsEntries = entries.filter((e) => e.effect === 'PROCEED');
  const prixRealise = proceedsEntries.some((e) => e.included) ? totals.proceedsEurMinor : null;
  if (disposed && prixRealise === null) warnings.add('DISPOSAL_PRICE_MISSING');
  const valeur = reliableValuation(input.valuationHistory, dateCession ?? input.today);
  if (!disposed && !valeur) warnings.add('NO_RELIABLE_VALUATION');
  const netEstime = !disposed && valeur ? cumul - valeur.cents : null;
  const netFinal = disposed && prixRealise !== null ? cumul - prixRealise : null;
  const provisoire = prixRealise === null && input.desiredSalePriceCents != null ? cumul - input.desiredSalePriceCents : null;

  if (totals.unconverted.length) warnings.add('UNCONVERTED_AMOUNTS');
  if (totals.unallocated.count) warnings.add('UNALLOCATED_AMOUNTS');
  if (!input.readComplete) warnings.add('PARTIAL_READ');

  // Forfaits d'usage : séparés du réel, jamais additionnés au coût cumulé.
  const jour = end;
  const items = input.budgets.map((b) => ({ ...b, annualEquivalentMinor: annualEquivalent(b), activeNow: budgetActif(b, jour) }));
  const annualEstimateCents = items.filter((b) => b.activeNow && b.currency === 'EUR').reduce((n, b) => n + b.annualEquivalentMinor, 0);
  const autres = new Map<string, number>();
  for (const b of items.filter((x) => x.activeNow && x.currency !== 'EUR')) autres.set(b.currency, (autres.get(b.currency) ?? 0) + b.annualEquivalentMinor);

  const counted = new Set(entries.filter((e) => e.included).map((e) => e.operationId));
  const docs = new Map<number, string>();
  for (const op of ops) if (counted.has(op.id)) for (const d of op.documents) if (!docs.has(d.fileId)) docs.set(d.fileId, d.title);
  const opLabel = new Map(ops.map((o) => [o.id, o.label]));
  const status: ReadStatus = !input.readComplete ? 'PARTIAL'
    : (!totals.complete || warnings.has('ACQUISITION_DATE_MISSING') || warnings.has('DISPOSAL_PRICE_MISSING') || warnings.has('DISPOSAL_DATE_MISSING')) ? 'INCOMPLETE' : 'COMPLETE';

  return {
    assetId: input.assetId,
    status,
    disposed,
    period: {
      start, startSource: dateAchatOp ? 'OPERATION' : start ? 'ASSET_DATA' : null,
      end, endSource: dateCession ? (dateCessionOp ? 'OPERATION' : 'ASSET_DATA') : 'TODAY',
      days: start ? daysInclusive(start, end) : null,
    },
    summary: { cumulativeCostCents: cumul, currentValue: disposed ? null : valeur, netEstimatedCents: netEstime, netFinalCents: netFinal },
    breakdown,
    reductionsCents: totals.reductionsEurMinor,
    refundsCents: totals.refundsEurMinor,
    indemnitiesCents: totals.indemnitiesEurMinor,
    disposal: {
      desiredPriceCents: input.desiredSalePriceCents,
      estimatedValueCents: valeur?.cents ?? null,
      realizedPriceCents: prixRealise,
      feesCents: postes.get('DISPOSAL')?.costsCents ?? 0,
      resultKind: netFinal !== null ? 'FINAL' : provisoire !== null ? 'PROVISIONAL' : 'NONE',
      provisionalNetCents: netFinal !== null ? null : provisoire,
    },
    usage: {
      items, annualEstimateCents,
      otherCurrencies: [...autres.entries()].map(([currency, annualEquivalentMinor]) => ({ currency, annualEquivalentMinor })),
    },
    reliability: {
      operationsCounted: counted.size,
      documents: [...docs.entries()].map(([fileId, title]) => ({ fileId, title })).slice(0, 200),
      excluded: entries.filter((e) => e.exclusion && e.exclusion !== 'OUT_OF_SCOPE').map((e) => ({
        componentId: e.componentId, operationId: e.operationId, reason: e.exclusion!, kind: e.kind, amountMinor: e.amountMinor, currency: e.currency,
        label: opLabel.get(e.operationId) ?? '',
      })),
      unconverted: totals.unconverted,
      unallocated: { count: totals.unallocated.count, eurCents: totals.unallocated.eurMinor },
      anomalies,
      warnings: [...warnings],
    },
    entries,
  };
}

/** Validation d'un forfait saisi (pure) : message d'erreur ou null. */
export function validateUsageBudget(b: { category?: unknown; amountMinor?: unknown; currency?: unknown; periodicity?: unknown; validFrom?: unknown; validTo?: unknown; label?: unknown }): string | null {
  if (!(USAGE_BUDGET_CATEGORIES as readonly unknown[]).includes(b.category)) return 'Objet du forfait invalide.';
  if (typeof b.amountMinor !== 'number' || !Number.isSafeInteger(b.amountMinor) || b.amountMinor < 0) return 'Montant invalide.';
  if (typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency) || b.currency === UNKNOWN_CURRENCY) return 'Devise invalide.';
  if (!(USAGE_BUDGET_PERIODICITIES as readonly unknown[]).includes(b.periodicity)) return 'Périodicité invalide.';
  for (const d of [b.validFrom, b.validTo]) if (d != null && d !== '' && !(typeof d === 'string' && isIsoDate(d))) return 'Date de validité invalide.';
  if (typeof b.validFrom === 'string' && typeof b.validTo === 'string' && b.validFrom && b.validTo && b.validTo < b.validFrom) return 'La fin de validité précède le début.';
  if (b.label != null && (typeof b.label !== 'string' || b.label.length > 120)) return 'Libellé trop long (120 caractères).';
  return null;
}
