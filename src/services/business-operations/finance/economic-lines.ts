/**
 * Lignes économiques — modèle COMMUN des dépenses d'un bien (lot 61, ticket
 * P1 « TCO — intégration de toutes les dépenses, consolidation anti-double
 * comptage », §3.2, §3.3, §3.4, §4.1, §6).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES DÉPENSES ALIMENTENT LE TCO, LES OPÉRATIONS EN AMÉLIORENT LA FIABILITÉ
 *
 * Une dépense qualifiée d'un document compte même sans Opération. Ce module
 * PUR (aucun accès base, utilisable côté client) qualifie les documents d'un
 * bien en lignes économiques AVANT le moteur partagé (`engine.ts`), qui
 * applique ensuite à chaque ligne retenue les MÊMES règles qu'aux composantes
 * consolidées (devise, attribution, cession, prorata) — pas de second moteur.
 *
 * Qualification d'un document (données PERSISTÉES par T1, jamais le PDF) :
 *   1. candidats T1 ÉTABLIS et ACTIFS (`document_operation_candidates`) :
 *      chaque indice financier porte sa nature (coût réalisé, prévu, avoir,
 *      remboursement, indemnité, produit de cession, règlement, capital), sa
 *      portée (total, acompte, solde, échéance, frais), sa date, sa cible ;
 *   2. à défaut (document antérieur aux candidats, montant corrigé par
 *      l'utilisateur) : montant du document SEULEMENT si son type est une
 *      dépense qualifiée (`classifyExpenseDocument`, règles T2-24) — jamais
 *      `asset_files.amount_cents` d'office (devis, annonce, notice exclus).
 *
 * Hiérarchie et anti-double comptage (§3.3, §3.4) — UN coût par fait :
 *   · document cité par une composante d'Opération active HORS prévision
 *     (attribuable à ce bien) : la composante le représente
 *     (CONSOLIDATED_ELSEWHERE) — le total ne varie pas quand T3 reprend une
 *     facture d'abord comptée directement ;
 *   · document source d'une Opération SANS composante financière exploitable
 *     (aucune hors prévision) : la dépense documentaire est CONSERVÉE ;
 *   · lot 75D (B) — la représentation est vérifiée au niveau du FAIT, plus de
 *     l'Opération entière (`operationCoverage`) : une source qu'aucune
 *     composante ne cite n'est écartée que si une composante appropriée la
 *     couvre (saisie / donnée structurée de même nature, sans justificatif ;
 *     acompte ou solde compris dans la facture totale consolidée) ; sinon
 *     elle est COMPTÉE DIRECTEMENT (180 € consolidés + 40 € non consolidés =
 *     220 €). L'achat du bien (une acquisition par cycle de possession, T3 M2) :
 *     un justificatif d'achat qui n'en porte pas le prix (non cité) et n'en
 *     est pas la preuve est une dépense DISTINCTE — `isDistinctFromAcquisition` ;
 *   · Opération invalidée ou fusionnée : ignorée (le document est réévalué) ;
 *     annulée : le document est écarté avec ce motif ;
 *   · copies (même empreinte, ou « fusion possible ») : une seule fois ;
 *     même référence de facture + même montant : une seule fois ;
 *   · devis : prévision ; preuve de paiement : jamais un coût ; capital
 *     emprunté : jamais un coût ; échéance FUTURE : jamais anticipée ;
 *   · acompte / solde compris dans une facture totale : même document, ou
 *     lien établi (référence d'événement commune, même Opération), ou preuves
 *     concordantes (somme exacte des parts, même bien, fournisseur
 *     compatible) — lot 75D (C) : le fournisseur commun SEUL ne suffit plus,
 *     le rapprochement est alors SIGNALÉ incertain, sans exclusion ;
 *   · document de plusieurs biens sans ventilation : non attribué, jamais
 *     réparti (le moteur le signale) ; lot 75D (E) : sur un document que T1 dit
 *     multi-biens, une cible unique n'est une ventilation que si T1 a établi
 *     des parts par bien (plusieurs candidats ciblés) ; deux factures
 *     distinctes de même montant restent deux coûts.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { FinancialComponentKind } from '../model';
import {
  classifyExpenseDocument, dedupePossibleMerges, isCreditNoteTitle, type ExpenseTheme,
} from '@/services/verebona-assistant/canonical/expense-classes';
import type { ExclusionReason } from './engine';
import { resolveEconomicDate, type EconomicDateResolution } from './economic-date';

// ── Entrées (lues par le service, persistées) ──────────────────────────────

/** Indice financier T1 persisté (payload du candidat). */
export interface EconomicHint {
  role: string;
  amountMinor: number;
  currency: string;
  amountEurMinor?: number | null;
  amountScope: string | null;
  economicDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

/** Candidat T1 ÉTABLI et ACTIF d'un document. */
export interface EconomicDocumentCandidate {
  id: number;
  typeHint: string | null;
  statusHint: string | null;
  sourceRole: string | null;
  provider: string | null;
  references: Array<{ kind: string; value: string }>;
  targets: Array<{ type: string; entityId: number | null }>;
  hints: EconomicHint[];
  /** Issue T3 du candidat (HOLD, erreur…) : diagnostic seulement, jamais bloquant (§4.2). */
  t3Outcome: string | null;
}

/** Opération ACTIVE (ni invalidée ni fusionnée) dont le document est une source active. */
export interface EconomicDocumentOperation {
  operationId: number;
  label: string;
  /** Liée au bien calculé (lien bien ou équipement). */
  inScope: boolean;
  cancelled: boolean;
  /** Au moins un bien lié (sinon : bien non confirmé). */
  hasAssets: boolean;
  /** Une composante active hors prévision existe. */
  exploitable: boolean;
  /** Une composante active HORS prévision cite ce document (lot 75D : une prévision ne couvre jamais une facture). */
  citesDocument: boolean;
  /** Type de l'Opération (ACQUISITION : règle de l'achat du bien, lot 61). */
  typeCode?: string | null;
  /**
   * Lot 75D (B) — couverture au niveau du FAIT. Absents (entrée antérieure) :
   * comportement du lot 61 (une Opération qui porte des montants représente
   * ses sources).
   *   · `citesForOtherAssetOnly` : les composantes qui citent ce document ne
   *     concernent qu'un AUTRE bien (part d'un autre fait pour ce bien) ;
   *   · `citesOtherDocuments` : une composante hors prévision cite un AUTRE
   *     justificatif de l'Opération (T3 a consolidé d'autres faits, pas celui-ci) ;
   *   · `freeComponents` : composantes hors prévision qu'AUCUN des
   *     justificatifs qu'elles citent n'explique (aucun montant ni indice T1
   *     de même nature et de même montant), ou sans justificatif (fiche,
   *     saisie de sinistre, arbitrage, migration) — elles peuvent porter le
   *     fait d'une source non citée.
   */
  citesForOtherAssetOnly?: boolean;
  citesOtherDocuments?: boolean;
  freeComponents?: ReadonlyArray<{ kind: string; amountMinor: number; currency: string; documented: boolean }>;
}

export interface EconomicDocumentInput {
  fileId: number;
  title: string;
  typeCode: string | null;
  legacyType: string | null;
  date: string | null;
  supplier: string | null;
  amountCents: number | null;
  /** Devise lue (extraction) ; null : euro présumé (règle T2). */
  currency: string | null;
  /** Montant corrigé par l'utilisateur dans le tiroir du document (autorité USER, en euros). */
  userEditedAmount: boolean;
  hash: string | null;
  state: string | null;
  ignoredWith: number[] | null;
  /** Biens liés (liens actifs, colonnes historiques). */
  linkedAssetIds: number[];
  /** T1 : document commun à plusieurs biens. */
  multiAsset: boolean;
  candidates: EconomicDocumentCandidate[];
  operations: EconomicDocumentOperation[];
  /**
   * Preuve active du prix d'achat d'un bien lié (T1 a lu sur ce document le
   * prix d'acquisition du bien) : c'est la facture de l'achat, même fait.
   */
  acquisitionEvidence?: boolean;
  /**
   * Lot 71A : équipements du bien auxquels le document est rattaché
   * (colonne `equipment_id`, liens N-N actifs) — déduplication avec le prix
   * d'achat de la fiche de l'équipement.
   */
  linkedEquipmentIds?: number[];
}

// ── Sortie : ligne économique ──────────────────────────────────────────────

/** Lot 71A : EQUIPMENT_DATA — prix d'achat de la fiche d'un équipement du bien. */
export type EconomicLineSource = 'OPERATION' | 'DOCUMENT' | 'ASSET_DATA' | 'EQUIPMENT_DATA';
/** Provenance de la donnée : T1 (analyse), T3 (consolidation), USER (saisie / correction), DOCUMENT (montant du document). */
export type EconomicLineProvenance = 'T1' | 'T3' | 'USER' | 'DOCUMENT';

export type EconomicLineStatus =
  | 'RETAINED_DIRECT'
  | 'RETAINED_CONSOLIDATED'
  | 'CONSOLIDATED_ELSEWHERE'
  | 'DUPLICATE'
  | 'INCLUDED_IN_TOTAL'
  | 'FORECAST'
  | 'PAYMENT'
  | 'UNALLOCATED'
  | 'NOT_QUALIFIED'
  | 'UNCONFIRMED_ASSET'
  | 'OUT_OF_SCOPE'
  | 'UNCONVERTED'
  | 'EXCLUDED';

export const ECONOMIC_LINE_STATUS_LABELS: Readonly<Record<EconomicLineStatus, string>> = {
  RETAINED_DIRECT: 'Retenue (justificatif)',
  RETAINED_CONSOLIDATED: 'Retenue (consolidée)',
  CONSOLIDATED_ELSEWHERE: 'Déjà comptée par ailleurs',
  DUPLICATE: 'Doublon',
  INCLUDED_IN_TOTAL: 'Comprise dans un total',
  FORECAST: 'Prévision',
  PAYMENT: 'Règlement',
  UNALLOCATED: 'Non attribuée',
  NOT_QUALIFIED: 'Non qualifiée',
  UNCONFIRMED_ASSET: 'Bien non confirmé',
  OUT_OF_SCOPE: 'Autre bien',
  UNCONVERTED: 'Devise non convertie',
  EXCLUDED: 'Exclue',
};

/** Motifs documentaires (en plus des motifs du moteur `ExclusionReason`). */
type DocumentLineReason =
  | 'DUPLICATE_COPY' | 'DUPLICATE_REFERENCE' | 'INCLUDED_IN_TOTAL_SAME_DOCUMENT' | 'INCLUDED_IN_TOTAL_INVOICE'
  | 'COVERED_BY_OPERATION' | 'COUNTED_FOR_OTHER_ASSET' | 'UNCONFIRMED_ASSET' | 'PAYMENT_PROOF' | 'LOAN_PRINCIPAL'
  | 'FUTURE_INSTALLMENT' | 'QUOTE' | 'NOT_EXPENSE_DOCUMENT' | 'THEME_UNKNOWN' | 'AMOUNT_UNKNOWN'
  | 'SAME_AS_ASSET_PRICE' | 'ASSET_PRICE_CONSOLIDATED' | 'CANDIDATE_CANCELLED' | 'OPERATION_CANCELLED_SOURCE'
  | 'SAME_AS_EQUIPMENT_DOCUMENT' | 'EQUIPMENT_PRICE_CONSOLIDATED'
  // Lot 75D : acompte / solde compris dans le total consolidé de la même Opération.
  | 'INCLUDED_IN_OPERATION_TOTAL'
  // Lot 78B : même somme portée par un autre justificatif du même fait (sans preuve de transaction distincte) ;
  // achat d'un objet distinct non incorporé au coût de possession du bien.
  | 'SAME_FACT_OTHER_DOCUMENT' | 'NOT_OWNERSHIP_COST' | 'SOURCE_WITHDRAWN'
  // Lot 80A : dépense retirée du coût de possession par l'utilisateur (décision persistée, réversible).
  | 'USER_EXCLUDED';

export type EconomicLineReason = ExclusionReason | DocumentLineReason;

export const DOCUMENT_LINE_REASON_LABELS: Readonly<Record<DocumentLineReason, string>> = {
  DUPLICATE_COPY: 'Copie d’un autre justificatif : comptée une seule fois',
  DUPLICATE_REFERENCE: 'Même facture (même référence, même montant) déjà comptée',
  INCLUDED_IN_TOTAL_SAME_DOCUMENT: 'Montant partiel compris dans le total du même document',
  INCLUDED_IN_TOTAL_INVOICE: 'Acompte ou solde compris dans la facture totale',
  COVERED_BY_OPERATION: 'Reprise dans une dépense consolidée : comptée une seule fois',
  COUNTED_FOR_OTHER_ASSET: 'Dépense attribuée à un autre bien',
  UNCONFIRMED_ASSET: 'Dépense dont le bien n’est pas confirmé',
  PAYMENT_PROOF: 'Preuve de paiement : confirme un règlement, pas un coût de plus',
  LOAN_PRINCIPAL: 'Capital emprunté : une dette, pas une dépense',
  FUTURE_INSTALLMENT: 'Échéance future non encore facturée',
  QUOTE: 'Devis ou commande : prévision, non réalisée',
  NOT_EXPENSE_DOCUMENT: 'Document sans valeur de dépense (notice, photo, annonce, recette…)',
  THEME_UNKNOWN: 'Nature du document non établie : montant non compté',
  AMOUNT_UNKNOWN: 'Justificatif de dépense sans montant lisible : montant inconnu, non compté (jamais 0 €)',
  SAME_AS_ASSET_PRICE: 'Facture d’achat du bien : déjà comptée par le prix d’achat',
  ASSET_PRICE_CONSOLIDATED: 'Prix d’achat repris par l’achat consolidé',
  CANDIDATE_CANCELLED: 'Dépense annulée',
  OPERATION_CANCELLED_SOURCE: 'Rattaché à une dépense annulée',
  SAME_AS_EQUIPMENT_DOCUMENT: 'Prix d’achat de l’équipement : déjà compté par sa facture',
  EQUIPMENT_PRICE_CONSOLIDATED: 'Prix d’achat de l’équipement repris par une dépense consolidée',
  INCLUDED_IN_OPERATION_TOTAL: 'Acompte ou solde compris dans la facture totale de la même dépense consolidée',
  SAME_FACT_OTHER_DOCUMENT: 'Même somme qu’un autre justificatif du même fait, sans preuve d’une transaction distincte : comptée une seule fois',
  NOT_OWNERSHIP_COST: 'Achat distinct, non incorporé au coût de possession du bien',
  SOURCE_WITHDRAWN: 'Justificatif retiré de la dépense : montant réévalué depuis le justificatif',
  USER_EXCLUDED: 'Retirée du coût de possession par vous',
};

/** Ligne documentaire qualifiée, avant le moteur (`status` null : à évaluer par `evaluateComponent`). */
export interface DocumentLineDraft {
  lineId: string;
  fileId: number;
  candidateId: number | null;
  title: string;
  /** Nature de la composante équivalente (null : règlement, capital — jamais une composante). */
  kind: FinancialComponentKind | null;
  role: string;
  amountMinor: number;
  currency: string;
  amountEurCents: number | null;
  date: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  targetAssetId: number | null;
  targetEquipmentId: number | null;
  /** Biens servant à l'attribution d'une ligne non ciblée (−1 : bien inconnu, document multi-biens). */
  assetIds: number[];
  typeHint: string | null;
  theme: ExpenseTheme | null;
  scope: string | null;
  provenance: EconomicLineProvenance;
  /** Opération liée (représentation, ou Opération sans montant). */
  operationId: number | null;
  operationLabel: string | null;
  status: EconomicLineStatus | null;
  reason: EconomicLineReason | null;
  /** Document de référence (copie, total englobant). */
  relatedFileId: number | null;
  /** Note de traçabilité (ex. « rattaché à une dépense sans montant consolidé »). */
  note: string | null;
  supplierKey: string | null;
  invoiceRefs: string[];
  /** Lot 75D (C) : références d'ÉVÉNEMENT (facture, devis, commande, ordre de travaux, contrat, sinistre) — `KIND:valeur`. */
  eventRefs?: string[];
  /** Lot 75D (C) : Opérations actives dont le document est une source (lien explicite entre documents). */
  linkedOperationIds?: number[];
  /**
   * Lot 75D (A, C) : rapprochement INCERTAIN avec un autre fait (même
   * montant sans preuve concordante, acompte du même fournisseur sans lien) :
   * la ligne reste comptée, l'ambiguïté est signalée (jamais une exclusion
   * arbitraire).
   */
  uncertain?: { relatedFileId: number | null; note: string } | null;
  /**
   * Lot 86F : résolution de la date économique de la ligne (même règle que
   * les composantes : paiement prouvé du document, date propre du montant,
   * date du justificatif sauf facturation anticipée d'une autre année).
   */
  dateResolution?: EconomicDateResolution;
}

// ── Règles ─────────────────────────────────────────────────────────────────

/**
 * Types qui n'établissent JAMAIS seuls une dépense — MÊME liste que la
 * barrière T1 (`operation-candidates/prepare.ts`, NON_BUSINESS_DOCUMENT_TYPES ;
 * égalité vérifiée par le test TCO-20). Recopiée : ce module reste pur et
 * client, sans dépendance au pipeline T1.
 */
export const NON_EXPENSE_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'PHOTO', 'VIDEO', 'USER_MANUAL', 'TECHNICAL_SHEET', 'CE_DECLARATION', 'ASSET_REFERENCE_PLAN', 'CADASTRAL_PLAN',
  'WORKS_PLAN', 'VALUE_APPRAISAL', 'VALUE_ESTIMATE', 'WARRANTY_CERTIFICATE',
]);

