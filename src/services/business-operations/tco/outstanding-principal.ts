/**
 * Lot 112D — capital restant dû des prêts d'un bien (pur, sans import serveur).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AFFICHÉ SEULEMENT S'IL EST ÉTABLI — JAMAIS UN COÛT
 *
 * Établi, par ordre de priorité :
 *   1. CALCULÉ EXACTEMENT (`loan-amortization.ts`) à partir de conditions
 *      prouvées — montant emprunté, taux nominal, périodicité, durée, date
 *      de première échéance (échéance hors assurance contrôlée si lue,
 *      différé lu) — en repartant du dernier capital restant dû lu qui
 *      concorde, des remboursements anticipés saisis ; échéances passées
 *      présumées honorées (comme le coût du crédit, 111F) ;
 *   2. LU (document) ou SAISI (USER / ADMIN) à une date : le plus récent au
 *      plus tard aujourd'hui, affiché AVEC sa date ;
 *   3. avant la première échéance : le montant emprunté (aucune échéance
 *      échue, aucun différé total).
 * Sinon : « Capital restant dû non établi » + ce qui manque — jamais une
 * estimation silencieuse. Un tableau rendu obsolète par un avenant (111F :
 * justificatif plus récent qui remplace l'échéancier à sa date d'effet)
 * n'est plus lu au-delà de cette date.
 *
 * Le capital restant dû n'entre dans AUCUN total (coût total, coût annuel,
 * coût net, coût du crédit) : information seule (règle 111F).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { computeAmortization, type AmortizationEvent, type AmortizationOutcome } from './loan-amortization';
import { assembleLoanEvidence, LOAN_TERM_FIELDS, LOAN_TERM_LABELS, type LoanEvidence, type LoanStatement, type LoanTermField, type LoanValueOrigin } from './loan-evidence';
import type { FinancingComponentTreatment, TcoFinancing } from './financing';

export const TCO_OUTSTANDING_NOT_ESTABLISHED = 'Capital restant dû non établi';
export const TCO_OUTSTANDING_NEVER_COST = 'Le capital restant dû n’est jamais un coût : il n’entre ni dans le coût total, ni dans le coût annuel, ni dans le coût du crédit.';
const AJOUTER = 'Ajoutez le tableau d’amortissement ou une attestation de capital restant dû.';

export type TcoOutstandingMethod = 'COMPUTED' | 'DOCUMENT' | 'USER' | 'ADMIN' | 'NO_INSTALLMENT_DUE';

export interface TcoOutstandingPrincipal {
  status: 'ESTABLISHED' | 'NOT_ESTABLISHED';
  /** Capital restant dû (EUR, centimes) — null si non établi. */
  cents: number | null;
  /** Date à laquelle il vaut (dernière échéance prise en compte, date du relevé) ; null : aucune échéance échue. */
  asOf: string | null;
  method: TcoOutstandingMethod | null;
  /** Phrase sous la valeur (base de calcul, source et date) ou motif complet si non établi. */
  label: string;
  /** Justificatif qui porte la valeur lue (null : calcul ou saisie). */
  sourceFileId: number | null;
  /** Ce qui manque pour l'établir (libellés), vide si établi. */
  missing: string[];
  repaid: boolean;
  /** Échéance hors assurance (lue ou théorique) et assurance par échéance, distinctes. */
  installment: { cents: number; source: 'READ' | 'THEORETICAL'; insuranceCents: number | null } | null;
  /** Conditions retenues et leur origine (diagnostic BO, export). */
  terms: Partial<Record<LoanTermField, { value: unknown; origin: LoanValueOrigin }>>;
  /** Remarques (contradictions, relevé non concordant, avenant, différé…). */
  notes: string[];
  /** Code stable du calcul non abouti (diagnostic). */
  computeIssue: string | null;
  /**
   * Lot 112H : détail de CHAQUE condition pour le formulaire de saisie (fiche du
   * bien) — valeur retenue et son origine, valeur lue sur les documents et leurs
   * sources (même si une saisie prime), valeurs contradictoires. Absent : prêt
   * sans événement de référence (aucune saisie possible).
   */
  fields?: Record<LoanTermField, TcoLoanTermFieldState>;
  /** Lot 112H : un document mentionne un taux variable ou révisable. */
  variableRateMentioned?: boolean;
}

