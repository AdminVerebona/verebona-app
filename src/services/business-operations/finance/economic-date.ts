/**
 * Lot 86F — DATE ÉCONOMIQUE d'une composante financière (ticket P1 « TCO /
 * Opérations : dates économiques injustifiées et leur autoréparation »,
 * complément du ticket #559). PUR (aucun accès base), utilisable côté client.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA DATE D'UNE OPÉRATION N'EST PAS CELLE DE CHACUNE DE SES DÉPENSES
 *
 * Avant ce lot, le moteur partagé reprenait la date de réalisation ou de
 * début de l'Opération pour toute composante sans date propre : trois
 * prestations 2026 d'un abonnement étaient affectées à 2025 parce que
 * l'Opération était datée du 05/11/2025. Ce repli générique est SUPPRIMÉ
 * (`EvaluateContext.fallbackDate` n'existe plus) et n'est PAS remplacé par
 * le début de la période couverte.
 *
 * Les dates disponibles sont DISTINGUÉES (`candidates`, provenance de
 * chacune) : paiement prouvé, date portée par la source pour ce montant
 * (échéance, date de dépense), date du justificatif (facture, avoir,
 * remboursement — engagement), période de prestation, dates de l'Opération.
 * Chaque composante (chaque échéance d'un même contrat) est résolue
 * INDÉPENDAMMENT. Ordre (convention financière : la dépense est datée par
 * son décaissement établi, à défaut par son engagement établi) :
 *
 *   1. PAIEMENT prouvé, attribuable sans ambiguïté à CETTE composante
 *      (indice de règlement porté par l'un de ses justificatifs, période
 *      concordante, ou seul règlement de ce montant pour la seule composante
 *      de ce montant) — un paiement anticipé prouvé l'emporte ;
 *   2. DATE PROPRE du montant, lue sur sa source (indice T1, donnée
 *      structurée de la fiche, élément d'agenda, saisie) ;
 *   3. DATE DU JUSTIFICATIF qui établit le montant (facture, avoir,
 *      remboursement…), unique et non contradictoire — sauf facturation
 *      anticipée d'une période couverte qui commence une année ultérieure
 *      sans paiement prouvé (l'année du décaissement n'est pas établie) ;
 *   4. DATE DE RÉALISATION de l'Opération, seulement quand elle est la date
 *      de CE fait : Opération ponctuelle réalisée (achat, intervention,
 *      cession, autre) qui ne porte qu'UN fait économique, sans période
 *      couverte qui la contredise. Jamais pour un contrat, un financement ou
 *      un sinistre (échéances, indemnités : faits distincts dans le temps),
 *      jamais la date de début ni la date planifiée.
 *
 * Sinon : date NON ÉTABLIE (`UNDETERMINED`, motif) — le montant reste dans le
 * TCO cumulatif, la dépense n'est rattachée à aucune année (ventilation
 * annuelle signalée incomplète), et la date est réévaluée dès qu'une preuve
 * apparaît (résolution recalculée à chaque lecture ; trace persistée et
 * vérifiée par le contrôle COH-TCO-ECONOMIC-DATES). Jamais une incertitude
 * transformée en date supposée. Aucune règle par fournisseur ou document.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isIsoDate } from './engine';

/** Version des règles de résolution : la changer fait réexaminer tout le stock (contrôle COH-TCO-ECONOMIC-DATES). */
const ECONOMIC_DATE_RULE_VERSION = 1;

/** Fondement de la date retenue. */
type EconomicDateBasis = 'PAYMENT' | 'AMOUNT_DATE' | 'DOCUMENT' | 'OPERATION_SINGLE_FACT';

/** Nature d'une date disponible (distinguées, jamais confondues). */
type EconomicDateCandidateType =
  | 'PAYMENT'            // règlement prouvé (indice de paiement, preuve de règlement)
  | 'AMOUNT_DATE'        // date portée par la source pour ce montant (échéance, date de dépense)
  | 'DOCUMENT'           // date du justificatif qui établit le montant (facture, avoir, remboursement)
  | 'PERIOD'             // période de prestation couverte (jamais une date économique à elle seule)
  | 'OPERATION_REALIZED' // date de réalisation de l'Opération
  | 'OPERATION_START'    // date de début de l'Opération (contrat : début d'effet)
  | 'OPERATION_PLANNED'; // date planifiée (jamais une date effective)

