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
 * Lot 61 (ticket P1 TCO) : les dépenses ALIMENTENT le TCO, les Opérations
 * en améliorent la consolidation. S'y ajoutent, sans double comptage :
 *   · les dépenses DOCUMENTAIRES qualifiées non représentées par une
 *     composante consolidée (`finance/economic-lines.ts`) ;
 *   · le PRIX D'ACHAT de la fiche tant qu'aucun achat consolidé ne le
 *     représente (jamais additionné à la facture d'achat correspondante).
 * Chaque ligne examinée (composante, document, fiche) est restituée dans
 * `lines` : identifiant stable, montant, catégorie, date, source, Opération
 * éventuelle, statut d'inclusion et motif — diagnostic BO et tiroir.
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
  checkLedger, componentEurMinor, daysInclusive, evaluateComponent, isIsoDate, summarizeLedger, UNKNOWN_CURRENCY,
  type ExclusionReason, type LedgerAnomaly, type LedgerComponent, type LedgerEntry, type ReadStatus,
} from '../finance/engine';
import {
  qualifyDocumentLines, type DocumentLineDraft, type EconomicDocumentInput, type EconomicLineProvenance,
  type EconomicLineReason, type EconomicLineSource, type EconomicLineStatus,
} from '../finance/economic-lines';

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
  /** Lot 61 : natures des sources actives (ASSET_DATA : achat consolidé depuis la fiche). */
  sourceKinds?: readonly string[];
}

/** Lot 61 : prix d'achat de la fiche (saisi ou extrait d'un justificatif). */
export interface TcoAssetPrice {
  amountMinor: number;
  currency: string;
  /** Origine canonique (USER, DOCUMENT_EXTRACTION…). */
  origin: string | null;
  /** Documents preuves actives du prix (même fait que leur facture d'achat). */
  evidenceFileIds: readonly number[];
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
  /** Lot 61 : documents du bien (qualification documentaire, sans Opération requise). */
  documents?: readonly EconomicDocumentInput[];
  /** Lot 61 : prix d'achat de la fiche. */
  assetPrice?: TcoAssetPrice | null;
}

// ── Sortie ─────────────────────────────────────────────────────────────────

export type TcoCategory = 'ACQUISITION' | 'ACCESSORIES' | 'MAINTENANCE' | 'CONTRACTS' | 'USAGE' | 'FINANCING' | 'CLAIMS' | 'DISPOSAL' | 'OTHER';

export const TCO_CATEGORY_LABELS: Readonly<Record<TcoCategory, string>> = {
  ACQUISITION: 'Acquisition', ACCESSORIES: 'Accessoires, équipements et améliorations', MAINTENANCE: 'Entretien, réparations et travaux',
  CONTRACTS: 'Contrats et assurances', USAGE: 'Charges, abonnements et frais d’usage',
  FINANCING: 'Financement (intérêts et frais)', CLAIMS: 'Sinistres', DISPOSAL: 'Frais de cession', OTHER: 'Autres coûts',
};

export type TcoWarning =
  | 'ACQUISITION_DATE_MISSING' | 'ACQUISITION_COST_MISSING' | 'UNCONVERTED_AMOUNTS' | 'UNALLOCATED_AMOUNTS'
  | 'NO_RELIABLE_VALUATION' | 'DISPOSAL_PRICE_MISSING' | 'DISPOSAL_DATE_MISSING' | 'PARTIAL_READ' | 'PRORATA_APPLIED'
  // Lot 61 : dépenses documentaires non qualifiées / sans montant, et dépenses dont le bien n'est pas confirmé.
  | 'DOCUMENTS_NOT_QUALIFIED' | 'UNCONFIRMED_ASSET_EXPENSES';

