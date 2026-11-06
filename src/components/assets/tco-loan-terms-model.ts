/**
 * Lot 112H — saisie manuelle des conditions d'un prêt (fiche du bien › Coût
 * total de possession › Financement) : modèle PUR du formulaire (aucun React,
 * aucun DOM, aucun module serveur), partagé par le composant et ses tests.
 *
 *   · état de chaque condition : valeur retenue, origine (document avec ses
 *     justificatifs, ou saisie), valeur lue sur document même quand une saisie
 *     prime (`outstanding.fields`, calculé par le serveur — lot 112D/112H) ;
 *   · textes du champ (formats français : « 1 109,20 », « 3,25 ») ;
 *   · validation côté client avec les MÊMES règles que la route
 *     `PUT /api/assets/[id]/tco/financing/[operationId]` (`parseLoanTermsBody`,
 *     bornes de `loan-amortization`) — la route reste l'autorité : son message
 *     422 est rattaché au champ concerné (`fieldOfServerMessage`) ;
 *   · corps envoyé : SEULS les champs modifiés ; `null` = « Revenir à la valeur
 *     du document » (la saisie est effacée, la lecture documentaire reprend).
 *
 * La durée se saisit en NOMBRE D'ÉCHÉANCES (décision PO 112H) et s'enregistre
 * en mois (route) : mois = échéances × mois par échéance de la périodicité.
 */
import { parseNumberInput, MONEY_INPUT } from '@/lib/number-input';
import { isCivilDate, LOAN_MAX_DURATION_MONTHS, LOAN_PERIOD_MONTHS, parseRatePct, type LoanPeriodicity } from '@/services/business-operations/tco/loan-amortization';
import type { LoanTermField, LoanValueOrigin } from '@/services/business-operations/tco/loan-evidence';
import type { TcoLoanTermFieldState } from '@/services/business-operations/tco/outstanding-principal';

export type LoanFormField = LoanTermField;
export type LoanDeferralChoice = 'NONE' | 'PARTIAL' | 'TOTAL';

/** Ordre d'affichage des champs du formulaire. */
export const LOAN_FORM_FIELDS: readonly LoanFormField[] = [
  'principalCents', 'ratePct', 'periodicity', 'durationMonths', 'firstInstallmentDate', 'installmentCents', 'insuranceCents', 'deferral',
];

export const LOAN_FORM_LABELS: Readonly<Record<LoanFormField, string>> = {
  principalCents: 'Montant emprunté',
  ratePct: 'Taux nominal annuel',
  periodicity: 'Périodicité des échéances',
  durationMonths: 'Durée (nombre d’échéances)',
  firstInstallmentDate: 'Date de la première échéance',
  installmentCents: 'Échéance hors assurance',
  insuranceCents: 'Assurance emprunteur par échéance',
  deferral: 'Différé',
};

export const LOAN_PERIODICITY_OPTIONS: ReadonlyArray<{ value: LoanPeriodicity; label: string; unit: string }> = [
  { value: 'MONTHLY', label: 'Mensuelle', unit: 'mensuelles' },
  { value: 'QUARTERLY', label: 'Trimestrielle', unit: 'trimestrielles' },
  { value: 'SEMIANNUAL', label: 'Semestrielle', unit: 'semestrielles' },
  { value: 'ANNUAL', label: 'Annuelle', unit: 'annuelles' },
];

export const LOAN_DEFERRAL_OPTIONS: ReadonlyArray<{ value: LoanDeferralChoice; label: string }> = [
  { value: 'NONE', label: 'Aucun différé' },
  { value: 'PARTIAL', label: 'Différé partiel (intérêts seuls)' },
  { value: 'TOTAL', label: 'Différé total' },
];

/** Montant maximal accepté par la route (centimes). */
const MONTANT_MAX_CENTS = 10_000_000_000;

/** Brouillon du formulaire : textes saisis des champs MODIFIÉS uniquement (les autres affichent la valeur retenue). */
export interface LoanFormDraft {
  principalCents?: string;
  ratePct?: string;
  periodicity?: LoanPeriodicity | '';
  durationMonths?: string;
  firstInstallmentDate?: string;
  installmentCents?: string;
  insuranceCents?: string;
  deferralKind?: LoanDeferralChoice | '';
  deferralMonths?: string;
}

export type LoanFieldStates = Partial<Record<LoanFormField, TcoLoanTermFieldState>>;

// ── Formats français ───────────────────────────────────────────────────────

