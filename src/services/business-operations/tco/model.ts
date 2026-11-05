/**
 * Coût total de possession (TCO) — règles PURES (lot 54D, ticket §3 ;
 * CDC Opérations V1 C17, C18, B17).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE TCO N'EST PAS UNE SECONDE SOURCE DE VÉRITÉ
 *
 * Il consomme les composantes CONSOLIDÉES par T3 (Opérations actives, liens
 * biens et équipements), `valuationHistory`, les dates d'acquisition et de
 * cession établies, et les forfaits d'usage (estimations : lot 108C, ils
 * complètent les dépenses réelles de leur catégorie pour les périodes échues,
 * `./usage-complement`, sans entrer dans le coût documenté). Il ne lit aucun PDF, ne crée aucune Opération, ne persiste aucun
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
 * Lot 81D (ticket P2 « TCO : écarts de calcul annuel ») — UNE date de
 * référence (`today`, date civile Europe/Paris) pour les trois indicateurs ;
 * les règles d'inclusion sont celles du moteur partagé (`evaluateComponent`,
 * `asOf`) : une dépense NON RÉALISÉE (Opération prévue sans paiement daté et
 * justifié, ou dépense datée après la date de référence) n'entre dans AUCUN
 * indicateur — conservée dans `lines` avec son motif ; une dépense payée
 * pour une période future compte à sa date de paiement. Dates strictes
 * (jamais normalisées) ; date planifiée jamais utilisée comme date
 * effective ; date d'acquisition future, impossible ou postérieure à la
 * cession : jamais utilisée (moyenne non calculée, prix compté sans date).
 *
 * Lot 86F (ticket P1 « dates économiques injustifiées ») — la date d'une
 * composante est SA date économique (`finance/economic-date`), résolue
 * composante par composante (chaque échéance indépendamment) : paiement
 * prouvé, date propre du montant, date du justificatif, réalisation d'une
 * Opération ponctuelle à fait unique. Jamais la date de l'Opération par
 * défaut, jamais le début de la période couverte : sans date établie, la
 * dépense compte dans le total sans année (`ECONOMIC_DATE_UNDETERMINED`,
 * années « potentiellement incomplètes »). Chaque ligne porte la résolution
 * (`economicDate` : fondement, provenance, justification, dates disponibles)
 * — diagnostic BO (`tracabilite/montants.json`) et tiroir (`dateLabel`).
 *
 * Lot 107C (ticket P1 « date d'achat du bien prioritaire ») — la date de
 * DÉPART (période, durée, TCO moyen annuel) est la date d'achat DU bien
 * (`./acquisition-start`) : date canonique saisie / corrigée par
 * l'utilisateur d'abord ; sinon l'Opération identifiée comme l'achat de ce
 * bien (date de réalisation seule) ; contradiction sans autorité → date
 * indéterminée (`ACQUISITION_DATE_UNDETERMINED`, moyenne non calculée).
 * Jamais la plus ancienne ACQUISITION, jamais `startDate`. Le TOTAL ne
 * dépend pas de cette date.
 *
 * Lot 108A (ticket P1 « TCO — correctifs globaux » §A) — l'identité d'un même
 * achat entre fiche, justificatif, événement de référence, composante et
 * équipement est établie par FAISCEAU DE PREUVES (`./fact-matching`), plus
 * par l'égalité des jours (`sameDay`, cause racine du double comptage
 * « fiche au J, facture au J-1 ») : même montant et même objet nécessaires ;
 * référence commune, ou dates proches avec cible explicite ou fournisseur
 * commun ; contradiction (fournisseurs, références, dates hors fenêtre) →
 * distinct ; doute → compté et signalé. Un achat établi n'absorbe qu'un
 * justificatif ; plusieurs événements de référence du même achat du bien ne
 * comptent qu'une fois (SAME_FACT_CROSS_SOURCE), comme la fiche et la facture
 * d'un même achat réunies par T3 en deux composantes (`./fact-identity`).
 * §C : l'absence de valorisation n'est plus un signalement.
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
 *
 * Lot 108C (TCO-646 §E, remplace #445 / #474) — dépenses d'usage :
 *   TCO avec estimations = coût cumulé documenté + Σ max(0, F − R) par
 *   catégorie d'usage et période échue (`summary.totalWithEstimatesCents`) ;
 *   le coût documenté reste strictement réel (T2 « dépenses réelles »).
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
  resolveAcquisitionStart, type AcquisitionOperationRole, type AcquisitionStartBasis, type AcquisitionStartKind, type AcquisitionStartResolution,
  type AcquisitionStartStatus, type CanonicalAcquisitionDateInput,
} from './acquisition-start';
import {
  presumedDuplicateComponents, purchaseIsOwnershipCost, structuredDocumentPurchaseAssessment, unjustifiedComponent, type ComponentProvenance, type PresumedDuplicate,
} from './fact-identity';
import { applyTcoUserDecisions, type TcoLineUserDecision, type TcoUserDecision } from './user-decisions';
import { assessSamePurchase, pickSameFact, purchaseDatesCompatible, type PurchaseFact, type SameFactAssessment } from './fact-matching';
import { computeUsageComplement, type UsageComplement, type UsageLineAssignment } from './usage-complement';
import { consolidateFinancing, planFinancingComponents, TCO_FINANCING_BASIS_LABEL, type FinancingComponentTreatment, type TcoFinancingDetails } from './financing';
import { assessValuations, assetAcquisitionPrice, computeOwnershipIndicators, type TcoIndicators, type ValuationHistoryInput } from './ownership-indicators';
import { multiEquipmentPurchaseCoverage } from './multi-equipment-attribution';
import {
  economicDateLabel, resolveOperationEconomicDates, type EconomicDateDocument, type EconomicDateEvidence, type EconomicDateResolution, type OwnDateOrigin,
} from '../finance/economic-date';

// ── Entrées ────────────────────────────────────────────────────────────────

export interface TcoOperation {
  id: number;
  typeCode: BusinessOperationTypeCode | null;
  status: string;
  realizedDate: string | null;
  startDate: string | null;
  plannedDate: string | null;
  /** Biens de l'Opération (liens actifs, et bien parent des équipements liés). */
  assetIds: number[];
  label: string;
  components: LedgerComponent[];
  /** Lot 86F : `date` — date du justificatif (preuve de la date économique de ses composantes). */
  documents: Array<{ fileId: number; title: string; role: string | null; date?: string | null }>;
  /** Lot 61 : natures des sources actives (ASSET_DATA : achat consolidé depuis la fiche). */
  sourceKinds?: readonly string[];
  /** Lot 78B (§3C) : l'utilisateur a lui-même rattaché l'Opération à ce bien (lien d'autorité USER). */
  userLinked?: boolean;
  /** Lot 78B (§3C) : l'Opération est rattachée à un équipement de ce bien. */
  equipmentLinked?: boolean;
  /** Lot 108A : fournisseur consolidé (faisceau d'identité avec le prix de la fiche). */
  provider?: string | null;
}

/** Lot 61 : prix d'achat de la fiche (saisi ou extrait d'un justificatif). */
export interface TcoAssetPrice {
  amountMinor: number;
  currency: string;
  /** Origine canonique (USER, DOCUMENT_EXTRACTION…). */
  origin: string | null;
  /** Documents preuves actives du prix (même fait que leur facture d'achat). */
  evidenceFileIds: readonly number[];
  /** Lot 108A : lieu d'achat saisi sur la fiche — indice positif de fournisseur, jamais une contradiction. */
  supplier?: string | null;
}

const USAGE_BUDGET_CATEGORIES = ['FUEL', 'CHARGING', 'TOLLS', 'OTHER'] as const;
type UsageBudgetCategory = (typeof USAGE_BUDGET_CATEGORIES)[number];
const USAGE_BUDGET_PERIODICITIES = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
type UsageBudgetPeriodicity = (typeof USAGE_BUDGET_PERIODICITIES)[number];

export const USAGE_BUDGET_CATEGORY_LABELS: Readonly<Record<UsageBudgetCategory, string>> = {
  FUEL: 'Carburant', CHARGING: 'Recharge électrique', TOLLS: 'Péages', OTHER: 'Autre dépense d’usage',
};
export const USAGE_BUDGET_PERIODICITY_LABELS: Readonly<Record<UsageBudgetPeriodicity, string>> = {
  MONTHLY: 'par mois', QUARTERLY: 'par trimestre', YEARLY: 'par an',
};

/**
 * Forfait d'usage (estimation) — jamais une Opération (§3.5). Lot 108C : il
 * COMPLÈTE les dépenses réelles de sa catégorie pour les périodes échues
 * (`./usage-complement`), sans jamais modifier le coût documenté.
 */
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
  /** Lot 108C : version précédente de ce forfait (révision datée : les périodes closes gardent l'ancien montant). */
  revisesBudgetId?: number | null;
}

