/**
 * Lot 112D — preuves du capital restant dû et des conditions d'un prêt (pur, sans import serveur).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LECTURE DÉTERMINISTE, JAMAIS D'ESTIMATION
 *
 * Sources lues (aucune IA à la consultation) :
 *   · DOCUMENTS du prêt (justificatifs de l'Opération FINANCING) :
 *       – tableaux T1 (`document_tables`) : colonne « capital restant dû » /
 *         « CRD » / « restant dû » + colonne de dates → un capital restant dû
 *         LU par ligne datée ;
 *       – faits T1 (`document_facts`, confiance « certain ») : clés stables du
 *         bloc PO facultatif (étape 20, `loan.*`) puis libellés explicites :
 *         taux nominal / débiteur (jamais TAEG, TAEA, taux d'assurance ou
 *         taux variable), durée, date de première échéance, échéance HORS
 *         assurance (ou assurance comprise + assurance par échéance),
 *         assurance par échéance, différé, capital restant dû à une date
 *         écrite (jamais la date du document par défaut) ;
 *       – montant emprunté : `business_operation_financing_details`
 *         (consolidé depuis LOAN_PRINCIPAL).
 *   · SAISIES USER / ADMIN (`business_operation_financing_details`,
 *     migration 1415) : PRIORITAIRES champ par champ, jamais remplacées par
 *     une lecture documentaire.
 * Deux documents qui donnent deux valeurs différentes pour un même champ :
 * contradiction, champ NON établi (jamais de choix silencieux).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isCivilDate, LOAN_MAX_DURATION_MONTHS, parseRatePct, type LoanDeferralKind, type LoanPeriodicity } from './loan-amortization';

export type LoanValueOrigin = 'DOCUMENT' | 'USER' | 'ADMIN';
export type LoanTermField = 'principalCents' | 'ratePct' | 'periodicity' | 'durationMonths' | 'firstInstallmentDate' | 'installmentCents' | 'insuranceCents' | 'deferral';
export const LOAN_TERM_FIELDS: readonly LoanTermField[] = ['principalCents', 'ratePct', 'periodicity', 'durationMonths', 'firstInstallmentDate', 'installmentCents', 'insuranceCents', 'deferral'];

export interface LoanDeferralValue { months: number; kind: LoanDeferralKind | 'NONE' }
export interface LoanTermValues {
  principalCents: number;
  ratePct: string;
  periodicity: LoanPeriodicity;
  durationMonths: number;
  firstInstallmentDate: string;
  installmentCents: number;
  insuranceCents: number;
  deferral: LoanDeferralValue;
}

/** Libellés utilisateur des champs (motif « ce qui manque »). */
export const LOAN_TERM_LABELS: Readonly<Record<LoanTermField, string>> = {
  principalCents: 'le montant emprunté',
  ratePct: 'le taux nominal',
  periodicity: 'la périodicité des échéances',
  durationMonths: 'la durée du prêt',
  firstInstallmentDate: 'la date de la première échéance',
  installmentCents: 'l’échéance hors assurance',
  insuranceCents: 'l’assurance par échéance',
  deferral: 'la durée et la nature du différé',
};

/** Clés stables du bloc PO facultatif (étape 20) — lues en priorité, à l'identique. */
export const LOAN_FACT_CODES = {
  ratePct: 'loan.nominal_rate_pct',
  periodicity: 'loan.periodicity',
  durationMonths: 'loan.duration_months',
  firstInstallmentDate: 'loan.first_installment_date',
  installmentCents: 'loan.installment_excl_insurance',
  installmentWithInsurance: 'loan.installment_incl_insurance',
  insuranceCents: 'loan.insurance_per_installment',
  deferralMonths: 'loan.deferral_months',
  deferralKind: 'loan.deferral_kind',
  outstanding: 'loan.outstanding_principal',
} as const;

export interface LoanFactInput {
  fileId: number;
  factKey: string | null;
  rawKey: string | null;
  label: string | null;
  subject: string | null;
  attribute: string | null;
  valueText: string | null;
  valueNumber: string | number | null;
  valueUnit: string | null;
  normalizedValue: string | null;
  valueType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  excerpt: string | null;
  confidence: string | null;
}

