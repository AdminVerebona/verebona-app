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
 *
 * Lot 75D — un fait économique n'est dédoublonné que sur IDENTITÉ établie,
 * jamais sur la seule égalité de montant (`sameFactAs`) :
 *   · preuve forte : preuve T1 active du prix (facture d'achat), donnée
 *     structurée consolidée (ASSET_DATA / EQUIPMENT_DATA), citation T3 ;
 *   · preuves concordantes : même montant ET même nature (achat) ET même
 *     cible ET dates concordantes ;
 *   · identité incertaine (même montant, dates inconnues) : la dépense reste
 *     comptée, l'ambiguïté est SIGNALÉE (`uncertain`, statut INCOMPLETE).
 * Le prix d'achat du bien et ceux de ses équipements restent séparés ; une
 * réparation d'équipement n'est jamais son acquisition. Sans prix dans la
 * fiche, l'achat du bien est identifié par la preuve T1, ou par l'unique
 * facture d'achat que T1 cible sur le bien ; une facture ambiguë n'est pas
 * classée arbitrairement. Coût d'acquisition attendu mais inconnu →
 * INCOMPLETE (sauf location, prêt, don : `acquisitionExpected`).
 * Chaque ligne examinée (composante, document, fiche) est restituée dans
 * `lines` : identifiant stable, montant, catégorie, date, source, Opération
 * éventuelle, statut d'inclusion et motif — diagnostic BO et tiroir.
 *
 * Lot 78B (ticket « identité économique » §3, `./fact-identity`) — une
 * Opération peut avoir été mal consolidée (rapprochement abusif) : le TCO ne
 * lui fait pas confiance en bloc.
 *   · §3A : chaque composante est rattachée à SES justificatifs (provenance
 *     persistée) ; l'achat du bien est identifié composante par composante ;
 *     le prix prouvé d'un AUTRE bien n'est jamais un coût de ce bien ; un
 *     montant absent de ses justificatifs est signalé ; un justificatif retiré
 *     n'attribue plus son montant (le justificatif est réévalué seul) ;
 *   · §3B : une même somme portée par plusieurs justificatifs d'une même
 *     Opération, sans preuve de transactions distinctes, est comptée une fois
 *     (doublon présumé, signalé) ; un bien immobilier n'est acquis qu'une fois ;
 *   · §3C : un achat d'objet distinct rattaché à un bien immobilier (ni le
 *     bien, ni un équipement, ni des frais d'acquisition, ni rattaché par
 *     l'utilisateur) n'est pas incorporé à son coût de possession.
 *   Les indicateurs annuels (76G) dérivent des mêmes lignes : cumul et années
 *   restent cohérents. Règle PO « même montant sans date » (75D A) inchangée.
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
import { computeTcoAnnual, type TcoAnnual } from './annual';
import {
  presumedDuplicateComponents, purchaseIsOwnershipCost, unjustifiedComponent, type ComponentProvenance, type PresumedDuplicate,
} from './fact-identity';
import { applyTcoUserDecisions, type TcoLineUserDecision, type TcoUserDecision } from './user-decisions';

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
  /** Lot 78B (§3C) : l'utilisateur a lui-même rattaché l'Opération à ce bien (lien d'autorité USER). */
  userLinked?: boolean;
  /** Lot 78B (§3C) : l'Opération est rattachée à un équipement de ce bien. */
  equipmentLinked?: boolean;
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
  /**
   * Lot 71A : prix d'achat des ÉQUIPEMENTS du bien (fiche de chaque
   * équipement) — dépenses du bien, JAMAIS son prix d'achat.
   */
  equipmentPrices?: readonly TcoEquipmentPrice[];
  /**
   * Lot 75D (H) : un achat du bien est attendu (faux : location, LLD / LOA,
   * prêt, occupation gratuite, don ou succession — aucune acquisition payée).
   * Absent : attendu.
   */
  acquisitionExpected?: boolean;
  /** Lot 78B (§3C) : catégorie du bien (IMMOBILIER, VEHICULE, OBJET…) — pertinence d'un achat pour son coût de possession. */
  assetCategory?: string | null;
  /**
   * Lot 78B (§3A, §3B) : provenance de chaque composante active (justificatifs
   * qui la portent, retirés, références de facture, montant retrouvé). Absente :
   * comportement antérieur (aucune présomption).
   */
  componentProvenance?: ReadonlyMap<number, ComponentProvenance>;
  /**
   * Lot 80A : décisions de l'utilisateur « Ajouter / Retirer du TCO » (par
   * compte et par bien, clé stable de la ligne — `./user-decisions`). Elles
   * priment sur les règles automatiques pour la ligne concernée.
   */
  userDecisions?: readonly TcoUserDecision[];
}