export interface TcoInput {
  assetId: number;
  today: string;
  operations: readonly TcoOperation[];
  /** Bien parent de chaque équipement du bien (composantes ciblant un équipement). */
  equipmentAssets?: ReadonlyMap<number, number>;
  /** Date d'acquisition saisie sur la fiche (date réelle ; jamais la date d'ajout dans Verebona). */
  assetAcquisitionDate: string | null;
  /**
   * Lot 107C : provenance canonique de cette date (origine, clé / alias /
   * colonne lue, dernière écriture journalisée). Absente : valeur historique
   * sans origine tracée — USER (règle commune `readOrigin`).
   */
  assetAcquisitionDateMeta?: Omit<CanonicalAcquisitionDateInput, 'raw'>;
  /** Date de cession saisie sur la fiche (repli si la Cession n'est pas datée). */
  assetSaleDate: string | null;
  /** Statut de la fiche (VENDU, TRANSMIS…). */
  assetStatus: string | null;
  /** Historique de valorisation (`valuationHistory`, valeurs en euros ; lot 111F : identifiant et date d'ajout distincts). */
  valuationHistory: ReadonlyArray<ValuationHistoryInput>;
  /**
   * Lot 111F : détails contractuels des prêts (Opérations FINANCING du bien,
   * `business_operation_financing_details`) — capital, prêteur, dates.
   */
  financingDetails?: ReadonlyMap<number, TcoFinancingDetails>;
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
  /** Lot 108C : classements « dépense d'usage » de l'utilisateur (clé stable de la ligne). */
  usageAssignments?: readonly UsageLineAssignment[];
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
  // Lot 108A (§C) : NO_RELIABLE_VALUATION retiré — l'absence de valeur actuelle n'est pas une anomalie du TCO historique
  // (coût net estimé « non calculable », état neutre ; aucun consommateur ne dépendait du code).
  | 'DISPOSAL_PRICE_MISSING' | 'DISPOSAL_DATE_MISSING' | 'PARTIAL_READ' | 'PRORATA_APPLIED'
  // Lot 61 : dépenses documentaires non qualifiées / sans montant, et dépenses dont le bien n'est pas confirmé.
  | 'DOCUMENTS_NOT_QUALIFIED' | 'UNCONFIRMED_ASSET_EXPENSES'
  // Lot 75D : justificatifs sans montant, rapprochements incertains, facture d'achat non identifiable.
  | 'AMOUNTS_UNKNOWN' | 'UNCERTAIN_MATCHES' | 'ACQUISITION_AMBIGUOUS'
  // Lot 78B : même somme portée par plusieurs justificatifs comptée une fois ; montant non retrouvé sur ses
  // justificatifs ; achats d'objets distincts non incorporés au coût de possession.
  | 'PRESUMED_DUPLICATES' | 'UNJUSTIFIED_AMOUNTS' | 'NOT_OWNERSHIP_COSTS'
  // Lot 80A : décisions de l'utilisateur appliquées ; dépense ajoutée malgré un doublon présumé (confirmé).
  | 'USER_DECISIONS' | 'USER_INCLUDED_DUPLICATES'
  // Lot 81D : dépenses non réalisées exclues ; contradictions statut / date / nature ; dates impossibles ignorées ;
  // date d'acquisition future, impossible ou postérieure à la cession.
  | 'NOT_REALIZED_EXPENSES' | 'STATUS_CONTRADICTIONS' | 'INVALID_DATES' | 'ACQUISITION_DATE_INCOHERENT'
  // Lot 86F : dépenses retenues dont la date économique n'est pas établie (comptées, rattachées à aucune année).
  | 'ECONOMIC_DATE_UNDETERMINED'
  // Lot 107C : dates d'achat du bien contradictoires sans autorité décisive (moyenne annuelle non calculée).
  | 'ACQUISITION_DATE_UNDETERMINED'
  // Lot 108B : montant d'un justificatif en cours de récupération automatique (état neutre, jamais une alerte).
  | 'AMOUNTS_RECOVERY_PENDING';

/** Lot 75D (H) : état du coût d'acquisition (distingue absence de dépense et information manquante). */
type TcoAcquisitionStatus = 'DOCUMENTED' | 'MISSING' | 'NOT_APPLICABLE';

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
  /**
   * Lot 85A (O-9) : identités STABLES des sources non documentaires de la
   * composante (`s:` — donnée structurée du bien / de l'équipement, élément
   * d'agenda) : clé de décision d'une composante SANS justificatif, qui
   * survit à la reconstruction des Opérations (O-2).
   */
  sourceIdentities?: string[];
  /** Lot 78B (§3B) : ligne comptée à la place de celle-ci (même somme, autre justificatif, sans preuve de transaction distincte). */
  duplicateOf?: string;
  /** Lot 80A : clé STABLE de la ligne (décision « Ajouter / Retirer du TCO »), voir `tcoLineKeys`. */
  decisionKey?: string;
  /** Lot 80A : décision de l'utilisateur portée par la ligne (et statut / motif automatiques qu'elle remplace). */
  userDecision?: TcoLineUserDecision;
  /** Lot 81D : année civile à laquelle le moteur rattache la ligne RETENUE (null : sans date fiable) — détail de l'année. */
  annualYear?: number | null;
  /** Lot 81D : dépense non réalisée (prévue, datée après la date de référence) — jamais ajoutable au TCO. */
  notRealized?: true;
  /** Lot 81D : contradiction statut / date / nature constatée sur la ligne. */
  contradiction?: string;
  /**
   * Lot 86F : résolution de la date économique de la ligne (fondement,
   * provenance, justification, dates disponibles retenues ou rejetées).
   */
  economicDate?: EconomicDateResolution;
  /** Lot 86F : libellé court du fondement de la date (« Date de paiement », « Date non établie »…) — tiroir. */
  dateLabel?: string | null;
  /**
   * Lot 108A : rapprochement d'identité avec un autre fait (faisceau de preuves) —
   * verdict, codes stables, ligne de référence. Diagnostic BO et tiroir.
   */
  identity?: { verdict: SameFactAssessment['verdict']; signals: string[]; against: string };
  /** Lot 109D : contexte de rattachement (détail consultable, jamais sur la ligne principale). */
  context?: string | null;
  /** Lot 109D : composition du net de l'achat (lignes, frais, remises, méthode, réconciliation). */
  composition?: import('../finance/commercial-adjustments').PurchaseCompositionView;
  /** Lot 109D : composante de calcul de la ligne d'achat désignée (masquée de la liste principale de la fiche). */
  compositionOf?: string;
  /** Lot 109D : coûts réunis dans un net d'achat recomposé (clés de décision antérieures). */
  mergedFacts?: Array<{ kind: string; amountMinor: number; currency: string }>;
  /** Lot 111F : échéance d'un prêt comptée selon l'échéancier contractuel (présumée honorée, paiement non vérifié). */
  financingBasis?: 'SCHEDULE';
}

export interface TcoResult {
  assetId: number;
  status: ReadStatus;
  disposed: boolean;
  period: {
    start: string | null; startSource: 'OPERATION' | 'ASSET_DATA' | null; end: string; endSource: 'TODAY' | 'OPERATION' | 'ASSET_DATA'; days: number | null;
    /** Lot 81D : date d'acquisition fournie mais impossible (ex. 29/02/2025) — ignorée, jamais normalisée. */
    startRejected?: string | null;
    /** Lot 107C : résolution de la date de départ (RESOLVED, MISSING, UNDETERMINED : contradiction sans autorité, REJECTED). */
    startStatus?: AcquisitionStartStatus;
    /** Lot 107C : fondement de la date retenue (fiche saisie, fiche automatique, achat du bien). */
    startBasis?: AcquisitionStartBasis | null;
    /** Lot 107C : achat du bien, ou début de possession (location, prêt, don). */
    startKind?: AcquisitionStartKind;
  };
  /**
   * Lot 107C : résolution complète de la date de départ (candidats, rejetés,
   * motifs, contradictions, réparation proposée, date de l'ancienne règle) —
   * diagnostic BO et contrôle de cohérence ; jamais transmise à la fiche.
   */
  acquisitionStart?: AcquisitionStartResolution;
  /** Lot 108B : état de la récupération automatique des montants inconnus (lu, jamais calculé à la consultation). */
  amountRecovery?: import('./amount-recovery').TcoAmountRecoveryView;
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
    /** Lot 108C : complément estimé des dépenses d'usage (périodes échues) — jamais compris dans `cumulativeCostCents`. */
    estimatedUsageComplementCents: number;
    /** Lot 108C : TCO cumulé intégrant les estimations = coût documenté + complément estimé. */
    totalWithEstimatesCents: number;
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
    /** Budget annuel PRÉVISIONNEL : Σ des équivalents annuels des forfaits EUR en cours (affiché à part, jamais ajouté pour des mois futurs). */
    annualEstimateCents: number;
    /** Forfaits dans une autre devise : jamais additionnés en euros. */
    otherCurrencies: Array<{ currency: string; annualEquivalentMinor: number }>;
    /** Lot 108C : complément estimé par catégorie et période (R, F, complément, contribution). */
    complement: UsageComplement;
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
  /**
   * Lot 111F : indicateurs de la fiche (coût total, coût annuel moyen de
   * possession, coût net estimé, financement) et motif de chaque valeur non
   * calculable — dérivés des MÊMES lignes (`./ownership-indicators`).
   */
  indicators: TcoIndicators;
  /** Lot 111F : admissibilité de chaque valorisation (index de l'historique, motif) — diagnostic BO. */
  valuations?: import('./ownership-indicators').ValuationAssessment;
}