export interface LoanTableInput {
  fileId: number;
  tableId: number;
  uncertain: boolean;
  columns: readonly string[];
  cells: ReadonlyArray<{ row: number; column: number; value: string | null; normalized: string | null; confidence: string | null }>;
}

export interface LoanManualEvent {
  id: string;
  kind: 'BALANCE' | 'EARLY_REPAYMENT';
  date: string;
  amountCents: number;
  mode?: 'REDUCED_DURATION' | 'NEW_INSTALLMENT' | null;
  newInstallmentCents?: number | null;
  origin: 'USER' | 'ADMIN';
  at: string | null;
  userId: number | null;
}

export interface LoanManualInput {
  values: Partial<{ [K in LoanTermField]: LoanTermValues[K] | null }>;
  origins: Partial<Record<LoanTermField, { origin: 'USER' | 'ADMIN'; at: string | null; userId: number | null }>>;
  events: readonly LoanManualEvent[];
}

export interface LoanTermEvidence<T> {
  value: T; origin: LoanValueOrigin; fileIds: number[];
  /** Lot 112H : date de la saisie (USER / ADMIN), null si inconnue ; absent pour une lecture documentaire. */
  at?: string | null;
}
export interface LoanStatement { date: string; cents: number; origin: LoanValueOrigin; fileId: number | null; source: 'TABLE' | 'FACT' | 'MANUAL'; ref: string }
export interface LoanEvidence {
  terms: Partial<{ [K in LoanTermField]: LoanTermEvidence<LoanTermValues[K]> }>;
  /** Valeurs contradictoires lues (aucune n'est retenue). */
  conflicts: Partial<Record<LoanTermField, string[]>>;
  /** Un document mentionne un différé dont la durée ou la nature n'est pas lue. */
  deferralMentioned: boolean;
  /** Taux variable / révisable mentionné : aucun calcul (le taux futur n'est pas connu). */
  variableRateMentioned: boolean;
  statements: LoanStatement[];
  /** Dates où deux documents donnent deux capitaux restants dus différents (ignorés). */
  statementConflicts: string[];
  earlyRepayments: LoanManualEvent[];
  /**
   * Lot 112H : lectures documentaires AVANT application des saisies (formulaire :
   * « Revenir à la valeur du document ») — mêmes règles que `terms` / `conflicts`.
   */
  documentTerms?: Partial<{ [K in LoanTermField]: LoanTermEvidence<LoanTermValues[K]> }>;
  documentConflicts?: Partial<Record<LoanTermField, string[]>>;
}

// ── Normalisation et analyse des valeurs ───────────────────────────────────

const plain = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

const AUTRE_DEVISE = /(\$|£|¥|\busd\b|\bgbp\b|\bchf\b|\bjpy\b|\bcad\b)/i;

/** Nombre machine (« 182345.6700 », NUMERIC) → centimes exacts ; null si fraction de centime. */
export function parseMachineEurCents(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const s = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : '') : String(raw).trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const dec = m[2] ?? '';
  if (/[^0]/.test(dec.slice(2))) return null;
  const c = Number(m[1]) * 100 + Number((dec + '00').slice(0, 2));
  return Number.isSafeInteger(c) ? c : null;
}

/** Montant EUR écrit (« 182 345,67 € », « 182.345,67 », « 1 234 ») → centimes exacts ; null si ambigu ou autre devise. */
export function parseEurAmountCents(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw >= 0 ? parseMachineEurCents(raw) : null;
  let s = String(raw).trim();
  if (!s || AUTRE_DEVISE.test(s)) return null;
  s = s.replace(/€|\beur(os?)?\b/gi, '').replace(/[\s\u00a0\u202f]/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const virg = s.lastIndexOf(','); const pt = s.lastIndexOf('.');
  let ent = s; let dec = '';
  if (virg >= 0 && pt >= 0) {
    const sep = Math.max(virg, pt);
    const milliers = sep === virg ? '.' : ',';
    ent = s.slice(0, sep).split(milliers).join('');
    dec = s.slice(sep + 1);
    if (!dec.length || dec.length > 2) return null;
  } else if (virg >= 0 || pt >= 0) {
    const c = virg >= 0 ? ',' : '.';
    const morceaux = s.split(c);
    const dernier = morceaux[morceaux.length - 1];
    if (morceaux.length === 2 && dernier.length >= 1 && dernier.length <= 2) { ent = morceaux[0]; dec = dernier; } else if (morceaux.slice(1).every((x) => x.length === 3)) { ent = morceaux.join(''); } else return null;
  }
  if (!/^\d+$/.test(ent) || !/^\d{0,2}$/.test(dec)) return null;
  const c = Number(ent) * 100 + Number((dec + '00').slice(0, 2));
  return Number.isSafeInteger(c) ? c : null;
}

const MOIS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};
const p2 = (n: number) => String(n).padStart(2, '0');
const dateOk = (y: number, m: number, d: number): string | null => { const iso = `${y}-${p2(m)}-${p2(d)}`; return isCivilDate(iso) ? iso : null; };