/** Lot 71A : prix d'achat de la fiche d'un équipement du bien. */
export interface TcoEquipmentPrice {
  equipmentId: number;
  name: string;
  amountMinor: number;
  currency: string;
  /** Date d'achat de l'équipement (jamais celle du bien), si connue. */
  date: string | null;
  origin: string | null;
  /** Documents preuves actives du prix de CET équipement (sa facture : même fait). */
  evidenceFileIds: readonly number[];
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
  | 'DOCUMENTS_NOT_QUALIFIED' | 'UNCONFIRMED_ASSET_EXPENSES'
  // Lot 75D : justificatifs sans montant, rapprochements incertains, facture d'achat non identifiable.
  | 'AMOUNTS_UNKNOWN' | 'UNCERTAIN_MATCHES' | 'ACQUISITION_AMBIGUOUS'
  // Lot 78B : même somme portée par plusieurs justificatifs comptée une fois ; montant non retrouvé sur ses
  // justificatifs ; achats d'objets distincts non incorporés au coût de possession.
  | 'PRESUMED_DUPLICATES' | 'UNJUSTIFIED_AMOUNTS' | 'NOT_OWNERSHIP_COSTS'
  // Lot 80A : décisions de l'utilisateur appliquées ; dépense ajoutée malgré un doublon présumé (confirmé).
  | 'USER_DECISIONS' | 'USER_INCLUDED_DUPLICATES';

/** Lot 75D (H) : état du coût d'acquisition (distingue absence de dépense et information manquante). */
export type TcoAcquisitionStatus = 'DOCUMENTED' | 'MISSING' | 'NOT_APPLICABLE';

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
  /** Lot 75D : rapprochement incertain avec un autre fait (ligne comptée, ambiguïté signalée). */
  uncertain?: boolean;
  /** Lot 75D (D) : montant inconnu (justificatif financier sans montant lisible) — jamais 0 €. */
  amountUnknown?: boolean;
  /** Lot 78B (§3A) : justificatifs (fichiers) qui portent CETTE composante — jamais ceux d'une autre transaction. */
  sourceFileIds?: number[];
  /** Lot 78B (§3B) : ligne comptée à la place de celle-ci (même somme, autre justificatif, sans preuve de transaction distincte). */
  duplicateOf?: string;
  /** Lot 80A : clé STABLE de la ligne (décision « Ajouter / Retirer du TCO »), voir `tcoLineKeys`. */
  decisionKey?: string;
  /** Lot 80A : décision de l'utilisateur portée par la ligne (et statut / motif automatiques qu'elle remplace). */
  userDecision?: TcoLineUserDecision;
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
    /** Lot 75D (H) : coût d'acquisition documenté, attendu mais inconnu, ou sans objet (location, prêt, don). */
    acquisitionStatus: TcoAcquisitionStatus;
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
  /**
   * Lot 76G : indicateurs annuels (TCO moyen annuel, dépenses par année
   * civile) DÉRIVÉS de `lines` — aucun second moteur (`./annual`).
   */
  annual: TcoAnnual;
  /** Lot 80A : décisions de l'utilisateur appliquées, doublons présumés ajoutés, décisions sans ligne (BO). */
  userDecisions: { applied: number; includedDuplicates: number; orphans: TcoUserDecision[] };
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

/**
 * Lot 78B (§3B) — plusieurs justificatifs que T1 qualifie d'achat DE CE BIEN
 * portent la même somme (même devise) sans références de facture distinctes :
 * une seule acquisition décrite plusieurs fois (acte, attestation, copie…).
 * Rend le justificatif retenu (le plus ancien), ou null (montants différents,
 * factures distinctes : l'ambiguïté reste signalée).
 */
function memeAchatDecritPlusieursFois(lignes: readonly DocumentLineDraft[]): { kept: number } | null {
  const montants = new Set(lignes.map((d) => `${d.currency}:${componentEurMinor({ amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents })}`));
  if (montants.size !== 1 || [...montants][0].endsWith(':null')) return null;
  const fichiers = [...new Set(lignes.map((d) => d.fileId))].sort((a, b) => a - b);
  const refs = new Map(fichiers.map((f) => [f, new Set(lignes.filter((d) => d.fileId === f).flatMap((d) => d.invoiceRefs))]));
  for (const f of fichiers) {
    for (const g of fichiers) {
      const [rf, rg] = [refs.get(f)!, refs.get(g)!];
      if (f < g && rf.size && rg.size && ![...rf].some((r) => rg.has(r))) return null;
    }
  }
  return { kept: fichiers[0] };
}

/** Lot 75D : même jour ? `null` si l'une des dates est inconnue (identité non démontrable par la date). */
function sameDay(a: string | null | undefined, b: string | null | undefined): boolean | null {
  if (!isIsoDate(a) || !isIsoDate(b)) return null;
  return a.slice(0, 10) === b.slice(0, 10);
}
const opDate = (o: Pick<TcoOperation, 'realizedDate' | 'startDate'>): string | null => {
  const d = o.realizedDate ?? o.startDate;
  return isIsoDate(d) ? d.slice(0, 10) : null;
};
const dateOfDraft = (d: Pick<DocumentLineDraft, 'date'>): string | null => (isIsoDate(d.date) ? d.date.slice(0, 10) : null);

/** Justificatif principal d'une Opération (facture, sinon premier document). */
const fichierPrincipalOp = (o: TcoOperation): number | null => (o.documents.find((d) => d.role === 'INVOICE') ?? o.documents[0])?.fileId ?? null;

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