/** Lot 61 (§4.1, §6) : ligne économique examinée — modèle commun composante / document / fiche. */
export interface TcoEconomicLine {
  /** Identifiant stable (`c:<composante>`, `doc:<fichier>[:<candidat>:<n>]`, `asset:<bien>:acquisitionPrice`). */
  id: string;
  source: EconomicLineSource;
  provenance: EconomicLineProvenance;
  label: string;
  kind: FinancialComponentKind | null;
  amountMinor: number;
  currency: string;
  /** EUR de la ligne entière (null : non convertible). */
  eurCents: number | null;
  /** EUR effectivement retenu dans le coût cumulé (après prorata ; 0 si écartée). */
  includedCents: number;
  category: TcoCategory | null;
  date: string | null;
  fileId: number | null;
  operationId: number | null;
  operationLabel: string | null;
  status: EconomicLineStatus;
  reason: EconomicLineReason | null;
  note: string | null;
  relatedFileId: number | null;
}

export interface TcoResult {
  assetId: number;
  status: ReadStatus;
  disposed: boolean;
  period: { start: string | null; startSource: 'OPERATION' | 'ASSET_DATA' | null; end: string; endSource: 'TODAY' | 'OPERATION' | 'ASSET_DATA'; days: number | null };
  summary: {
    /** Coût cumulé documenté (C17), centimes EUR. */
    cumulativeCostCents: number;
    /** Lot 61 : coût d'acquisition retenu (poste « Acquisition »). */
    acquisitionCents: number;
    /** Lot 61 : dépenses complémentaires retenues (tous les autres postes, avant avoirs et remboursements). */
    additionalCostsCents: number;
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
    /** Lot 61 : justificatifs comptés directement (sans composante consolidée). */
    documentsCounted: number;
    documents: Array<{ fileId: number; title: string }>;
    excluded: Array<{ componentId: number; operationId: number; reason: ExclusionReason; kind: FinancialComponentKind; amountMinor: number; currency: string; label: string }>;
    unconverted: Array<{ currency: string; amountMinor: number; kind: FinancialComponentKind }>;
    unallocated: { count: number; eurCents: number };
    anomalies: LedgerAnomaly[];
    warnings: TcoWarning[];
  };
  /** Lot 61 : lignes économiques examinées (retenues et écartées, motif). */
  lines: TcoEconomicLine[];
  /**
   * Lot 68 (diagnostic BO seulement, jamais transmis à la fiche) : documents
   * qui CITENT seulement le bien (lien MENTIONED) — exclus des sources.
   */
  citedOnlyDocuments?: Array<{ fileId: number; title: string }>;
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

/** Catégorie d'une ligne documentaire (indice T1 d'abord, thème du document sinon) ; `PURCHASE` : achat à départager. */
function documentCategory(l: Pick<DocumentLineDraft, 'typeHint' | 'theme'>): TcoCategory | 'PURCHASE' {
  switch (l.typeHint) {
    case 'ACQUISITION': return 'PURCHASE';
    case 'INTERVENTION': return 'MAINTENANCE';
    case 'CONTRACT': return 'CONTRACTS';
    case 'FINANCING': return 'FINANCING';
    case 'CLAIM': return 'CLAIMS';
    case 'DISPOSAL': return 'DISPOSAL';
    default: break;
  }
  switch (l.theme) {
    case 'purchase': return 'PURCHASE';
    case 'maintenance': case 'repair': case 'works': case 'inspection': return 'MAINTENANCE';
    case 'insurance': return 'CONTRACTS';
    case 'subscription': case 'charges': return 'USAGE';
    default: return 'OTHER';
  }
}

/** Statut d'une ligne évaluée par le moteur (pure). */
function statusOfEntry(e: LedgerEntry, retained: EconomicLineStatus): EconomicLineStatus {
  if (e.included) return retained;
  switch (e.exclusion) {
    case 'FORECAST': return 'FORECAST';
    case 'UNCONVERTED_CURRENCY': return 'UNCONVERTED';
    case 'UNALLOCATED_MULTI_ASSET': return 'UNALLOCATED';
    case 'OUT_OF_SCOPE': return 'OUT_OF_SCOPE';
    default: return 'EXCLUDED';
  }
}

/** Calcul du TCO d'un bien (pure, testée — scénarios FIN-A à FIN-H, TCO-01 à TCO-17). */
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