/** Lot 112H : état d'une condition du prêt (formulaire de saisie). */
export interface TcoLoanTermFieldState {
  /** Valeur retenue (saisie si elle existe, sinon lecture documentaire) ; null : non établie. */
  value: unknown;
  origin: LoanValueOrigin | null;
  /** Date de la saisie (USER / ADMIN). */
  enteredAt: string | null;
  /** Valeur lue sur les documents du prêt (même si une saisie prime) et les justificatifs qui la portent. */
  document: { value: unknown; sources: Array<{ fileId: number; title: string | null }> } | null;
  /** Valeurs contradictoires lues sur les documents (aucune retenue), null sinon. */
  documentConflict: string[] | null;
}

export interface TcoFinancingOutstanding {
  /** ESTABLISHED : tous les prêts établis ; PARTIAL : une partie ; NOT_ESTABLISHED : aucun. */
  status: 'ESTABLISHED' | 'PARTIAL' | 'NOT_ESTABLISHED';
  /** Somme des capitaux restants dus — seulement si TOUS les prêts sont établis. */
  cents: number | null;
  text: string;
}

const frDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const eurFr = (c: number) => `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

const REQUIS: readonly LoanTermField[] = ['principalCents', 'ratePct', 'periodicity', 'durationMonths', 'firstInstallmentDate'];

const ISSUE_TEXT: Record<string, string> = {
  INSTALLMENT_MISMATCH: 'l’échéance hors assurance ne correspond pas au montant, au taux et à la durée lus',
  DURATION_PERIODICITY: 'la durée n’est pas un nombre entier d’échéances',
  DEFERRAL_TOO_LONG: 'le différé couvre toute la durée du prêt',
  SCHEDULE_CHANGED: 'l’échéancier a été modifié (avenant, report ou remboursement anticipé) sans nouveau capital restant dû connu',
  EARLY_REPAYMENT_MODE_UNKNOWN: 'un remboursement anticipé a eu lieu sans nouvelle échéance ni durée réduite connue',
  EARLY_REPAYMENT_DURING_DEFERRAL: 'un remboursement anticipé a eu lieu avant le début de l’amortissement',
  BALANCE_MISMATCH: 'le capital restant dû lu ne concorde pas avec le calcul',
  INVALID_TERMS: 'les conditions du prêt sont invalides',
};

/**
 * Capital restant dû d'UN prêt (pure, testée L112D-OUT-*).
 */
export function resolveOutstandingPrincipal(input: {
  evidence: LoanEvidence;
  /** Avenants constatés (111F) : date d'effet et justificatif qui remplace l'échéancier. */
  scheduleChanges: ReadonlyArray<{ date: string; byFileId: number }>;
  documents: ReadonlyMap<number, { title: string | null; date: string | null }>;
  today: string;
}): TcoOutstandingPrincipal {
  const { evidence: ev, today } = input;
  const notes: string[] = [];
  const terms: TcoOutstandingPrincipal['terms'] = {};
  for (const [k, v] of Object.entries(ev.terms)) if (v) terms[k as LoanTermField] = { value: v.value, origin: v.origin };
  for (const [k, vals] of Object.entries(ev.conflicts)) if (vals?.length) notes.push(`Valeurs contradictoires pour ${LOAN_TERM_LABELS[k as LoanTermField]} (${vals.join(' / ')}) : aucune n’est retenue.`);
  if (ev.statementConflicts.length) notes.push(`Capitaux restants dus contradictoires au ${ev.statementConflicts.map(frDate).join(', ')} : ignorés.`);
  const insuranceCents = ev.terms.insuranceCents?.value ?? null;

  // Relevés admissibles : au plus tard aujourd'hui, non rendus obsolètes par un avenant plus récent.
  const dateDoc = (f: number | null) => (f == null ? null : input.documents.get(f)?.date ?? null);
  const obsolete = (s: LoanStatement) => s.fileId != null && input.scheduleChanges.some((c) =>
    c.byFileId !== s.fileId && s.date >= c.date && (() => { const a = dateDoc(s.fileId); const b = dateDoc(c.byFileId); return !a || !b || a < b; })());
  const releves = ev.statements.filter((s) => s.date <= today && !obsolete(s));
  const dernier = releves.length ? releves[releves.length - 1] : null;

  const missing = REQUIS.filter((f) => !ev.terms[f]).map((f) => LOAN_TERM_LABELS[f]);
  if (ev.deferralMentioned && !ev.terms.deferral) missing.push(LOAN_TERM_LABELS.deferral);
  if (ev.variableRateMentioned && ev.terms.ratePct?.origin === 'DOCUMENT') notes.push('Taux variable ou révisable mentionné : le capital restant dû n’est pas calculé (taux futur inconnu).');
  const calculable = !missing.length && !(ev.variableRateMentioned && ev.terms.ratePct?.origin === 'DOCUMENT');

  let issue: string | null = null;
  let issueAt: string | null = null;
  let outcome: AmortizationOutcome | null = null;
  if (calculable) {
    const t = ev.terms;
    const deferral = t.deferral && t.deferral.value.kind !== 'NONE' && t.deferral.value.months > 0 ? { months: t.deferral.value.months, kind: t.deferral.value.kind } : null;
    const events: AmortizationEvent[] = [
      ...releves.map((s): AmortizationEvent => ({ kind: 'BALANCE', date: s.date, cents: s.cents, ref: s.ref })),
      ...ev.earlyRepayments.map((e): AmortizationEvent => ({ kind: 'EARLY_REPAYMENT', date: e.date, cents: e.amountCents, mode: e.mode ?? null, newInstallmentCents: e.newInstallmentCents ?? null, ref: `saisie:${e.id}` })),
      ...input.scheduleChanges.map((c): AmortizationEvent => ({ kind: 'SCHEDULE_CHANGE', date: c.date, ref: `avenant:${c.byFileId}` })),
    ];
    outcome = computeAmortization({
      principalCents: t.principalCents!.value, ratePct: t.ratePct!.value, periodicity: t.periodicity!.value, durationMonths: t.durationMonths!.value,
      firstInstallmentDate: t.firstInstallmentDate!.value, installmentCents: t.installmentCents?.value ?? null, deferral,
    }, events, today);
    if (!outcome.ok) {
      issue = outcome.code; issueAt = outcome.at;
      notes.push(`Calcul non établi : ${ISSUE_TEXT[outcome.code] ?? outcome.detail}${outcome.at ? ` (${frDate(outcome.at)})` : ''}${outcome.code === 'INSTALLMENT_MISMATCH' && outcome.expectedInstallmentCents != null ? ` — échéance attendue ${eurFr(outcome.expectedInstallmentCents)}` : ''}.`);
      for (const c of outcome.balanceChecks.filter((x) => !x.concordant)) notes.push(`Capital lu au ${frDate(c.date)} : ${eurFr(c.statedCents)} ; calcul : ${eurFr(c.computedCents)}.`);
    }
  }

  const base = {
    terms, notes, computeIssue: issue, sourceFileId: null as number | null, missing: [] as string[],
    fields: loanTermFieldStates(ev, input.documents), variableRateMentioned: ev.variableRateMentioned,
  };
  const installment = (o: AmortizationOutcome | null) => (o && o.ok ? { cents: o.installmentUsedCents, source: o.installmentSource, insuranceCents } : null);
  const sourceLabel = (s: LoanStatement): string => {
    if (s.origin === 'USER') return `Saisi par vous au ${frDate(s.date)}`;
    if (s.origin === 'ADMIN') return `Saisi par le support Verebona au ${frDate(s.date)}`;
    const titre = s.fileId != null ? input.documents.get(s.fileId)?.title : null;
    return `Lu sur ${titre ? `« ${titre} »` : 'un justificatif du prêt'} au ${frDate(s.date)}`;
  };
  const methodOf = (s: LoanStatement): TcoOutstandingMethod => (s.origin === 'USER' ? 'USER' : s.origin === 'ADMIN' ? 'ADMIN' : 'DOCUMENT');

  // 1. Calcul exact abouti.
  if (outcome && outcome.ok) {
    const releveCourant = dernier && outcome.lastBalanceRef === dernier.ref && dernier.date === outcome.asOf ? dernier : null;
    if (releveCourant) {
      return {
        ...base, status: 'ESTABLISHED', cents: outcome.cents, asOf: outcome.asOf, method: methodOf(releveCourant), sourceFileId: releveCourant.fileId,
        label: `${sourceLabel(releveCourant)} (concorde avec le calcul selon les conditions du prêt).`, repaid: outcome.repaid, installment: installment(outcome),
      };
    }
    const depuis = outcome.lastBalanceRef ? releves.find((r) => r.ref === outcome!.lastBalanceRef) : null;
    const quand = outcome.repaid ? 'prêt intégralement remboursé' : outcome.asOf ? `après l’échéance du ${frDate(outcome.asOf)}` : 'aucune échéance échue';
    return {
      ...base, status: 'ESTABLISHED', cents: outcome.cents, asOf: outcome.asOf, method: 'COMPUTED',
      label: `Calculé selon les conditions du prêt (montant, taux, durée${outcome.installmentSource === 'READ' ? ', échéance' : ''})${depuis ? `, à partir du capital ${depuis.origin === 'DOCUMENT' ? 'lu' : 'saisi'} au ${frDate(depuis.date)}` : ''} — ${quand} ; échéances passées présumées honorées.`,
      repaid: outcome.repaid, installment: installment(outcome),
    };
  }

  // 2. Dernier capital restant dû lu ou saisi, avec sa date.
  if (dernier) {
    const apres = issueAt && issueAt > dernier.date ? ` Événement postérieur non déduit (${frDate(issueAt)}).` : '';
    return {
      ...base, status: 'ESTABLISHED', cents: dernier.cents, asOf: dernier.date, method: methodOf(dernier), sourceFileId: dernier.fileId,
      label: `${sourceLabel(dernier)}.${apres}`, repaid: dernier.cents === 0, installment: null,
    };
  }

  // 3. Avant la première échéance : le montant emprunté (sans différé total).
  const premiere = ev.terms.firstInstallmentDate?.value;
  const capital = ev.terms.principalCents?.value;
  if (premiere && capital && today < premiere && ev.terms.deferral?.value.kind !== 'TOTAL' && !(ev.deferralMentioned && !ev.terms.deferral)) {
    return {
      ...base, status: 'ESTABLISHED', cents: capital, asOf: null, method: 'NO_INSTALLMENT_DUE',
      label: `Montant emprunté : aucune échéance échue avant le ${frDate(premiere)}.`, repaid: false, installment: null,
    };
  }

  // Non établi : ce qui manque, jamais d'estimation.
  const manque = issue ? [] : missing;
  const motif = issue
    ? `${TCO_OUTSTANDING_NOT_ESTABLISHED} : ${ISSUE_TEXT[issue] ?? 'calcul impossible'}. ${AJOUTER}`
    : `${TCO_OUTSTANDING_NOT_ESTABLISHED}${manque.length ? ` : il manque ${joinFr(manque)}` : ''}. ${AJOUTER}`;
  return { ...base, missing: manque, status: 'NOT_ESTABLISHED', cents: null, asOf: null, method: null, label: motif, repaid: false, installment: null };
}

/**
 * Lot 112H : état de chaque condition (pure). Montant emprunté lu sans justificatif précis (capital consolidé) :
 * sources = tous les justificatifs du prêt.
 */
function loanTermFieldStates(ev: LoanEvidence, documents: ReadonlyMap<number, { title: string | null; date: string | null }>): Record<LoanTermField, TcoLoanTermFieldState> {
  const docs = ev.documentTerms ?? Object.fromEntries(Object.entries(ev.terms).filter(([, v]) => v?.origin === 'DOCUMENT'));
  const conflits = ev.documentConflicts ?? ev.conflicts;
  const out = {} as Record<LoanTermField, TcoLoanTermFieldState>;
  for (const f of LOAN_TERM_FIELDS) {
    const t = ev.terms[f];
    const d = (docs as LoanEvidence['terms'])[f];
    const ids = d ? (d.fileIds.length ? d.fileIds : [...documents.keys()]) : [];
    out[f] = {
      value: t?.value ?? null,
      origin: t?.origin ?? null,
      enteredAt: t && t.origin !== 'DOCUMENT' ? t.at ?? null : null,
      document: d ? { value: d.value, sources: ids.map((fileId) => ({ fileId, title: documents.get(fileId)?.title ?? null })) } : null,
      documentConflict: conflits[f]?.length ? [...conflits[f]!] : null,
    };
  }
  return out;
}

function joinFr(l: readonly string[]): string {
  return l.length <= 1 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} et ${l[l.length - 1]}`;
}