/** Centimes → texte de champ « 1 109,20 » (espaces fines insécables évitées : espace simple, relu par `parseNumberInput`). */
export function centsToInput(c: unknown): string {
  if (typeof c !== 'number' || !Number.isSafeInteger(c)) return '';
  const e = Math.floor(c / 100);
  const cts = String(c % 100).padStart(2, '0');
  return `${String(e).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${cts}`;
}

/** Taux « 3.25 » (route) → « 3,25 ». */
export function rateToInput(r: unknown): string {
  return typeof r === 'string' && r ? r.replace('.', ',') : '';
}

export const eurText = (c: number): string => (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
export const dateText = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

const periodLabel = (p: unknown) => LOAN_PERIODICITY_OPTIONS.find((o) => o.value === p)?.label ?? null;

/** Valeur d'une condition, lisible (origine, valeur du document). */
export function formatLoanValue(field: LoanFormField, v: unknown, periodicity?: LoanPeriodicity | null): string {
  if (v == null) return '—';
  switch (field) {
    case 'principalCents': case 'installmentCents': case 'insuranceCents':
      return typeof v === 'number' ? eurText(v) : '—';
    case 'ratePct': return `${rateToInput(v)} %`;
    case 'periodicity': return periodLabel(v) ?? '—';
    case 'firstInstallmentDate': return typeof v === 'string' ? dateText(v) : '—';
    case 'durationMonths': {
      if (typeof v !== 'number') return '—';
      const pm = periodicity ? LOAN_PERIOD_MONTHS[periodicity] : null;
      const unit = LOAN_PERIODICITY_OPTIONS.find((o) => o.value === periodicity)?.unit;
      return pm && v % pm === 0 && pm > 1 ? `${v / pm} échéances ${unit} (${v} mois)` : `${v} mois`;
    }
    case 'deferral': {
      const d = v as { months?: number; kind?: string };
      if (d.kind === 'NONE' || !d.months) return 'Aucun différé';
      return `${d.kind === 'TOTAL' ? 'Différé total' : 'Différé partiel'} de ${d.months} mois`;
    }
  }
}

// ── Origine affichée ───────────────────────────────────────────────────────

export interface LoanFieldOrigin {
  /** DOCUMENT : lu ; USER / ADMIN : saisi ; CONFLICT : documents contradictoires ; NONE : non renseigné. */
  kind: LoanValueOrigin | 'CONFLICT' | 'NONE';
  text: string;
  /** Valeur lue sur document quand une saisie prime (« Valeur du document : … »). */
  documentText: string | null;
  /** « Revenir à la valeur du document » possible (une saisie existe et un document porte une valeur). */
  canRevertToDocument: boolean;
  /** « Effacer la saisie » (une saisie existe, aucun document ne porte de valeur). */
  canClear: boolean;
}

const sourcesText = (s: Array<{ title: string | null }>): string => {
  const titres = [...new Set(s.map((x) => x.title).filter((t): t is string => !!t))];
  if (!titres.length) return 'un justificatif du prêt';
  return titres.length === 1 ? `« ${titres[0]} »` : titres.map((t) => `« ${t} »`).join(', ');
};

/** Valeurs contradictoires lisibles (codes de périodicité → libellés). */
const conflitText = (field: LoanFormField, vals: readonly string[]): string =>
  vals.map((v) => (field === 'periodicity' ? periodLabel(v) ?? v : v)).join(' / ');

export function loanFieldOrigin(field: LoanFormField, st: TcoLoanTermFieldState | undefined, periodicity: LoanPeriodicity | null): LoanFieldOrigin {
  const docVal = st?.document ? formatLoanValue(field, st.document.value, periodicity) : null;
  if (st && st.value != null && (st.origin === 'USER' || st.origin === 'ADMIN')) {
    const qui = st.origin === 'ADMIN' ? 'Saisi par le support Verebona' : 'Saisi par vous';
    return {
      kind: st.origin,
      text: `${qui}${st.enteredAt ? ` le ${dateText(st.enteredAt.slice(0, 10))}` : ''} : votre saisie prime sur les documents.`,
      documentText: st.document ? `Valeur du document : ${docVal} (lu sur ${sourcesText(st.document.sources)}).`
        : st.documentConflict ? `Les documents se contredisent (${conflitText(field, st.documentConflict)}).` : null,
      canRevertToDocument: st.origin === 'USER' && !!st.document,
      canClear: st.origin === 'USER' && !st.document,
    };
  }
  if (st && st.value != null && st.origin === 'DOCUMENT') {
    return { kind: 'DOCUMENT', text: `Lu sur ${sourcesText(st.document?.sources ?? [])}.`, documentText: null, canRevertToDocument: false, canClear: false };
  }
  if (st?.documentConflict) {
    return { kind: 'CONFLICT', text: `Les documents se contredisent (${conflitText(field, st.documentConflict)}) : aucune valeur retenue. Votre saisie primera.`, documentText: null, canRevertToDocument: false, canClear: false };
  }
  return { kind: 'NONE', text: 'Non renseigné.', documentText: null, canRevertToDocument: false, canClear: false };
}

// ── Valeurs affichées dans les champs ──────────────────────────────────────

const effective = (states: LoanFieldStates, f: LoanFormField) => states[f]?.value ?? null;

export function effectivePeriodicity(states: LoanFieldStates, draft: LoanFormDraft): LoanPeriodicity | null {
  if (draft.periodicity !== undefined) return draft.periodicity || null;
  const p = effective(states, 'periodicity');
  return typeof p === 'string' && p in LOAN_PERIOD_MONTHS ? (p as LoanPeriodicity) : null;
}

/** Texte initial (valeur retenue) d'un champ non modifié. */
export function initialText(states: LoanFieldStates, f: Exclude<LoanFormField, 'periodicity' | 'deferral'>, periodicity: LoanPeriodicity | null): string {
  const v = effective(states, f);
  if (v == null) return '';
  switch (f) {
    case 'principalCents': case 'installmentCents': case 'insuranceCents': return centsToInput(v);
    case 'ratePct': return rateToInput(v);
    case 'firstInstallmentDate': return typeof v === 'string' ? v : '';
    case 'durationMonths': {
      const pm = periodicity ? LOAN_PERIOD_MONTHS[periodicity] : null;
      return typeof v === 'number' && pm && v % pm === 0 ? String(v / pm) : '';
    }
  }
}

export function textOf(states: LoanFieldStates, draft: LoanFormDraft, f: Exclude<LoanFormField, 'periodicity' | 'deferral'>): string {
  const d = draft[f];
  return d !== undefined ? d : initialText(states, f, effectivePeriodicity(states, draft));
}

export function deferralOf(states: LoanFieldStates, draft: LoanFormDraft): { kind: LoanDeferralChoice | ''; months: string } {
  const v = effective(states, 'deferral') as { months: number; kind: LoanDeferralChoice } | null;
  const kind = draft.deferralKind !== undefined ? draft.deferralKind : v?.kind ?? '';
  const months = draft.deferralMonths !== undefined ? draft.deferralMonths : v && v.kind !== 'NONE' ? String(v.months) : '';
  return { kind, months };
}

// ── Validation et corps envoyé ─────────────────────────────────────────────

export type LoanTermsPatchBody = { terms: Partial<Record<LoanFormField, unknown>> };
export type LoanFormErrors = Partial<Record<LoanFormField, string>>;

const egal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function money(text: string, min: number, label: string): { ok: true; cents: number | null } | { ok: false; error: string } {
  const r = parseNumberInput(text, MONEY_INPUT);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.value === null) return { ok: true, cents: null };
  const cents = Math.round(r.value * 100);
  if (cents < min) return { ok: false, error: min > 0 ? `${label} : indiquez un montant supérieur à 0 €.` : `${label} : montant invalide.` };
  if (cents > MONTANT_MAX_CENTS) return { ok: false, error: `${label} : montant trop élevé.` };
  return { ok: true, cents };
}