  // ── Lot 78B (§3A, §3B) : provenance des composantes, doublons présumés dans une même Opération ──
  const prov = input.componentProvenance ?? new Map<number, ComponentProvenance>();
  const prix = input.assetPrice && input.assetPrice.amountMinor > 0 ? input.assetPrice : null;
  const prixEur = prix ? componentEurMinor({ amountMinor: prix.amountMinor, currency: prix.currency, amountEurCents: null }) : null;
  const preuves = new Set(prix?.evidenceFileIds ?? []);
  const prixDate = isIsoDate(input.assetAcquisitionDate) ? input.assetAcquisitionDate.slice(0, 10) : null;
  const justifieParPreuve = (componentId: number) => (prov.get(componentId)?.documentFileIds ?? []).some((f) => preuves.has(f));
  const force = (componentId: number): number => {
    const p = prov.get(componentId);
    if (!p) return 0;
    // Preuve du prix d'un AUTRE bien : désignée en premier, pour que ses copies la suivent hors de ce bien (§3A).
    return (p.otherAssetAcquisition && !justifieParPreuve(componentId) ? 8 : 0)
      + (justifieParPreuve(componentId) ? 4 : 0) + (p.otherSourceKinds.includes('ASSET_DATA') ? 4 : 0) + (p.explained === true ? 1 : 0);
  };
  const doublons = new Map<number, PresumedDuplicate>();
  for (const op of ops) for (const [id, d] of presumedDuplicateComponents(op, prov, force)) doublons.set(id, d);
  const nonJustifiees = new Map<number, 'AMOUNT_NOT_ON_SOURCES' | 'SOURCES_WITHDRAWN'>();
  const autresBiens = new Set<number>();

  for (const op of ops) {
    const category = tcoCategoryOf(op, op.parentOperationId != null ? (typeParId.get(op.parentOperationId) ?? null) : null);
    const hasRefund = op.components.some((c) => c.kind === 'REFUND');
    for (const c of op.components) {
      const e = evaluateComponent(c, {
        scope, operationAssetIds: op.assetIds, operationStatus: op.status, equipmentAssets: input.equipmentAssets,
        disposalDate: dateCession, isDisposalOperation: op.typeCode === 'DISPOSAL', hasRefund,
        fallbackDate: op.realizedDate ?? op.startDate ?? op.plannedDate,
      });
      // §3A : montant justifié par la preuve du prix d'achat d'un AUTRE bien (et non de celui-ci) — jamais un coût de
      // ce bien, quelle que soit l'Opération qui le porte (ex. prix d'une maison dans une commande de mobilier).
      const autreBien = e.included && !!prov.get(c.id)?.otherAssetAcquisition && !justifieParPreuve(c.id);
      // §3B : même somme, autre justificatif de la même dépense, sans preuve de transaction distincte — comptée une fois.
      const doublon = e.included && !autreBien && doublons.has(c.id);
      if (doublon) warnings.add('PRESUMED_DUPLICATES');
      if (autreBien) autresBiens.add(c.id);
      if (e.prorata && !doublon && !autreBien) warnings.add('PRORATA_APPLIED');
      const x = autreBien
        ? { ...e, included: false, includedEurMinor: 0, prorata: null, exclusion: 'OUT_OF_SCOPE' as const, category: null }
        : doublon
          ? { ...e, included: false, includedEurMinor: 0, prorata: null, category: null }
          : { ...e, category: e.effect === 'COST' ? category : null };
      if (!doublon && !autreBien && e.included) {
        const nj = unjustifiedComponent(prov.get(c.id));
        if (nj) { nonJustifiees.set(c.id, nj); warnings.add('UNJUSTIFIED_AMOUNTS'); }
        // §3A : justificatif retiré de la dépense — le montant qu'il justifiait n'est plus attribué par elle ; le
        // justificatif lui-même est réévalué par la règle documentaire (jamais compté deux fois, jamais perdu).
        if (nj === 'SOURCES_WITHDRAWN') { x.included = false; x.includedEurMinor = 0; x.category = null; x.prorata = null; }
      }
      entries.push(x);
      opEntries.set(op.id, [...(opEntries.get(op.id) ?? []), x]);
    }
  }