/** Synthèse des prêts du bien (pure) : total seulement si TOUS les capitaux restants dus sont établis. */
export function summarizeOutstanding(list: ReadonlyArray<TcoOutstandingPrincipal | null | undefined>): TcoFinancingOutstanding {
  const l = list.filter((x): x is TcoOutstandingPrincipal => !!x);
  const etablis = l.filter((x) => x.status === 'ESTABLISHED');
  if (l.length && etablis.length === l.length) {
    const cents = etablis.reduce((n, x) => n + (x.cents ?? 0), 0);
    return { status: 'ESTABLISHED', cents, text: `${l.length > 1 ? `Somme des ${l.length} prêts. ` : ''}${TCO_OUTSTANDING_NEVER_COST}` };
  }
  if (etablis.length) return { status: 'PARTIAL', cents: null, text: `Établi pour ${etablis.length} prêt(s) sur ${l.length} : aucun total n’est affiché. ${TCO_OUTSTANDING_NEVER_COST}` };
  return { status: 'NOT_ESTABLISHED', cents: null, text: `${l.length === 1 ? l[0].label : `${TCO_OUTSTANDING_NOT_ESTABLISHED} pour ${l.length} prêts.`} ${TCO_OUTSTANDING_NEVER_COST}` };
}

/**
 * Lot 112D : rattache le capital restant dû à chaque prêt consolidé (111F) et
 * la synthèse au financement — aucun montant de coût n'est modifié.
 */