/** Motif d'une date non établie. */
type EconomicDateUndeterminedReason =
  | 'NO_EVIDENCE'                   // aucune date propre, aucun paiement, aucun justificatif daté
  | 'PERIOD_ONLY'                   // seule la période couverte est connue (jamais une année inventée)
  | 'ADVANCE_BILLING_UNPAID'        // facturée avant une période d'une année ultérieure, paiement non prouvé
  | 'CONTRADICTORY_DOCUMENT_DATES'  // justificatifs du même montant datés différemment
  | 'AMBIGUOUS_PAYMENT'             // plusieurs règlements attribuables, dates différentes
  | 'OPERATION_DATE_NOT_RELEVANT';  // seule la date de l'Opération existe, sans être celle de ce fait

/** Motif de rejet d'une date disponible (trace). */
type EconomicDateRejection =
  | 'INVALID_DATE' | 'NOT_ATTRIBUTABLE' | 'CONTRADICTORY' | 'SUPERSEDED' | 'BEFORE_COVERED_PERIOD_OTHER_YEAR'
  | 'RECURRING_OPERATION' | 'MULTIPLE_FACTS' | 'NOT_REALIZED' | 'OUTSIDE_COVERED_PERIOD' | 'NEVER_ECONOMIC' | 'OWN_DATE_INVALID';

interface EconomicDateCandidate {
  type: EconomicDateCandidateType;
  date: string;
  /** Fin de la période (PERIOD seulement). */
  end?: string | null;
  fileId?: number | null;
  /** Origine de la date (indice T1, fiche, agenda, saisie, rôle du justificatif…). */
  origin?: string | null;
  retained: boolean;
  rejected?: EconomicDateRejection;
}

export interface EconomicDateResolution {
  version: number;
  status: 'ESTABLISHED' | 'UNDETERMINED';
  /** Date retenue (`YYYY-MM-DD`), null si non établie. */
  date: string | null;
  basis: EconomicDateBasis | null;
  reason: EconomicDateUndeterminedReason | null;
  /** Provenance vérifiable de la date retenue. */
  provenance: { type: EconomicDateCandidateType; fileId: number | null; origin: string | null } | null;
  /** Justification en langage utilisateur (tiroir « Dépenses retenues », diagnostic). */
  justification: string;
  /** Toutes les dates disponibles, retenue ou rejetée (motif). */
  candidates: EconomicDateCandidate[];
  /** Date propre fournie mais impossible (ex. 29/02/2025) — ignorée, jamais normalisée. */
  rejectedOwnDate?: string | null;
}

/** Origine de la date propre d'une composante (natures de ses sources). */
export type OwnDateOrigin = 'DOCUMENT_HINT' | 'STRUCTURED' | 'AGENDA' | 'USER' | 'UNKNOWN';

/** Justificatif (source document ACTIVE) qui porte la composante. */
export interface EconomicDateDocument {
  fileId: number;
  /** Rôle de la source (INVOICE, CREDIT_NOTE, PAYMENT_PROOF…), null si inconnu. */
  role: string | null;
  date: string | null;
}

/** Règlement prouvé lu sur une source de l'Opération (indice PAYMENT, preuve de règlement). */
export interface EconomicDatePayment {
  fileId: number | null;
  amountMinor: number;
  currency: string;
  date: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  origin?: string | null;
}

export interface EconomicDateInput {
  kind: string;
  amountMinor: number;
  currency: string;
  ownDate: string | null;
  ownDateOrigin?: OwnDateOrigin;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Justificatifs ACTIFS de la composante (provenance 78B). */
  documents?: readonly EconomicDateDocument[];
  /** Règlements prouvés de l'Opération (tous : l'attribution est décidée ici). */
  payments?: readonly EconomicDatePayment[];
  /** Nombre de composantes actives de l'Opération de même nature, montant et devise (celle-ci comprise). */
  sameAmountSiblings?: number;
  operation?: {
    typeCode: string | null;
    status: string | null;
    realizedDate: string | null;
    startDate: string | null;
    plannedDate: string | null;
    /** Faits économiques de l'Opération : composantes actives hors prévision. */
    factCount: number;
  } | null;
}

