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
 *   · document cité par une composante d'Opération active : la composante
 *     le représente (CONSOLIDATED_ELSEWHERE) — le total ne varie pas quand T3
 *     reprend une facture d'abord comptée directement ;
 *   · document source d'une Opération SANS composante financière exploitable
 *     (aucune hors prévision) : la dépense documentaire est CONSERVÉE ;
 *   · source d'une Opération qui porte des montants sans le citer : T3 l'a
 *     rattaché au même fait → représenté, jamais additionné — SAUF l'achat du
 *     bien (une acquisition par cycle de possession, T3 M2) : un justificatif
 *     d'achat qui n'en porte pas le prix (non cité) et n'en est pas la preuve
 *     (aucune preuve T1 du prix d'achat) est une dépense DISTINCTE (accessoire)
 *     — `isDistinctFromAcquisition` ;
 *   · Opération invalidée ou fusionnée : ignorée (le document est réévalué) ;
 *     annulée : le document est écarté avec ce motif ;
 *   · copies (même empreinte, ou « fusion possible ») : une seule fois ;
 *     même référence de facture + même montant : une seule fois ;
 *   · devis : prévision ; preuve de paiement : jamais un coût ; capital
 *     emprunté : jamais un coût ; échéance FUTURE : jamais anticipée ;
 *   · acompte / solde compris dans une facture totale (même document, ou
 *     même fournisseur / référence, ou somme exacte) : compris dans le total ;
 *   · document de plusieurs biens sans ventilation : non attribué, jamais
 *     réparti (le moteur le signale) ; deux factures distinctes de même
 *     montant restent deux coûts.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { FinancialComponentKind } from '../model';
import {
  classifyExpenseDocument, dedupePossibleMerges, isCreditNoteTitle, type ExpenseTheme,
} from '@/services/verebona-assistant/canonical/expense-classes';
import type { ExclusionReason } from './engine';

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
  /** Une composante active cite ce document. */
  citesDocument: boolean;
  /** Type de l'Opération (ACQUISITION : règle de l'achat du bien, lot 61). */
  typeCode?: string | null;
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
export type DocumentLineReason =
  | 'DUPLICATE_COPY' | 'DUPLICATE_REFERENCE' | 'INCLUDED_IN_TOTAL_SAME_DOCUMENT' | 'INCLUDED_IN_TOTAL_INVOICE'
  | 'COVERED_BY_OPERATION' | 'COUNTED_FOR_OTHER_ASSET' | 'UNCONFIRMED_ASSET' | 'PAYMENT_PROOF' | 'LOAN_PRINCIPAL'
  | 'FUTURE_INSTALLMENT' | 'QUOTE' | 'NOT_EXPENSE_DOCUMENT' | 'THEME_UNKNOWN' | 'AMOUNT_UNKNOWN'
  | 'SAME_AS_ASSET_PRICE' | 'ASSET_PRICE_CONSOLIDATED' | 'CANDIDATE_CANCELLED' | 'OPERATION_CANCELLED_SOURCE'
  | 'SAME_AS_EQUIPMENT_DOCUMENT' | 'EQUIPMENT_PRICE_CONSOLIDATED';

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
  AMOUNT_UNKNOWN: 'Facture sans montant lisible',
  SAME_AS_ASSET_PRICE: 'Facture d’achat du bien : déjà comptée par le prix d’achat',
  ASSET_PRICE_CONSOLIDATED: 'Prix d’achat repris par l’achat consolidé',
  CANDIDATE_CANCELLED: 'Dépense annulée',
  OPERATION_CANCELLED_SOURCE: 'Rattaché à une dépense annulée',
  SAME_AS_EQUIPMENT_DOCUMENT: 'Prix d’achat de l’équipement : déjà compté par sa facture',
  EQUIPMENT_PRICE_CONSOLIDATED: 'Prix d’achat de l’équipement repris par une dépense consolidée',
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
const QUOTE_REASONS = new Set(['MAINTENANCE_QUOTE', 'REPAIR_QUOTE', 'WORKS_QUOTE', 'BON_COMMANDE', 'ACQUISITION_ORDER', 'WORKS_PURCHASE_ORDER', 'DEVIS']);
const ACOMPTE = /\b(acompte|arrhes)\b/i;
const SOLDE = /\bsolde\b/i;
const INVOICE_LIKE = /(INVOICE|FACTURE|TICKET)/i;

export const normalizeSupplier = (s: string | null | undefined): string | null => {
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
    const base = (over: Partial<DocumentLineDraft>): DocumentLineDraft => {
      const m = documentAmount(d);
      return {
        lineId: `doc:${d.fileId}`, fileId: d.fileId, candidateId: null, title: d.title, kind: 'REALIZED_COST', role: 'REALIZED_COST',
        amountMinor: m.amountMinor, currency: m.currency, amountEurCents: null, date: d.date, periodStart: null, periodEnd: null,
        targetAssetId: null, targetEquipmentId: null, assetIds: attributionAssets(d), typeHint: d.candidates[0]?.typeHint ?? null,
        theme: themeOf(d), scope: null, provenance: d.userEditedAmount ? 'USER' : d.candidates.length ? 'T1' : 'DOCUMENT',
        operationId: null, operationLabel: null, status: null, reason: null, relatedFileId: null, note: null, supplierKey, invoiceRefs, ...over,
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
    const representantes = vivantes.filter((o) => (o.exploitable || o.citesDocument) && !isDistinctFromAcquisition(o, d));
    const achatDistinct = vivantes.find((o) => isDistinctFromAcquisition(o, d)) ?? null;
    if (representantes.length) {
      const o = representantes.find((x) => x.citesDocument && x.inScope) ?? representantes.find((x) => x.inScope)
        ?? representantes.find((x) => !x.hasAssets) ?? representantes[0];
      const [status, reason]: [EconomicLineStatus, DocumentLineReason] = o.inScope ? ['CONSOLIDATED_ELSEWHERE', 'COVERED_BY_OPERATION']
        : !o.hasAssets ? ['UNCONFIRMED_ASSET', 'UNCONFIRMED_ASSET'] : ['OUT_OF_SCOPE', 'COUNTED_FOR_OTHER_ASSET'];
      out.push(base({ status, reason, operationId: o.operationId, operationLabel: o.label }));
      continue;
    }
    // Rattaché seulement à des Opérations sans composante exploitable : la dépense documentaire est conservée.
    const sansMontant = vivantes[0] ?? null;
    const lien = achatDistinct
      ? { operationId: achatDistinct.operationId, operationLabel: achatDistinct.label, note: 'Rattaché à l’achat du bien sans en porter le prix : dépense distincte (accessoire ou complément).' }
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
      for (const c of candidats) {
        const ciblesBien = [...new Set(c.targets.filter((t) => t.type === 'ASSET' && t.entityId != null).map((t) => t.entityId!))];
        const ciblesEquip = [...new Set(c.targets.filter((t) => t.type === 'EQUIPMENT' && t.entityId != null).map((t) => t.entityId!))];
        const cible = {
          targetAssetId: ciblesBien.length === 1 && !ciblesEquip.length ? ciblesBien[0] : null,
          targetEquipmentId: ciblesEquip.length === 1 && ciblesBien.length <= 1 ? ciblesEquip[0] : null,
          assetIds: ciblesBien.length > 1 ? ciblesBien : attributionAssets(d),
        };
        // Total du même document : les montants partiels de même nature y sont compris.
        const totaux = c.hints.filter((h) => h.role === 'REALIZED_COST' && h.amountScope === 'TOTAL');
        const totalRetenu = totaux.length ? totaux.reduce((m, h) => (h.amountMinor > m.amountMinor ? h : m), totaux[0]) : null;
        c.hints.forEach((h, i) => {
          const role = String(h.role);
          const ligne = base({
            ...lien, ...cible, lineId: `doc:${d.fileId}:${c.id}:${i}`, candidateId: c.id, role,
            kind: KINDS.has(role) ? (role as FinancialComponentKind) : null,
            amountMinor: h.amountMinor, currency: String(h.currency || 'EUR').trim().toUpperCase(),
            amountEurCents: h.amountEurMinor ?? null, date: h.economicDate ?? d.date, periodStart: h.periodStart, periodEnd: h.periodEnd,
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
    if (d.amountCents == null) {
      if (cls.kind === 'theme') out.push(base({ ...lien, amountMinor: 0, status: 'NOT_QUALIFIED', reason: 'AMOUNT_UNKNOWN' }));
      continue;
    }
    const facture = cls.kind === 'theme' || (cls.kind === 'unqualified' && INVOICE_LIKE.test(`${d.typeCode ?? ''} ${d.legacyType ?? ''}`));
    if (cls.kind === 'excluded') {
      // Devis sans indice T1 : prévision.
      out.push(base({ ...lien, kind: 'FORECAST_COST', role: 'FORECAST_COST', currency: d.userEditedAmount ? 'EUR' : String(d.currency || 'EUR').toUpperCase() }));
      continue;
    }
    if (!facture) { out.push(base({ ...lien, status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN' })); continue; }
    const avoir = isCreditNoteTitle(d.title);
    out.push(base({
      ...lien, kind: avoir ? 'REDUCTION' : 'REALIZED_COST', role: avoir ? 'REDUCTION' : 'REALIZED_COST',
      amountMinor: Math.abs(d.amountCents), currency: d.userEditedAmount ? 'EUR' : String(d.currency || 'EUR').toUpperCase(),
      scope: avoir ? null : ACOMPTE.test(d.title) ? 'DEPOSIT' : SOLDE.test(d.title) ? 'BALANCE' : null,
    }));
  }

  crossDocumentRules(out);
  return out;
}

/**
 * Justificatif rattaché à l'ACHAT du bien sans en être (pure) : T3 rattache
 * tout achat du bien à l'acquisition unique du cycle de possession (M2) ; un
 * document qu'aucune composante de cet achat ne cite et qui n'est pas la
 * preuve T1 du prix d'achat est une dépense distincte, jamais perdue.
 */
export function isDistinctFromAcquisition(o: Pick<EconomicDocumentOperation, 'typeCode' | 'citesDocument' | 'inScope'>, d: Pick<EconomicDocumentInput, 'acquisitionEvidence'>): boolean {
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
 * acomptes / soldes compris dans une facture totale — preuve requise
 * (fournisseur, référence ou somme exacte), jamais une fusion au seul montant.
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
  const meme = (a: DocumentLineDraft, b: DocumentLineDraft) =>
    a.invoiceRefs.some((r) => b.invoiceRefs.includes(r)) || (!!a.supplierKey && a.supplierKey === b.supplierKey);
  const pris = new Set<DocumentLineDraft>();
  for (const t of [...totaux].sort((a, b) => b.amountMinor - a.amountMinor)) {
    const lies = parts.filter((p) => !pris.has(p) && p.fileId !== t.fileId && p.currency === t.currency && meme(p, t));
    const restants = parts.filter((p) => !pris.has(p) && p.fileId !== t.fileId && p.currency === t.currency && !lies.includes(p)
      && p.assetIds.some((a) => t.assetIds.includes(a)));
    let groupe: DocumentLineDraft[] = [];
    const somme = (g: DocumentLineDraft[]) => g.reduce((n, p) => n + p.amountMinor, 0);
    if (lies.length && somme(lies) <= t.amountMinor) groupe = lies;
    else if (restants.length > 1 && somme(restants) === t.amountMinor) groupe = restants;
    for (const p of groupe) { p.status = 'INCLUDED_IN_TOTAL'; p.reason = 'INCLUDED_IN_TOTAL_INVOICE'; p.relatedFileId = t.fileId; pris.add(p); }
  }
}