/** Toutes les dates civiles écrites dans un texte (ISO, JJ/MM/AAAA, « 5 octobre 2026 »), dans l'ordre. */
export function datesInText(raw: string | null | undefined): Array<{ date: string; index: number }> {
  const s = plain(raw);
  const out: Array<{ date: string; index: number }> = [];
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) { const d = dateOk(+m[1], +m[2], +m[3]); if (d) out.push({ date: d, index: m.index ?? 0 }); }
  for (const m of s.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g)) { const d = dateOk(+m[3], +m[2], +m[1]); if (d) out.push({ date: d, index: m.index ?? 0 }); }
  for (const m of s.matchAll(/\b(1er|\d{1,2}) (janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre) (\d{4})\b/g)) {
    const d = dateOk(+m[3], MOIS[m[2]], m[1] === '1er' ? 1 : +m[1]); if (d) out.push({ date: d, index: m.index ?? 0 });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Date unique d'une valeur (cellule, fait) ; null si absente ou plusieurs dates différentes. */
export function parseCivilDate(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (isCivilDate(t.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}(T|$)/.test(t)) return t.slice(0, 10);
  const all = [...new Set(datesInText(t).map((x) => x.date))];
  return all.length === 1 ? all[0] : null;
}

/** Date « au JJ/MM/AAAA » d'un capital restant dû écrit dans un texte ; à défaut, date unique du texte. */
function statementDateInText(...texts: Array<string | null | undefined>): string | null {
  for (const t of texts) {
    const s = plain(t);
    if (!s) continue;
    const m = s.match(/\b(au|a la date du|arrete au|en date du)\s+/);
    if (m) {
      const suite = datesInText(s.slice((m.index ?? 0) + m[0].length));
      if (suite.length && suite[0].index === 0) return suite[0].date;
    }
  }
  for (const t of texts) { const d = parseCivilDate(t); if (d) return d; }
  return null;
}

const valeurTexte = (f: LoanFactInput): string => [f.valueText, f.normalizedValue, f.valueNumber == null ? null : String(f.valueNumber)].filter((x) => x != null && String(x).trim() !== '').map(String)[0] ?? '';

function factMoneyCents(f: LoanFactInput): number | null {
  const unit = plain(f.valueUnit);
  if (unit && !/^(eur|euro|euros|€|cents|centimes|cent)$/.test(unit)) return null;
  if (f.valueType === 'money_cents' || /^(cents|centimes|cent)$/.test(unit)) {
    const v = String(f.normalizedValue ?? f.valueNumber ?? '').trim();
    return /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
  }
  for (const v of [f.valueText, f.normalizedValue]) { const c = parseEurAmountCents(v); if (c != null) return c; }
  return parseMachineEurCents(f.valueNumber);
}

function factRatePct(f: LoanFactInput, codeExact: boolean): string | null {
  const textes = [f.valueText, f.normalizedValue, f.valueNumber == null ? null : String(f.valueNumber)].filter((x): x is string => x != null);
  const pourcent = codeExact || plain(f.valueUnit) === '%' || textes.some((t) => t.includes('%'));
  if (!pourcent) return null;
  for (const t of textes) {
    const m = t.replace(/[\s  ]/g, '').match(/^(\d{1,2}(?:[.,]\d{1,6})?)%?(l'an|\/an)?$/i);
    if (m) { const r = parseRatePct(m[1]); if (r) return r.text; }
  }
  return null;
}

function factDurationMonths(f: LoanFactInput, codeExact: boolean): number | null {
  const unit = plain(f.valueUnit);
  const t = plain(valeurTexte(f));
  const m = t.match(/^(\d{1,3})\s*(mois|ans?|annees?)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2] ?? (unit ? unit : codeExact ? 'mois' : '');
  const mois = /^(mois|months?)$/.test(u) ? n : /^(ans?|annees?|years?)$/.test(u) ? n * 12 : null;
  return mois != null && mois >= 1 && mois <= LOAN_MAX_DURATION_MONTHS ? mois : null;
}

function periodicityFrom(s: string): LoanPeriodicity | null {
  if (/\b(mensuel(le)?s?|monthly|mensualites?)\b/.test(s)) return 'MONTHLY';
  if (/\b(trimestriel(le)?s?|quarterly|trimestrialites?)\b/.test(s)) return 'QUARTERLY';
  if (/\b(semestriel(le)?s?|semiannual|semestrialites?)\b/.test(s)) return 'SEMIANNUAL';
  if (/\b(annuel(le)?s?|annual|annuites?)\b/.test(s)) return 'ANNUAL';
  return null;
}

// ── Classement d'un fait ───────────────────────────────────────────────────

type FactReading =
  | { field: 'ratePct'; value: string }
  | { field: 'periodicity'; value: LoanPeriodicity }
  | { field: 'durationMonths'; value: number }
  | { field: 'firstInstallmentDate'; value: string }
  | { field: 'installmentCents'; value: number }
  | { field: 'installmentWithInsurance'; value: number }
  | { field: 'insuranceCents'; value: number }
  | { field: 'deferralMonths'; value: number }
  | { field: 'deferralKind'; value: LoanDeferralKind }
  | { field: 'deferralMention' }
  | { field: 'variableRate' }
  | { field: 'statement'; date: string; cents: number };

const RE_CRD = /(capital restant du|capital du restant|restant du|\bcrd\b|encours (du )?(pret|credit|capital)|capital restant a rembourser)/;

/** Lecture d'UN fait (pure, testée L112D-EVI-*) : un champ du prêt, un capital restant dû daté, ou rien. */
export function readLoanFact(f: LoanFactInput): FactReading[] {
  if (f.confidence && f.confidence !== 'certain') return [];
  const code = [f.rawKey, f.factKey].map((x) => (x ?? '').trim().toLowerCase()).find((x) => x.startsWith('loan.')) ?? null;
  const k = plain([f.rawKey, f.factKey, f.label, f.attribute, f.subject].filter(Boolean).join(' '));
  const out: FactReading[] = [];
  const C = LOAN_FACT_CODES;
  // 1. Clés stables (bloc PO étape 20).
  if (code) {
    if (code === C.ratePct) { const v = factRatePct(f, true); if (v) out.push({ field: 'ratePct', value: v }); }
    else if (code === C.periodicity) { const v = periodicityFrom(plain(valeurTexte(f))) ?? (['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'].includes(valeurTexte(f).trim().toUpperCase()) ? valeurTexte(f).trim().toUpperCase() as LoanPeriodicity : null); if (v) out.push({ field: 'periodicity', value: v }); }
    else if (code === C.durationMonths) { const v = factDurationMonths(f, true); if (v) out.push({ field: 'durationMonths', value: v }); }
    else if (code === C.firstInstallmentDate) { const v = parseCivilDate(valeurTexte(f)) ?? parseCivilDate(f.periodStart); if (v) out.push({ field: 'firstInstallmentDate', value: v }); }
    else if (code === C.installmentCents) { const v = factMoneyCents(f); if (v) out.push({ field: 'installmentCents', value: v }); }
    else if (code === C.installmentWithInsurance) { const v = factMoneyCents(f); if (v) out.push({ field: 'installmentWithInsurance', value: v }); }
    else if (code === C.insuranceCents) { const v = factMoneyCents(f); if (v != null) out.push({ field: 'insuranceCents', value: v }); }
    else if (code === C.deferralMonths) { const v = factDurationMonths(f, true); if (v != null) out.push({ field: 'deferralMonths', value: v }); else if (plain(valeurTexte(f)) === '0') out.push({ field: 'deferralMonths', value: 0 }); }
    else if (code === C.deferralKind) { const v = plain(valeurTexte(f)); if (/total/.test(v)) out.push({ field: 'deferralKind', value: 'TOTAL' }); else if (/partiel|partial/.test(v)) out.push({ field: 'deferralKind', value: 'PARTIAL' }); }
    else if (code === C.outstanding) {
      const cents = factMoneyCents(f);
      const date = parseCivilDate(f.periodEnd) ?? parseCivilDate(f.periodStart) ?? statementDateInText(f.label, f.attribute, f.excerpt);
      if (cents != null && date) out.push({ field: 'statement', date, cents });
    }
    return out;
  }
  // 2. Libellés explicites.
  if (/\bdiffere\b/.test(k)) {
    if (/\btotal\b/.test(k)) out.push({ field: 'deferralKind', value: 'TOTAL' });
    else if (/\bpartiel\b/.test(k)) out.push({ field: 'deferralKind', value: 'PARTIAL' });
    const d = /\bduree\b|\bdiffere de\b/.test(k) ? factDurationMonths(f, false) : null;
    if (d != null) out.push({ field: 'deferralMonths', value: d });
    if (!out.length) out.push({ field: 'deferralMention' });
    return out;
  }
  if (/\btaux\b/.test(k) && /(variable|revisable|capee?)/.test(k + ' ' + plain(valeurTexte(f)))) return [{ field: 'variableRate' }];
  if (RE_CRD.test(k) && !/assurance/.test(k)) {
    const cents = factMoneyCents(f);
    const date = parseCivilDate(f.periodEnd) ?? statementDateInText(f.label, f.attribute, f.rawKey, f.excerpt) ?? (f.periodStart && f.periodStart === f.periodEnd ? parseCivilDate(f.periodStart) : null);
    if (cents != null && date) out.push({ field: 'statement', date, cents });
    return out;
  }
  if (/\btaux\b/.test(k) && /(nominal|debiteur|annuel fixe|fixe|du pret|du credit|d'interet|interets?)\b/.test(k)
    && !/(taeg|taea|effectif|global|assurance|usure|actuariel|periodique|mensuel)/.test(k)) {
    const v = factRatePct(f, false); if (v) out.push({ field: 'ratePct', value: v });
    return out;
  }
  if (/\b(periodicite|frequence des (echeances|remboursements))\b/.test(k)) {
    const v = periodicityFrom(plain(valeurTexte(f))); if (v) out.push({ field: 'periodicity', value: v });
    return out;
  }
  if (/\b(premiere|1re|1ere|1er) (echeance|mensualite|remboursement)\b|\bdebut (des remboursements|de l'amortissement|d'amortissement)\b/.test(k)) {
    const v = parseCivilDate(valeurTexte(f)) ?? parseCivilDate(f.periodStart); if (v) out.push({ field: 'firstInstallmentDate', value: v });
    return out;
  }
  if (/\b(mensualite|echeance|trimestrialite|semestrialite|annuite)s?\b/.test(k) && !/(total|cout|nombre|derniere|date)/.test(k)) {
    const v = factMoneyCents(f);
    const per = periodicityFrom(k);
    if (per && v != null) out.push({ field: 'periodicity', value: per });
    if (v == null) return out;
    if (/hors assurance|sans assurance|\bhors ass\b/.test(k)) out.push({ field: 'installmentCents', value: v });
    else if (/(assurance (comprise|incluse)|avec assurance|y compris (l')?assurance|assurance inclus)/.test(k)) out.push({ field: 'installmentWithInsurance', value: v });
    return out;
  }
  if (/\bassurance\b/.test(k) && /(par mois|mensuel|par echeance|cotisation|prime)/.test(k) && !/(total|cout total|comprise|incluse|hors|taux)/.test(k)) {
    const v = factMoneyCents(f); if (v != null) out.push({ field: 'insuranceCents', value: v });
    return out;
  }
  if (/\bduree\b/.test(k) && /(pret|credit|emprunt|remboursement|totale)/.test(k) && !/(assurance|garantie|preavis|validite|offre|restant)/.test(k)) {
    const v = factDurationMonths(f, false); if (v) out.push({ field: 'durationMonths', value: v });
    return out;
  }
  return out;
}

// ── Tableaux d'amortissement ───────────────────────────────────────────────

/** Capitaux restants dus lus dans un tableau (colonne CRD + colonne de dates) — pure, testée L112D-EVI-*. */
export function readLoanTable(t: LoanTableInput): Array<{ date: string; cents: number; row: number }> {
  if (t.uncertain) return [];
  const heads = t.columns.map((h) => plain(h));
  const crd = heads.findIndex((h) => RE_CRD.test(h) && !/assurance/.test(h));
  if (crd < 0) return [];
  const parLigne = new Map<number, Map<number, { value: string | null; normalized: string | null; confidence: string | null }>>();
  for (const c of t.cells) {
    if (!parLigne.has(c.row)) parLigne.set(c.row, new Map());
    parLigne.get(c.row)!.set(c.column, c);
  }
  // Colonne de dates : en-tête « date » / « échéance » prioritaire, sinon la colonne dont les valeurs sont toutes des dates.
  const estDate = (col: number) => {
    let n = 0; let ok = 0;
    for (const l of parLigne.values()) { const v = l.get(col)?.value ?? null; if (v == null || !String(v).trim()) continue; n += 1; if (parseCivilDate(v)) ok += 1; }
    return n > 0 && ok / n >= 0.8;
  };
  const candidates = heads.map((h, i) => ({ h, i })).filter((x) => x.i !== crd && estDate(x.i));
  const dateCol = (candidates.find((x) => /\bdate\b/.test(x.h)) ?? candidates.find((x) => /echeance|periode/.test(x.h)) ?? candidates[0])?.i;
  if (dateCol == null) return [];
  const out: Array<{ date: string; cents: number; row: number }> = [];
  for (const [row, l] of parLigne) {
    const d = l.get(dateCol); const v = l.get(crd);
    if (!d || !v || (d.confidence && d.confidence !== 'certain') || (v.confidence && v.confidence !== 'certain')) continue;
    const date = parseCivilDate(d.value);
    const cents = parseEurAmountCents(v.value) ?? null;
    if (date && cents != null) out.push({ date, cents, row });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row);
}

// ── Assemblage des preuves d'un prêt ───────────────────────────────────────

const egal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const affiche = (v: unknown): string => (typeof v === 'object' && v ? JSON.stringify(v) : String(v));

/**
 * Preuves d'un prêt (pure, testée L112D-EVI-*) : saisies USER / ADMIN
 * prioritaires champ par champ, puis lectures documentaires concordantes.
 */
export function assembleLoanEvidence(input: {
  principal: { cents: number | null; currency: string | null };
  facts: readonly LoanFactInput[];
  tables: readonly LoanTableInput[];
  manual: LoanManualInput | null;
}): LoanEvidence {
  const lus = new Map<string, Array<{ value: unknown; fileId: number }>>();
  const ajouter = (champ: string, value: unknown, fileId: number) => {
    const l = lus.get(champ) ?? [];
    l.push({ value, fileId });
    lus.set(champ, l);
  };
  let deferralMentioned = false;
  let variableRateMentioned = false;
  const releves: LoanStatement[] = [];
  for (const f of input.facts) {
    for (const r of readLoanFact(f)) {
      if (r.field === 'deferralMention') { deferralMentioned = true; continue; }
      if (r.field === 'variableRate') { variableRateMentioned = true; continue; }
      if (r.field === 'statement') { releves.push({ date: r.date, cents: r.cents, origin: 'DOCUMENT', fileId: f.fileId, source: 'FACT', ref: `fait:${f.fileId}:${r.date}` }); continue; }
      ajouter(r.field, r.value, f.fileId);
    }
  }
  for (const t of input.tables) {
    for (const r of readLoanTable(t)) releves.push({ date: r.date, cents: r.cents, origin: 'DOCUMENT', fileId: t.fileId, source: 'TABLE', ref: `tableau:${t.tableId}:${r.row}` });
  }

  const terms: LoanEvidence['terms'] = {};
  const conflicts: LoanEvidence['conflicts'] = {};
  const unique = (champ: string): { value: unknown; fileIds: number[] } | 'CONFLICT' | null => {
    const l = lus.get(champ) ?? [];
    if (!l.length) return null;
    const distincts = l.filter((x, i) => l.findIndex((y) => egal(y.value, x.value)) === i);
    if (distincts.length > 1) return 'CONFLICT';
    return { value: l[0].value, fileIds: [...new Set(l.map((x) => x.fileId))] };
  };
  const doc = <K extends LoanTermField>(field: K, champ: string = field) => {
    const u = unique(champ);
    if (u === 'CONFLICT') { conflicts[field] = [...new Set((lus.get(champ) ?? []).map((x) => affiche(x.value)))]; return; }
    if (u) terms[field] = { value: u.value as LoanTermValues[K], origin: 'DOCUMENT', fileIds: u.fileIds } as never;
  };
  if (input.principal.cents != null && input.principal.cents > 0 && (input.principal.currency ?? '').toUpperCase() === 'EUR') {
    terms.principalCents = { value: input.principal.cents, origin: 'DOCUMENT', fileIds: [] };
  }
  doc('ratePct'); doc('periodicity'); doc('durationMonths'); doc('firstInstallmentDate'); doc('insuranceCents');
  doc('installmentCents');
  // Échéance assurance comprise − assurance par échéance (lues) = échéance hors assurance (exacte).
  if (!terms.installmentCents && !conflicts.installmentCents) {
    const ttc = unique('installmentWithInsurance');
    const ass = terms.insuranceCents;
    if (ttc && ttc !== 'CONFLICT' && ass && (ttc.value as number) > ass.value) {
      terms.installmentCents = { value: (ttc.value as number) - ass.value, origin: 'DOCUMENT', fileIds: [...new Set([...ttc.fileIds, ...ass.fileIds])] };
    }
  }
  // Différé : durée ET nature lues (ou durée 0) ; sinon mention seulement.
  const dm = unique('deferralMonths'); const dk = unique('deferralKind');
  if (dm === 'CONFLICT' || dk === 'CONFLICT') conflicts.deferral = ['valeurs contradictoires'];
  else if (dm && (dm.value as number) === 0) terms.deferral = { value: { months: 0, kind: 'NONE' }, origin: 'DOCUMENT', fileIds: dm.fileIds };
  else if (dm && dk) terms.deferral = { value: { months: dm.value as number, kind: dk.value as LoanDeferralKind }, origin: 'DOCUMENT', fileIds: [...new Set([...dm.fileIds, ...dk.fileIds])] };
  else if (dm || dk) deferralMentioned = true;

  // Lot 112H : lectures documentaires conservées telles quelles avant les saisies (formulaire, réversibilité).
  const documentTerms: LoanEvidence['terms'] = { ...terms };
  const documentConflicts: LoanEvidence['conflicts'] = { ...conflicts };
  // Saisies USER / ADMIN : prioritaires, champ par champ (jamais remplacées par une lecture).
  const m = input.manual;
  if (m) {
    for (const field of LOAN_TERM_FIELDS) {
      const v = m.values[field];
      if (v == null) continue;
      const o = m.origins[field]?.origin ?? 'USER';
      const at = m.origins[field]?.at;
      terms[field] = { value: v, origin: o, fileIds: [], ...(at ? { at } : {}) } as never;
      delete conflicts[field];
    }
    for (const e of m.events) {
      if (e.kind === 'BALANCE' && isCivilDate(e.date) && Number.isSafeInteger(e.amountCents) && e.amountCents >= 0) {
        releves.push({ date: e.date, cents: e.amountCents, origin: e.origin, fileId: null, source: 'MANUAL', ref: `saisie:${e.id}` });
      }
    }
  }

  // Relevés : à date égale, une saisie prime ; deux documents différents → contradiction (aucun retenu).
  const parDate = new Map<string, LoanStatement[]>();
  for (const r of releves) parDate.set(r.date, [...(parDate.get(r.date) ?? []), r]);
  const statements: LoanStatement[] = [];
  const statementConflicts: string[] = [];
  for (const [date, l] of [...parDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const saisies = l.filter((x) => x.origin !== 'DOCUMENT');
    if (saisies.length) { statements.push(saisies.sort((a, b) => (a.origin === 'ADMIN' ? 1 : 0) - (b.origin === 'ADMIN' ? 1 : 0))[0]); continue; }
    const montants = new Set(l.map((x) => x.cents));
    if (montants.size > 1) { statementConflicts.push(date); continue; }
    statements.push(l.sort((a, b) => (a.source === 'TABLE' ? 0 : 1) - (b.source === 'TABLE' ? 0 : 1))[0]);
  }
  const earlyRepayments = (m?.events ?? []).filter((e) => e.kind === 'EARLY_REPAYMENT' && isCivilDate(e.date) && Number.isSafeInteger(e.amountCents) && e.amountCents > 0);
  return { terms, conflicts, deferralMentioned, variableRateMentioned, statements, statementConflicts, earlyRepayments, documentTerms, documentConflicts };
}