/** Types d'Opération ponctuels : leur date de réalisation peut être celle de leur fait UNIQUE. */
const PONCTUELLES = new Set<string | null>(['ACQUISITION', 'INTERVENTION', 'DISPOSAL', 'OTHER', null]);
/** Rôles de source qui n'établissent jamais le montant d'une dépense (prévision, preuve de règlement, pièce annexe). */
const ROLES_SANS_ENGAGEMENT = new Set(['QUOTE', 'ORDER', 'CONTRACT_DOCUMENT', 'PAYMENT_PROOF', 'OTHER_EVIDENCE']);
const ROLES_SANS_PREVISION = new Set(['PAYMENT_PROOF', 'OTHER_EVIDENCE']);

const jour = (d: string | null | undefined): string | null => (isIsoDate(d) ? d.slice(0, 10) : null);
const an = (d: string) => Number(d.slice(0, 4));
const fr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const chevauche = (a0: string, a1: string, b0: string, b1: string) => a0 <= b1 && b0 <= a1;

const ECONOMIC_DATE_BASIS_LABELS: Readonly<Record<EconomicDateBasis, string>> = {
  PAYMENT: 'Date de paiement',
  AMOUNT_DATE: 'Date indiquée pour ce montant',
  DOCUMENT: 'Date du justificatif',
  OPERATION_SINGLE_FACT: 'Date de la dépense',
};

const POURQUOI: Readonly<Record<EconomicDateUndeterminedReason, string>> = {
  NO_EVIDENCE: 'aucune date de paiement ni de justificatif n’est connue',
  PERIOD_ONLY: 'seule la période couverte est connue, pas la date du paiement',
  ADVANCE_BILLING_UNPAID: 'facturée avant une période couverte d’une autre année, sans paiement prouvé',
  CONTRADICTORY_DOCUMENT_DATES: 'ses justificatifs portent des dates différentes',
  AMBIGUOUS_PAYMENT: 'plusieurs paiements de dates différentes pourraient la régler',
  OPERATION_DATE_NOT_RELEVANT: 'la date du dossier n’est pas celle de cette dépense',
};

/** Note utilisateur d'une date non établie (tiroir « Dépenses retenues »). */
function undeterminedNote(reason: EconomicDateUndeterminedReason): string {
  return `Date de la dépense non établie (${POURQUOI[reason]}) : comptée dans le total, rattachée à aucune année.`;
}

/**
 * Résout la date économique d'UNE composante (pure, testée L86F-U-*). Aucune
 * date supposée : sans preuve suffisante, `UNDETERMINED` avec son motif.
 */
