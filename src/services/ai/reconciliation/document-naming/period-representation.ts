/**
 * T3 DOCUMENT_NAMING — REPRÉSENTATION TEMPORELLE DES TITRES (lot 99C, ticket
 * « représentation temporelle des titres de documents » ; contrat
 * `t3-naming-period-v1`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI DÉCIDE QUOI
 *
 *   · T1 extrait la période facturée (`document.billingPeriod`, lot 97A), le
 *     mois explicitement désigné et leurs preuves : des FAITS ;
 *   · la branche T3 DOCUMENT_NAMING existante DÉCIDE comment représenter
 *     cette période dans le titre d'une facture périodique : MONTH,
 *     DATE_RANGE, MULTI_MONTH ou NONE, avec son fondement et ses preuves —
 *     en tenant compte du type de document, du fournisseur, du contrat, de
 *     l'événement de référence et des titres des documents comparables de la
 *     même série (cohérence de série R5 fournie comme CONTEXTE, jamais comme
 *     règle codée) ;
 *   · le serveur VALIDE (R1 aucune période inventée, R6 jamais une date
 *     d'émission / d'import / du jour / d'échéance comme période, R7 titre
 *     utilisateur jamais remplacé) puis le service de nommage unique (87D)
 *     compose le titre (`ensureBusinessTitle`).
 *
 * MÊME BRANCHE, AUTRE APPEL : opération `t3_document_naming`, TASK
 * DOCUMENT_NAMING, mêmes six emplacements ; SUBJECT_CONTEXT.mode =
 * PERIOD_REPRESENTATION. Les factures sous convention périodique restent
 * hors de l'harmonisation des familles (`document_renames`, lot 87D) : seule
 * leur représentation temporelle est demandée ici.
 *
 * ACTIVATION PRUDENTE : aucun appel tant que la version ACTIVE du prompt T3
 * ne porte pas le marqueur `t3-naming-period-v1` (texte collé par le PO,
 * docs/exploitation/prompts-a-appliquer-par-le-po.md, étape 9) ; coupure
 * d'urgence `T3_NAMING_PERIOD_ENABLED=0`. Sans décision valable, le nommage
 * applique le repli prudent (`resolveTitlePeriod`) : mois explicitement
 * désigné, sinon période exacte, sinon rien.
 *
 * BORNES : `T3_NAMING_PERIOD_MAX_CALLS_PER_PASS` (2) appels par passage, au
 * plus `PERIOD_TARGETS_PER_CALL` documents par appel, plafond journalier
 * partagé avec l'harmonisation (`T3_NAMING_MAX_CALLS_PER_DAY`). Une décision
 * (acceptée ou refusée) est mémorisée avec les faits sur lesquels elle porte :
 * aucun nouvel appel tant que ces faits ne changent pas (refus : ni tant que
 * la version du prompt ne change pas).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { envNumber } from '@/lib/env-number';
import {
  ARTIFICIAL_DATE_SOURCES, PERIOD_EVIDENCE_SOURCES, PERIOD_REFUSAL_LABEL, PERIOD_REPRESENTATIONS, T3_NAMING_PERIOD_CONTRACT,
  periodInputsOf, validatePeriodChoice, type PeriodFacts, type PeriodRefusal, type StoredPeriodDecision,
} from '@/lib/documents/document-title-period';
import { isExecutionCancelled, type ExecutionGuard } from '../../queue/execution-control';
import type { ReportEntry, ReportStep } from '../../execution-report/model';
import type { T3DocumentNamingOutput, T3PeriodRepresentation } from '../master/t3-contract';
import type { NamingDocDetail } from './context';
import type { NamingCall, NamingCallResult, NamingPromptStatus } from './model';

/** Documents à décider par appel (une même série). */
export const PERIOD_TARGETS_PER_CALL = 12;
/** Titres comparables de la série transmis au plus. */
const SERIES_TITLES_MAX = 24;
/** Candidats lus par passage. */
const PERIOD_CANDIDATES_PER_PASS = 120;
const namingPeriodCallsPerPass = () => Math.min(20, Math.floor(envNumber('T3_NAMING_PERIOD_MAX_CALLS_PER_PASS', 2, { min: 0 })));

