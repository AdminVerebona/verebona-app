/**
 * REPRÉSENTATION TEMPORELLE du titre d'un document — règles pures, partagées
 * client / serveur (lot 99C, ticket « représentation temporelle des titres de
 * documents »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX NOTIONS SÉPARÉES
 *
 *   · la PÉRIODE FACTURÉE est une donnée documentaire (T1, lot 97A :
 *     `document.billingPeriod`, échéances et faits) — `PeriodFacts` ;
 *   · la manière de la REPRÉSENTER dans le titre (un mois, une plage de
 *     dates, plusieurs mois, rien) est une décision SÉMANTIQUE prise par la
 *     branche T3 DOCUMENT_NAMING (contrat `t3-naming-period-v1`) — le code ne
 *     fait que la VALIDER (`validatePeriodChoice`) puis la composer.
 *
 * Aucune règle « mois majoritaire » ici : le mois qui couvre le plus de jours
 * n'est qu'un indice transmis à l'IA (`monthHint`), jamais une règle.
 *
 * VALIDATION SERVEUR d'une décision (R1, R6) :
 *   · R1 — aucune période inventée : un mois doit être le mois explicitement
 *     désigné par le document ou un mois couvert par la période facturée ; une
 *     plage de dates est EXACTEMENT la période facturée ; une plage de mois
 *     reste dans la période facturée ;
 *   · R6 — jamais la date d'émission, d'import, du jour ou d'échéance comme
 *     période : une preuve de ces natures est refusée (`ARTIFICIAL_DATE`), et
 *     un mois qui ne vient que d'elles aussi ;
 *   · R7 (titre utilisateur) est appliqué par l'appelant (document protégé).
 *
 * SANS DÉCISION VALABLE (prompt T3 sans le contrat, coupure d'urgence,
 * décision périmée ou refusée) — comportement PRUDENT : le mois seulement
 * s'il est explicitement désigné par le document (preuve), sinon la période
 * exacte (comportement 87D), sinon rien.
 *
 * Aucune dépendance serveur (importable par les composants).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { formatTitleMonth, presentBilledPeriod } from './document-title-convention';

/** Marqueur exact du contrat dans le texte du prompt maître T3 (branche DOCUMENT_NAMING). */
export const T3_NAMING_PERIOD_CONTRACT = 't3-naming-period-v1';

/** Représentations possibles de la période dans un titre. */
export const PERIOD_REPRESENTATIONS = ['MONTH', 'DATE_RANGE', 'MULTI_MONTH', 'NONE'] as const;
export type PeriodRepresentation = (typeof PERIOD_REPRESENTATIONS)[number];

/** Sources de preuve admises (données fournies à l'IA). */
export const PERIOD_EVIDENCE_SOURCES = [
  'BILLED_PERIOD', 'STATED_MONTH', 'MONTH_HINT', 'DOCUMENT_TYPE', 'SUPPLIER', 'CONTRACT', 'REFERENCE_EVENT', 'SERIES_TITLES', 'DOCUMENT_TEXT',
] as const;
/** Sources INTERDITES comme fondement d'une période (R6). */
export const ARTIFICIAL_DATE_SOURCES = ['ISSUE_DATE', 'DOCUMENT_DATE', 'IMPORT_DATE', 'UPLOAD_DATE', 'TODAY', 'CURRENT_DATE', 'DUE_DATE', 'PAYMENT_DATE', 'PAYMENT_DUE_DATE'] as const;

/** Faits temporels d'un document (données, jamais une décision). */
export interface PeriodFacts {
  /** Période réellement facturée (bornes ISO), avec sa provenance. */
  billedPeriod: { start: string; end: string; source: string } | null;
  /** Mois EXPLICITEMENT désigné par le document (T1 `STATED_ON_DOCUMENT`, certain, preuve citée). */
  statedMonth: { value: string; quote: string | null } | null;
  /** Mois principal proposé par T1 sur un autre fondement (ex. MAJORITY_OF_PERIOD) : indice seulement. */
  monthHint: { value: string; basis: string | null } | null;
  /** Date d'émission (jamais une période, R6). */
  issueDate: string | null;
  /** Date d'échéance de paiement, si connue (jamais une période, R6). */
  dueDate?: string | null;
}

/** Choix proposé par l'IA (forme normalisée, sans identifiant). */
export interface PeriodChoice {
  representation: PeriodRepresentation;
  month?: string | null;
  fromMonth?: string | null;
  toMonth?: string | null;
  start?: string | null;
  end?: string | null;
  basis?: string | null;
  evidence?: ReadonlyArray<{ source: string; documentId?: number | null; quote?: string | null }>;
  confidence?: string | null;
}