const KINDS = new Set<string>(['REALIZED_COST', 'FORECAST_COST', 'REDUCTION', 'REFUND', 'INDEMNITY', 'PROCEED']);
// Lot 86E : ACQUISITION_QUOTE (devis d'achat) — une proposition, jamais un coût réalisé.
const QUOTE_REASONS = new Set(['MAINTENANCE_QUOTE', 'REPAIR_QUOTE', 'WORKS_QUOTE', 'ACQUISITION_QUOTE', 'BON_COMMANDE', 'ACQUISITION_ORDER', 'WORKS_PURCHASE_ORDER', 'DEVIS']);
const ACOMPTE = /\b(acompte|arrhes)\b/i;
const SOLDE = /\bsolde\b/i;
const INVOICE_LIKE = /(INVOICE|FACTURE|TICKET)/i;

const normalizeSupplier = (s: string | null | undefined): string | null => {
  const v = (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\b(SARL|SAS|SA|EURL|SASU|SNC|ETS|STE)\b/g, '').replace(/[^A-Z0-9]/g, '');
  return v.length >= 2 ? v : null;
};
const normalizeRef = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Catégorie documentaire d'un document exclu par sa classe (pure). */
function excludedReasonOf(reason: string): DocumentLineReason {
  if (reason === 'PAYMENT_PROOF') return 'PAYMENT_PROOF';
  if (QUOTE_REASONS.has(reason) || /QUOTE|DEVIS|ORDER|COMMANDE/.test(reason)) return 'QUOTE';
  return 'NOT_EXPENSE_DOCUMENT';
}