export function resolveEconomicDate(input: EconomicDateInput): EconomicDateResolution {
  const candidates: EconomicDateCandidate[] = [];
  const ps = jour(input.periodStart);
  const pe = jour(input.periodEnd) ?? ps;
  if (ps) candidates.push({ type: 'PERIOD', date: ps, end: pe, retained: false, rejected: 'NEVER_ECONOMIC' });
  const ok = (r: Omit<EconomicDateResolution, 'version' | 'status' | 'reason' | 'candidates'>): EconomicDateResolution =>
    ({ version: ECONOMIC_DATE_RULE_VERSION, status: 'ESTABLISHED', reason: null, candidates, ...r });
  const non = (reason: EconomicDateUndeterminedReason, extra: Partial<EconomicDateResolution> = {}): EconomicDateResolution => ({
    version: ECONOMIC_DATE_RULE_VERSION, status: 'UNDETERMINED', date: null, basis: null, reason, provenance: null,
    justification: undeterminedNote(reason), candidates, ...extra,
  });

  // ── Dates disponibles, distinguées ────────────────────────────────────────
  const propreBrute = input.ownDate ?? null;
  const propre = jour(propreBrute);
  const rejectedOwnDate = propreBrute && !propre ? String(propreBrute) : null;
  if (rejectedOwnDate) candidates.push({ type: 'AMOUNT_DATE', date: rejectedOwnDate.slice(0, 10), origin: input.ownDateOrigin ?? null, retained: false, rejected: 'INVALID_DATE' });

  // Une prévision (devis, commande, tarif contractuel) est datée par son document ; une dépense, par le justificatif qui l'établit.
  const exclus = input.kind === 'FORECAST_COST' ? ROLES_SANS_PREVISION : ROLES_SANS_ENGAGEMENT;
  const docs = (input.documents ?? []).filter((d) => !exclus.has(String(d.role ?? '')));
  // Date de justificatif fournie mais impossible : signalée comme la date propre (jamais normalisée).
  const docInvalide = docs.map((d) => d.date).find((x) => !!x && !jour(x)) ?? null;
  const docFiles = new Set((input.documents ?? []).map((d) => d.fileId));
  const cur = String(input.currency ?? '').trim().toUpperCase();
  // Règlements attribuables à CETTE composante (jamais au seul montant quand plusieurs composantes l'ont).
  const paiements = (input.payments ?? []).filter((p) => p.amountMinor === input.amountMinor && String(p.currency ?? '').trim().toUpperCase() === cur);
  const attribuables: EconomicDatePayment[] = [];
  for (const p of paiements) {
    const d = jour(p.date);
    const pps = jour(p.periodStart);
    const ppe = jour(p.periodEnd) ?? pps;
    const memeJustificatif = p.fileId != null && docFiles.has(p.fileId);
    const periodeConcordante = ps && pe && pps && ppe ? chevauche(ps, pe, pps, ppe) : null;
    const seul = paiements.length === 1 && (input.sameAmountSiblings ?? 1) <= 1;
    const attribuable = periodeConcordante === false ? false : memeJustificatif || periodeConcordante === true || seul;
    if (!d) { candidates.push({ type: 'PAYMENT', date: String(p.date ?? '').slice(0, 10) || '?', fileId: p.fileId, origin: p.origin ?? null, retained: false, rejected: 'INVALID_DATE' }); continue; }
    if (!attribuable) { candidates.push({ type: 'PAYMENT', date: d, fileId: p.fileId, origin: p.origin ?? null, retained: false, rejected: 'NOT_ATTRIBUTABLE' }); continue; }
    attribuables.push({ ...p, date: d });
  }

  // 1. Paiement prouvé.
  const datesPaiement = [...new Set(attribuables.map((p) => p.date as string))].sort();
  if (datesPaiement.length > 1) {
    for (const p of attribuables) candidates.push({ type: 'PAYMENT', date: p.date as string, fileId: p.fileId, origin: p.origin ?? null, retained: false, rejected: 'CONTRADICTORY' });
    return non('AMBIGUOUS_PAYMENT', { rejectedOwnDate });
  }
  const paiement = attribuables[0] ?? null;
  if (paiement) {
    for (const p of attribuables) candidates.push({ type: 'PAYMENT', date: p.date as string, fileId: p.fileId, origin: p.origin ?? null, retained: p === paiement });
  }
  if (propre) candidates.push({ type: 'AMOUNT_DATE', date: propre, origin: input.ownDateOrigin ?? null, retained: !paiement, ...(paiement ? { rejected: 'SUPERSEDED' as const } : {}) });
  if (paiement) {
    pushDocs(candidates, docs, 'SUPERSEDED');
    pushOperation(candidates, input, 'SUPERSEDED');
    return ok({
      date: paiement.date as string, basis: 'PAYMENT', provenance: { type: 'PAYMENT', fileId: paiement.fileId, origin: paiement.origin ?? null },
      justification: `Date du paiement prouvé (${fr(paiement.date as string)}).`, rejectedOwnDate,
    });
  }

  // 2. Date propre du montant.
  if (propre) {
    pushDocs(candidates, docs, 'SUPERSEDED');
    pushOperation(candidates, input, 'SUPERSEDED');
    return ok({
      date: propre, basis: 'AMOUNT_DATE', provenance: { type: 'AMOUNT_DATE', fileId: null, origin: input.ownDateOrigin ?? null },
      justification: `Date indiquée pour ce montant par sa source (${fr(propre)}).`, rejectedOwnDate,
    });
  }

  // 3. Date du justificatif qui établit le montant (engagement), unique et non contradictoire.
  const datesDocs = [...new Set(docs.map((d) => jour(d.date)).filter((d): d is string => !!d))].sort();
  if (datesDocs.length > 1) {
    pushDocs(candidates, docs, 'CONTRADICTORY');
    pushOperation(candidates, input, 'SUPERSEDED');
    return non('CONTRADICTORY_DOCUMENT_DATES', { rejectedOwnDate });
  }
  if (datesDocs.length === 1) {
    const d = datesDocs[0];
    const doc = docs.find((x) => jour(x.date) === d)!;
    // Facturation anticipée d'une période couverte qui commence une année ultérieure : sans paiement prouvé,
    // l'année du décaissement n'est pas établie (ni la date du justificatif, ni le début de la période).
    if (ps && d < ps && an(d) < an(ps)) {
      pushDocs(candidates, docs, 'BEFORE_COVERED_PERIOD_OTHER_YEAR');
      pushOperation(candidates, input, 'SUPERSEDED');
      return non('ADVANCE_BILLING_UNPAID', { rejectedOwnDate });
    }
    pushDocs(candidates, docs, undefined, doc.fileId);
    pushOperation(candidates, input, 'SUPERSEDED');
    return ok({
      date: d, basis: 'DOCUMENT', provenance: { type: 'DOCUMENT', fileId: doc.fileId, origin: doc.role ?? null },
      justification: `Date du justificatif qui établit ce montant (${fr(d)}).`, rejectedOwnDate,
    });
  }

  // 4. Date de réalisation d'une Opération ponctuelle à fait unique, non contredite par la période couverte.
  const o = input.operation ?? null;
  const realise = o ? jour(o.realizedDate) : null;
  const refus = operationRejection(input, realise);
  if (o && realise && !refus && !rejectedOwnDate) {
    pushOperation(candidates, input, undefined);
    return ok({
      date: realise, basis: 'OPERATION_SINGLE_FACT', provenance: { type: 'OPERATION_REALIZED', fileId: null, origin: o.typeCode ?? null },
      justification: `Dépense ponctuelle unique : datée par la réalisation (${fr(realise)}).`, rejectedOwnDate,
    });
  }
  pushOperation(candidates, input, rejectedOwnDate ? 'OWN_DATE_INVALID' : undefined);
  const opDates = candidates.some((c) => c.type.startsWith('OPERATION_'));
  return non(ps ? 'PERIOD_ONLY' : opDates ? 'OPERATION_DATE_NOT_RELEVANT' : 'NO_EVIDENCE', { rejectedOwnDate: rejectedOwnDate ?? docInvalide });
}

