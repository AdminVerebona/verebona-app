/**
 * Lot 113AL (Trello #737, demande `82B-t3-decision-tco`) — APPLICATION des
 * décisions T3 VALIDÉES d'arbitrage sémantique aux lignes économiques d'un
 * document, EN ENTRÉE du moteur existant (`qualifyDocumentLines`). Module PUR
 * (aucun accès base, utilisable côté client), comme `economic-lines.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * La décision T3 (persistée, `economic_qualification_reviews`) ne porte
 * AUCUN montant calculé par l'IA : la somme est celle de la ligne du moteur
 * ou de l'extract T1 persisté. Elle tient la place d'un indice financier T1
 * manquant — rôle, portée, date, attribution — puis le moteur applique ses
 * règles habituelles (devise, attribution, cession, prorata, acomptes et
 * totaux, échéances futures). Une représentation par un fait déjà compté est
 * une ligne « déjà comptée » reliée à ce fait (vérifiée après coup par
 * `tco/semantic-representation.ts`), jamais un second coût ; un règlement
 * n'est jamais un coût ; une dépense commune sans ventilation prouvée n'est
 * jamais répartie. Abstention, confiance insuffisante ou examen en attente :
 * la ligne reste « Nature à confirmer » (arbitrage utilisateur du lot 111V),
 * avec la trace de l'examen.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { FinancialComponentKind } from '../model';
import type { DocumentLineDraft, EconomicDocumentInput, EconomicLineReason, EconomicLineStatus } from './economic-lines';
import { resolveEconomicDate } from './economic-date';

/** Effet validé d'un montant, tel que relu par le moteur (sous-ensemble persisté de `QualificationEffect`). */
export interface SemanticQualification {
  reviewId: number;
  decidedAt: string;
  contractVersion: string;
  promptVersion: string | null;
  model: string | null;
  amountMinor: number;
  currency: string;
  origin: 'LINE' | 'EXTRACT';
  outcome: 'INCLUDE' | 'REPRESENTED' | 'EXCLUDE' | 'ABSTAIN';
  applied: boolean;
  role: string | null;
  scope: string | null;
  economicDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  allocation: 'THIS_ASSET' | 'NOT_ALLOCATED' | null;
  representedBy: { key: string; lineId: string; label: string; source: string; fileId: number | null } | null;
  exclusion: 'NOT_AN_EXPENSE' | 'NOT_OWNERSHIP_COST' | 'OTHER_ASSET' | null;
  confidence: 'certain' | 'probable' | 'ambiguous';
  reason: string;
  evidence: Array<{ fileId: number; excerpt: string }>;
  serverNote?: string | null;
}

/** État sémantique d'un document relu par le service TCO (examens conclus + examen en cours). */
export interface SemanticDocumentState {
  effects: SemanticQualification[];
  /** Un examen T3 est demandé ou en cours pour un contexte plus récent (la décision précédente reste lue). */
  awaiting: boolean;
  /** Contrat absent du prompt T3 actif : examen en attente du contrat (supervisé). */
  contractPending?: boolean;
}

/** Trace portée par la ligne (tiroir, diagnostic BO, export) : jamais un montant. */
export interface SemanticLineTrace {
  /** APPLIED : décision certaine appliquée ; ABSTAINED : abstention / confiance insuffisante ; AWAITING : examen en attente ; STALE : fait représentant disparu. */
  state: 'APPLIED' | 'ABSTAINED' | 'AWAITING' | 'CONTRACT_PENDING' | 'STALE';
  reviewId: number | null;
  outcome: SemanticQualification['outcome'] | null;
  role: string | null;
  confidence: SemanticQualification['confidence'] | null;
  reason: string | null;
  evidence: Array<{ fileId: number; excerpt: string }>;
  contractVersion: string | null;
  promptVersion: string | null;
  decidedAt: string | null;
  /** Clé stable du fait déjà compté qui représente ce montant (REPRESENTED). */
  representedByKey?: string | null;
  serverNote?: string | null;
}

const KINDS = new Set<string>(['REALIZED_COST', 'FORECAST_COST', 'REDUCTION', 'REFUND', 'INDEMNITY', 'PROCEED']);
const PARTS = new Set(['DEPOSIT', 'BALANCE', 'INSTALLMENT']);
const devise = (c: string | null | undefined) => String(c || 'EUR').trim().toUpperCase();

/** Effet T3 d'un montant du document (même somme, même devise ; `rank` : rang parmi les montants identiques). */
export function semanticEffectFor(state: SemanticDocumentState | undefined, amountMinor: number, currency: string, rank = 0): SemanticQualification | null {
  if (!state?.effects.length) return null;
  const memes = state.effects.filter((e) => e.amountMinor === Math.abs(amountMinor) && devise(e.currency) === devise(currency));
  return memes[rank] ?? null;
}

/** Trace d'un montant resté sans nature (abstention, attente, contrat absent) — null : jamais examiné. */
export function semanticPendingTrace(state: SemanticDocumentState | undefined, e: SemanticQualification | null): SemanticLineTrace | null {
  if (e && !e.applied) return traceOf(e, 'ABSTAINED');
  if (state?.awaiting) return { ...emptyTrace(), state: 'AWAITING' };
  if (state?.contractPending) return { ...emptyTrace(), state: 'CONTRACT_PENDING' };
  return null;
}