export function attachOutstandingPrincipal(financing: TcoFinancing, input: {
  evidence: ReadonlyMap<number, LoanEvidence> | undefined;
  /** Traitements 111F des composantes de chaque prêt (avenants : SUPERSEDED). */
  plans: ReadonlyMap<number, ReadonlyMap<number, FinancingComponentTreatment>>;
  documents: ReadonlyMap<number, ReadonlyArray<{ fileId: number; title: string | null; date: string | null }>>;
  today: string;
}): void {
  for (const loan of financing.loans) {
    if (loan.operationId == null) {
      loan.outstanding = {
        status: 'NOT_ESTABLISHED', cents: null, asOf: null, method: null, sourceFileId: null, repaid: false, installment: null, terms: {}, notes: [], computeIssue: null,
        missing: [LOAN_TERM_LABELS.principalCents],
        label: `${TCO_OUTSTANDING_NOT_ESTABLISHED} : justificatif de financement sans prêt consolidé. ${AJOUTER}`,
      };
      continue;
    }
    const ev = input.evidence?.get(loan.operationId) ?? assembleLoanEvidence({
      principal: { cents: loan.principalCents, currency: loan.principalCents != null ? 'EUR' : null }, facts: [], tables: [], manual: null,
    });
    const changes = new Map<string, { date: string; byFileId: number }>();
    for (const t of input.plans.get(loan.operationId)?.values() ?? []) {
      if (t.kind === 'SUPERSEDED') changes.set(`${t.effectiveFrom}|${t.byFileId}`, { date: t.effectiveFrom, byFileId: t.byFileId });
    }
    const docs = new Map((input.documents.get(loan.operationId) ?? []).map((d) => [d.fileId, { title: d.title, date: d.date }]));
    loan.outstanding = resolveOutstandingPrincipal({ evidence: ev, scheduleChanges: [...changes.values()], documents: docs, today: input.today });
  }
  financing.outstanding = financing.loans.length ? summarizeOutstanding(financing.loans.map((l) => l.outstanding)) : null;
}