/**
 * Corps de la requête : seuls les champs MODIFIÉS par rapport à la valeur retenue ; un champ saisi vidé → `null`
 * (retour à la lecture documentaire). Un champ lu sur document qu'on vide n'est pas envoyé (rien à effacer).
 */
export function buildLoanTermsPatch(states: LoanFieldStates, draft: LoanFormDraft): { ok: true; body: LoanTermsPatchBody; changed: LoanFormField[] } | { ok: false; errors: LoanFormErrors } {
  const errors: LoanFormErrors = {};
  const terms: LoanTermsPatchBody['terms'] = {};
  const saisi = (f: LoanFormField) => states[f]?.origin === 'USER' || states[f]?.origin === 'ADMIN';
  const poser = (f: LoanFormField, v: unknown) => {
    if (v === null) { if (saisi(f) && effective(states, f) != null) terms[f] = null; return; }
    if (!egal(v, effective(states, f))) terms[f] = v;
  };
  for (const f of ['principalCents', 'installmentCents', 'insuranceCents'] as const) {
    if (draft[f] === undefined) continue;
    const r = money(draft[f]!, f === 'insuranceCents' ? 0 : 1, LOAN_FORM_LABELS[f]);
    if (!r.ok) errors[f] = r.error; else poser(f, r.cents);
  }
  if (draft.ratePct !== undefined) {
    const t = draft.ratePct.trim().replace(/\s*%$/, '');
    if (!t) poser('ratePct', null);
    else {
      const n = parseNumberInput(t, { maxDecimals: 6, min: 0 });
      const r = n.ok && n.value !== null ? parseRatePct(t.replace(/\s/g, '')) : null;
      if (!r) errors.ratePct = 'Taux nominal invalide : indiquez un pourcentage entre 0 et 99, ex. « 3,25 ».';
      else poser('ratePct', r.text);
    }
  }
  if (draft.periodicity !== undefined) poser('periodicity', draft.periodicity || null);
  if (draft.durationMonths !== undefined) {
    const t = draft.durationMonths.trim();
    const per = effectivePeriodicity(states, draft);
    if (!t) poser('durationMonths', null);
    else if (!/^\d{1,4}$/.test(t) || Number(t) < 1) errors.durationMonths = 'Durée invalide : indiquez un nombre entier d’échéances (ex. 240).';
    else if (!per) errors.durationMonths = 'Choisissez d’abord la périodicité des échéances.';
    else {
      const mois = Number(t) * LOAN_PERIOD_MONTHS[per];
      if (mois > LOAN_MAX_DURATION_MONTHS) errors.durationMonths = `Durée invalide : ${LOAN_MAX_DURATION_MONTHS} mois au plus (${LOAN_MAX_DURATION_MONTHS / LOAN_PERIOD_MONTHS[per]} échéances ${LOAN_PERIODICITY_OPTIONS.find((o) => o.value === per)!.unit}).`;
      else poser('durationMonths', mois);
    }
  } else if (draft.periodicity !== undefined) {
    // Périodicité changée, durée non retouchée : la durée en mois est conservée ; elle doit rester un nombre entier d'échéances.
    const per = effectivePeriodicity(states, draft);
    const m = effective(states, 'durationMonths');
    if (per && typeof m === 'number' && m % LOAN_PERIOD_MONTHS[per] !== 0) errors.durationMonths = `La durée actuelle (${m} mois) n’est pas un nombre entier d’échéances ${LOAN_PERIODICITY_OPTIONS.find((o) => o.value === per)!.unit} : indiquez le nombre d’échéances.`;
  }
  if (draft.firstInstallmentDate !== undefined) {
    const d = draft.firstInstallmentDate.trim();
    if (!d) poser('firstInstallmentDate', null);
    else if (!isCivilDate(d)) errors.firstInstallmentDate = 'Date invalide (JJ/MM/AAAA).';
    else poser('firstInstallmentDate', d);
  }
  if (draft.deferralKind !== undefined || draft.deferralMonths !== undefined) {
    const { kind, months } = deferralOf(states, draft);
    if (!kind) poser('deferral', null);
    else if (kind === 'NONE') poser('deferral', { months: 0, kind: 'NONE' });
    else if (!/^\d{1,3}$/.test(months.trim()) || Number(months) < 1 || Number(months) > LOAN_MAX_DURATION_MONTHS) errors.deferral = 'Différé : indiquez sa durée en mois (nombre entier, au moins 1).';
    else poser('deferral', { months: Number(months), kind });
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { terms }, changed: Object.keys(terms) as LoanFormField[] };
}