export type PeriodRefusal =
  | 'UNKNOWN_DOCUMENT' | 'DUPLICATE_DECISION' | 'USER_TITLE_PROTECTED' | 'NOT_A_PERIODIC_DOCUMENT'
  | 'LOW_CONFIDENCE' | 'ARTIFICIAL_DATE' | 'PERIOD_INVENTED' | 'MISSING_VALUE' | 'NO_EVIDENCE' | 'INVALID_EVIDENCE' | 'NOT_A_RANGE';

export const PERIOD_REFUSAL_LABEL: Record<PeriodRefusal, string> = {
  UNKNOWN_DOCUMENT: 'Document hors de ceux fournis à l’IA (monde fermé)',
  DUPLICATE_DECISION: 'Décision en double pour ce document',
  USER_TITLE_PROTECTED: 'Titre corrigé par l’utilisateur : jamais remplacé',
  NOT_A_PERIODIC_DOCUMENT: 'Document sans période facturée ni mois désigné : rien à représenter',
  LOW_CONFIDENCE: 'Confiance IA insuffisante',
  ARTIFICIAL_DATE: 'Date d’émission, d’import, du jour ou d’échéance utilisée comme période',
  PERIOD_INVENTED: 'Période absente des données du document',
  MISSING_VALUE: 'Valeur de la représentation absente ou illisible',
  NO_EVIDENCE: 'Aucune preuve fondée sur la période facturée ou le mois désigné',
  INVALID_EVIDENCE: 'Source de preuve inconnue',
  NOT_A_RANGE: 'Plage de mois vide ou inversée',
};

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const cap = (s: string) => (s ? s.charAt(0).toLocaleUpperCase('fr-FR') + s.slice(1) : s);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ym = (iso: string | null | undefined): string | null => (iso && DAY_RE.test(iso.slice(0, 10)) ? iso.slice(0, 7) : iso && MONTH_RE.test(iso) ? iso : null);
const idx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
function day(v: string | null | undefined): string | null {
  return v && DAY_RE.test(v.slice(0, 10)) ? v.slice(0, 10) : null;
}

/** « Janvier à juin 2026 », « Décembre 2025 à février 2026 » (pure ; null si illisible ou vide). */
export function formatTitleMonthRange(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to || !MONTH_RE.test(from) || !MONTH_RE.test(to) || idx(from) >= idx(to)) return null;
  const [ya, ma] = [from.slice(0, 4), Number(from.slice(5, 7))];
  const [yb, mb] = [to.slice(0, 4), Number(to.slice(5, 7))];
  return ya === yb ? `${cap(MOIS[ma - 1])} à ${MOIS[mb - 1]} ${yb}` : `${cap(MOIS[ma - 1])} ${ya} à ${MOIS[mb - 1]} ${yb}`;
}

/** Le mois `m` est-il couvert par la période facturée ? */
function inBilled(m: string, f: PeriodFacts): boolean {
  const b = f.billedPeriod;
  if (!b) return false;
  const a = ym(b.start);
  const z = ym(b.end);
  return !!a && !!z && idx(m) >= idx(a) && idx(m) <= idx(z);
}

/** Mois d'une date « artificielle » (émission, échéance) — R6. */
const artificialMonths = (f: PeriodFacts) => new Set([ym(f.issueDate), ym(f.dueDate ?? null)].filter((x): x is string => !!x));
const artificialDays = (f: PeriodFacts) => new Set([day(f.issueDate), day(f.dueDate ?? null)].filter((x): x is string => !!x));

type Verdict = { ok: true; label: string | null } | { ok: false; code: PeriodRefusal; detail?: string };

/**
 * Validation SERVEUR d'un choix de représentation (pure) — R1, R6. Rend le
 * libellé composé (null pour NONE) ou le motif de refus. Ne juge jamais la
 * pertinence métier (décision de l'IA), seulement le fondement factuel.
 */
