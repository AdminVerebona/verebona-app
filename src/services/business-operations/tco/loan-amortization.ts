/**
 * Lot 112D — capital restant dû d'un prêt : calcul EXACT (pur, sans import serveur).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FORMULE D'AMORTISSEMENT STANDARD, EN CENTIMES, SANS ARRONDI INTERMÉDIAIRE
 *
 * Le capital restant dû n'est jamais un coût (règle 111F) : ce module ne
 * produit qu'une information, jamais une ligne TCO.
 *
 *   · taux périodique PROPORTIONNEL : i = taux nominal annuel / nombre
 *     d'échéances par an (usage des prêts amortissables en France) ;
 *   · échéance constante hors assurance M (lue, ou théorique
 *     M = C·i·(1+i)^n / ((1+i)^n − 1) ; taux 0 : M = C / n) ;
 *   · différé PARTIEL (intérêts seuls payés, capital inchangé) ou TOTAL
 *     (intérêts capitalisés) pendant les premières échéances, compris dans la
 *     durée totale ;
 *   · après chaque échéance : CRD ← CRD·(1+i) − M, en nombres RATIONNELS
 *     exacts (BigInt) — un seul arrondi, au centime le plus proche, à la fin ;
 *     la dernière échéance du contrat solde le prêt (CRD = 0) ;
 *   · l'assurance emprunteur n'entre jamais dans le calcul (affichée à part).
 *
 * Événements datés (ordre chronologique ; à date égale : échéance, puis
 * remboursement anticipé, puis capital lu) :
 *   · BALANCE (capital restant dû lu ou saisi à une date) : s'il concorde
 *     avec le calcul (écart ≤ 1 centime par échéance écoulée, arrondis de la
 *     banque), il le REMPLACE et le calcul repart de lui ; sinon le calcul
 *     s'arrête (BALANCE_MISMATCH) — jamais de valeur « moyenne » ;
 *   · EARLY_REPAYMENT (remboursement anticipé) : capital diminué du montant ;
 *     durée réduite (même échéance) ou nouvelle échéance connue ; mode
 *     inconnu → calcul arrêté à cette date ;
 *   · SCHEDULE_CHANGE (avenant / renégociation / report constaté par 111F,
 *     sans nouvelles conditions) → calcul arrêté à sa date d'effet.
 * Dates : jours civils (Europe/Paris, `today` fourni par l'appelant) ; une
 * échéance datée d'aujourd'hui est échue.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type LoanPeriodicity = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
export const LOAN_PERIODICITIES: readonly LoanPeriodicity[] = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'];
export const LOAN_PERIOD_MONTHS: Readonly<Record<LoanPeriodicity, number>> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 };
export type LoanDeferralKind = 'PARTIAL' | 'TOTAL';
/** Borne du calcul : 50 ans (600 mois). */
export const LOAN_MAX_DURATION_MONTHS = 600;

export interface AmortizationTerms {
  /** Montant emprunté (EUR, centimes, > 0). */
  principalCents: number;
  /** Taux nominal annuel en pourcentage, écriture décimale exacte (« 3.25 »). */
  ratePct: string;
  periodicity: LoanPeriodicity;
  /** Durée totale en mois, différé compris. */
  durationMonths: number;
  /** Date de la première échéance (AAAA-MM-JJ). */
  firstInstallmentDate: string;
  /** Échéance constante hors assurance LUE ou saisie (centimes) ; null : théorique. */
  installmentCents: number | null;
  /** Différé (mois, nature) ; null : aucun. */
  deferral: { months: number; kind: LoanDeferralKind } | null;
}

export type AmortizationEvent =
  | { kind: 'BALANCE'; date: string; cents: number; ref: string }
  | { kind: 'EARLY_REPAYMENT'; date: string; cents: number; mode: 'REDUCED_DURATION' | 'NEW_INSTALLMENT' | null; newInstallmentCents: number | null; ref: string }
  | { kind: 'SCHEDULE_CHANGE'; date: string; ref: string };