/** Message de validation de la route (422) → champ concerné (affiché sous le champ et dans le résumé). */
export function fieldOfServerMessage(message: string | null | undefined): LoanFormField | null {
  const m = (message ?? '').toLowerCase();
  if (m.startsWith('montant emprunté')) return 'principalCents';
  if (m.startsWith('échéance hors assurance')) return 'installmentCents';
  if (m.startsWith('assurance')) return 'insuranceCents';
  if (m.startsWith('taux nominal')) return 'ratePct';
  if (m.startsWith('périodicité')) return 'periodicity';
  if (m.startsWith('durée')) return 'durationMonths';
  if (m.startsWith('date de première échéance')) return 'firstInstallmentDate';
  if (m.startsWith('différé')) return 'deferral';
  return null;
}

/** Capital restant dû après enregistrement (résumé en tête du formulaire). */
export function outstandingSummary(o: { status: string; cents: number | null; asOf: string | null; label: string } | null | undefined): { established: boolean; title: string; detail: string } | null {
  if (!o) return null;
  if (o.status === 'ESTABLISHED' && o.cents != null) {
    return { established: true, title: `Capital restant dû : ${eurText(o.cents)}${o.asOf ? ` au ${dateText(o.asOf)}` : ''}`, detail: o.label };
  }
  return { established: false, title: 'Capital restant dû : non établi', detail: o.label };
}