  const entries: TcoResult['entries'] = [];
  const lines: TcoEconomicLine[] = [];
  const opEntries = new Map<number, Array<LedgerEntry & { category: TcoCategory | null }>>();
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
      const x = { ...e, category: e.effect === 'COST' ? category : null };
      entries.push(x);
      opEntries.set(op.id, [...(opEntries.get(op.id) ?? []), x]);
    }
  }

  // ── Achat du bien (lot 61, §3.1) : prix de la fiche ↔ achat consolidé ────
  const prix = input.assetPrice && input.assetPrice.amountMinor > 0 ? input.assetPrice : null;
  const prixEur = prix ? componentEurMinor({ amountMinor: prix.amountMinor, currency: prix.currency, amountEurCents: null }) : null;
  const preuves = new Set(prix?.evidenceFileIds ?? []);
  const coutOp = (id: number) => (opEntries.get(id) ?? []).filter((e) => e.included && e.effect === 'COST').reduce((n, e) => n + e.includedEurMinor, 0);
  const achatsCoutes = ops.filter((o) => o.typeCode === 'ACQUISITION' && o.status !== 'CANCELLED' && coutOp(o.id) > 0);
  // Achat consolidé DU BIEN : issu de la fiche, ou de la facture preuve du prix, ou de même montant que le prix.
  const achatsDuBien = new Set((prix
    ? achatsCoutes.filter((o) => (o.sourceKinds ?? []).includes('ASSET_DATA') || o.documents.some((d) => preuves.has(d.fileId)) || (prixEur != null && coutOp(o.id) === prixEur))
    : achatsCoutes).map((o) => o.id));
  if (prix) {
    // Un autre achat (accessoire, équipement) n'est pas l'acquisition du bien.
    for (const o of achatsCoutes) if (!achatsDuBien.has(o.id)) for (const e of opEntries.get(o.id) ?? []) if (e.category === 'ACQUISITION') e.category = 'ACCESSORIES';
  }
  const coutsAchatDuBien = new Set([...achatsDuBien].map(coutOp));

  // Acquisition : date réelle (achat du bien consolidé, sinon fiche) — jamais la date d'ajout.
  const achatsDates = ops.filter((o) => o.typeCode === 'ACQUISITION' && o.status === 'REALIZED' && (!prix || achatsDuBien.has(o.id) || !achatsDuBien.size));
  const dateAchatOp = earliest(achatsDates.map((o) => o.realizedDate ?? o.startDate));
  const start = dateAchatOp ?? (isIsoDate(input.assetAcquisitionDate) ? input.assetAcquisitionDate.slice(0, 10) : null);
  if (!start) warnings.add('ACQUISITION_DATE_MISSING');
  const end = dateCession ?? input.today;

  const assetLineId = `asset:${input.assetId}:acquisitionPrice`;
  let assetEntry: (LedgerEntry & { category: TcoCategory | null }) | null = null;
  if (prix) {
    const base = {
      id: assetLineId, source: 'ASSET_DATA' as const, provenance: (prix.origin && prix.origin !== 'USER' && prix.origin !== 'ADMIN' ? 'T1' : 'USER') as EconomicLineProvenance,
      label: 'Prix d’achat (fiche du bien)', kind: 'REALIZED_COST' as const, amountMinor: prix.amountMinor, currency: prix.currency, eurCents: prixEur,
      category: 'ACQUISITION' as const, date: start, fileId: [...preuves][0] ?? null, note: null, relatedFileId: null,
    };
    if (achatsDuBien.size) {
      const o = ops.find((x) => achatsDuBien.has(x.id))!;
      lines.push({ ...base, includedCents: 0, operationId: o.id, operationLabel: o.label, status: 'CONSOLIDATED_ELSEWHERE', reason: 'ASSET_PRICE_CONSOLIDATED' });
    } else {
      const e = evaluateComponent({
        id: 0, lineId: assetLineId, operationId: 0, kind: 'REALIZED_COST', amountMinor: prix.amountMinor, currency: prix.currency, amountEurCents: null,
        economicDate: start, targetAssetId: input.assetId,
      }, { scope, operationAssetIds: [input.assetId], disposalDate: dateCession, fallbackDate: start });
      assetEntry = { ...e, category: e.effect === 'COST' ? 'ACQUISITION' : null };
      entries.push(assetEntry);
      lines.push({ ...base, includedCents: e.includedEurMinor, operationId: null, operationLabel: null, status: statusOfEntry(e, 'RETAINED_DIRECT'), reason: e.exclusion });
    }
  }

  // ── Dépenses documentaires (lot 61, §3.3) ────────────────────────────────
  const drafts = qualifyDocumentLines(input.documents ?? [], { today: input.today });
  const docEntries: Array<{ draft: DocumentLineDraft; entry: LedgerEntry & { category: TcoCategory | null } }> = [];
  for (const d of drafts) {
    let category: TcoCategory | null = null;
    const cat = documentCategory(d);
    if (cat === 'PURCHASE') {
      const eur = componentEurMinor({ amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents });
      // Facture d'achat du bien : même fait que le prix de la fiche ou que l'achat consolidé (jamais additionnée).
      const memeFait = d.kind === 'REALIZED_COST' && (preuves.has(d.fileId) || (eur != null && ((prixEur != null && eur === prixEur) || coutsAchatDuBien.has(eur))));
      if (memeFait && d.status === null && (prix || achatsDuBien.size)) { d.status = 'DUPLICATE'; d.reason = 'SAME_AS_ASSET_PRICE'; }
      category = memeFait || (!prix && !achatsDuBien.size && preuves.has(d.fileId)) ? 'ACQUISITION' : 'ACCESSORIES';
    } else category = cat;
    const ligne: Omit<TcoEconomicLine, 'status' | 'reason' | 'includedCents' | 'eurCents'> = {
      id: d.lineId, source: 'DOCUMENT', provenance: d.provenance, label: d.title, kind: d.kind, amountMinor: d.amountMinor, currency: d.currency,
      category, date: d.date, fileId: d.fileId, operationId: d.operationId, operationLabel: d.operationLabel, note: d.note, relatedFileId: d.relatedFileId,
    };
    if (d.status !== null || !d.kind) {
      const eur = d.kind ? componentEurMinor({ amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents }) : null;
      lines.push({ ...ligne, eurCents: eur, includedCents: 0, status: d.status ?? 'EXCLUDED', reason: d.reason });
      continue;
    }
    const e = evaluateComponent({
      id: 0, lineId: d.lineId, operationId: 0, kind: d.kind, amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents,
      economicDate: d.date, periodStart: d.periodStart, periodEnd: d.periodEnd, targetAssetId: d.targetAssetId, targetEquipmentId: d.targetEquipmentId,
    }, {
      scope, operationAssetIds: d.assetIds, equipmentAssets: input.equipmentAssets, disposalDate: dateCession,
      isDisposalOperation: category === 'DISPOSAL', fallbackDate: d.date,
    });
    if (e.prorata) warnings.add('PRORATA_APPLIED');
    const x = { ...e, category: e.effect === 'COST' ? category : null };
    entries.push(x);
    docEntries.push({ draft: d, entry: x });
    lines.push({ ...ligne, eurCents: e.eurMinor, includedCents: e.includedEurMinor, status: statusOfEntry(e, 'RETAINED_DIRECT'), reason: e.exclusion });
  }
  if (drafts.some((d) => d.status === 'NOT_QUALIFIED')) warnings.add('DOCUMENTS_NOT_QUALIFIED');
  if (drafts.some((d) => d.status === 'UNCONFIRMED_ASSET')) warnings.add('UNCONFIRMED_ASSET_EXPENSES');

  const totals = summarizeLedger(entries);

  // Postes du détail (coûts réalisés retenus, par catégorie ; un élément = une Opération, un justificatif ou la fiche).
  const postes = new Map<TcoCategory, { costsCents: number; items: Set<string> }>();
  const itemOf = (e: LedgerEntry): string => e.operationId > 0 ? `op:${e.operationId}` : (e.lineId ?? '').split(':').slice(0, 2).join(':');
  for (const e of entries) {
    if (!e.included || e.effect !== 'COST' || !e.category) continue;
    const p = postes.get(e.category) ?? { costsCents: 0, items: new Set<string>() };
    p.costsCents += e.includedEurMinor;
    p.items.add(itemOf(e));
    postes.set(e.category, p);
  }
  const ordre: TcoCategory[] = ['ACQUISITION', 'ACCESSORIES', 'MAINTENANCE', 'CONTRACTS', 'USAGE', 'FINANCING', 'CLAIMS', 'DISPOSAL', 'OTHER'];
  const breakdown = ordre.filter((c) => postes.has(c)).map((c) => ({ category: c, label: TCO_CATEGORY_LABELS[c], costsCents: postes.get(c)!.costsCents, count: postes.get(c)!.items.size }));
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

  const counted = new Set(entries.filter((e) => e.included && e.operationId > 0).map((e) => e.operationId));
  const docs = new Map<number, string>();
  for (const op of ops) if (counted.has(op.id)) for (const d of op.documents) if (!docs.has(d.fileId)) docs.set(d.fileId, d.title);
  const docsComptes = new Set(docEntries.filter((x) => x.entry.included).map((x) => x.draft.fileId));
  for (const x of docEntries) if (x.entry.included && !docs.has(x.draft.fileId)) docs.set(x.draft.fileId, x.draft.title);
  const opLabel = new Map(ops.map((o) => [o.id, o.label]));
  const docIncomplet = warnings.has('DOCUMENTS_NOT_QUALIFIED') || warnings.has('UNCONFIRMED_ASSET_EXPENSES');
  const status: ReadStatus = !input.readComplete ? 'PARTIAL'
    : (!totals.complete || docIncomplet || warnings.has('ACQUISITION_DATE_MISSING') || warnings.has('DISPOSAL_PRICE_MISSING') || warnings.has('DISPOSAL_DATE_MISSING')) ? 'INCOMPLETE' : 'COMPLETE';

  // Lignes des composantes consolidées (en tête : l'ordre suit la hiérarchie des sources).
  const fichierPrincipal = (o: TcoOperation): number | null => (o.documents.find((d) => d.role === 'INVOICE') ?? o.documents[0])?.fileId ?? null;
  const opLines: TcoEconomicLine[] = [];
  for (const op of ops) {
    for (const e of opEntries.get(op.id) ?? []) {
      const c = op.components.find((x) => x.id === e.componentId);
      opLines.push({
        id: `c:${e.componentId}`, source: 'OPERATION', provenance: 'T3', label: c?.label ? `${op.label} — ${c.label}` : op.label, kind: e.kind,
        amountMinor: e.amountMinor, currency: e.currency, eurCents: e.eurMinor, includedCents: e.includedEurMinor, category: e.category, date: e.date,
        fileId: fichierPrincipal(op), operationId: op.id, operationLabel: op.label, status: statusOfEntry(e, 'RETAINED_CONSOLIDATED'), reason: e.exclusion,
        note: null, relatedFileId: null,
      });
    }
  }
  const acquisitionCents = postes.get('ACQUISITION')?.costsCents ?? 0;

  return {
    assetId: input.assetId,
    status,
    disposed,
    period: {
      start, startSource: dateAchatOp ? 'OPERATION' : start ? 'ASSET_DATA' : null,
      end, endSource: dateCession ? (dateCessionOp ? 'OPERATION' : 'ASSET_DATA') : 'TODAY',
      days: start ? daysInclusive(start, end) : null,
    },
    summary: {
      cumulativeCostCents: cumul, acquisitionCents, additionalCostsCents: totals.costsEurMinor - acquisitionCents,
      currentValue: disposed ? null : valeur, netEstimatedCents: netEstime, netFinalCents: netFinal,
    },
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
      documentsCounted: docsComptes.size,
      documents: [...docs.entries()].map(([fileId, title]) => ({ fileId, title })).slice(0, 200),
      excluded: entries.filter((e) => e.exclusion && e.exclusion !== 'OUT_OF_SCOPE' && e.operationId > 0).map((e) => ({
        componentId: e.componentId, operationId: e.operationId, reason: e.exclusion!, kind: e.kind, amountMinor: e.amountMinor, currency: e.currency,
        label: opLabel.get(e.operationId) ?? '',
      })),
      unconverted: totals.unconverted,
      unallocated: { count: totals.unallocated.count, eurCents: totals.unallocated.eurMinor },
      anomalies,
      warnings: [...warnings],
    },
    lines: [...opLines, ...lines],
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