// ── Règles ─────────────────────────────────────────────────────────────────

const latest = (dates: Array<string | null | undefined>): string | null => dates.filter(isIsoDate).map((d) => d.slice(0, 10)).sort().pop() ?? null;

/**
 * Catégorie TCO d'une Opération. Lot 83D (CDC v5 §18.4, AC39) : plus
 * d'intervention ENFANT d'un sinistre — une réparation de sinistre reste dans
 * l'Opération CLAIM, donc un coût de sinistre.
 */
export function tcoCategoryOf(op: Pick<TcoOperation, 'typeCode'>): TcoCategory {
  if (op.typeCode === 'CLAIM') return 'CLAIMS';
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
 * Lot 111F : et STRICTEMENT postérieure à l'acquisition (`acquisitionDate`,
 * date de départ cohérente du moteur ; inconnue → aucune valeur actuelle), la
 * plus récente par DATE DE VALORISATION, jamais par ordre d'ajout
 * (`./ownership-indicators`, règle partagée avec la route des valorisations).
 */
export function reliableValuation(history: TcoInput['valuationHistory'], asOf: string, acquisitionDate: string | null): TcoResult['summary']['currentValue'] {
  const r = assessValuations(history, { asOf, acquisitionDate });
  const v = r.retainedIndex != null ? history[r.retainedIndex] : null;
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

// Lot 108A : `sameDay` (exigence du même jour) supprimé — identité par faisceau de preuves (`./fact-matching`).
const opDate = (o: Pick<TcoOperation, 'realizedDate' | 'startDate'>): string | null => {
  const d = o.realizedDate ?? o.startDate;
  return isIsoDate(d) ? d.slice(0, 10) : null;
};
const dateOfDraft = (d: Pick<DocumentLineDraft, 'date'>): string | null => (isIsoDate(d.date) ? d.date.slice(0, 10) : null);

/** Justificatif principal d'une Opération (facture, sinon premier document). */
const fichierPrincipalOp = (o: TcoOperation): number | null => (o.documents.find((d) => d.role === 'INVOICE') ?? o.documents[0])?.fileId ?? null;

/** Lot 81D : trace d'une dépense non réalisée ou contradictoire (motif et note en langage utilisateur). */
function nonRealisee(e: LedgerEntry, op?: Pick<TcoOperation, 'plannedDate'>): Partial<TcoEconomicLine> {
  const out: Partial<TcoEconomicLine> = {};
  if (e.contradiction) out.contradiction = e.contradiction;
  if (e.exclusion === 'NOT_REALIZED' || e.exclusion === 'FUTURE_DATED') out.notRealized = true;
  const prevue = op?.plannedDate && isIsoDate(op.plannedDate) ? ` (prévue le ${op.plannedDate.slice(8, 10)}/${op.plannedDate.slice(5, 7)}/${op.plannedDate.slice(0, 4)})` : '';
  if (e.contradiction === 'PLANNED_WITHOUT_PROOF') out.note = `Dépense encore prévue${prevue} : non comptée tant qu’aucun paiement daté et justifié ne l’établit.`;
  else if (e.contradiction === 'PLANNED_WITH_PAYMENT') out.note = 'Dépense marquée « prévue » mais paiement daté et justifié : comptée à sa date de paiement, statut à vérifier.';
  else if (e.contradiction === 'REALIZED_FUTURE_DATE') out.note = 'Dépense marquée « réalisée » mais datée après aujourd’hui : non comptée, date à vérifier.';
  else if (e.exclusion === 'FUTURE_DATED') out.note = 'Datée après aujourd’hui : non encore réalisée, elle sera comptée à sa date.';
  else if (e.dateRejected && !e.date) out.note = `Date impossible (« ${e.dateRejected.slice(0, 10)} ») ignorée : dépense rattachée à aucune année.`;
  else if (e.dateRejected) out.note = `Date impossible (« ${e.dateRejected.slice(0, 10)} ») ignorée : dépense datée par une autre preuve.`;
  return out;
}

/** Lot 86F : origine de la date propre d'une composante, d'après les natures de ses sources. */
function ownDateOrigin(p: Pick<ComponentProvenance, 'documentFileIds' | 'otherSourceKinds'> | undefined): OwnDateOrigin {
  if (!p) return 'UNKNOWN';
  if (p.documentFileIds.length) return 'DOCUMENT_HINT';
  if (p.otherSourceKinds.some((k) => k === 'ASSET_DATA' || k === 'EQUIPMENT_DATA')) return 'STRUCTURED';
  if (p.otherSourceKinds.includes('AGENDA')) return 'AGENDA';
  return p.otherSourceKinds.length ? 'USER' : 'UNKNOWN';
}

/**
 * Lot 86F : preuves de date connues du TCO pour les composantes d'une
 * Opération (justificatifs de chaque composante et leur date). Le lecteur des
 * Opérations résout déjà avec toutes les preuves (règlements compris) : ce
 * repli ne sert qu'aux composantes reçues sans résolution.
 */
function tcoDateEvidence(op: TcoOperation, prov: ReadonlyMap<number, ComponentProvenance>): EconomicDateEvidence {
  const documents = new Map<number, EconomicDateDocument[]>();
  const origins = new Map<number, OwnDateOrigin>();
  for (const c of op.components) {
    const p = prov.get(c.id);
    origins.set(c.id, ownDateOrigin(p));
    documents.set(c.id, (p?.documentFileIds ?? []).map((f) => {
      const d = op.documents.find((x) => x.fileId === f);
      return { fileId: f, role: d?.role ?? null, date: d?.date ?? null };
    }));
  }
  return { documents, origins };
}

/** Lot 86F : résolution de la date portée par une ligne (et note d'une date non établie, sans écraser une autre note). */
function dateEco(r: EconomicDateResolution | undefined, e: LedgerEntry): Partial<TcoEconomicLine> {
  if (!r) return {};
  return {
    economicDate: r, dateLabel: economicDateLabel(r),
    ...(r.status === 'UNDETERMINED' && e.included && !e.date ? { note: r.justification } : {}),
  };
}

/** Statut d'une ligne évaluée par le moteur (pure). */
function statusOfEntry(e: LedgerEntry, retained: EconomicLineStatus): EconomicLineStatus {
  if (e.included) return retained;
  switch (e.exclusion) {
    case 'FORECAST': case 'NOT_REALIZED': case 'FUTURE_DATED': return 'FORECAST';
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
  const prixDate = isIsoDate(input.assetAcquisitionDate) && input.assetAcquisitionDate.slice(0, 10) <= input.today ? input.assetAcquisitionDate.slice(0, 10) : null;
  const justifieParPreuve = (componentId: number) => (prov.get(componentId)?.documentFileIds ?? []).some((f) => preuves.has(f));
  const force = (componentId: number): number => {
    const p = prov.get(componentId);
    if (!p) return 0;
    // Preuve du prix d'un AUTRE bien : désignée en premier, pour que ses copies la suivent hors de ce bien (§3A).
    return (p.otherAssetAcquisition && !justifieParPreuve(componentId) ? 8 : 0)
      + (justifieParPreuve(componentId) ? 4 : 0) + (p.otherSourceKinds.includes('ASSET_DATA') ? 4 : 0) + (p.explained === true ? 1 : 0);
  };
  // Lot 111F : prêts — échéancier contractuel à date, capital jamais un coût, avenant à sa date d'effet (`./financing`).
  // Calculé AVANT les doublons présumés : une échéance remplacée par un avenant n'est jamais « la même somme » comptée.
  const plansPret = new Map<number, Map<number, FinancingComponentTreatment>>();
  for (const op of ops) {
    if (op.typeCode !== 'FINANCING') continue;
    const res = resolveOperationEconomicDates(op, tcoDateEvidence(op, prov));
    plansPret.set(op.id, planFinancingComponents({
      components: op.components, details: input.financingDetails?.get(op.id) ?? null, today: input.today,
      dateOf: (id) => res.get(id)?.date ?? (isIsoDate(op.components.find((x) => x.id === id)?.economicDate) ? op.components.find((x) => x.id === id)!.economicDate : null),
      filesOf: (id) => prov.get(id)?.documentFileIds ?? [],
      documentDates: new Map(op.documents.map((d) => [d.fileId, d.date ?? null])),
    }));
  }
  const horsCoutPret = (op: TcoOperation, id: number) => { const t = plansPret.get(op.id)?.get(id); return t?.kind === 'PRINCIPAL' || t?.kind === 'SUPERSEDED'; };
  const doublons = new Map<number, PresumedDuplicate>();
  for (const op of ops) {
    const sansPret = plansPret.has(op.id) ? { ...op, components: op.components.filter((c) => !horsCoutPret(op, c.id)) } : op;
    for (const [id, d] of presumedDuplicateComponents(sansPret, prov, force)) doublons.set(id, d);
  }
  // Lot 108A : fiche + justificatif du même achat consolidé, identité INCERTAINE (dates inconnues) — comptés, signalés.
  const incertitudesComp = new Map<number, { against: number; signals: string[] }>();
  for (const op of ops) {
    if (op.typeCode !== 'ACQUISITION') continue;
    for (const a of op.components) {
      for (const b of op.components) {
        if (a.id >= b.id || doublons.has(a.id) || doublons.has(b.id)) continue;
        const v = structuredDocumentPurchaseAssessment(a, b, prov.get(a.id), prov.get(b.id), op.typeCode);
        if (v?.verdict !== 'UNCERTAIN') continue;
        const [doc, fiche] = (prov.get(a.id)?.documentFileIds.length ?? 0) > 0 ? [a, b] : [b, a];
        incertitudesComp.set(doc.id, { against: fiche.id, signals: v.signals });
      }
    }
  }
  const nonJustifiees = new Map<number, 'AMOUNT_NOT_ON_SOURCES' | 'SOURCES_WITHDRAWN'>();
  const autresBiens = new Set<number>();

  const datesEco = new Map<number, EconomicDateResolution>();
  const traitementsPret = new Map<number, FinancingComponentTreatment>();
  for (const op of ops) {
    const category = tcoCategoryOf(op);
    const hasRefund = op.components.some((c) => c.kind === 'REFUND');
    // Lot 86F : date économique de CHAQUE composante (jamais celle de l'Opération par défaut).
    const resolutions = resolveOperationEconomicDates(op, tcoDateEvidence(op, prov));
    const planPret = plansPret.get(op.id) ?? null;
    for (const c0 of op.components) {
      const res = resolutions.get(c0.id)!;
      datesEco.set(c0.id, res);
      const pt0 = planPret?.get(c0.id);
      // Un coût déjà daté par un paiement prouvé reste un fait payé (jamais rétrogradé en « présumé honoré »).
      const pt = pt0?.kind === 'CONTRACTUAL_TO_DATE' && c0.kind === 'REALIZED_COST' && res.basis === 'PAYMENT' ? undefined : pt0;
      if (pt) traitementsPret.set(c0.id, pt);
      // Échéance contractuelle passée : comptée comme coût réalisé à sa date d'échéance (présumée honorée).
      const c: LedgerComponent = pt?.kind === 'CONTRACTUAL_TO_DATE'
        ? { ...c0, kind: 'REALIZED_COST', economicDate: pt.date }
        : { ...c0, economicDate: res.date, economicDateResolution: res };
      const contractuel = pt?.kind === 'CONTRACTUAL_TO_DATE';
      const e0 = evaluateComponent(c, {
        // Lot 111F : une échéance contractuelle échue ne dépend pas du statut du prêt (sauf annulation) — jamais une contradiction.
        scope, operationAssetIds: op.assetIds, operationStatus: contractuel && op.status !== 'CANCELLED' ? null : op.status, equipmentAssets: input.equipmentAssets,
        disposalDate: dateCession, isDisposalOperation: op.typeCode === 'DISPOSAL', hasRefund,
        // Lot 81D : date de référence ; preuve de réalisation. Lot 86F : aucun repli vers la date de l'Opération (sa date
        // effective ne sert qu'à constater une non-réalisation).
        asOf: input.today, operationEffectiveDate: op.realizedDate ?? op.startDate,
        realizationEvidence: (prov.get(c.id)?.documentFileIds.length ?? 0) > 0 || pt?.kind === 'CONTRACTUAL_TO_DATE',
      });
      // Lot 111F : capital emprunté ou échéance remplacée par un avenant — jamais un coût (ligne conservée, motif).
      const e = pt && pt.kind !== 'CONTRACTUAL_TO_DATE' && e0.included ? { ...e0, included: false, includedEurMinor: 0, prorata: null } : e0;
      // §3A : montant justifié par la preuve du prix d'achat d'un AUTRE bien (et non de celui-ci) — jamais un coût de
      // ce bien, quelle que soit l'Opération qui le porte (ex. prix d'une maison dans une commande de mobilier).
      const autreBien = e.included && !!prov.get(c.id)?.otherAssetAcquisition && !justifieParPreuve(c.id);
      // §3B : même somme, autre justificatif de la même dépense, sans preuve de transaction distincte — comptée une fois.
      const doublon = e.included && !autreBien && doublons.has(c.id);
      // Lot 108A : identité CONFIRMÉE (fiche + justificatif du même achat) : une contribution, aucune alerte « à vérifier ».
      if (doublon && !doublons.get(c.id)!.confirmed) warnings.add('PRESUMED_DUPLICATES');
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
  // Lot 108A (§A) : faits comparés par faisceau de preuves (montant, objet, cible, fournisseur, références, dates
  // proches) — jamais le même jour exigé, jamais le montant seul (`./fact-matching`).
  const ficheFait: PurchaseFact | null = prix && prixEur != null
    ? { eurCents: prixEur, date: prixDate, supplier: prix.supplier ?? null, supplierHintOnly: true, explicitTarget: true, equipment: false } : null;
  const opFait = (o: TcoOperation, eur: number, date: string | null): PurchaseFact => ({
    eurCents: eur, date, supplier: o.provider ?? null, equipment: false,
    explicitTarget: !!o.userLinked || o.components.some((c) => c.targetAssetId === input.assetId)
      || (o.assetIds.length === 1 && o.assetIds[0] === input.assetId && !o.equipmentLinked),
  });
  const identitesOp = new Map<number, SameFactAssessment>();
  const incertitudesOp = new Map<number, SameFactAssessment>();
  for (const o of achatsCoutes) {
    const couts = (opEntries.get(o.id) ?? []).filter((e) => e.included && e.effect === 'COST' && !cibleEquipement(o, e.componentId));
    let ids: number[] = [];
    if (!prix || (o.sourceKinds ?? []).includes('ASSET_DATA')) ids = couts.map((e) => e.componentId);
    else if (o.documents.some((d) => preuves.has(d.fileId))) {
      // Seules les composantes portées par la preuve du prix (ou sans justificatif documentaire connu) sont l'achat du bien.
      ids = couts.filter((e) => { const p = prov.get(e.componentId); return !p || !p.documentFileIds.length || justifieParPreuve(e.componentId); }).map((e) => e.componentId);
    } else if (ficheFait && prixEur != null && !preuves.size) {
      if (coutOp(o.id) === prixEur) {
        const v = assessSamePurchase(ficheFait, opFait(o, prixEur, opDate(o)));
        if (v.verdict === 'UNCERTAIN') { achatsIncertains.add(o.id); incertitudesOp.set(o.id, v); }
        if (v.verdict === 'SAME') { ids = couts.map((e) => e.componentId); identitesOp.set(o.id, v); }
      } else {
        for (const e of couts.filter((x) => x.eurMinor === prixEur)) {
          const v = assessSamePurchase(ficheFait, opFait(o, prixEur, e.date ?? opDate(o)));
          if (v.verdict === 'UNCERTAIN') { achatsIncertains.add(o.id); incertitudesOp.set(o.id, v); }
          if (v.verdict === 'SAME') { ids.push(e.componentId); identitesOp.set(o.id, v); }
        }
      }
    }
    if (ids.length) compAchat.set(o.id, new Set(ids));
  }
  // Lot 108A (§A) : plusieurs événements de référence identifiés comme L'ACHAT de ce bien face au prix de la fiche
  // (donnée de la fiche, preuve du prix, faisceau ; ex. facture importée avant la création du bien puis fiche saisie)
  // portant le même coût : un seul achat — le mieux établi est compté, les autres restent consultables, non additionnés.
  const memesAchats = new Map<number, { keptComponentId: number; keptOperationId: number }>();
  if (prix && compAchat.size > 1) {
    const cout = (o: TcoOperation) => (opEntries.get(o.id) ?? []).filter((e) => e.included && compAchat.get(o.id)?.has(e.componentId)).reduce((n, e) => n + e.includedEurMinor, 0);
    const rang = (o: TcoOperation) => ((o.sourceKinds ?? []).includes('ASSET_DATA') ? 0 : o.documents.some((d) => preuves.has(d.fileId)) ? 1 : 2);
    const identifies = ops.filter((o) => compAchat.has(o.id)).sort((a, b) => rang(a) - rang(b) || a.id - b.id);
    const garde = identifies[0];
    const gardeComp = [...compAchat.get(garde.id)!].sort((a, b) => a - b)[0];
    for (const o of identifies.slice(1)) {
      if (cout(o) !== cout(garde)) continue;
      for (const id of compAchat.get(o.id)!) memesAchats.set(id, { keptComponentId: gardeComp, keptOperationId: garde.id });
      compAchat.delete(o.id);
    }
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
  for (const o of ops) {
    for (const e of opEntries.get(o.id) ?? []) {
      if (!memesAchats.has(e.componentId) || !e.included) continue;
      e.included = false; e.includedEurMinor = 0; e.category = null; e.prorata = null;
    }
  }
  const coutAchat = (o: TcoOperation) => (opEntries.get(o.id) ?? []).filter((e) => e.included && compAchat.get(o.id)?.has(e.componentId)).reduce((n, e) => n + e.includedEurMinor, 0);
  /** Achats du bien établis (fiche, achats consolidés) — faits comparés par faisceau (lot 108A). */
  const achatsEtablis: Array<{ id: string; fait: PurchaseFact }> = [
    ...(ficheFait ? [{ id: `asset:${input.assetId}:acquisitionPrice`, fait: ficheFait }] : []),
    ...ops.filter((o) => achatsDuBien.has(o.id)).map((o) => ({ id: `op:${o.id}`, fait: opFait(o, coutAchat(o), opDate(o)) })),
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

  // ── Lot 107C : date de départ = date d'achat DU bien (`./acquisition-start`) ──
  // Date canonique humaine prioritaire ; sinon l'Opération qui EST l'achat du bien (identité établie ci-dessus,
  // date de réalisation seule) ; contradiction sans autorité → indéterminée. Jamais la plus ancienne ACQUISITION,
  // jamais `startDate`, jamais la date d'ajout. L'ancienne règle n'est plus que restituée (`legacyDate`, diagnostic).
  const acquisitionsDuBien = ops.filter((o) => o.typeCode === 'ACQUISITION' && o.status !== 'CANCELLED');
  const sansCout = (o: TcoOperation) => !o.components.some((x) => x.kind === 'REALIZED_COST');
  const achatProuve = (o: TcoOperation) => !!o.userLinked || (o.sourceKinds ?? []).includes('ASSET_DATA') || o.documents.some((d) => preuves.has(d.fileId));
  const roleAchat = (o: TcoOperation): AcquisitionOperationRole => {
    // Achat d'un équipement (cible) ou rattaché à un équipement du bien sans preuve qu'il soit l'achat du bien : jamais sa date.
    if (achatEquipement(o) || (o.equipmentLinked && !achatProuve(o))) return 'EQUIPMENT';
    if (achatsDuBien.has(o.id)) return 'ASSET_PURCHASE';
    if (o.assetIds.some((a) => a !== input.assetId)) return 'MULTI_ASSET';
    if (!sansCout(o)) return 'OTHER_PURCHASE';
    // Acquisition sans montant : l'achat du bien seulement si elle est la seule du bien, rattachée à lui seul, et
    // fondée sur la fiche ou rattachée par l'utilisateur — sinon rien ne l'établit.
    const seule = acquisitionsDuBien.filter((x) => !achatEquipement(x) && !x.equipmentLinked).length === 1;
    return seule && (o.userLinked || (o.sourceKinds ?? []).includes('ASSET_DATA')) ? 'ASSET_PURCHASE' : 'UNQUALIFIED';
  };
  const acquisitionStart = resolveAcquisitionStart({
    today: input.today, disposalDate: dateCession, acquisitionExpected: input.acquisitionExpected !== false,
    canonical: typeof input.assetAcquisitionDate === 'string' && input.assetAcquisitionDate.trim()
      ? { ...(input.assetAcquisitionDateMeta ?? {}), raw: input.assetAcquisitionDate } : null,
    operations: acquisitionsDuBien.map((o) => ({
      id: o.id, label: o.label, status: o.status, realizedDate: o.realizedDate, startDate: o.startDate, role: roleAchat(o),
      strongProof: achatProuve(o),
      legacyEligible: !achatEquipement(o) && (!prix || achatsDuBien.has(o.id) || !achatsDuBien.size),
    })),
  });
  const start = acquisitionStart.date;
  // Lot 81D : date fournie mais impossible (29/02/2025) — jamais normalisée ni remplacée par une autre date.
  const startRejected = acquisitionStart.rejected;
  const end = dateCession ?? input.today;
  // Lot 81D : date d'acquisition COHÉRENTE (ni future, ni postérieure à la cession) — seule utilisée pour dater l'achat.
  const startCoherent = start && start <= input.today && start <= end ? start : null;
  if (acquisitionStart.status === 'UNDETERMINED') warnings.add('ACQUISITION_DATE_UNDETERMINED');
  else if (!start && !startRejected) warnings.add('ACQUISITION_DATE_MISSING');
  else if (!startCoherent) warnings.add('ACQUISITION_DATE_INCOHERENT');

  const assetLineId = `asset:${input.assetId}:acquisitionPrice`;
  let assetEntry: (LedgerEntry & { category: TcoCategory | null }) | null = null;
  if (prix) {
    const base = {
      id: assetLineId, source: 'ASSET_DATA' as const, provenance: (prix.origin && prix.origin !== 'USER' && prix.origin !== 'ADMIN' ? 'T1' : 'USER') as EconomicLineProvenance,
      label: 'Prix d’achat (fiche du bien)', kind: 'REALIZED_COST' as const, amountMinor: prix.amountMinor, currency: prix.currency, eurCents: prixEur,
      category: 'ACQUISITION' as const, date: startCoherent, fileId: [...preuves][0] ?? null, note: null, relatedFileId: null,
    };
    if (achatsDuBien.size) {
      const o = ops.find((x) => achatsDuBien.has(x.id))!;
      const v = identitesOp.get(o.id);
      lines.push({
        ...base, includedCents: 0, operationId: o.id, operationLabel: o.label, status: 'CONSOLIDATED_ELSEWHERE', reason: 'ASSET_PRICE_CONSOLIDATED',
        ...(v ? { identity: { verdict: v.verdict, signals: v.signals, against: `op:${o.id}` } } : {}),
      });
    } else {
      const e = evaluateComponent({
        id: 0, lineId: assetLineId, operationId: 0, kind: 'REALIZED_COST', amountMinor: prix.amountMinor, currency: prix.currency, amountEurCents: null,
        economicDate: startCoherent, targetAssetId: input.assetId,
      }, { scope, operationAssetIds: [input.assetId], disposalDate: dateCession, asOf: input.today });
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
  // Lot 108A (§A) : facture d'achat ↔ achats du bien établis (fiche, achats consolidés), par faisceau de preuves.
  // Un achat établi n'absorbe qu'UN justificatif (le plus proche en date) ; les autres confirmés restent comptés,
  // signalés incertains. Le jour exact n'est jamais exigé ; le montant seul ne suffit jamais.
  const identitesDoc = new Map<string, { verdict: SameFactAssessment['verdict']; signals: string[]; against: string }>();
  if ((prix || achatsDuBien.size) && !preuves.size) {
    const eligibles = drafts.filter((d) => documentCategory(d) === 'PURCHASE' && d.kind === 'REALIZED_COST' && d.status === null && !docEquipement(d)
      && componentEurMinor({ amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents }) != null);
    const docFait = (d: DocumentLineDraft): PurchaseFact => {
      const c = d.candidateId != null ? docsParId.get(d.fileId)?.candidates.find((x) => x.id === d.candidateId) : undefined;
      const sansCible = !c || !c.targets.length;
      return {
        eurCents: componentEurMinor({ amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents }), date: dateOfDraft(d),
        supplier: d.supplierKey, invoiceRefs: d.invoiceRefs, equipment: false,
        explicitTarget: d.targetAssetId === input.assetId || (sansCible && d.assetIds.length === 1 && d.assetIds[0] === input.assetId),
      };
    };
    // Les achats établis représentent le MÊME achat du bien (fiche, achat consolidé) : une contradiction relevée face à
    // l'un d'eux (fournisseur connu différent, références de facture disjointes, autre objet) écarte l'identité pour tous.
    const contradiction = (v: SameFactAssessment) => v.signals.some((x) => x === '-SUPPLIER_DIFFERENT' || x === '-REFERENCE_DIFFERENT' || x === '!OBJECT_DIFFERENT');
    const vetos = new Set(eligibles.filter((d) => achatsEtablis.some((a) => contradiction(assessSamePurchase(a.fait, docFait(d))))).map((d) => d.lineId));
    for (const a of achatsEtablis) {
      const examens = eligibles.filter((d) => !vetos.has(d.lineId)).map((d, i) => ({ item: d, assessment: assessSamePurchase(a.fait, docFait(d)), order: i }));
      const { kept, demoted } = pickSameFact(examens);
      for (const x of examens) {
        const cur = identitesDoc.get(x.item.lineId);
        if (cur?.verdict === 'SAME') continue;
        const verdict = x.item === kept ? 'SAME' : demoted.includes(x.item) ? 'UNCERTAIN' : x.assessment.verdict;
        if (verdict === 'DISTINCT' && cur) continue;
        identitesDoc.set(x.item.lineId, { verdict, signals: x.assessment.signals, against: a.id });
      }
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
          const v = identitesDoc.get(d.lineId);
          if (v?.verdict === 'SAME') memeFait = true;
          else if (v?.verdict === 'UNCERTAIN') {
            d.uncertain = { relatedFileId: null, note: 'Même montant que l’achat du bien, sans preuve qu’il s’agisse de la même dépense : comptée, à vérifier (renseignez la date d’achat de la fiche ou retirez le doublon).' };
          }
        }
        if (memeFait && d.status === null) { d.status = 'DUPLICATE'; d.reason = 'SAME_AS_ASSET_PRICE'; }
        if (memeFait) category = 'ACQUISITION';
      } else if (factureAchat.has(d.fileId)) category = 'ACQUISITION';
      // Lot 78B (§3C) : achat distinct (ni le bien, ni un équipement, ni des frais d'acquisition) — pertinence.
      if (category === 'ACCESSORIES' && d.status === null && (prix || achatsDuBien.size > 0 || factureAchat.size > 0 || input.acquisitionExpected === false)
        && !purchaseIsOwnershipCost({ assetCategory: input.assetCategory ?? null, concernsEquipment: docEquipement(d), acquisitionFee: d.scope === 'FEE' })) {
        const memeMontant = eur != null && achatsEtablis.some((x) => x.fait.eurCents === eur);
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
      // Lot 109D : détail consultable de la ligne (contexte, composition du net, composante de calcul).
      ...(d.context ? { context: d.context } : {}), ...(d.composition ? { composition: d.composition } : {}),
      ...(d.compositionOf ? { compositionOf: d.compositionOf } : {}), ...(d.mergedFacts?.length ? { mergedFacts: d.mergedFacts } : {}),
    };
    if (d.status !== null || !d.kind) {
      // Lot 75D (D) : montant inconnu — jamais présenté comme 0 €.
      const inconnu = d.reason === 'AMOUNT_UNKNOWN';
      const eur = d.kind && !inconnu ? componentEurMinor({ amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents }) : null;
      const idDoc = d.reason === 'SAME_AS_ASSET_PRICE' ? identitesDoc.get(d.lineId) : undefined;
      lines.push({
        ...ligne, eurCents: eur, includedCents: 0, status: d.status ?? 'EXCLUDED', reason: d.reason, ...(inconnu ? { amountUnknown: true } : {}),
        // Lot 108A : même achat confirmé — relié à la ligne comptée (fiche ou achat consolidé), justificatif ouvrable.
        ...(idDoc ? { identity: idDoc, ...(idDoc.against.startsWith('asset:') ? { duplicateOf: idDoc.against } : {}) } : {}),
      });
      continue;
    }
    // Lot 111F : échéance d'un justificatif de prêt (prévision contractuelle) datée au plus tard aujourd'hui — présumée honorée.
    // Un justificatif rattaché à un prêt consolidé (Opération FINANCING) : ses échéances sont portées par les composantes
    // du prêt (jamais comptées deux fois, même si la couverture fait par fait n'est pas établie pour une prévision).
    const echeanceContractuelle = category === 'FINANCING' && d.kind === 'FORECAST_COST' && isIsoDate(d.date) && d.date.slice(0, 10) <= input.today
      && !(d.operationId != null && plansPret.has(d.operationId));
    const e = evaluateComponent({
      id: 0, lineId: d.lineId, operationId: 0, kind: echeanceContractuelle ? 'REALIZED_COST' : d.kind, amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents,
      economicDate: d.date, periodStart: d.periodStart, periodEnd: d.periodEnd, targetAssetId: d.targetAssetId, targetEquipmentId: d.targetEquipmentId,
      ...(d.dateResolution ? { economicDateResolution: d.dateResolution } : {}),
    }, {
      scope, operationAssetIds: d.assetIds, equipmentAssets: input.equipmentAssets, disposalDate: dateCession,
      isDisposalOperation: category === 'DISPOSAL', asOf: input.today,
    });
    if (e.prorata) warnings.add('PRORATA_APPLIED');
    if (e.included && d.uncertain) warnings.add('UNCERTAIN_MATCHES');
    const x = { ...e, category: e.effect === 'COST' ? category : null };
    entries.push(x);
    docEntries.push({ draft: d, entry: x });
    const incertaine = e.included && d.uncertain
      ? { uncertain: true, note: d.uncertain.note, relatedFileId: d.relatedFileId ?? d.uncertain.relatedFileId, ...(identitesDoc.get(d.lineId) ? { identity: identitesDoc.get(d.lineId)! } : {}) } : {};
    lines.push({
      ...ligne, date: e.date, eurCents: e.eurMinor, includedCents: e.includedEurMinor, status: statusOfEntry(e, 'RETAINED_DIRECT'), reason: e.exclusion, ...incertaine,
      ...dateEco(d.dateResolution, e), ...nonRealisee(e),
      ...(echeanceContractuelle && e.included ? { kind: 'REALIZED_COST' as const, financingBasis: 'SCHEDULE' as const, note: `${TCO_FINANCING_BASIS_LABEL} : échéance présumée honorée (paiement non vérifié).` } : {}),
    });
  }
  // Lot 108A : prix de la fiche retenu sans preuve T1 mais facture du même achat confirmée — le justificatif est
  // ouvrable depuis la ligne comptée (toutes les sources restent consultables et reliées).
  const ligneFiche = lines.find((l) => l.id === assetLineId && l.fileId == null);
  const factureFiche = ligneFiche ? lines.find((l) => l.source === 'DOCUMENT' && l.reason === 'SAME_AS_ASSET_PRICE' && l.duplicateOf === assetLineId && l.fileId != null) : undefined;
  if (ligneFiche && factureFiche) { ligneFiche.fileId = factureFiche.fileId; ligneFiche.identity = { ...factureFiche.identity!, against: factureFiche.id }; }
  // ── Prix d'achat des équipements (lot 71A ; lot 75D F) : dépense du bien, sans doublon ─
  // Jamais additionné à SA facture d'achat ni à l'achat consolidé de l'équipement — identité établie seulement
  // (preuve T1 du prix, donnée structurée, ou rattachement à l'équipement + nature « achat » + même montant + dates
  // concordantes) et dépense couvrante effectivement RETENUE ; une réparation ou un entretien de même montant n'est
  // jamais l'acquisition ; jamais confondu avec l'achat du bien.
  // Lot 111I : facture d'achat rattachée à PLUSIEURS équipements — couvre la somme exacte de leurs prix (module isolé).
  const achatMultiEquipements = multiEquipmentPurchaseCoverage(
    docEntries.filter((x) => x.entry.included && x.draft.kind === 'REALIZED_COST' && documentCategory(x.draft) === 'PURCHASE')
      .map((x) => ({ fileId: x.draft.fileId, eurMinor: x.entry.eurMinor, date: dateOfDraft(x.draft), linkedEquipmentIds: docsParId.get(x.draft.fileId)?.linkedEquipmentIds ?? [] })),
    (input.equipmentPrices ?? []).map((ep) => ({
      equipmentId: ep.equipmentId, eurMinor: componentEurMinor({ amountMinor: ep.amountMinor, currency: ep.currency, amountEurCents: null }),
      date: isIsoDate(ep.date) ? ep.date.slice(0, 10) : null,
    })));
  for (const ep of input.equipmentPrices ?? []) {
    if (!(ep.amountMinor > 0)) continue;
    const eur = componentEurMinor({ amountMinor: ep.amountMinor, currency: ep.currency, amountEurCents: null });
    const lineId = `equipment:${ep.equipmentId}:acquisitionPrice`;
    // Lot 81D : date d'achat PROPRE de l'équipement (indépendante du bien), stricte, jamais future.
    const epDate = isIsoDate(ep.date) && ep.date.slice(0, 10) <= input.today ? ep.date.slice(0, 10) : null;
    if (ep.date && !epDate) warnings.add('INVALID_DATES');
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
        && documentCategory(x.draft) === 'PURCHASE' && x.entry.eurMinor === eur && purchaseDatesCompatible(dateOfDraft(x.draft), epDate)));
    if (facture) {
      lines.push({ ...base, includedCents: 0, fileId: facture.draft.fileId, operationId: null, operationLabel: null, status: 'DUPLICATE', reason: 'SAME_AS_EQUIPMENT_DOCUMENT' });
      continue;
    }
    const factureMulti = preuvesEq.size ? undefined : achatMultiEquipements.get(ep.equipmentId);
    if (factureMulti !== undefined) {
      lines.push({ ...base, includedCents: 0, fileId: factureMulti, operationId: null, operationLabel: null, status: 'DUPLICATE', reason: 'SAME_AS_EQUIPMENT_DOCUMENT' });
      continue;
    }
    const retenue = (o: TcoOperation) => (opEntries.get(o.id) ?? []).some((e) => e.included && e.effect === 'COST');
    const cibleEq = (o: TcoOperation, componentId: number) => o.components.find((c) => c.id === componentId)?.targetEquipmentId === ep.equipmentId;
    const opCouvrante = ops.find((o) => o.status !== 'CANCELLED' && retenue(o) && (
      drafts.some((dr) => preuvesEq.has(dr.fileId) && dr.status === 'CONSOLIDATED_ELSEWHERE' && dr.operationId === o.id)
      || ((o.sourceKinds ?? []).includes('EQUIPMENT_DATA') && o.components.some((c) => c.targetEquipmentId === ep.equipmentId))
      || (!preuvesEq.size && eur != null && o.typeCode === 'ACQUISITION' && purchaseDatesCompatible(opDate(o), epDate)
        && (opEntries.get(o.id) ?? []).some((e) => e.included && e.kind === 'REALIZED_COST' && e.eurMinor === eur && cibleEq(o, e.componentId)))));
    if (opCouvrante) {
      lines.push({ ...base, includedCents: 0, fileId: fichierPrincipalOp(opCouvrante), operationId: opCouvrante.id, operationLabel: opCouvrante.label, status: 'CONSOLIDATED_ELSEWHERE', reason: 'EQUIPMENT_PRICE_CONSOLIDATED' });
      continue;
    }
    const e = evaluateComponent({
      id: 0, lineId, operationId: 0, kind: 'REALIZED_COST', amountMinor: ep.amountMinor, currency: ep.currency, amountEurCents: null,
      economicDate: base.date ?? startCoherent, targetAssetId: input.assetId,
    }, { scope, operationAssetIds: [input.assetId], disposalDate: dateCession, asOf: input.today });
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
        ...(achatsIncertains.has(op.id) && e.included ? {
          uncertain: true,
          ...(incertitudesOp.get(op.id) ? { identity: { verdict: 'UNCERTAIN' as const, signals: incertitudesOp.get(op.id)!.signals, against: `asset:${input.assetId}:acquisitionPrice` } } : {}),
        } : {}),
        ...(p ? { sourceFileIds: [...p.documentFileIds] } : {}),
        // Lot 85A (O-9) : identités stables des sources non documentaires (clé de décision sans justificatif).
        ...(p?.otherSourceKeys?.length ? { sourceIdentities: [...p.otherSourceKeys] } : {}),
        ...dateEco(datesEco.get(e.componentId), e),
        ...nonRealisee(e, op),
      };
      // Lot 111F : traitements d'un prêt (capital, échéance remplacée par un avenant, échéance contractuelle à date).
      const tp = traitementsPret.get(e.componentId);
      if (tp?.kind === 'PRINCIPAL') {
        opLines.push({ ...base, category: null, status: 'EXCLUDED', reason: 'LOAN_PRINCIPAL', note: 'Capital emprunté : jamais un coût du bien (le prix d’achat est compté une seule fois).' });
        continue;
      }
      if (tp?.kind === 'SUPERSEDED') {
        opLines.push({
          ...base, category: null, status: 'EXCLUDED', reason: 'FINANCING_SCHEDULE_SUPERSEDED', relatedFileId: tp.byFileId,
          note: `Échéance remplacée par un avenant ou un nouvel échéancier du même prêt, à partir du ${tp.effectiveFrom.slice(8, 10)}/${tp.effectiveFrom.slice(5, 7)}/${tp.effectiveFrom.slice(0, 4)}.`,
        });
        continue;
      }
      if (tp?.kind === 'CONTRACTUAL_TO_DATE' && e.included) {
        opLines.push({ ...base, financingBasis: 'SCHEDULE', note: `${TCO_FINANCING_BASIS_LABEL} : échéance présumée honorée (paiement non vérifié).` });
        continue;
      }
      if (autresBiens.has(e.componentId)) {
        opLines.push({
          ...base, category: null, status: 'OUT_OF_SCOPE', reason: 'COUNTED_FOR_OTHER_ASSET',
          note: 'Montant justifié par la preuve du prix d’achat d’un autre bien : jamais un coût de ce bien.',
        });
        continue;
      }
      // Lot 108A : même achat du bien porté par un autre événement de référence (identité établie, même coût).
      const ma = memesAchats.get(e.componentId);
      if (ma && !e.included && !e.exclusion) {
        const gardeOp = ops.find((x) => x.id === ma.keptOperationId)!;
        opLines.push({
          ...base, category: null, status: 'DUPLICATE', reason: 'SAME_FACT_CROSS_SOURCE', duplicateOf: `c:${ma.keptComponentId}`,
          relatedFileId: fichierComposante(gardeOp, ma.keptComponentId),
          note: `Même achat du bien que « ${gardeOp.label} », déjà compté : cette autre représentation n’est pas additionnée (ses justificatifs restent consultables).`,
        });
        continue;
      }
      const d = doublons.get(e.componentId);
      if (d?.confirmed && !e.included && !e.exclusion) {
        // Lot 108A : prix saisi sur la fiche et justificatif du même achat réunis dans le même événement de référence.
        opLines.push({
          ...base, category: null, status: 'DUPLICATE', reason: 'SAME_FACT_CROSS_SOURCE', duplicateOf: `c:${d.keptComponentId}`, relatedFileId: fileId,
          note: 'Même achat que le prix d’achat saisi sur la fiche (même montant, dates concordantes) : compté une seule fois, le justificatif reste consultable.',
        });
        continue;
      }
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
      const ic = incertitudesComp.get(e.componentId);
      if (ic && e.included) {
        warnings.add('UNCERTAIN_MATCHES');
        opLines.push({
          ...base, uncertain: true, identity: { verdict: 'UNCERTAIN', signals: ic.signals, against: `c:${ic.against}` },
          note: 'Même montant que le prix d’achat saisi sur la fiche, dans le même achat, sans date permettant de confirmer qu’il s’agit de la même dépense : comptée, à vérifier (renseignez la date d’achat de la fiche ou retirez le doublon).',
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
  // ── Lot 81D : prévisions datées après la date de référence (échéance future, devis futur) : non réalisées ──
  const toutesLignes = [...opLines, ...lines];
  for (const l of toutesLignes) {
    if (l.status === 'FORECAST' && !l.notRealized && (l.reason === 'FUTURE_INSTALLMENT' || (isIsoDate(l.date) && l.date.slice(0, 10) > input.today))) l.notRealized = true;
  }
  if (toutesLignes.some((l) => l.reason === 'NOT_REALIZED' || l.reason === 'FUTURE_DATED')) warnings.add('NOT_REALIZED_EXPENSES');
  // Lot 109C : une dépense PRÉVUE sans preuve de paiement (PLANNED_WITHOUT_PROOF) est une prévision normale, exclue
  // (NOT_REALIZED_EXPENSES) — pas une contradiction ; seules « prévue mais payée » et « réalisée mais datée après
  // aujourd'hui » le sont (la trace `contradiction` de la ligne reste inchangée, diagnostic BO).
  if (toutesLignes.some((l) => l.contradiction === 'PLANNED_WITH_PAYMENT' || l.contradiction === 'REALIZED_FUTURE_DATE')) warnings.add('STATUS_CONTRADICTIONS');
  if (entries.some((e) => e.dateRejected)) warnings.add('INVALID_DATES');
  // Lot 86F : dépense retenue sans date économique établie — comptée, rattachée à aucune année (signalée).
  if (toutesLignes.some((l) => l.economicDate?.status === 'UNDETERMINED' && !l.date && (l.status === 'RETAINED_CONSOLIDATED' || l.status === 'RETAINED_DIRECT'))) {
    warnings.add('ECONOMIC_DATE_UNDETERMINED');
  }

  // ── Lot 80A : décisions de l'utilisateur (Ajouter / Retirer du TCO) — AVANT les totaux, priment sur les règles ──
  const decisionsUtilisateur = applyTcoUserDecisions({
    lines: toutesLignes, entries, decisions: input.userDecisions ?? [], warnings,
    operationCategory: new Map(ops.map((o) => [o.id, tcoCategoryOf(o)])),
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
  // Lot 111F : valeur actuelle admissible = datée, en euros, non future, STRICTEMENT postérieure à l'acquisition.
  const evaluationValeurs = assessValuations(input.valuationHistory, { asOf: dateCession ?? input.today, acquisitionDate: startCoherent });
  const valeur = reliableValuation(input.valuationHistory, dateCession ?? input.today, startCoherent);
  const netEstime = !disposed && valeur ? cumul - valeur.cents : null;
  const netFinal = disposed && prixRealise !== null ? cumul - prixRealise : null;
  const provisoire = prixRealise === null && input.desiredSalePriceCents != null ? cumul - input.desiredSalePriceCents : null;

  if (totals.unconverted.length) warnings.add('UNCONVERTED_AMOUNTS');
  if (totals.unallocated.count) warnings.add('UNALLOCATED_AMOUNTS');
  if (!input.readComplete) warnings.add('PARTIAL_READ');

  // Forfaits d'usage : budget annuel prévisionnel (forfaits en cours), affiché à part. Lot 108C : le complément
  // estimé des périodes échues est calculé plus bas (`computeUsageComplement`), hors du coût documenté.
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
  // Lot 81D : contradiction statut / date / nature (fait économique non établi) : à vérifier.
  const docIncomplet = (['DOCUMENTS_NOT_QUALIFIED', 'UNCONFIRMED_ASSET_EXPENSES', 'AMOUNTS_UNKNOWN', 'UNCERTAIN_MATCHES', 'ACQUISITION_AMBIGUOUS', 'ACQUISITION_COST_MISSING',
    'PRESUMED_DUPLICATES', 'UNJUSTIFIED_AMOUNTS', 'STATUS_CONTRADICTIONS'] as const)
    .some((w) => warnings.has(w));
  const status: ReadStatus = !input.readComplete ? 'PARTIAL'
    : (!totals.complete || docIncomplet || warnings.has('ACQUISITION_DATE_MISSING') || warnings.has('ACQUISITION_DATE_INCOHERENT') || warnings.has('ACQUISITION_DATE_UNDETERMINED') || warnings.has('DISPOSAL_PRICE_MISSING') || warnings.has('DISPOSAL_DATE_MISSING')) ? 'INCOMPLETE' : 'COMPLETE';

  const acquisitionCents = postes.get('ACQUISITION')?.costsCents ?? 0;
  const period: TcoResult['period'] = {
    start, startSource: acquisitionStart.basis === 'OPERATION' ? 'OPERATION' : start ? 'ASSET_DATA' : null,
    end, endSource: dateCession ? (dateCessionOp ? 'OPERATION' : 'ASSET_DATA') : 'TODAY',
    days: start ? daysInclusive(start, end) : null,
    startRejected,
    // Lot 107C : état de la résolution, fondement et nature (achat / début de possession) — libellés de la fiche.
    startStatus: acquisitionStart.status, startBasis: acquisitionStart.basis, startKind: acquisitionStart.kind,
  };

  const parIdLigne = new Map<string, TcoEconomicLine[]>();
  for (const l of toutesLignes) parIdLigne.set(l.id, [...(parIdLigne.get(l.id) ?? []), l]);

  // Lot 76G : indicateurs annuels dérivés des MÊMES lignes (montants retenus, dédoublonnés) — aucun second moteur.
  // Lot 81D : chaque ligne retenue porte son année (détail de l'année = sélection exacte de l'indicateur).
  // Lot 111F : prix d'acquisition DU BIEN (valeur historique) retiré du coût annuel moyen — mêmes lignes que le total.
  const prixAcquisitionBien = assetAcquisitionPrice({ lines: toutesLignes, acquisitionStatus, assetPriceEurCents: prixEur });
  const annual = computeTcoAnnual({
    lines: toutesLignes, period, cumulativeCostCents: cumul, acquisitionPriceCents: prixAcquisitionBien, status, today: input.today, disposed,
    assign: (id, year) => { for (const l of parIdLigne.get(id) ?? []) l.annualYear = year; },
  });
  // Lot 108C : dépenses d'usage — complément estimé max(0, F − R) par catégorie et période échue (coût documenté inchangé).
  const usageComplement = computeUsageComplement({
    budgets: input.budgets, lines: toutesLignes, assignments: input.usageAssignments ?? [],
    possession: { start: period.start, end: period.end, disposed }, today: input.today, documentedCents: cumul,
    averageDays: annual.average.status === 'COMPUTED' ? annual.average.days : null,
    averageDuration: annual.average.status === 'COMPUTED' ? annual.average.duration : null,
    averageExcludedCents: annual.average.status === 'COMPUTED' ? annual.average.acquisitionPriceCents : null,
    net: { estimatedCents: netEstime, finalCents: netFinal, provisionalCents: netFinal !== null ? null : provisoire },
  });

  // Lot 111F : prêts du bien consolidés (mêmes lignes) et indicateurs de la fiche, motifs des valeurs non calculables.
  const financing = consolidateFinancing({ operations: ops, details: input.financingDetails ?? new Map(), lines: toutesLignes, today: input.today });
  const indicators = computeOwnershipIndicators({
    today: input.today, disposed, annual, cumulativeCostCents: cumul, estimatedComplementCents: usageComplement.estimatedComplementCents,
    averageWithEstimatesCents: usageComplement.averageWithEstimatesCents, financing, valuation: disposed ? null : valeur, valuationAssessment: evaluationValeurs,
    netEstimatedCents: netEstime, netFinalCents: netFinal, realizedPriceCents: prixRealise, disposalFeesCents: postes.get('DISPOSAL')?.costsCents ?? 0,
  });

  return {
    assetId: input.assetId,
    status,
    disposed,
    period,
    acquisitionStart,
    summary: {
      cumulativeCostCents: cumul, acquisitionCents, additionalCostsCents: totals.costsEurMinor - acquisitionCents, acquisitionStatus,
      currentValue: disposed ? null : valeur, netEstimatedCents: netEstime, netFinalCents: netFinal,
      estimatedUsageComplementCents: usageComplement.estimatedComplementCents, totalWithEstimatesCents: usageComplement.totalWithEstimatesCents,
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
      complement: usageComplement,
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
    annual,
    userDecisions: decisionsUtilisateur,
    indicators,
    valuations: evaluationValeurs,
  };
}

/**
 * Lot 81D (TCO-R-14, compte entier) — composantes NON RÉALISÉES selon la règle
 * du moteur partagé, indépendante de tout bien : Opération prévue sans paiement
 * daté (jamais la date planifiée) et justifié, ou dépense datée après la date de
 * référence. Même évaluation que `computeTco` (`evaluateComponent`, `asOf`), sans
 * périmètre de biens (pure, testée L81D-T2-*).
 */
export function nonRealizedComponentIds(
  ops: ReadonlyArray<{
    typeCode?: string | null; status: string; realizedDate: string | null; startDate: string | null; plannedDate?: string | null; components: readonly LedgerComponent[];
  }>,
  provenance: ReadonlyMap<number, Pick<ComponentProvenance, 'documentFileIds'>>,
  today: string,
): Set<number> {
  const out = new Set<number>();
  for (const o of ops) {
    // Lot 86F : même date économique que le TCO (résolution du lecteur, sinon même règle) — jamais la date de l'Opération par défaut.
    const dates = resolveOperationEconomicDates({ typeCode: o.typeCode ?? null, status: o.status, realizedDate: o.realizedDate, startDate: o.startDate, plannedDate: o.plannedDate ?? null, components: o.components });
    for (const c0 of o.components) {
      const res = dates.get(c0.id)!;
      const c: LedgerComponent = { ...c0, economicDate: res.date, economicDateResolution: res };
      const e = evaluateComponent(c, {
        scope: null, operationAssetIds: [], operationStatus: o.status, asOf: today, operationEffectiveDate: o.realizedDate ?? o.startDate,
        realizationEvidence: (provenance.get(c.id)?.documentFileIds.length ?? 0) > 0,
      });
      if (e.exclusion === 'NOT_REALIZED' || e.exclusion === 'FUTURE_DATED') out.add(c.id);
    }
  }
  return out;
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