/** Motif pour lequel la date de réalisation de l'Opération n'est pas celle de ce fait (null : elle l'est). */
function operationRejection(input: EconomicDateInput, realise: string | null): EconomicDateRejection | null {
  const o = input.operation;
  if (!o || !realise) return 'NOT_REALIZED';
  if (o.status !== 'REALIZED') return 'NOT_REALIZED';
  if (!PONCTUELLES.has(o.typeCode ?? null)) return 'RECURRING_OPERATION';
  if (o.factCount !== 1) return 'MULTIPLE_FACTS';
  const ps = jour(input.periodStart);
  const pe = jour(input.periodEnd) ?? ps;
  if (ps && pe && (an(realise) < an(ps) || an(realise) > an(pe))) return 'OUTSIDE_COVERED_PERIOD';
  return null;
}

function pushDocs(out: EconomicDateCandidate[], docs: readonly EconomicDateDocument[], rejected: EconomicDateRejection | undefined, retainedFile?: number): void {
  for (const d of docs) {
    const j = jour(d.date);
    if (!j) continue;
    const retained = retainedFile != null && d.fileId === retainedFile && !rejected;
    out.push({ type: 'DOCUMENT', date: j, fileId: d.fileId, origin: d.role ?? null, retained, ...(retained ? {} : { rejected: rejected ?? 'SUPERSEDED' }) });
  }
}