export const PERIOD_RELATION =
  'DOCUMENT_NAMING — représentation temporelle des titres (mode PERIOD_REPRESENTATION, contrat t3-naming-period-v1 ; sortie : period_representations, document_renames = [])';

/** Facture périodique à décider (faits recalculés par le service de nommage). */
export interface PeriodTarget {
  id: number;
  title: string;
  typeCode: string | null;
  nature: string;
  supplier: string;
  issueDate: string | null;
  facts: PeriodFacts;
  /** Citation T1 de la période facturée (`document.billingPeriod.evidence.quote`), si lue. */
  billingQuote?: string | null;
}

/** Document comparable de la même série (titre en place, période, représentation retenue). */
export interface SeriesMember {
  id: number;
  title: string;
  titleOrigin: 'USER' | 'SYSTEM';
  billedPeriod: { start: string; end: string } | null;
  statedMonth: string | null;
  representation: string | null;
}

/** Clé de série (nature + fournisseur normalisé) — regroupement des appels, jamais une règle de nommage. */
export const seriesKeyOf = (nature: string, supplier: string): string =>
  `${nature}|${supplier.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;

/**
 * Variables du master T3 pour un appel de représentation temporelle (pure,
 * déterministe) : les six emplacements de la branche, `null` pour ceux des
 * autres branches. Utilisé par la production ET le corpus (passage réel).
 */
export function periodRepresentationVariables(p: {
  series: { nature: string; supplier: string; members: readonly SeriesMember[] };
  targets: readonly PeriodTarget[];
  details?: ReadonlyMap<number, NamingDocDetail>;
}): Record<string, unknown> {
  const subject = {
    mode: 'PERIOD_REPRESENTATION',
    contract: T3_NAMING_PERIOD_CONTRACT,
    series: {
      nature: p.series.nature,
      supplier: p.series.supplier,
      // R5 : titres des documents comparables de la même série (contexte, jamais une règle).
      comparableTitles: [...p.series.members].sort((a, b) => (a.billedPeriod?.start ?? '').localeCompare(b.billedPeriod?.start ?? '') || a.id - b.id)
        .slice(-SERIES_TITLES_MAX).map((m) => ({
          documentId: m.id, title: m.title, titleOrigin: m.titleOrigin, billedPeriod: m.billedPeriod, statedMonth: m.statedMonth, representation: m.representation,
        })),
    },
    constraints: {
      representations: [...PERIOD_REPRESENTATIONS],
      evidenceSources: [...PERIOD_EVIDENCE_SOURCES],
      forbiddenPeriodSources: [...ARTIFICIAL_DATE_SOURCES],
      decideEveryDocumentToExamine: true,
      userTitlesAreNeverRenamed: true,
      majorityMonthIsOnlyAHint: true,
    },
  };
  const candidates = [...p.targets].sort((a, b) => a.id - b.id).map((t) => {
    const d = p.details?.get(t.id);
    return {
      documentId: t.id,
      role: 'TO_EXAMINE',
      currentName: t.title,
      documentType: t.typeCode,
      nature: t.nature,
      supplier: t.supplier,
      // R6 : date d'émission fournie pour être ÉCARTÉE comme période, jamais pour la représenter.
      issueDate: t.issueDate,
      billingPeriod: t.facts.billedPeriod ? { start: t.facts.billedPeriod.start, end: t.facts.billedPeriod.end, source: t.facts.billedPeriod.source, quote: t.billingQuote ?? null } : null,
      statedMonth: t.facts.statedMonth ? { value: t.facts.statedMonth.value, quote: t.facts.statedMonth.quote } : null,
      monthHint: t.facts.monthHint,
      contracts: d?.contracts ?? [],
      operations: d?.operations ?? [],
      facts: (d?.facts ?? []).slice(0, 12),
      excerpt: d?.excerpt ?? null,
    };
  });
  return {
    FIELD: null,
    CURRENT_STATE: null,
    EVIDENCES: null,
    SUBJECT_CONTEXT: JSON.stringify(subject),
    CANDIDATES: candidates,
    RELATION_TYPE: PERIOD_RELATION,
  };
}

export type PeriodVerdict =
  | { documentId: number; status: 'ACCEPTED'; label: string | null; decision: StoredPeriodDecision; proposal: T3PeriodRepresentation }
  | { documentId: number; status: 'REFUSED'; code: PeriodRefusal | 'NO_DECISION'; detail?: string; decision: StoredPeriodDecision | null; proposal: T3PeriodRepresentation | null };

/**
 * Jugement SERVEUR des décisions d'un appel (pure) : monde fermé (documents
 * TO_EXAMINE de l'appel), une décision par document, puis R1 / R6
 * (`validatePeriodChoice`). Un document sans décision dans la sortie est
 * rendu `NO_DECISION` (mémorisé comme refus : pas de rappel sur la même
 * version du prompt). R7 : les cibles sont des titres SYSTÈME ; l'écriture le
 * re-vérifie (compare-and-set).
 */
export function judgePeriodRepresentations(
  out: Pick<T3DocumentNamingOutput, 'period_representations'>, targets: readonly PeriodTarget[],
  meta: { promptVersion: string | null; traceId: string | null; now: Date },
): PeriodVerdict[] {
  const parId = new Map(targets.map((t) => [t.id, t]));
  const vus = new Set<number>();
  const verdicts: PeriodVerdict[] = [];
  const stocke = (t: PeriodTarget, p: T3PeriodRepresentation, status: 'ACCEPTED' | 'REFUSED', refusal: PeriodRefusal | null, detail: string | null): StoredPeriodDecision => ({
    v: 1, contract: T3_NAMING_PERIOD_CONTRACT, status, representation: p.representation,
    month: p.month ?? null, fromMonth: p.from_month ?? null, toMonth: p.to_month ?? null, start: p.start ?? null, end: p.end ?? null,
    basis: p.basis.slice(0, 60),
    evidence: (p.evidence ?? []).slice(0, 10).map((e) => ({ source: e.source.slice(0, 40), documentId: e.document_id ?? null, quote: e.quote?.slice(0, 300) ?? null })),
    reason: p.reason.slice(0, 400), confidence: p.confidence, refusal, refusalDetail: detail?.slice(0, 200) ?? null,
    inputs: periodInputsOf(t.facts), promptVersion: meta.promptVersion, traceId: meta.traceId, decidedAt: meta.now.toISOString(),
  });
  for (const p of out.period_representations ?? []) {
    const t = parId.get(p.document_id);
    if (!t) { verdicts.push({ documentId: p.document_id, status: 'REFUSED', code: 'UNKNOWN_DOCUMENT', decision: null, proposal: p }); continue; }
    if (vus.has(p.document_id)) { verdicts.push({ documentId: p.document_id, status: 'REFUSED', code: 'DUPLICATE_DECISION', decision: null, proposal: p }); continue; }
    vus.add(p.document_id);
    const v = validatePeriodChoice({
      representation: p.representation, month: p.month, fromMonth: p.from_month, toMonth: p.to_month, start: p.start, end: p.end,
      basis: p.basis, confidence: p.confidence,
      evidence: (p.evidence ?? []).map((e) => ({ source: e.source, documentId: e.document_id ?? null, quote: e.quote ?? null })),
    }, t.facts);
    if (v.ok) verdicts.push({ documentId: t.id, status: 'ACCEPTED', label: v.label, decision: stocke(t, p, 'ACCEPTED', null, null), proposal: p });
    else verdicts.push({ documentId: t.id, status: 'REFUSED', code: v.code, detail: v.detail, decision: stocke(t, p, 'REFUSED', v.code, v.detail ?? null), proposal: p });
  }
  for (const t of targets) {
    if (vus.has(t.id)) continue;
    verdicts.push({
      documentId: t.id, status: 'REFUSED', code: 'NO_DECISION', proposal: null,
      decision: {
        v: 1, contract: T3_NAMING_PERIOD_CONTRACT, status: 'REFUSED', representation: null, basis: null, evidence: [], reason: null, confidence: null,
        refusal: null, refusalDetail: 'NO_DECISION', inputs: periodInputsOf(t.facts), promptVersion: meta.promptVersion, traceId: meta.traceId, decidedAt: meta.now.toISOString(),
      },
    });
  }
  return verdicts;
}

export const PERIOD_REFUSAL_TEXT = (code: PeriodRefusal | 'NO_DECISION'): string =>
  (code === 'NO_DECISION' ? 'Aucune décision rendue par l’IA pour ce document (repli prudent conservé)' : PERIOD_REFUSAL_LABEL[code]);

// ── Accès base (bornés au compte) ─────────────────────────────────────────

type Sql = typeof import('@/db').pgClient;
const sqlClient = async (): Promise<Sql> => (await import('@/db')).pgClient;

/**
 * Factures périodiques SYSTÈME dont la représentation est à décider : aucune
 * décision, décision prise sur d'autres faits (bornes ou mois désigné), ou
 * refus sur une autre version du prompt. Titre utilisateur exclu (R7).
 */
export async function loadPeriodCandidateIds(accountId: number, promptVersion: string | null, limit = PERIOD_CANDIDATES_PER_PASS): Promise<number[]> {
  const sql = await sqlClient();
  const rows = (await sql.unsafe(
    `SELECT f.id FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
        AND f.title_convention = 'PERIODIC' AND f.title_source = 'SYSTEM'
        AND COALESCE((f.user_edited_fields ->> 'retainedTitle') = 'true', false) = false
        AND jsonb_typeof(f.title_basis -> 'billedPeriod') = 'object'
        AND (f.title_period_decision IS NULL
             OR f.title_period_decision -> 'inputs' ->> 'start' IS DISTINCT FROM f.title_basis -> 'billedPeriod' ->> 'start'
             OR f.title_period_decision -> 'inputs' ->> 'end' IS DISTINCT FROM f.title_basis -> 'billedPeriod' ->> 'end'
             OR (f.title_basis ? 'statedMonth' AND f.title_period_decision -> 'inputs' ->> 'statedMonth' IS DISTINCT FROM f.title_basis ->> 'statedMonth')
             OR (f.title_period_decision ->> 'status' <> 'ACCEPTED' AND f.title_period_decision ->> 'promptVersion' IS DISTINCT FROM $2::text))
      ORDER BY f.id LIMIT $3`,
    [accountId, promptVersion, limit] as never[],
  )) as unknown as Array<{ id: number }>;
  return rows.map((r) => Number(r.id));
}

/** Faits ACTUELS d'un document, recalculés par le service de nommage unique (aucune analyse relancée). */
async function loadTarget(accountId: number, fileId: number): Promise<PeriodTarget | null> {
  const svc = await import('@/services/documents/document-title.service');
  const { periodFactsOf } = await import('@/services/ai/source-analysis/document-title');
  const inputs = await svc.loadPersistedTitleInputs(fileId, accountId);
  if (!inputs) return null;
  const { plan, basis } = await svc.planTitleForDocument(fileId, accountId, inputs);
  if (plan.convention !== 'PERIODIC' || !plan.supplier) return null;
  const facts = periodFactsOf(basis);
  if (!facts.billedPeriod) return null;
  const sql = await sqlClient();
  const [r] = (await sql.unsafe(
    `SELECT retained_title, COALESCE(document_type_code, document_type) AS type_code, title_period_decision
       FROM asset_files WHERE id = $1 AND account_id = $2 AND title_source = 'SYSTEM' AND deleted_at IS NULL`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ retained_title: string | null; type_code: string | null; title_period_decision: unknown }>;
  if (!r) return null;
  const { readStoredPeriodDecision, samePeriodInputs } = await import('@/lib/documents/document-title-period');
  // Décision déjà prise sur ces mêmes faits (sélection SQL sur des données de nommage pas encore à jour) : rien à demander.
  const existante = readStoredPeriodDecision(r.title_period_decision);
  if (existante && existante.status === 'ACCEPTED' && samePeriodInputs(existante.inputs, periodInputsOf(facts))) return null;
  return {
    id: fileId, title: r.retained_title ?? '', typeCode: r.type_code ?? inputs.ctx.typeCode ?? null, nature: plan.nature, supplier: plan.supplier,
    issueDate: basis.issueDate, facts, billingQuote: null,
  };
}

/** Documents de la même série (nature + fournisseur), toutes origines de titre, bornés. */
async function loadSeries(accountId: number, nature: string, supplier: string): Promise<SeriesMember[]> {
  const sql = await sqlClient();
  const rows = (await sql.unsafe(
    `SELECT id, retained_title, title_source, title_basis, title_period_decision ->> 'representation' AS representation,
            title_period_decision ->> 'status' AS status
       FROM asset_files
      WHERE account_id = $1 AND deleted_at IS NULL AND grouped_into_file_id IS NULL AND title_convention = 'PERIODIC'
        AND title_basis ->> 'nature' = $2 AND lower(title_basis ->> 'supplier') = lower($3)
      ORDER BY COALESCE(title_basis -> 'billedPeriod' ->> 'start', '') DESC, id DESC LIMIT ${SERIES_TITLES_MAX * 2}`,
    [accountId, nature, supplier] as never[],
  )) as unknown as Array<{ id: number; retained_title: string | null; title_source: string | null; title_basis: unknown; representation: string | null; status: string | null }>;
  return rows.map((r) => {
    const b = (typeof r.title_basis === 'string' ? JSON.parse(r.title_basis) : r.title_basis) as { billedPeriod?: { start?: string; end?: string } | null; statedMonth?: string | null } | null;
    return {
      id: Number(r.id), title: r.retained_title ?? '', titleOrigin: r.title_source === 'USER' ? 'USER' as const : 'SYSTEM' as const,
      billedPeriod: b?.billedPeriod?.start && b.billedPeriod.end ? { start: b.billedPeriod.start, end: b.billedPeriod.end } : null,
      statedMonth: b?.statedMonth ?? null, representation: r.status === 'ACCEPTED' ? r.representation : null,
    };
  });
}

/** Persiste une décision (compare-and-set : titre toujours SYSTÈME, toujours sous convention). Jamais `updated_at`. */
async function persistDecision(accountId: number, fileId: number, d: StoredPeriodDecision): Promise<boolean> {
  const sql = await sqlClient();
  const rows = (await sql.unsafe(
    `UPDATE asset_files SET title_period_decision = $3::jsonb
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL AND title_source = 'SYSTEM' AND title_convention = 'PERIODIC'
        AND COALESCE((user_edited_fields ->> 'retainedTitle') = 'true', false) = false
      RETURNING id`,
    [fileId, accountId, JSON.stringify(d)] as never[],
  )) as unknown as unknown[];
  return rows.length > 0;
}

// ── Étape de la phase DOCUMENT_NAMING ──────────────────────────────────────

export interface PeriodStepResult {
  status: 'SKIPPED_NO_CONTRACT' | 'DISABLED' | 'NOTHING_TO_DO' | 'DONE' | 'PARTIAL' | 'CAPPED';
  candidates: number;
  calls: number;
  decided: number;
  accepted: number;
  refused: number;
  titlesUpdated: number;
  remaining: number;
  steps: ReportStep[];
  entries: ReportEntry[];
  traceIds: string[];
}

/**
 * Représentation temporelle des factures périodiques d'un compte (une étape
 * de la phase DOCUMENT_NAMING). Ne lève pas, sauf interruption d'exécution.
 */
export async function runPeriodRepresentationStep(accountId: number, o: {
  prompt: NamingPromptStatus;
  callModel: (p: NamingCall) => Promise<NamingCallResult>;
  /** Appels encore permis par le plafond journalier partagé. */
  dailyBudget: number;
  maxCallsPerPass?: number;
  now: () => Date;
  guard?: ExecutionGuard;
}): Promise<PeriodStepResult> {
  const r: PeriodStepResult = { status: 'NOTHING_TO_DO', candidates: 0, calls: 0, decided: 0, accepted: 0, refused: 0, titlesUpdated: 0, remaining: 0, steps: [], entries: [], traceIds: [] };
  const svc = await import('@/services/documents/document-title.service');
  if (!svc.namingPeriodDecisionsEnabled()) return { ...r, status: 'DISABLED' };
  if (!o.prompt.available || !o.prompt.periodContract) return { ...r, status: 'SKIPPED_NO_CONTRACT' };
  let ids: number[];
  try { ids = await loadPeriodCandidateIds(accountId, o.prompt.version); } catch (e) {
    r.steps.push({ step: 'REPRÉSENTATION TEMPORELLE — lecture', status: 'FAILED', error: ((e as Error).message ?? '').slice(0, 200) });
    return r;
  }
  if (!ids.length) return r;
  const parPassage = Math.min(o.maxCallsPerPass ?? namingPeriodCallsPerPass(), Math.max(0, o.dailyBudget));
  const series = new Map<string, PeriodTarget[]>();
  for (const id of ids) {
    const t = await loadTarget(accountId, id).catch(() => null);
    if (!t) continue;
    const k = seriesKeyOf(t.nature, t.supplier);
    series.set(k, [...(series.get(k) ?? []), t]);
  }
  r.candidates = [...series.values()].reduce((a, l) => a + l.length, 0);
  if (!r.candidates) return r;
  const { loadDocDetails } = await import('./repository');
  for (const [, cibles] of [...series.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (let i = 0; i < cibles.length; i += PERIOD_TARGETS_PER_CALL) {
      const lot = cibles.slice(i, i + PERIOD_TARGETS_PER_CALL);
      if (r.calls >= parPassage) { r.remaining += lot.length; continue; }
      if (o.guard) await o.guard.assertActive('T3 représentation temporelle des titres');
      const membres = await loadSeries(accountId, lot[0].nature, lot[0].supplier).catch(() => [] as SeriesMember[]);
      const details = await loadDocDetails(accountId, lot.map((t) => t.id)).catch(() => new Map<number, NamingDocDetail>());
      const variables = periodRepresentationVariables({ series: { nature: lot[0].nature, supplier: lot[0].supplier, members: membres }, targets: lot, details });
      r.calls++;
      let sortie: NamingCallResult;
      try {
        sortie = await o.callModel({ accountId, sourceIds: lot.map((t) => t.id).sort((a, b) => a - b), variables });
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        r.steps.push({ step: `REPRÉSENTATION TEMPORELLE ${lot[0].supplier}`, status: 'FAILED', error: ((e as Error).message ?? '').slice(0, 200) });
        r.remaining += lot.length;
        continue;
      }
      if (sortie.traceId) r.traceIds.push(sortie.traceId);
      const out = sortie.output;
      // Section absente : réponse incomplète — repli prudent conservé, refus mémorisé (pas de rappel sur cette version).
      const manquante = !Array.isArray(out.period_representations);
      const verdicts = judgePeriodRepresentations(out, lot, { promptVersion: o.prompt.version, traceId: sortie.traceId, now: o.now() });
      r.steps.push({ step: `REPRÉSENTATION TEMPORELLE ${lot[0].supplier}`, status: manquante ? 'FAILED' : 'OK', error: manquante ? 'PERIOD_SECTION_MISSING' : null, detail: {
        toExamine: lot.map((t) => t.id), series: membres.length, traceId: sortie.traceId,
        accepted: verdicts.filter((v) => v.status === 'ACCEPTED').length, refused: verdicts.filter((v) => v.status === 'REFUSED').length,
      } });
      for (const v of verdicts) {
        const t = lot.find((x) => x.id === v.documentId);
        if (!t) {
          // Hors monde fermé : jamais journalisé sous son identifiant (peut appartenir à un autre compte).
          r.refused++;
          r.entries.push({ section: 'NAMING_PERIOD', label: 'Décision hors des documents fournis', writeResult: 'NOT_WRITTEN', reasonCode: 'UNKNOWN_DOCUMENT', reason: PERIOD_REFUSAL_TEXT('UNKNOWN_DOCUMENT') });
          continue;
        }
        if (!v.decision) {
          r.refused++;
          r.entries.push(entry(t, v, 'NOT_WRITTEN', null));
          continue;
        }
        const ecrit = await persistDecision(accountId, t.id, v.decision).catch(() => false);
        r.decided += ecrit ? 1 : 0;
        if (v.status === 'REFUSED') { r.refused++; r.entries.push(entry(t, v, 'NOT_WRITTEN', null)); continue; }
        r.accepted++;
        if (!ecrit) {
          // R7 : titre devenu utilisateur (ou document sorti de la convention) entre la lecture et l'écriture.
          r.entries.push(entry(t, v, 'NOT_WRITTEN', null, 'USER_TITLE_PROTECTED'));
          continue;
        }
        const res = await svc.ensureBusinessTitle({ fileId: t.id, accountId, origin: 'T3', mode: 'repair', trigger: 'CONTEXT_CHANGED', guard: o.guard });
        if (res.outcome === 'UPDATED') r.titlesUpdated++;
        r.entries.push(entry(t, v, 'WRITTEN', res.newTitle ?? null, res.outcome));
      }
    }
  }
  r.status = r.remaining > 0 ? (r.calls > 0 ? 'PARTIAL' : 'CAPPED') : 'DONE';
  return r;
}

function entry(t: PeriodTarget, v: PeriodVerdict, writeResult: 'WRITTEN' | 'NOT_WRITTEN', newTitle: string | null, outcome?: string): ReportEntry {
  const p = v.proposal;
  return {
    section: 'NAMING_PERIOD', tableName: 'asset_files', recordId: t.id, columnPath: 'title_period_decision',
    entityType: 'DOCUMENT', entityId: t.id, label: t.title.slice(0, 200), oldValue: t.title,
    value: p ? { representation: p.representation, month: p.month ?? null, fromMonth: p.from_month ?? null, toMonth: p.to_month ?? null, start: p.start ?? null, end: p.end ?? null } : null,
    writeResult,
    reasonCode: v.status === 'ACCEPTED' ? (outcome ?? 'ACCEPTED') : v.code,
    reason: v.status === 'ACCEPTED'
      ? `Représentation retenue (${p?.representation}) : ${p?.reason ?? ''}`.slice(0, 400)
      : `${PERIOD_REFUSAL_TEXT(v.code)}${v.detail ? ` (${v.detail})` : ''}`,
    links: {
      contract: T3_NAMING_PERIOD_CONTRACT, basis: p?.basis ?? null, evidence: p?.evidence ?? [], confidence: p?.confidence ?? null,
      facts: { billedPeriod: t.facts.billedPeriod, statedMonth: t.facts.statedMonth?.value ?? null, issueDate: t.issueDate },
      label: v.status === 'ACCEPTED' ? v.label : null, finalTitle: newTitle,
    },
  };
}