export function validatePeriodChoice(c: PeriodChoice, f: PeriodFacts): Verdict {
  if (!f.billedPeriod && !f.statedMonth) return { ok: false, code: 'NOT_A_PERIODIC_DOCUMENT' };
  if (c.confidence === 'conflictual') return { ok: false, code: 'LOW_CONFIDENCE' };
  const evidence = c.evidence ?? [];
  const basis = String(c.basis ?? '').trim().toUpperCase();
  if ((ARTIFICIAL_DATE_SOURCES as readonly string[]).includes(basis)) return { ok: false, code: 'ARTIFICIAL_DATE', detail: `fondement ${basis}` };
  for (const e of evidence) {
    const s = String(e.source ?? '').trim().toUpperCase();
    if ((ARTIFICIAL_DATE_SOURCES as readonly string[]).includes(s)) return { ok: false, code: 'ARTIFICIAL_DATE', detail: `preuve ${s}` };
    if (!(PERIOD_EVIDENCE_SOURCES as readonly string[]).includes(s)) return { ok: false, code: 'INVALID_EVIDENCE', detail: s.slice(0, 40) };
  }
  if (c.representation === 'NONE') return { ok: true, label: null };
  // Toute représentation datée repose sur la période facturée ou le mois désigné (R1).
  if (!evidence.some((e) => ['BILLED_PERIOD', 'STATED_MONTH'].includes(String(e.source).trim().toUpperCase()))) return { ok: false, code: 'NO_EVIDENCE' };
  const faux = (valeur: string, artificiel: boolean): Verdict => (artificiel
    ? { ok: false, code: 'ARTIFICIAL_DATE', detail: valeur }
    : { ok: false, code: 'PERIOD_INVENTED', detail: valeur });

  if (c.representation === 'MONTH') {
    const m = c.month ?? null;
    if (!m || !MONTH_RE.test(m)) return { ok: false, code: 'MISSING_VALUE', detail: 'month' };
    if (f.statedMonth?.value === m || inBilled(m, f)) return { ok: true, label: formatTitleMonth(m) };
    return faux(m, artificialMonths(f).has(m));
  }
  if (c.representation === 'DATE_RANGE') {
    const s = day(c.start ?? null);
    const e = day(c.end ?? null);
    if (!s || !e) return { ok: false, code: 'MISSING_VALUE', detail: 'start/end' };
    const b = f.billedPeriod;
    if (!b || day(b.start) !== s || day(b.end) !== e) {
      const art = artificialDays(f);
      return faux(`${s} → ${e}`, (art.has(s) && day(b?.start) !== s) || (art.has(e) && day(b?.end) !== e));
    }
    const label = presentBilledPeriod(s, e)?.label ?? null;
    return label ? { ok: true, label } : { ok: false, code: 'MISSING_VALUE', detail: 'start/end' };
  }
  // MULTI_MONTH
  const a = c.fromMonth ?? null;
  const z = c.toMonth ?? null;
  if (!a || !z || !MONTH_RE.test(a) || !MONTH_RE.test(z)) return { ok: false, code: 'MISSING_VALUE', detail: 'fromMonth/toMonth' };
  if (idx(a) >= idx(z)) return { ok: false, code: 'NOT_A_RANGE', detail: `${a} → ${z}` };
  if (!inBilled(a, f) || !inBilled(z, f)) return faux(`${a} → ${z}`, artificialMonths(f).has(a) || artificialMonths(f).has(z));
  return { ok: true, label: formatTitleMonthRange(a, z) };
}

/** Décision T3 PERSISTÉE d'un document (`asset_files.title_period_decision`). */
export interface StoredPeriodDecision {
  v: 1;
  contract: typeof T3_NAMING_PERIOD_CONTRACT;
  status: 'ACCEPTED' | 'REFUSED';
  representation: PeriodRepresentation | null;
  month?: string | null;
  fromMonth?: string | null;
  toMonth?: string | null;
  start?: string | null;
  end?: string | null;
  basis: string | null;
  evidence: Array<{ source: string; documentId?: number | null; quote?: string | null }>;
  reason: string | null;
  confidence: string | null;
  refusal?: PeriodRefusal | null;
  refusalDetail?: string | null;
  /** Faits sur lesquels la décision a été prise : une décision ne vaut que pour ces faits. */
  inputs: { start: string | null; end: string | null; statedMonth: string | null };
  promptVersion: string | null;
  traceId: string | null;
  decidedAt: string;
}

/** Faits « clés » d'une décision (comparaison de péremption). */
export function periodInputsOf(f: PeriodFacts): StoredPeriodDecision['inputs'] {
  return { start: f.billedPeriod?.start ?? null, end: f.billedPeriod?.end ?? null, statedMonth: f.statedMonth?.value ?? null };
}