  // ── Achat du bien (lot 61, §3.1 ; lot 75D A, F ; lot 78B §3A) : prix de la fiche ↔ achat consolidé ──
  const coutOp = (id: number) => (opEntries.get(id) ?? []).filter((e) => e.included && e.effect === 'COST').reduce((n, e) => n + e.includedEurMinor, 0);
  // Lot 75D (F) : achat d'un ÉQUIPEMENT (toutes ses composantes de coût le ciblent) — jamais l'achat du bien.
  const achatEquipement = (o: TcoOperation) => {
    const c = o.components.filter((x) => x.kind === 'REALIZED_COST');
    return c.length > 0 && c.every((x) => x.targetEquipmentId != null);
  };
  const cibleEquipement = (o: TcoOperation, componentId: number) => o.components.find((x) => x.id === componentId)?.targetEquipmentId != null;
  const achatsCoutes = ops.filter((o) => o.typeCode === 'ACQUISITION' && o.status !== 'CANCELLED' && coutOp(o.id) > 0 && !achatEquipement(o));
  // Lot 75D (A) : achat consolidé DU BIEN sur identité établie — donnée structurée de la fiche (ASSET_DATA), facture
  // preuve du prix, ou preuves concordantes (même montant ET même date) ; même montant sans date : INCERTAIN, signalé.
  // Lot 78B (§3A) : l'identification se fait au niveau de la COMPOSANTE et de SES justificatifs — une Opération qui
  // mêle plusieurs achats (rapprochement abusif) ne fait jamais du prix d'un autre achat celui du bien, ni l'inverse.
  const achatsIncertains = new Set<number>();
  const compAchat = new Map<number, Set<number>>();
  for (const o of achatsCoutes) {
    const couts = (opEntries.get(o.id) ?? []).filter((e) => e.included && e.effect === 'COST' && !cibleEquipement(o, e.componentId));
    let ids: number[] = [];
    if (!prix || (o.sourceKinds ?? []).includes('ASSET_DATA')) ids = couts.map((e) => e.componentId);
    else if (o.documents.some((d) => preuves.has(d.fileId))) {
      // Seules les composantes portées par la preuve du prix (ou sans justificatif documentaire connu) sont l'achat du bien.
      ids = couts.filter((e) => { const p = prov.get(e.componentId); return !p || !p.documentFileIds.length || justifieParPreuve(e.componentId); }).map((e) => e.componentId);
    } else if (prixEur != null && !preuves.size) {
      if (coutOp(o.id) === prixEur) {
        const memeJour = sameDay(prixDate, opDate(o));
        if (memeJour === null) achatsIncertains.add(o.id);
        if (memeJour === true) ids = couts.map((e) => e.componentId);
      } else {
        for (const e of couts.filter((x) => x.eurMinor === prixEur)) {
          const memeJour = sameDay(prixDate, e.date ?? opDate(o));
          if (memeJour === null) achatsIncertains.add(o.id);
          if (memeJour === true) ids.push(e.componentId);
        }
      }
    }
    if (ids.length) compAchat.set(o.id, new Set(ids));
  }
  const achatsDuBien = new Set(compAchat.keys());
  // Sans prix dans la fiche, plusieurs achats consolidés distincts pourraient chacun être celui du bien : signalé.
  if (!prix && achatsDuBien.size > 1) warnings.add('ACQUISITION_AMBIGUOUS');
  for (const o of ops) {
    for (const e of opEntries.get(o.id) ?? []) {
      if (e.category !== 'ACQUISITION') continue;
      // Un autre achat (accessoire, équipement, objet distinct) n'est pas l'acquisition du bien.
      if (achatEquipement(o) || cibleEquipement(o, e.componentId)) e.category = 'ACCESSORIES';
      else if (compAchat.get(o.id)?.has(e.componentId)) continue;
      else if (prix || compAchat.has(o.id)) e.category = 'ACCESSORIES';
    }
  }
  const coutAchat = (o: TcoOperation) => (opEntries.get(o.id) ?? []).filter((e) => e.included && compAchat.get(o.id)?.has(e.componentId)).reduce((n, e) => n + e.includedEurMinor, 0);
  /** Montant (EUR) et date des achats du bien établis : fiche, achats consolidés. */
  const achatsEtablis: Array<{ eur: number; date: string | null }> = [
    ...(prix && prixEur != null ? [{ eur: prixEur, date: prixDate }] : []),
    ...ops.filter((o) => achatsDuBien.has(o.id)).map((o) => ({ eur: coutAchat(o), date: opDate(o) })),
  ];

  // ── Lot 78B (§3C) : pertinence d'un achat pour le coût de possession du bien ──
  // L'acquisition du bien établie (ou sans objet), un achat distinct qui n'est ni un équipement, ni des frais
  // d'acquisition, ni rattaché au bien par l'utilisateur, n'est pas incorporé automatiquement (bien immobilier).
  const acquisitionEtablie = !!prix || achatsDuBien.size > 0 || input.acquisitionExpected === false;
  const horsPossession = new Set<number>();
  if (acquisitionEtablie) {
    for (const o of ops) {
      if (o.typeCode !== 'ACQUISITION') continue;
      for (const e of opEntries.get(o.id) ?? []) {
        if (!e.included || e.effect !== 'COST' || e.category !== 'ACCESSORIES') continue;
        const pertinent = purchaseIsOwnershipCost({
          assetCategory: input.assetCategory ?? null, userLinked: o.userLinked,
          concernsEquipment: achatEquipement(o) || cibleEquipement(o, e.componentId) || !!o.equipmentLinked,
        });
        if (pertinent) continue;
        e.included = false; e.includedEurMinor = 0; e.category = null; e.prorata = null;
        horsPossession.add(e.componentId);
        warnings.add('NOT_OWNERSHIP_COSTS');
      }
    }
  }