function emptyTrace(): SemanticLineTrace {
  return { state: 'AWAITING', reviewId: null, outcome: null, role: null, confidence: null, reason: null, evidence: [], contractVersion: null, promptVersion: null, decidedAt: null };
}

function traceOf(e: SemanticQualification, state: SemanticLineTrace['state']): SemanticLineTrace {
  return {
    state, reviewId: e.reviewId, outcome: e.outcome, role: e.role, confidence: e.confidence, reason: e.reason, evidence: e.evidence.slice(0, 4),
    contractVersion: e.contractVersion, promptVersion: e.promptVersion, decidedAt: e.decidedAt,
    ...(e.representedBy ? { representedByKey: e.representedBy.key } : {}), ...(e.serverNote ? { serverNote: e.serverNote } : {}),
  };
}

/**
 * Ligne qualifiée par une décision T3 APPLIQUÉE (pure). `base` : ligne du
 * document telle que le moteur l'aurait produite (fichier, titre, biens,
 * fournisseur, références) ; le montant et la devise restent ceux du fait
 * persisté. Rend null si la décision n'est pas appliquée.
 */
export function semanticDraft(d: EconomicDocumentInput, base: DocumentLineDraft, e: SemanticQualification): DocumentLineDraft | null {
  if (!e.applied) return null;
  const trace = traceOf(e, 'APPLIED');
  const role = String(e.role ?? '');
  const commun = {
    ...base, provenance: 'T3' as const, role, scope: e.scope ?? null, amountMinor: Math.abs(base.amountMinor), currency: devise(base.currency),
    periodStart: e.periodStart, periodEnd: e.periodEnd, semantic: trace, uncertain: null,
  };
  const ligne = (kind: FinancialComponentKind | null, status: EconomicLineStatus | null, reason: EconomicLineReason | null, over: Partial<DocumentLineDraft> = {}): DocumentLineDraft =>
    ({ ...commun, kind, status, reason, ...over });

  if (e.outcome === 'EXCLUDE') {
    if (e.exclusion === 'OTHER_ASSET') return ligne(null, 'OUT_OF_SCOPE', 'COUNTED_FOR_OTHER_ASSET');
    if (e.exclusion === 'NOT_OWNERSHIP_COST') return ligne(KINDS.has(role) ? (role as FinancialComponentKind) : null, 'EXCLUDED', 'NOT_OWNERSHIP_COST');
    return ligne(null, 'EXCLUDED', 'NOT_EXPENSE_DOCUMENT');
  }
  if (e.outcome === 'REPRESENTED') {
    const r = e.representedBy;
    const lie = { relatedFileId: r?.fileId ?? null, representedBy: r?.key ?? null, operationId: base.operationId, operationLabel: base.operationLabel };
    // Règlement d'un fait déjà compté : jamais un coût de plus.
    if (role === 'PAYMENT') return ligne(null, 'PAYMENT', 'PAYMENT_PROOF', lie);
    const kind = KINDS.has(role) ? (role as FinancialComponentKind) : null;
    // Acompte / solde / échéance compris dans le total déjà compté.
    if (e.scope && PARTS.has(e.scope)) return ligne(kind, 'INCLUDED_IN_TOTAL', 'INCLUDED_IN_TOTAL_INVOICE', lie);
    // Même fait qu'une source déjà comptée : motif du vrai fait (prix de la fiche, dépense consolidée, autre justificatif).
    const reason: EconomicLineReason = r?.source === 'ASSET_DATA' ? 'SAME_AS_ASSET_PRICE' : r?.source === 'OPERATION' ? 'COVERED_BY_OPERATION' : 'SEMANTIC_SAME_FACT';
    return ligne(kind, 'CONSOLIDATED_ELSEWHERE', reason, lie);
  }
  // INCLUDE.
  if (role === 'PAYMENT') return ligne(null, 'PAYMENT', 'PAYMENT_PROOF');
  if (role === 'LOAN_PRINCIPAL') return ligne(null, 'EXCLUDED', 'LOAN_PRINCIPAL');
  if (!KINDS.has(role)) return null;
  // Date économique : date prouvée du montant d'abord, sinon règle commune (date du justificatif…).
  const dateEco = resolveEconomicDate({
    kind: role, amountMinor: commun.amountMinor, currency: commun.currency, ownDate: e.economicDate, ownDateOrigin: 'DOCUMENT_HINT',
    periodStart: e.periodStart, periodEnd: e.periodEnd, documents: [{ fileId: d.fileId, role: null, date: d.date }],
  });
  // Dépense commune à plusieurs biens sans ventilation prouvée : jamais répartie (le moteur la déclare non attribuée).
  const biens = e.allocation === 'NOT_ALLOCATED' ? [...new Set(d.linkedAssetIds), -1] : base.assetIds;
  return ligne(role as FinancialComponentKind, null, null, { date: dateEco.date, dateResolution: dateEco, assetIds: biens, targetAssetId: null, targetEquipmentId: null });
}