/** Mêmes faits ? (comparaison champ à champ : l'ordre des clés d'un JSONB relu n'est pas garanti). */
export function samePeriodInputs(a: StoredPeriodDecision['inputs'] | null | undefined, b: StoredPeriodDecision['inputs']): boolean {
  return !!a && (a.start ?? null) === b.start && (a.end ?? null) === b.end && (a.statedMonth ?? null) === b.statedMonth;
}

/** Lecture tolérante d'une décision persistée (null si illisible ou d'un autre contrat). */
export function readStoredPeriodDecision(raw: unknown): StoredPeriodDecision | null {
  const x = (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw) as Partial<StoredPeriodDecision> | null;
  if (!x || typeof x !== 'object' || x.contract !== T3_NAMING_PERIOD_CONTRACT || !x.inputs) return null;
  if (x.status !== 'ACCEPTED' && x.status !== 'REFUSED') return null;
  if (x.representation != null && !(PERIOD_REPRESENTATIONS as readonly string[]).includes(x.representation)) return null;
  return { ...x, evidence: Array.isArray(x.evidence) ? x.evidence : [] } as StoredPeriodDecision;
}

/** Représentation RETENUE pour le titre, avec son fondement (diagnostic). */
export interface ResolvedTitlePeriod {
  /** Libellé du titre (null : aucun suffixe temporel). */
  label: string | null;
  representation: PeriodRepresentation;
  /**
   *   T3_DECISION    décision T3 DOCUMENT_NAMING valable pour les faits actuels ;
   *   STATED_MONTH   repli prudent : mois explicitement désigné par le document ;
   *   EXACT_PERIOD   repli prudent : période facturée présentée exactement (87D) ;
   *   NONE           aucune donnée temporelle exploitable.
   */
  source: 'T3_DECISION' | 'STATED_MONTH' | 'EXACT_PERIOD' | 'NONE';
  basis: string | null;
  evidence: Array<{ source: string; documentId?: number | null; quote?: string | null }>;
  /** Mois représenté (`AAAA-MM`) quand la représentation est MONTH. */
  month?: string | null;
  /** Décision T3 présente mais écartée (périmée, refusée, invalide) : motif. */
  decisionIgnored?: string | null;
}

/**
 * Représentation temporelle du titre (pure) : décision T3 si elle est
 * valable pour les faits ACTUELS (re-validée, R1 / R6), sinon repli prudent.
 */
export function resolveTitlePeriod(f: PeriodFacts, decision: StoredPeriodDecision | null): ResolvedTitlePeriod {
  let ignored: string | null = null;
  if (decision) {
    const memes = samePeriodInputs(decision.inputs, periodInputsOf(f));
    if (decision.status !== 'ACCEPTED' || !decision.representation) ignored = `REFUSED${decision.refusal ? ` ${decision.refusal}` : ''}`;
    else if (!memes) ignored = 'STALE_INPUTS';
    else {
      const v = validatePeriodChoice({ ...decision, representation: decision.representation }, f);
      if (v.ok) {
        return {
          label: v.label, representation: decision.representation, source: 'T3_DECISION', basis: decision.basis, evidence: decision.evidence.slice(0, 10),
          month: decision.representation === 'MONTH' ? decision.month ?? null : null,
        };
      }
      ignored = `INVALID ${v.code}`;
    }
  }
  const extra = ignored ? { decisionIgnored: ignored } : {};
  if (f.statedMonth) {
    const label = formatTitleMonth(f.statedMonth.value);
    if (label) {
      return {
        label, representation: 'MONTH', source: 'STATED_MONTH', basis: 'STATED_ON_DOCUMENT', evidence: [{ source: 'STATED_MONTH', quote: f.statedMonth.quote }],
        month: f.statedMonth.value, ...extra,
      };
    }
  }
  if (f.billedPeriod) {
    const p = presentBilledPeriod(f.billedPeriod.start, f.billedPeriod.end);
    if (p) {
      return {
        label: p.label, representation: p.kind === 'MONTH' ? 'MONTH' : p.kind === 'MONTH_RANGE' ? 'MULTI_MONTH' : 'DATE_RANGE',
        source: 'EXACT_PERIOD', basis: `BILLED_PERIOD ${f.billedPeriod.source}`, evidence: [{ source: 'BILLED_PERIOD', quote: `${f.billedPeriod.start} → ${f.billedPeriod.end}` }],
        month: p.kind === 'MONTH' ? ym(f.billedPeriod.start) : null, ...extra,
      };
    }
  }
  return { label: null, representation: 'NONE', source: 'NONE', basis: null, evidence: [], ...extra };
}