function pushOperation(out: EconomicDateCandidate[], input: EconomicDateInput, forced: EconomicDateRejection | undefined): void {
  const o = input.operation;
  if (!o) return;
  const realise = jour(o.realizedDate);
  if (realise) {
    const refus = forced ?? operationRejection(input, realise);
    out.push({ type: 'OPERATION_REALIZED', date: realise, origin: o.typeCode ?? null, retained: !refus, ...(refus ? { rejected: refus } : {}) });
  }
  const debut = jour(o.startDate);
  if (debut) out.push({ type: 'OPERATION_START', date: debut, origin: o.typeCode ?? null, retained: false, rejected: 'NEVER_ECONOMIC' });
  const prevue = jour(o.plannedDate);
  if (prevue) out.push({ type: 'OPERATION_PLANNED', date: prevue, origin: o.typeCode ?? null, retained: false, rejected: 'NEVER_ECONOMIC' });
}

/** Signature STABLE d'une résolution (ce qui est retenu, jamais la liste des candidats) : idempotence du contrôle. */
export function economicDateSignature(r: Pick<EconomicDateResolution, 'version' | 'status' | 'date' | 'basis' | 'reason' | 'provenance'>): string {
  return [r.version, r.status, r.date ?? '', r.basis ?? '', r.reason ?? '', r.provenance?.type ?? '', r.provenance?.fileId ?? ''].join('|');
}

/** Libellé court de la date d'une ligne (tiroir) : fondement, ou « Date non établie ». */
export function economicDateLabel(r: Pick<EconomicDateResolution, 'status' | 'basis'> | null | undefined): string | null {
  if (!r) return null;
  if (r.status === 'UNDETERMINED' || !r.basis) return 'Date non établie';
  return ECONOMIC_DATE_BASIS_LABELS[r.basis];
}

/** Composante d'une Opération à résoudre (forme commune lecteur Opérations / TCO / T2). */
interface EconomicDateComponent {
  id: number;
  kind: string;
  amountMinor: number;
  currency: string;
  economicDate: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  economicDateResolution?: EconomicDateResolution;
}

/** Preuves lues pour les composantes d'une Opération (absentes : seules la date propre et l'Opération sont connues). */
export interface EconomicDateEvidence {
  documents?: ReadonlyMap<number, readonly EconomicDateDocument[]>;
  origins?: ReadonlyMap<number, OwnDateOrigin>;
  payments?: readonly EconomicDatePayment[];
}

/**
 * Résout chaque composante d'UNE Opération, indépendamment (même règle pour
 * le lecteur des Opérations, le TCO et T2 — aucun second moteur). Une
 * composante déjà résolue (`economicDateResolution`) garde sa résolution.
 */
export function resolveOperationEconomicDates(
  op: { typeCode: string | null; status: string | null; realizedDate: string | null; startDate: string | null; plannedDate: string | null; components: readonly EconomicDateComponent[] },
  evidence: EconomicDateEvidence = {},
): Map<number, EconomicDateResolution> {
  const out = new Map<number, EconomicDateResolution>();
  const faits = op.components.filter((c) => c.kind !== 'FORECAST_COST');
  const cle = (c: EconomicDateComponent) => `${c.kind}:${c.amountMinor}:${String(c.currency ?? '').trim().toUpperCase()}`;
  const memes = new Map<string, number>();
  for (const c of op.components) memes.set(cle(c), (memes.get(cle(c)) ?? 0) + 1);
  for (const c of op.components) {
    if (c.economicDateResolution) { out.set(c.id, c.economicDateResolution); continue; }
    out.set(c.id, resolveEconomicDate({
      kind: c.kind, amountMinor: c.amountMinor, currency: c.currency, ownDate: c.economicDate, ownDateOrigin: evidence.origins?.get(c.id) ?? 'UNKNOWN',
      periodStart: c.periodStart ?? null, periodEnd: c.periodEnd ?? null,
      documents: evidence.documents?.get(c.id) ?? [], payments: evidence.payments ?? [], sameAmountSiblings: memes.get(cle(c)) ?? 1,
      operation: { typeCode: op.typeCode, status: op.status, realizedDate: op.realizedDate, startDate: op.startDate, plannedDate: op.plannedDate, factCount: faits.length },
    }));
  }
  return out;
}