const isFuture = (d: string | null | undefined, today: string): boolean => !!d && /^\d{4}-\d{2}-\d{2}/.test(d) && d.slice(0, 10) > today;

/** Montant indicatif d'un document (traçabilité des lignes écartées en bloc). */
function documentAmount(d: EconomicDocumentInput): { amountMinor: number; currency: string } {
  const h = d.candidates.flatMap((c) => c.hints).find((x) => x.role === 'REALIZED_COST' && x.amountScope === 'TOTAL')
    ?? d.candidates.flatMap((c) => c.hints).find((x) => x.role === 'REALIZED_COST');
  if (h && !d.userEditedAmount) return { amountMinor: h.amountMinor, currency: String(h.currency || 'EUR').toUpperCase() };
  return { amountMinor: d.amountCents ?? 0, currency: d.userEditedAmount ? 'EUR' : String(d.currency || 'EUR').toUpperCase() };
}

/**
 * Qualifie les documents d'un bien en lignes économiques (pure, testée —
 * TCO-01 à TCO-14). `today` : date de calcul (échéances futures).
 */
export function qualifyDocumentLines(docs: readonly EconomicDocumentInput[], ctx: { today: string }): DocumentLineDraft[] {
  const out: DocumentLineDraft[] = [];
  const { removed } = dedupePossibleMerges(docs.map((d) => ({
    id: d.fileId, v2: d.typeCode, legacy: d.legacyType, date: d.date, hash: d.hash, title: d.title,
    assetId: d.linkedAssetIds[0] ?? null, supplier: d.supplier, state: d.state, ignored: d.ignoredWith,
  })));
  const copies = new Set(removed);

  for (const d of docs) {
    const supplierKey = normalizeSupplier(d.supplier) ?? normalizeSupplier(d.candidates.find((c) => c.provider)?.provider);
    const invoiceRefs = [...new Set(d.candidates.flatMap((c) => c.references.filter((r) => r.kind === 'INVOICE').map((r) => normalizeRef(r.value)).filter(Boolean)))];
    const eventRefs = eventRefsOf(d.candidates);
    const linkedOperationIds = [...new Set(d.operations.filter((o) => !o.cancelled).map((o) => o.operationId))];
    const base = (over: Partial<DocumentLineDraft>): DocumentLineDraft => {
      const m = documentAmount(d);
      return {
        lineId: `doc:${d.fileId}`, fileId: d.fileId, candidateId: null, title: d.title, kind: 'REALIZED_COST', role: 'REALIZED_COST',
        amountMinor: m.amountMinor, currency: m.currency, amountEurCents: null, date: d.date, periodStart: null, periodEnd: null,
        targetAssetId: null, targetEquipmentId: null, assetIds: attributionAssets(d), typeHint: d.candidates[0]?.typeHint ?? null,
        theme: themeOf(d), scope: null, provenance: d.userEditedAmount ? 'USER' : d.candidates.length ? 'T1' : 'DOCUMENT',
        operationId: null, operationLabel: null, status: null, reason: null, relatedFileId: null, note: null, supplierKey, invoiceRefs,
        eventRefs, linkedOperationIds, uncertain: null, ...over,
      };
    };

    // 1. Copie d'un autre justificatif.
    if (copies.has(d.fileId)) { out.push(base({ status: 'DUPLICATE', reason: 'DUPLICATE_COPY' })); continue; }

    // 2. Représentation par une Opération active (hiérarchie §3.4).
    const ops = d.operations;
    const vivantes = ops.filter((o) => !o.cancelled);
    if (ops.length && !vivantes.length) {
      out.push(base({ status: 'EXCLUDED', reason: 'OPERATION_CANCELLED_SOURCE', operationId: ops[0].operationId, operationLabel: ops[0].label }));
      continue;
    }
    // Lot 75D (B) : couverture vérifiée au niveau du fait (`operationCoverage`), jamais de l'Opération entière.
    const couverture = vivantes.map((o) => ({ o, c: operationCoverage(o, d) }));
    const representantes = couverture.filter((x) => x.c === 'COVERED' || x.c === 'INCLUDED_IN_TOTAL');
    if (representantes.length) {
      const r = representantes.find((x) => x.o.citesDocument && x.o.inScope) ?? representantes.find((x) => x.o.inScope)
        ?? representantes.find((x) => !x.o.hasAssets) ?? representantes[0];
      const o = r.o;
      const [status, reason]: [EconomicLineStatus, DocumentLineReason] = o.inScope
        ? (r.c === 'INCLUDED_IN_TOTAL' ? ['INCLUDED_IN_TOTAL', 'INCLUDED_IN_OPERATION_TOTAL'] : ['CONSOLIDATED_ELSEWHERE', 'COVERED_BY_OPERATION'])
        : !o.hasAssets ? ['UNCONFIRMED_ASSET', 'UNCONFIRMED_ASSET'] : ['OUT_OF_SCOPE', 'COUNTED_FOR_OTHER_ASSET'];
      out.push(base({ status, reason, operationId: o.operationId, operationLabel: o.label }));
      continue;
    }
    // Rattaché seulement à des Opérations qui ne couvrent pas ce fait : la dépense documentaire est conservée.
    const achatDistinct = couverture.find((x) => x.c === 'DISTINCT_FROM_ACQUISITION')?.o ?? null;
    const nonCouvert = couverture.find((x) => x.c === 'NOT_COVERED')?.o ?? null;
    const sansMontant = couverture.find((x) => x.c === 'NO_AMOUNT')?.o ?? null;
    const lien = achatDistinct
      ? { operationId: achatDistinct.operationId, operationLabel: achatDistinct.label, note: 'Rattaché à l’achat du bien sans en porter le prix : dépense distincte (accessoire ou complément).' }
      : nonCouvert ? { operationId: nonCouvert.operationId, operationLabel: nonCouvert.label, note: 'Rattaché à une dépense consolidée qui n’en reprend pas le montant : le justificatif est compté directement.' }
        : sansMontant ? { operationId: sansMontant.operationId, operationLabel: sansMontant.label, note: 'Rattaché à une dépense sans montant consolidé : le justificatif fait foi.' } : {};

    // 3. Classe du document (barrière : notice, photo, annonce, recette ne portent aucune dépense).
    const nonMetier = !!d.typeCode && NON_EXPENSE_DOCUMENT_TYPES.has(d.typeCode);
    const cls = nonMetier ? { kind: 'excluded' as const, reason: d.typeCode! } : classifyExpenseDocument(d.typeCode, d.legacyType);
    if (cls.kind === 'excluded') {
      // Ni montant ni indice : rien à expliquer (photo, notice sans montant).
      if (d.amountCents == null && !d.candidates.some((c) => c.hints.length)) continue;
      const r = excludedReasonOf(cls.reason);
      // Devis / commande : leurs indices restent des prévisions (évaluées : total « prévu »).
      if (r !== 'QUOTE') {
        out.push(base({ ...lien, status: r === 'PAYMENT_PROOF' ? 'PAYMENT' : 'EXCLUDED', reason: r, kind: null }));
        continue;
      }
    }

    // 4. Lignes issues des indices T1 (qualification persistée, §3.2).
    const candidats = d.userEditedAmount ? [] : d.candidates.filter((c) => c.hints.length);
    if (candidats.length) {
      // Lot 75D (E) : document que T1 dit multi-biens — une cible unique est une cible DOCUMENTAIRE ; elle
      // ne vaut ventilation financière que si T1 a établi des parts par bien (plusieurs candidats ciblés).
      const ventile = !d.multiAsset || isFinanciallySplit(candidats);
      for (const c of candidats) {
        const ciblesBien = [...new Set(c.targets.filter((t) => t.type === 'ASSET' && t.entityId != null).map((t) => t.entityId!))];
        const ciblesEquip = [...new Set(c.targets.filter((t) => t.type === 'EQUIPMENT' && t.entityId != null).map((t) => t.entityId!))];
        const cible = {
          targetAssetId: ventile && ciblesBien.length === 1 && !ciblesEquip.length ? ciblesBien[0] : null,
          targetEquipmentId: ventile && ciblesEquip.length === 1 && ciblesBien.length <= 1 ? ciblesEquip[0] : null,
          assetIds: ciblesBien.length > 1 ? ciblesBien : attributionAssets(d),
        };
        // Total du même document : les montants partiels de même nature y sont compris.
        const totaux = c.hints.filter((h) => h.role === 'REALIZED_COST' && h.amountScope === 'TOTAL');
        const totalRetenu = totaux.length ? totaux.reduce((m, h) => (h.amountMinor > m.amountMinor ? h : m), totaux[0]) : null;
        c.hints.forEach((h, i) => {
          const role = String(h.role);
          // Lot 86F : date économique du montant (jamais la date du document par défaut pour une période d'une autre année).
          const dateEco = resolveEconomicDate({
            kind: role, amountMinor: h.amountMinor, currency: String(h.currency || 'EUR'), ownDate: h.economicDate, ownDateOrigin: 'DOCUMENT_HINT',
            periodStart: h.periodStart, periodEnd: h.periodEnd, documents: [{ fileId: d.fileId, role: c.sourceRole, date: d.date }],
            payments: c.hints.filter((x) => x.role === 'PAYMENT').map((x) => ({
              fileId: d.fileId, amountMinor: x.amountMinor, currency: String(x.currency || 'EUR'), date: x.economicDate, periodStart: x.periodStart, periodEnd: x.periodEnd, origin: 'DOCUMENT_HINT',
            })),
            sameAmountSiblings: c.hints.filter((x) => x.role === h.role && x.amountMinor === h.amountMinor).length,
          });
          const ligne = base({
            ...lien, ...cible, lineId: `doc:${d.fileId}:${c.id}:${i}`, candidateId: c.id, role,
            kind: KINDS.has(role) ? (role as FinancialComponentKind) : null,
            amountMinor: h.amountMinor, currency: String(h.currency || 'EUR').trim().toUpperCase(),
            amountEurCents: h.amountEurMinor ?? null, date: role === 'PAYMENT' ? h.economicDate ?? d.date : dateEco.date, dateResolution: dateEco,
            periodStart: h.periodStart, periodEnd: h.periodEnd,
            typeHint: c.typeHint, scope: h.amountScope, provenance: 'T1',
            supplierKey: normalizeSupplier(c.provider) ?? supplierKey,
          });
          if (c.statusHint === 'CANCELLED') { out.push({ ...ligne, status: 'EXCLUDED', reason: 'CANDIDATE_CANCELLED' }); return; }
          if (role === 'PAYMENT') { out.push({ ...ligne, kind: null, status: 'PAYMENT', reason: 'PAYMENT_PROOF' }); return; }
          if (role === 'LOAN_PRINCIPAL') { out.push({ ...ligne, kind: null, status: 'EXCLUDED', reason: 'LOAN_PRINCIPAL' }); return; }
          if (!ligne.kind) { out.push({ ...ligne, status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN' }); return; }
          if (role === 'REALIZED_COST' && h.amountScope === 'INSTALLMENT' && (isFuture(h.economicDate, ctx.today) || isFuture(h.periodStart, ctx.today))) {
            out.push({ ...ligne, status: 'FORECAST', reason: 'FUTURE_INSTALLMENT' }); return;
          }
          if (role === 'REALIZED_COST' && totalRetenu && h !== totalRetenu) {
            out.push({ ...ligne, status: 'INCLUDED_IN_TOTAL', reason: 'INCLUDED_IN_TOTAL_SAME_DOCUMENT', relatedFileId: d.fileId }); return;
          }
          out.push(ligne);
        });
      }
      continue;
    }

    // 5. Repli : montant du document, si son type est une dépense qualifiée.
    const facture = cls.kind === 'theme' || (cls.kind === 'unqualified' && INVOICE_LIKE.test(`${d.typeCode ?? ''} ${d.legacyType ?? ''}`));
    if (d.amountCents == null) {
      // Lot 75D (D) : justificatif financier reconnu sans montant — montant INCONNU (jamais 0 € certain), signalé.
      if (facture) out.push(base({ ...lien, amountMinor: 0, status: 'NOT_QUALIFIED', reason: 'AMOUNT_UNKNOWN' }));
      continue;
    }
    if (cls.kind === 'excluded') {
      // Devis sans indice T1 : prévision.
      out.push(base({ ...lien, kind: 'FORECAST_COST', role: 'FORECAST_COST', currency: d.userEditedAmount ? 'EUR' : String(d.currency || 'EUR').toUpperCase() }));
      continue;
    }
    if (!facture) { out.push(base({ ...lien, status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN' })); continue; }
    const avoir = isCreditNoteTitle(d.title);
    // Lot 86F : montant du document daté par le document (fondement tracé).
    const dateDoc = resolveEconomicDate({
      kind: avoir ? 'REDUCTION' : 'REALIZED_COST', amountMinor: Math.abs(d.amountCents), currency: String(d.currency || 'EUR'), ownDate: null,
      documents: [{ fileId: d.fileId, role: null, date: d.date }],
    });
    out.push(base({
      ...lien, kind: avoir ? 'REDUCTION' : 'REALIZED_COST', role: avoir ? 'REDUCTION' : 'REALIZED_COST', date: dateDoc.date, dateResolution: dateDoc,
      amountMinor: Math.abs(d.amountCents), currency: d.userEditedAmount ? 'EUR' : String(d.currency || 'EUR').toUpperCase(),
      scope: avoir ? null : ACOMPTE.test(d.title) ? 'DEPOSIT' : SOLDE.test(d.title) ? 'BALANCE' : null,
    }));
  }

  crossDocumentRules(out);
  return out;
}

/** Lot 75D (E) : T1 a établi des parts par bien — au moins deux candidats chiffrés, chacun ciblant un bien distinct. */
function isFinanciallySplit(candidats: readonly EconomicDocumentCandidate[]): boolean {
  const cibles = candidats.filter((c) => c.hints.length).map((c) => {
    const b = [...new Set(c.targets.filter((t) => t.type === 'ASSET' && t.entityId != null).map((t) => t.entityId!))];
    return b.length === 1 ? b[0] : null;
  });
  return cibles.every((x) => x !== null) && new Set(cibles).size >= 2;
}

/** Références d'ÉVÉNEMENT d'un document (jamais un numéro client, commun à des prestations indépendantes). */
const EVENT_REF_KINDS = new Set(['INVOICE', 'QUOTE', 'ORDER', 'WORK_ORDER', 'CONTRACT', 'CLAIM']);
function eventRefsOf(candidates: readonly EconomicDocumentCandidate[]): string[] {
  return [...new Set(candidates.flatMap((c) => c.references.filter((r) => EVENT_REF_KINDS.has(r.kind))
    .map((r) => { const v = normalizeRef(r.value); return v.length >= 3 ? `${r.kind}:${v}` : ''; }).filter(Boolean)))];
}

type CoverageDocument = Pick<EconomicDocumentInput, 'acquisitionEvidence' | 'userEditedAmount' | 'candidates' | 'amountCents' | 'title'>
  & Partial<Pick<EconomicDocumentInput, 'typeCode' | 'legacyType'>>;

/**
 * Faits de coût portés par un document (nature hors prévision et montant) :
 * indices T1, sinon montant du document (corrigé, ou sans indice) si son
 * type est une dépense ; un devis, une preuve de paiement, une notice n'en
 * portent aucun.
 */
function documentCostFacts(d: CoverageDocument): Array<{ kind: string; amountMinor: number | null }> {
  if (!d.userEditedAmount && d.candidates.some((c) => c.hints.length)) {
    return d.candidates.flatMap((c) => c.hints).filter((h) => KINDS.has(String(h.role)) && h.role !== 'FORECAST_COST')
      .map((h) => ({ kind: String(h.role), amountMinor: h.amountMinor }));
  }
  if (d.typeCode !== undefined || d.legacyType !== undefined) {
    const nonMetier = !!d.typeCode && NON_EXPENSE_DOCUMENT_TYPES.has(d.typeCode);
    if (nonMetier || classifyExpenseDocument(d.typeCode ?? null, d.legacyType ?? null).kind === 'excluded') return [];
  }
  if (d.amountCents == null) return [];
  return [{ kind: isCreditNoteTitle(d.title) ? 'REDUCTION' : 'REALIZED_COST', amountMinor: Math.abs(d.amountCents) }];
}

/** Le document ne porte que des PARTS (acompte, solde) d'un coût — jamais un total. */
function isPartsOnly(d: Pick<EconomicDocumentInput, 'userEditedAmount' | 'candidates' | 'title'>): boolean {
  const couts = d.userEditedAmount ? [] : d.candidates.flatMap((c) => c.hints).filter((h) => h.role === 'REALIZED_COST');
  if (couts.length) return couts.every((h) => h.amountScope === 'DEPOSIT' || h.amountScope === 'BALANCE');
  return ACOMPTE.test(d.title) || SOLDE.test(d.title);
}

/**
 * Lot 75D (B) — couverture d'un document par UNE Opération active dont il est
 * source (pure ; même règle pour le TCO et T2) :
 *   · COVERED : une composante hors prévision le cite (pour ce bien), ou il
 *     est la preuve du prix d'un achat, ou une composante SANS justificatif
 *     (fiche, saisie de sinistre, arbitrage, migration) porte la même nature
 *     (lien de consolidation + nature) ;
 *   · INCLUDED_IN_TOTAL : acompte / solde d'une Opération dont la facture
 *     totale est consolidée (T3 ne compte jamais les parts avec le total) ;
 *   · DISTINCT_FROM_ACQUISITION : rattaché à l'achat du bien sans en être (lot 61) ;
 *   · NO_AMOUNT : l'Opération n'a aucune composante exploitable ;
 *   · NOT_COVERED : l'Opération consolide d'AUTRES faits — le justificatif
 *     est compté directement (jamais perdu).
 */
type OperationCoverage = 'COVERED' | 'INCLUDED_IN_TOTAL' | 'DISTINCT_FROM_ACQUISITION' | 'NO_AMOUNT' | 'NOT_COVERED';

export function operationCoverage(o: EconomicDocumentOperation, d: CoverageDocument): OperationCoverage {
  const pourCeBien = !(o.inScope && o.citesForOtherAssetOnly);
  if (o.citesDocument && pourCeBien) return 'COVERED';
  if (o.typeCode === 'ACQUISITION' && o.inScope && d.acquisitionEvidence && o.exploitable) return 'COVERED';
  if (isDistinctFromAcquisition(o, d)) return 'DISTINCT_FROM_ACQUISITION';
  if (!o.exploitable) return 'NO_AMOUNT';
  // Entrée antérieure au lot 75D (couverture non lue) : règle du lot 61, l'Opération représente ses sources.
  if (o.citesOtherDocuments === undefined && o.freeComponents === undefined && o.citesForOtherAssetOnly === undefined) return 'COVERED';
  const faits = documentCostFacts(d);
  // Aucun fait de coût propre (devis, preuve de paiement, notice) : pièce du dossier, représentée par l'Opération.
  if (!faits.length) return 'COVERED';
  const libres = o.freeComponents ?? [];
  // Composante SANS justificatif de même nature (la saisie prime sur le document, T3) : lien de consolidation + nature.
  if (libres.some((c) => !c.documented && faits.some((f) => f.kind === c.kind))) return 'COVERED';
  // Composante qu'aucun justificatif cité n'explique, de même nature ET de même montant : preuves concordantes.
  if (libres.some((c) => c.documented && faits.some((f) => f.kind === c.kind && f.amountMinor === c.amountMinor))) return 'COVERED';
  if (o.citesOtherDocuments && faits.some((f) => f.kind === 'REALIZED_COST') && isPartsOnly(d)) return 'INCLUDED_IN_TOTAL';
  return 'NOT_COVERED';
}

/**
 * Justificatif rattaché à l'ACHAT du bien sans en être (pure) : T3 rattache
 * tout achat du bien à l'acquisition unique du cycle de possession (M2) ; un
 * document qu'aucune composante de cet achat ne cite et qui n'est pas la
 * preuve T1 du prix d'achat est une dépense distincte, jamais perdue.
 */
function isDistinctFromAcquisition(o: Pick<EconomicDocumentOperation, 'typeCode' | 'citesDocument' | 'inScope'>, d: Pick<EconomicDocumentInput, 'acquisitionEvidence'>): boolean {
  return o.typeCode === 'ACQUISITION' && o.inScope && !o.citesDocument && !d.acquisitionEvidence;
}

/** Biens d'attribution d'une ligne non ciblée : biens liés, plus un bien inconnu si T1 a vu plusieurs biens. */
function attributionAssets(d: EconomicDocumentInput): number[] {
  const ids = [...new Set(d.linkedAssetIds)];
  return d.multiAsset && ids.length <= 1 ? [...ids, -1] : ids;
}

function themeOf(d: EconomicDocumentInput): ExpenseTheme | null {
  const c = classifyExpenseDocument(d.typeCode, d.legacyType);
  return c.kind === 'theme' ? c.theme : null;
}

/**
 * Règles entre documents (pure) : même facture (référence + montant) et
 * acomptes / soldes compris dans une facture totale.
 *
 * Lot 75D (C) — un acompte ou un solde n'est compris dans une facture totale
 * que sur preuve du MÊME événement :
 *   · lien établi : référence d'événement commune (facture, devis, commande,
 *     ordre de travaux, contrat, sinistre) ou même Opération active ;
 *   · preuves concordantes : plusieurs parts dont la somme est EXACTEMENT le
 *     total, même bien, fournisseurs compatibles ;
 * le fournisseur commun SEUL ne suffit jamais (deux prestations
 * indépendantes chez le même fournisseur restent deux dépenses) : la part
 * reste comptée et le rapprochement est signalé INCERTAIN.
 */
function crossDocumentRules(lines: DocumentLineDraft[]): void {
  const vivantes = () => lines.filter((l) => l.status === null && (l.kind === 'REALIZED_COST' || l.kind === 'REDUCTION'));
  // Même facture : même référence, même montant, même devise, même nature, fournisseur compatible.
  const vues = new Map<string, DocumentLineDraft>();
  for (const l of vivantes()) {
    for (const r of l.invoiceRefs) {
      const k = `${r}|${l.kind}|${l.currency}|${l.amountMinor}`;
      const autre = vues.get(k);
      if (autre && autre.fileId !== l.fileId && (!autre.supplierKey || !l.supplierKey || autre.supplierKey === l.supplierKey)) {
        l.status = 'DUPLICATE'; l.reason = 'DUPLICATE_REFERENCE'; l.relatedFileId = autre.fileId;
        break;
      }
      if (!autre) vues.set(k, l);
    }
  }
  // Acomptes / soldes compris dans une facture totale d'un autre document.
  const couts = vivantes().filter((l) => l.kind === 'REALIZED_COST');
  const parts = couts.filter((l) => l.scope === 'DEPOSIT' || l.scope === 'BALANCE');
  const totaux = couts.filter((l) => l.scope !== 'DEPOSIT' && l.scope !== 'BALANCE' && l.scope !== 'INSTALLMENT' && l.scope !== 'FEE');
  const lien = (a: DocumentLineDraft, b: DocumentLineDraft) =>
    (a.eventRefs ?? []).some((r) => (b.eventRefs ?? []).includes(r))
    || (a.linkedOperationIds ?? []).some((o) => (b.linkedOperationIds ?? []).includes(o));
  const fournisseursCompatibles = (a: DocumentLineDraft, b: DocumentLineDraft) => !a.supplierKey || !b.supplierKey || a.supplierKey === b.supplierKey;
  const pris = new Set<DocumentLineDraft>();
  const somme = (g: DocumentLineDraft[]) => g.reduce((n, p) => n + p.amountMinor, 0);
  for (const t of [...totaux].sort((a, b) => b.amountMinor - a.amountMinor)) {
    const libres = parts.filter((p) => !pris.has(p) && p.fileId !== t.fileId && p.currency === t.currency);
    const lies = libres.filter((p) => lien(p, t));
    const concordantes = libres.filter((p) => !lies.includes(p) && fournisseursCompatibles(p, t) && p.assetIds.some((a) => t.assetIds.includes(a)));
    let groupe: DocumentLineDraft[] = [];
    if (lies.length && somme(lies) <= t.amountMinor) groupe = lies;
    else if (concordantes.length > 1 && somme(concordantes) === t.amountMinor) groupe = concordantes;
    for (const p of groupe) { p.status = 'INCLUDED_IN_TOTAL'; p.reason = 'INCLUDED_IN_TOTAL_INVOICE'; p.relatedFileId = t.fileId; p.uncertain = null; pris.add(p); }
    // Même fournisseur (connu) sans lien ni somme exacte : rapprochement INCERTAIN, signalé, jamais exclu.
    if (!groupe.length) {
      for (const p of libres) {
        if (p.uncertain || !p.supplierKey || p.supplierKey !== t.supplierKey || p.amountMinor > t.amountMinor) continue;
        p.uncertain = { relatedFileId: t.fileId, note: 'Acompte ou solde du même fournisseur qu’une facture totale, sans référence commune : vérifiez qu’il n’y est pas déjà compris.' };
      }
    }
  }
}