  // Acquisition : date réelle (achat du bien consolidé, sinon fiche) — jamais la date d'ajout.
  const achatsDates = ops.filter((o) => o.typeCode === 'ACQUISITION' && o.status === 'REALIZED' && !achatEquipement(o) && (!prix || achatsDuBien.has(o.id) || !achatsDuBien.size));
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
  const docsParId = new Map((input.documents ?? []).map((d) => [d.fileId, d]));
  const preuvesEquipements = new Set((input.equipmentPrices ?? []).flatMap((e) => e.evidenceFileIds));
  /** Lot 75D (F) : justificatif d'un ÉQUIPEMENT (cible, preuve de son prix, rattachement) — jamais l'achat du bien. */
  const docEquipement = (d: DocumentLineDraft): boolean => d.targetEquipmentId != null || preuvesEquipements.has(d.fileId)
    || (docsParId.get(d.fileId)?.linkedEquipmentIds ?? []).length > 0
    || (docsParId.get(d.fileId)?.candidates ?? []).some((c) => c.id === d.candidateId && c.targets.some((t) => t.type === 'EQUIPMENT'));
  // Lot 75D (G) : sans prix dans la fiche ni achat consolidé, la facture d'achat DU BIEN est identifiée par la preuve
  // T1 du prix, sinon par l'unique facture d'achat que T1 cible sur le bien ; plusieurs candidates : ambiguïté signalée.
  const factureAchat = new Set<number>();
  if (!prix && !achatsDuBien.size) {
    const achats = drafts.filter((d) => d.kind === 'REALIZED_COST' && documentCategory(d) === 'PURCHASE'
      && (d.status === null || d.status === 'INCLUDED_IN_TOTAL'));
    const fortes = new Set(achats.filter((d) => docsParId.get(d.fileId)?.acquisitionEvidence).map((d) => d.fileId));
    const t1 = achats.filter((d) => d.status === null && !docEquipement(d) && d.candidateId != null && d.typeHint === 'ACQUISITION' && d.targetAssetId === input.assetId);
    const fichiers = new Set(t1.map((d) => d.fileId));
    if (fortes.size) for (const f of fortes) factureAchat.add(f);
    else if (fichiers.size === 1 || (fichiers.size > 1 && t1.every((d) => d.scope === 'DEPOSIT' || d.scope === 'BALANCE'))) for (const f of fichiers) factureAchat.add(f);
    else if (fichiers.size > 1) {
      // Lot 78B (§3B) : un bien IMMOBILIER s'acquiert une fois par cycle de possession — plusieurs justificatifs de
      // SON achat (même montant, mêmes nature et cible, aucune référence de facture distincte : acte, attestation,
      // copie) décrivent une seule acquisition, comptée une fois, les autres signalés. Bien mobile : deux factures
      // de même montant peuvent être deux achats (règle PO TCO-21 inchangée) — l'ambiguïté reste signalée.
      const unique = input.assetCategory === 'IMMOBILIER' ? memeAchatDecritPlusieursFois(t1) : null;
      if (unique) {
        factureAchat.add(unique.kept);
        for (const d of t1) {
          if (d.fileId === unique.kept) continue;
          d.status = 'DUPLICATE'; d.reason = 'SAME_FACT_OTHER_DOCUMENT'; d.relatedFileId = unique.kept;
          d.note = 'Même achat du bien (même montant, même nature) qu’un autre justificatif, sans référence de facture distincte : compté une seule fois, à vérifier.';
        }
        warnings.add('PRESUMED_DUPLICATES');
      } else warnings.add('ACQUISITION_AMBIGUOUS');
    }
  }
  const docEntries: Array<{ draft: DocumentLineDraft; entry: LedgerEntry & { category: TcoCategory | null } }> = [];
  for (const d of drafts) {
    let category: TcoCategory | null = null;
    const cat = documentCategory(d);
    if (cat === 'PURCHASE') {
      const eur = componentEurMinor({ amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents });
      category = 'ACCESSORIES';
      if (prix || achatsDuBien.size) {
        // Facture d'achat du bien : même fait que le prix de la fiche ou que l'achat consolidé (jamais additionnée).
        // Lot 75D (A) : identité établie seulement — preuve T1 du prix, ou montant + date concordants ; jamais le montant seul.
        let memeFait = d.kind === 'REALIZED_COST' && preuves.has(d.fileId);
        if (!memeFait && d.kind === 'REALIZED_COST' && d.status === null && eur != null && !preuves.size && !docEquipement(d)) {
          const verdicts = achatsEtablis.filter((x) => x.eur === eur).map((x) => sameDay(dateOfDraft(d), x.date));
          if (verdicts.includes(true)) memeFait = true;
          else if (verdicts.includes(null)) {
            d.uncertain = { relatedFileId: null, note: 'Même montant que l’achat du bien, sans preuve qu’il s’agisse de la même dépense : comptée, à vérifier (renseignez la date d’achat de la fiche ou retirez le doublon).' };
          }
        }
        if (memeFait && d.status === null) { d.status = 'DUPLICATE'; d.reason = 'SAME_AS_ASSET_PRICE'; }
        if (memeFait) category = 'ACQUISITION';
      } else if (factureAchat.has(d.fileId)) category = 'ACQUISITION';
      // Lot 78B (§3C) : achat distinct (ni le bien, ni un équipement, ni des frais d'acquisition) — pertinence.
      if (category === 'ACCESSORIES' && d.status === null && (prix || achatsDuBien.size > 0 || factureAchat.size > 0 || input.acquisitionExpected === false)
        && !purchaseIsOwnershipCost({ assetCategory: input.assetCategory ?? null, concernsEquipment: docEquipement(d), acquisitionFee: d.scope === 'FEE' })) {
        const memeMontant = eur != null && achatsEtablis.some((x) => x.eur === eur);
        d.status = 'EXCLUDED'; d.reason = 'NOT_OWNERSHIP_COST'; d.uncertain = null;
        d.note = memeMontant
          ? 'Même montant que l’achat du bien : probablement un autre justificatif de cet achat, déjà compté. Non ajouté au coût de possession.'
          : 'Achat d’un objet distinct, rattaché au bien sans en faire partie : non incorporé au coût de possession (rattachez-le comme équipement pour l’inclure).';
        warnings.add('NOT_OWNERSHIP_COSTS');
      }
    } else category = cat;
    const ligne: Omit<TcoEconomicLine, 'status' | 'reason' | 'includedCents' | 'eurCents'> = {
      id: d.lineId, source: 'DOCUMENT', provenance: d.provenance, label: d.title, kind: d.kind, amountMinor: d.amountMinor, currency: d.currency,
      category, date: d.date, fileId: d.fileId, operationId: d.operationId, operationLabel: d.operationLabel,
      note: d.note, relatedFileId: d.relatedFileId,
    };
    if (d.status !== null || !d.kind) {
      // Lot 75D (D) : montant inconnu — jamais présenté comme 0 €.
      const inconnu = d.reason === 'AMOUNT_UNKNOWN';
      const eur = d.kind && !inconnu ? componentEurMinor({ amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents }) : null;
      lines.push({ ...ligne, eurCents: eur, includedCents: 0, status: d.status ?? 'EXCLUDED', reason: d.reason, ...(inconnu ? { amountUnknown: true } : {}) });
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
    if (e.included && d.uncertain) warnings.add('UNCERTAIN_MATCHES');
    const x = { ...e, category: e.effect === 'COST' ? category : null };
    entries.push(x);
    docEntries.push({ draft: d, entry: x });
    const incertaine = e.included && d.uncertain
      ? { uncertain: true, note: d.uncertain.note, relatedFileId: d.relatedFileId ?? d.uncertain.relatedFileId } : {};
    lines.push({ ...ligne, eurCents: e.eurMinor, includedCents: e.includedEurMinor, status: statusOfEntry(e, 'RETAINED_DIRECT'), reason: e.exclusion, ...incertaine });
  }
  // ── Prix d'achat des équipements (lot 71A ; lot 75D F) : dépense du bien, sans doublon ─
  // Jamais additionné à SA facture d'achat ni à l'achat consolidé de l'équipement — identité établie seulement
  // (preuve T1 du prix, donnée structurée, ou rattachement à l'équipement + nature « achat » + même montant + dates
  // concordantes) et dépense couvrante effectivement RETENUE ; une réparation ou un entretien de même montant n'est
  // jamais l'acquisition ; jamais confondu avec l'achat du bien.
  for (const ep of input.equipmentPrices ?? []) {
    if (!(ep.amountMinor > 0)) continue;
    const eur = componentEurMinor({ amountMinor: ep.amountMinor, currency: ep.currency, amountEurCents: null });
    const lineId = `equipment:${ep.equipmentId}:acquisitionPrice`;
    const epDate = isIsoDate(ep.date) ? ep.date.slice(0, 10) : null;
    const base = {
      id: lineId, source: 'EQUIPMENT_DATA' as const,
      provenance: (ep.origin && ep.origin !== 'USER' && ep.origin !== 'ADMIN' ? 'T1' : 'USER') as EconomicLineProvenance,
      label: `Prix d’achat — ${ep.name} (fiche de l’équipement)`, kind: 'REALIZED_COST' as const, amountMinor: ep.amountMinor, currency: ep.currency,
      eurCents: eur, category: 'ACCESSORIES' as const, date: epDate, note: null, relatedFileId: null,
    };
    const preuvesEq = new Set(ep.evidenceFileIds);
    const lieA = (fileId: number) => (docsParId.get(fileId)?.linkedEquipmentIds ?? []).includes(ep.equipmentId)
      || (docsParId.get(fileId)?.candidates ?? []).some((c) => c.targets.some((t) => t.type === 'EQUIPMENT' && t.entityId === ep.equipmentId));
    const facture = docEntries.find((x) => x.entry.included && x.draft.kind === 'REALIZED_COST' && preuvesEq.has(x.draft.fileId))
      ?? (preuvesEq.size || eur == null ? undefined : docEntries.find((x) => x.entry.included && x.draft.kind === 'REALIZED_COST' && lieA(x.draft.fileId)
        && documentCategory(x.draft) === 'PURCHASE' && x.entry.eurMinor === eur && sameDay(dateOfDraft(x.draft), epDate) !== false));
    if (facture) {
      lines.push({ ...base, includedCents: 0, fileId: facture.draft.fileId, operationId: null, operationLabel: null, status: 'DUPLICATE', reason: 'SAME_AS_EQUIPMENT_DOCUMENT' });
      continue;
    }
    const retenue = (o: TcoOperation) => (opEntries.get(o.id) ?? []).some((e) => e.included && e.effect === 'COST');
    const cibleEq = (o: TcoOperation, componentId: number) => o.components.find((c) => c.id === componentId)?.targetEquipmentId === ep.equipmentId;
    const opCouvrante = ops.find((o) => o.status !== 'CANCELLED' && retenue(o) && (
      drafts.some((dr) => preuvesEq.has(dr.fileId) && dr.status === 'CONSOLIDATED_ELSEWHERE' && dr.operationId === o.id)
      || ((o.sourceKinds ?? []).includes('EQUIPMENT_DATA') && o.components.some((c) => c.targetEquipmentId === ep.equipmentId))
      || (!preuvesEq.size && eur != null && o.typeCode === 'ACQUISITION' && sameDay(opDate(o), epDate) !== false
        && (opEntries.get(o.id) ?? []).some((e) => e.included && e.kind === 'REALIZED_COST' && e.eurMinor === eur && cibleEq(o, e.componentId)))));
    if (opCouvrante) {
      lines.push({ ...base, includedCents: 0, fileId: fichierPrincipalOp(opCouvrante), operationId: opCouvrante.id, operationLabel: opCouvrante.label, status: 'CONSOLIDATED_ELSEWHERE', reason: 'EQUIPMENT_PRICE_CONSOLIDATED' });
      continue;
    }
    const e = evaluateComponent({
      id: 0, lineId, operationId: 0, kind: 'REALIZED_COST', amountMinor: ep.amountMinor, currency: ep.currency, amountEurCents: null,
      economicDate: base.date ?? start, targetAssetId: input.assetId,
    }, { scope, operationAssetIds: [input.assetId], disposalDate: dateCession, fallbackDate: base.date ?? start });
    const x = { ...e, category: e.effect === 'COST' ? ('ACCESSORIES' as const) : null };
    entries.push(x);
    lines.push({ ...base, includedCents: e.includedEurMinor, fileId: null, operationId: null, operationLabel: null, status: statusOfEntry(e, 'RETAINED_DIRECT'), reason: e.exclusion });
  }

  // Lignes des composantes consolidées (en tête : l'ordre suit la hiérarchie des sources).
  const fichierPrincipal = (o: TcoOperation): number | null => (o.documents.find((d) => d.role === 'INVOICE') ?? o.documents[0])?.fileId ?? null;
  // Lot 78B (§3A) : une composante désigne SES justificatifs (preuve du prix d'abord, puis facture de l'Opération), jamais
  // le justificatif principal d'une autre transaction de la même Opération ; provenance inconnue : comportement antérieur.
  const fichierComposante = (o: TcoOperation, componentId: number): number | null => {
    const f = prov.get(componentId)?.documentFileIds ?? [];
    if (!f.length) return fichierPrincipal(o);
    return f.find((x) => preuves.has(x)) ?? f.find((x) => o.documents.some((d) => d.fileId === x && d.role === 'INVOICE')) ?? [...f].sort((a, b) => a - b)[0];
  };
  const titreDe = (o: TcoOperation, fileId: number | null) => (fileId != null ? o.documents.find((d) => d.fileId === fileId)?.title ?? null : null);
  const opLines: TcoEconomicLine[] = [];
  for (const op of ops) {
    for (const e of opEntries.get(op.id) ?? []) {
      const c = op.components.find((x) => x.id === e.componentId);
      const p = prov.get(e.componentId);
      const fileId = fichierComposante(op, e.componentId);
      const base: TcoEconomicLine = {
        id: `c:${e.componentId}`, source: 'OPERATION', provenance: 'T3', label: c?.label ? `${op.label} — ${c.label}` : op.label, kind: e.kind,
        amountMinor: e.amountMinor, currency: e.currency, eurCents: e.eurMinor, includedCents: e.includedEurMinor, category: e.category, date: e.date,
        fileId, operationId: op.id, operationLabel: op.label, status: statusOfEntry(e, 'RETAINED_CONSOLIDATED'), reason: e.exclusion,
        note: achatsIncertains.has(op.id) && e.category === 'ACCESSORIES' && e.included
          ? 'Même montant que le prix d’achat de la fiche, sans preuve qu’il s’agisse de la même dépense : comptée, à vérifier.' : null,
        relatedFileId: null,
        ...(achatsIncertains.has(op.id) && e.included ? { uncertain: true } : {}),
        ...(p ? { sourceFileIds: [...p.documentFileIds] } : {}),
      };
      if (autresBiens.has(e.componentId)) {
        opLines.push({
          ...base, category: null, status: 'OUT_OF_SCOPE', reason: 'COUNTED_FOR_OTHER_ASSET',
          note: 'Montant justifié par la preuve du prix d’achat d’un autre bien : jamais un coût de ce bien.',
        });
        continue;
      }
      const d = doublons.get(e.componentId);
      if (d && !e.included && !e.exclusion) {
        const gardee = fichierComposante(op, d.keptComponentId);
        opLines.push({
          ...base, category: null, status: 'DUPLICATE', reason: 'SAME_FACT_OTHER_DOCUMENT', duplicateOf: `c:${d.keptComponentId}`, relatedFileId: gardee,
          note: `Même somme et même nature que ${titreDe(op, gardee) ? `« ${titreDe(op, gardee)} »` : 'un autre justificatif'} dans la même dépense, sans preuve d’une transaction distincte (facture, échéance ou période différente) : comptée une seule fois, à vérifier.`,
        });
        continue;
      }
      if (horsPossession.has(e.componentId)) {
        opLines.push({
          ...base, status: 'EXCLUDED', reason: 'NOT_OWNERSHIP_COST',
          note: 'Achat d’un objet distinct, rattaché au bien sans en faire partie : non incorporé au coût de possession (rattachez-le comme équipement, ou rattachez vous-même la dépense au bien, pour l’inclure).',
        });
        continue;
      }
      const nj = nonJustifiees.get(e.componentId);
      if (nj === 'SOURCES_WITHDRAWN') {
        opLines.push({
          ...base, category: null, status: 'EXCLUDED', reason: 'SOURCE_WITHDRAWN', relatedFileId: prov.get(e.componentId)?.withdrawnFileIds[0] ?? null,
          note: 'Le justificatif de ce montant a été retiré de la dépense : il n’est plus compté par elle (le justificatif est réévalué seul).',
        });
        continue;
      }
      if (nj && e.included) {
        opLines.push({
          ...base, uncertain: true,
          note: 'Montant introuvable sur les justificatifs de cette dépense : compté, à vérifier (il ne doit jamais provenir d’une autre transaction).',
        });
        continue;
      }
      opLines.push(base);
    }
  }
  // ── Lot 80A : décisions de l'utilisateur (Ajouter / Retirer du TCO) — AVANT les totaux, priment sur les règles ──
  const toutesLignes = [...opLines, ...lines];
  const decisionsUtilisateur = applyTcoUserDecisions({
    lines: toutesLignes, entries, decisions: input.userDecisions ?? [], warnings,
    operationCategory: new Map(ops.map((o) => [o.id, tcoCategoryOf(o, o.parentOperationId != null ? (typeParId.get(o.parentOperationId) ?? null) : null)])),
  });

  // Lot 80A : une ligne que l'utilisateur a lui-même ajoutée au TCO ne rend plus le total incomplet pour son motif d'origine.
  const ajouteeParUtilisateur = new Set(toutesLignes.filter((l) => l.userDecision?.applied && l.userDecision.decision === 'INCLUDE').map((l) => l.id));
  if (drafts.some((d) => d.status === 'NOT_QUALIFIED' && d.reason !== 'AMOUNT_UNKNOWN' && !ajouteeParUtilisateur.has(d.lineId))) warnings.add('DOCUMENTS_NOT_QUALIFIED');
  if (drafts.some((d) => d.reason === 'AMOUNT_UNKNOWN')) warnings.add('AMOUNTS_UNKNOWN');
  if (achatsIncertains.size) warnings.add('UNCERTAIN_MATCHES');
  if (drafts.some((d) => d.status === 'UNCONFIRMED_ASSET' && !ajouteeParUtilisateur.has(d.lineId))) warnings.add('UNCONFIRMED_ASSET_EXPENSES');

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
  // Lot 75D (H) : coût d'acquisition attendu mais inconnu → incomplet ; sans objet (location, prêt, don) → aucune alerte.
  const acquisitionStatus: TcoAcquisitionStatus = postes.has('ACQUISITION') ? 'DOCUMENTED' : input.acquisitionExpected === false ? 'NOT_APPLICABLE' : 'MISSING';
  if (acquisitionStatus === 'MISSING') warnings.add('ACQUISITION_COST_MISSING');

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
  // Lot 80A : justificatifs ajoutés par l'utilisateur (ligne documentaire sans entrée évaluée).
  for (const l of toutesLignes) {
    if (l.source !== 'DOCUMENT' || l.fileId == null || !l.userDecision?.applied || l.includedCents <= 0) continue;
    docsComptes.add(l.fileId);
    if (!docs.has(l.fileId)) docs.set(l.fileId, l.label);
  }
  const opLabel = new Map(ops.map((o) => [o.id, o.label]));
  // Lot 75D (H) : toute information financière manquante ou incertaine rend le total non exhaustif.
  // Lot 78B : doublon présumé (peut-être deux paiements) et montant non justifié par ses sources : à vérifier.
  const docIncomplet = (['DOCUMENTS_NOT_QUALIFIED', 'UNCONFIRMED_ASSET_EXPENSES', 'AMOUNTS_UNKNOWN', 'UNCERTAIN_MATCHES', 'ACQUISITION_AMBIGUOUS', 'ACQUISITION_COST_MISSING',
    'PRESUMED_DUPLICATES', 'UNJUSTIFIED_AMOUNTS'] as const)
    .some((w) => warnings.has(w));
  const status: ReadStatus = !input.readComplete ? 'PARTIAL'
    : (!totals.complete || docIncomplet || warnings.has('ACQUISITION_DATE_MISSING') || warnings.has('DISPOSAL_PRICE_MISSING') || warnings.has('DISPOSAL_DATE_MISSING')) ? 'INCOMPLETE' : 'COMPLETE';

  const acquisitionCents = postes.get('ACQUISITION')?.costsCents ?? 0;
  const period: TcoResult['period'] = {
    start, startSource: dateAchatOp ? 'OPERATION' : start ? 'ASSET_DATA' : null,
    end, endSource: dateCession ? (dateCessionOp ? 'OPERATION' : 'ASSET_DATA') : 'TODAY',
    days: start ? daysInclusive(start, end) : null,
  };

  return {
    assetId: input.assetId,
    status,
    disposed,
    period,
    summary: {
      cumulativeCostCents: cumul, acquisitionCents, additionalCostsCents: totals.costsEurMinor - acquisitionCents, acquisitionStatus,
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
    lines: toutesLignes,
    entries,
    // Lot 76G : indicateurs annuels dérivés des MÊMES lignes (montants retenus, dédoublonnés) — aucun second moteur.
    annual: computeTcoAnnual({ lines: toutesLignes, period, cumulativeCostCents: cumul, status, today: input.today, disposed }),
    userDecisions: decisionsUtilisateur,
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