export type AmortizationFailureCode =
  | 'INVALID_TERMS' | 'DURATION_PERIODICITY' | 'DEFERRAL_TOO_LONG' | 'INSTALLMENT_MISMATCH'
  | 'SCHEDULE_CHANGED' | 'EARLY_REPAYMENT_MODE_UNKNOWN' | 'EARLY_REPAYMENT_DURING_DEFERRAL' | 'BALANCE_MISMATCH';

export interface BalanceCheck { ref: string; date: string; statedCents: number; computedCents: number; concordant: boolean }

export type AmortizationOutcome =
  | {
    ok: true;
    /** Capital restant dû après les échéances et événements datés au plus tard `today`. */
    cents: number;
    /** Date de la dernière échéance ou du dernier événement pris en compte ; null : aucune échéance échue. */
    asOf: string | null;
    installmentsElapsed: number;
    installmentsTotal: number;
    repaid: boolean;
    /** Échéance théorique hors assurance (arrondie au centime pour l'affichage) et échéance retenue. */
    theoreticalInstallmentCents: number;
    installmentUsedCents: number;
    installmentSource: 'READ' | 'THEORETICAL';
    /** Dernier événement pris en compte (capital lu / saisi qui a remplacé le calcul). */
    lastBalanceRef: string | null;
    balanceChecks: BalanceCheck[];
  }
  | { ok: false; code: AmortizationFailureCode; at: string | null; detail: string; expectedInstallmentCents?: number; balanceChecks: BalanceCheck[] };

// Constantes BigInt (cible ES2017 : pas de littéraux BigInt).
const B0 = BigInt(0); const B1 = BigInt(1); const B2 = BigInt(2); const B10 = BigInt(10); const B100 = BigInt(100);

// ── Dates civiles ──────────────────────────────────────────────────────────

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
export const isCivilDate = (d: unknown): d is string => {
  if (typeof d !== 'string' || !ISO.test(d)) return false;
  const [y, m, j] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, j));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === j;
};
const pad = (n: number) => String(n).padStart(2, '0');

/** Date + `months` mois, jour ancré sur celui de la première échéance (31 → dernier jour du mois). */
export function addMonthsAnchored(first: string, months: number): string {
  const [y, m, d] = first.split('-').map(Number);
  const total = (m - 1) + months;
  const yy = y + Math.floor(total / 12);
  const mm = ((total % 12) + 12) % 12;
  const fin = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${pad(mm + 1)}-${pad(Math.min(d, fin))}`;
}

// ── Taux exact ─────────────────────────────────────────────────────────────

/** « 3,25 » / « 3.250 » → { num: 3250n, den: 1000n } ; null si invalide ou hors [0 ; 100[. */
export function parseRatePct(v: string | null | undefined): { num: bigint; den: bigint; text: string } | null {
  if (v == null) return null;
  const s = String(v).trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d{1,6})?$/.test(s)) return null;
  const [ent, dec = ''] = s.split('.');
  const num = BigInt(ent + dec);
  const den = B10 ** BigInt(dec.length);
  const text = dec.replace(/0+$/, '') ? `${Number(ent)}.${dec.replace(/0+$/, '')}` : String(Number(ent));
  return { num, den, text };
}

const roundHalfUp = (num: bigint, den: bigint): bigint => (num <= B0 ? B0 : (B2 * num + den) / (B2 * den));

/**
 * Calcul exact du capital restant dû à `today` (pure, testée L112D-AMO-*).
 */
export function computeAmortization(terms: AmortizationTerms, events: readonly AmortizationEvent[], today: string): AmortizationOutcome {
  const checks: BalanceCheck[] = [];
  const fail = (code: AmortizationFailureCode, at: string | null, detail: string, extra: { expectedInstallmentCents?: number } = {}): AmortizationOutcome =>
    ({ ok: false, code, at, detail, ...extra, balanceChecks: checks });
  const rate = parseRatePct(terms.ratePct);
  const p = LOAN_PERIOD_MONTHS[terms.periodicity];
  if (!rate || !p || !Number.isSafeInteger(terms.principalCents) || terms.principalCents <= 0 || !isCivilDate(terms.firstInstallmentDate) || !isCivilDate(today)
    || !Number.isSafeInteger(terms.durationMonths) || terms.durationMonths < 1 || terms.durationMonths > LOAN_MAX_DURATION_MONTHS
    || (terms.installmentCents != null && (!Number.isSafeInteger(terms.installmentCents) || terms.installmentCents <= 0))) {
    return fail('INVALID_TERMS', null, 'Conditions du prêt invalides.');
  }
  if (terms.durationMonths % p !== 0) return fail('DURATION_PERIODICITY', null, 'La durée n’est pas un nombre entier d’échéances.');
  const N = terms.durationMonths / p;
  const defMonths = terms.deferral?.months ?? 0;
  if (!Number.isSafeInteger(defMonths) || defMonths < 0 || defMonths % p !== 0) return fail('DURATION_PERIODICITY', null, 'La durée du différé n’est pas un nombre entier d’échéances.');
  const D = defMonths / p;
  if (D >= N) return fail('DEFERRAL_TOO_LONG', null, 'Le différé couvre toute la durée du prêt.');
  const total = terms.deferral?.kind === 'TOTAL';

  // i = a / b (taux proportionnel) ; taux 0 : a = 0, b = 1.
  const zero = rate.num === B0;
  const a = zero ? B0 : rate.num;
  const b = zero ? B1 : rate.den * B100 * BigInt(12 / p);
  const q = a + b;
  const puissB: bigint[] = [B1];
  const bp = (k: number): bigint => { while (puissB.length <= k) puissB.push(puissB[puissB.length - 1] * b); return puissB[k]; };

  // Échéance théorique sur les conditions initiales (contrôle de l'échéance lue) : base après différé.
  const n = N - D;
  // Base = C·q^D / b^D (différé total) ou C ; M = base·a·q^n / (b·(q^n − b^n)) ; taux 0 : base / n.
  const baseNum = BigInt(terms.principalCents) * (total ? q ** BigInt(D) : B1);
  const baseDen = total ? bp(D) : B1;
  let thNum: bigint; let thDen: bigint;
  if (zero) { thNum = baseNum; thDen = baseDen * BigInt(n); } else {
    const qn = q ** BigInt(n); const bn = bp(n);
    thNum = baseNum * a * qn; thDen = baseDen * b * (qn - bn);
  }
  const theoreticalInstallmentCents = Number(roundHalfUp(thNum, thDen));
  if (terms.installmentCents != null) {
    const ecart = BigInt(terms.installmentCents) * thDen - thNum;
    if ((ecart < B0 ? -ecart : ecart) > thDen) {
      return fail('INSTALLMENT_MISMATCH', null, 'L’échéance hors assurance ne correspond pas au montant, au taux et à la durée.', { expectedInstallmentCents: theoreticalInstallmentCents });
    }
  }

  // État exact : CRD = num / (Md · b^pw) ; échéance M = Mn / Md (null : pas encore fixée).
  let Md = B1; let pw = 0; let num = BigInt(terms.principalCents); let Mn: bigint | null = null;
  let installmentSource: 'READ' | 'THEORETICAL' = terms.installmentCents != null ? 'READ' : 'THEORETICAL';
  const den = () => Md * bp(pw);
  const arrondi = () => Number(roundHalfUp(num, den()));
  const fixerEcheance = (remaining: number) => {
    if (terms.installmentCents != null) { Mn = BigInt(terms.installmentCents) * Md; return; }
    // Théorique EXACTE sur le capital courant (`remaining` échéances d'amortissement).
    if (zero) { const K = BigInt(remaining) * bp(pw); const crdNum = num; num *= K; Md *= K; Mn = crdNum; return; }
    const qr = q ** BigInt(remaining); const br = bp(remaining);
    const K = bp(pw + 1) * (qr - br);
    const crdNum = num;
    num *= K; Md *= K;
    Mn = crdNum * a * qr;
  };

  const dates = Array.from({ length: N }, (_, j) => addMonthsAnchored(terms.firstInstallmentDate, j * p));
  const evts = [...events].filter((e) => isCivilDate(e.date) && e.date <= today)
    .sort((x, y) => x.date.localeCompare(y.date) || ordre(x) - ordre(y));
  let ei = 0;
  let asOf: string | null = null;
  let elapsed = 0;
  let repaid = false;
  let lastBalanceRef: string | null = null;
  const changeAt: string | null = evts.find((e) => e.kind === 'SCHEDULE_CHANGE')?.date ?? null;

  const appliquer = (e: AmortizationEvent): AmortizationOutcome | null => {
    if (e.kind === 'SCHEDULE_CHANGE') return fail('SCHEDULE_CHANGED', e.date, 'L’échéancier a été modifié (avenant, report ou remboursement anticipé) sans nouvelles conditions connues.');
    if (e.kind === 'EARLY_REPAYMENT') {
      if (Mn === null && elapsed < N) return fail('EARLY_REPAYMENT_DURING_DEFERRAL', e.date, 'Remboursement anticipé avant le début de l’amortissement : calcul non établi.');
      if (BigInt(e.cents) * den() >= num) { num = B0; repaid = true; asOf = e.date; return null; }
      if (e.mode === 'NEW_INSTALLMENT' && e.newInstallmentCents != null && e.newInstallmentCents > 0) {
        num -= BigInt(e.cents) * den(); Mn = BigInt(e.newInstallmentCents) * Md; installmentSource = 'READ'; asOf = e.date; return null;
      }
      if (e.mode === 'REDUCED_DURATION') { num -= BigInt(e.cents) * den(); asOf = e.date; return null; }
      return fail('EARLY_REPAYMENT_MODE_UNKNOWN', e.date, 'Remboursement anticipé sans nouvelle échéance ni durée réduite connue.');
    }
    // BALANCE : concordance avec le calcul (≤ 1 centime par échéance écoulée), puis remplacement.
    const calc = repaid ? 0 : arrondi();
    const concordant = Math.abs(calc - e.cents) <= Math.max(1, elapsed);
    checks.push({ ref: e.ref, date: e.date, statedCents: e.cents, computedCents: calc, concordant });
    if (!concordant) return fail('BALANCE_MISMATCH', e.date, 'Le capital restant dû lu ne concorde pas avec le calcul (remboursement anticipé ou avenant non documenté possible).');
    num = BigInt(e.cents) * den(); repaid = e.cents === 0; asOf = e.date; lastBalanceRef = e.ref;
    return null;
  };

  for (let j = 0; j < N && !repaid; j++) {
    const dj = dates[j];
    if (dj > today) break;
    // Événements antérieurs à cette échéance.
    while (ei < evts.length && evts[ei].date < dj) { const r = appliquer(evts[ei++]); if (r) return r; if (repaid) break; }
    if (repaid) break;
    if (changeAt && dj >= changeAt) { const r = appliquer({ kind: 'SCHEDULE_CHANGE', date: changeAt, ref: 'schedule' }); if (r) return r; }
    if (j < D) {
      if (total) { num *= q; pw += 1; }
    } else {
      if (Mn === null) fixerEcheance(N - j);
      num = num * q - (Mn ?? B0) * bp(pw + 1);
      pw += 1;
      if (j === N - 1 || num <= B0) { num = B0; repaid = true; }
    }
    elapsed = j + 1;
    asOf = dj;
    // Événements du même jour (après l'échéance).
    while (ei < evts.length && evts[ei].date === dj) { const r = appliquer(evts[ei++]); if (r) return r; }
  }
  while (!repaid && ei < evts.length) { const r = appliquer(evts[ei++]); if (r) return r; }
  if (Mn === null && !repaid) fixerEcheance(N - Math.max(D, elapsed));
  const installmentUsedCents = Mn === null ? theoreticalInstallmentCents : Number(roundHalfUp(Mn, Md));
  return {
    ok: true, cents: repaid ? 0 : arrondi(), asOf, installmentsElapsed: elapsed, installmentsTotal: N, repaid,
    theoreticalInstallmentCents, installmentUsedCents, installmentSource, lastBalanceRef, balanceChecks: checks,
  };
}

function ordre(e: AmortizationEvent): number {
  return e.kind === 'SCHEDULE_CHANGE' ? 0 : e.kind === 'EARLY_REPAYMENT' ? 1 : 2;
}
