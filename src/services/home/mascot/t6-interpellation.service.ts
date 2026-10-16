/**
 * T6 — décision d'interpellation, partie SERVEUR (lot 60).
 *
 * Lit, pour un compte et — s'il est connu — un utilisateur :
 *   · le seuil indicatif (BO › Configuration IA › réglages, « Mascotte
 *     d'accueil — T6 », sinon `MASCOT_T6_INTERPELLATION_THRESHOLD_DAYS`, 60) ;
 *   · les préférences de rappel de CET utilisateur (Duo : jamais celles de
 *     l'autre membre) ;
 *   · les dernières évaluations IA du compte ;
 *   · l'historique récent des présentations à cet utilisateur (anti-répétition) ;
 * puis applique `decideT6Interpellation` à chaque échéance candidate, AVANT la
 * composition de l'accueil. Toutes les lectures sont bornées au compte, et
 * chaque préférence ou évaluation est rejointe à une échéance DU compte.
 *
 * Une lecture en échec (table absente pendant le déploiement, base
 * indisponible) n'empêche jamais l'accueil : décision prudente, sans IA ni
 * préférence (aucune interpellation au-delà du seuil).
 */
import { pgClient } from '@/db';
import type { MascotAgendaRow, MascotDecidedAgenda, MascotRawData } from './signals';
import { EXT_ACTION_LOOKBACK_DAYS, extActionOccurrenceKey, formatDateFr, roleOf } from './signals';
import { canonicalJson, sha256 } from './hash';
import { entriesFingerprint, serializeForHash, sha256 as reportSha256, type ReportEntry } from '@/services/ai/execution-report/model';
import {
  DEFAULT_T6_THRESHOLD_DAYS, T6_ASSESSMENT_CONTRACT, T6_MAX_ASSESSMENTS_PER_CALL, T6_REPEAT_WINDOW_DAYS,
  addDays, agendaFingerprintParts, agendaOccurrenceKey, agendaSubjectKey, assessmentFromDecision, assessmentHorizonDays, compareShown,
  daysBetween, decideT6Interpellation, suggestReminderDate,
  type T6Assessment, type T6Candidate, type T6CandidateRef, type T6DecisionResult, type T6InterpellationBundle, type T6ReminderPreference,
  type T6StoredAssessment,
} from './t6-interpellation';
import {
  T6_EVALUATION_INPUT_SCHEMA_VERSION,
  type T6EvaluationCandidate, type T6EvidenceRef, type T6ValidatedDecision,
} from './t6-contract';

type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[]): Promise<Row[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];

/** Empreinte stable d'une échéance (champs significatifs). */
export function agendaFingerprint(p: { title: string; date: string | null; forecast: boolean; requiresQualification: boolean }): string {
  return sha256(agendaFingerprintParts(p)).slice(0, 32);
}

// ── Réglage ──────────────────────────────────────────────────────────────────

/** Seuil indicatif effectif (BO > environnement > 60). Ne lève jamais. */
export async function t6ThresholdDays(): Promise<number> {
  try {
    const m = await import('@/services/verebona-assistant/config/assistant-settings');
    await m.refreshAssistantSettings();
    const v = Number(m.effectiveSetting('t6_interpellation_threshold_days'));
    return Number.isInteger(v) && v > 0 ? v : DEFAULT_T6_THRESHOLD_DAYS;
  } catch {
    return DEFAULT_T6_THRESHOLD_DAYS;
  }
}

// ── Lectures ─────────────────────────────────────────────────────────────────

/** Préférences de rappel de l'utilisateur, rattachées à une échéance du compte (ou à une série). */
export async function loadUserPreferences(accountId: number, userId: number): Promise<T6ReminderPreference[]> {
  const r = await rows(
    `SELECT p.scope, p.decision, to_char(p.remind_at, 'YYYY-MM-DD') AS remind_at, p.context_fingerprint,
            p.agenda_item_id, p.series_key, p.updated_at
       FROM t6_reminder_preferences p
      WHERE p.account_id = $1 AND p.user_id = $2
        AND (p.agenda_item_id IS NULL
             OR EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = p.agenda_item_id AND i.account_id = p.account_id))
      LIMIT 2000`,
    [accountId, userId],
  );
  return r.map((x) => ({
    scope: x.scope === 'SERIES' ? 'SERIES' : 'OCCURRENCE',
    decision: x.decision === 'DISMISSED' ? 'DISMISSED' : 'SNOOZED',
    remindAt: (x.remind_at as string | null) ?? null,
    contextFingerprint: (x.context_fingerprint as string | null) ?? null,
    agendaItemId: x.agenda_item_id == null ? null : Number(x.agenda_item_id),
    seriesKey: (x.series_key as string | null) ?? null,
    updatedAt: x.updated_at ? new Date(String(x.updated_at)).toISOString() : null,
  }));
}

/** Préférences applicables à une échéance : son occurrence, et sa série. */
export function preferencesFor(prefs: readonly T6ReminderPreference[], agendaItemId: number, seriesKey: string | null): T6ReminderPreference[] {
  return prefs.filter((p) => (p.scope === 'OCCURRENCE' && p.agendaItemId === agendaItemId)
    || (p.scope === 'SERIES' && seriesKey != null && p.seriesKey === seriesKey));
}

export async function loadAssessments(accountId: number, agendaIds: number[]): Promise<Map<number, T6StoredAssessment>> {
  const out = new Map<number, T6StoredAssessment>();
  if (agendaIds.length === 0) return out;
  const r = await rows(
    `SELECT a.id, a.agenda_item_id, a.context_fingerprint, to_char(a.assessed_on, 'YYYY-MM-DD') AS assessed_on,
            a.interpellation, a.action_needed, a.priority, to_char(a.action_date, 'YYYY-MM-DD') AS action_date,
            to_char(a.reevaluate_on, 'YYYY-MM-DD') AS reevaluate_on, a.reason, a.action, a.consequence, a.uncertainty,
            a.exception_reason, a.prompt_version, a.trace_id,
            a.contract_version, a.decision, a.category, a.reason_code, a.evidence_refs, a.uncertainties
       FROM t6_interpellation_assessments a
       JOIN agenda_items i ON i.id = a.agenda_item_id AND i.account_id = a.account_id
      WHERE a.account_id = $1 AND a.agenda_item_id = ANY($2::int[])`,
    [accountId, agendaIds],
  );
  for (const x of r) {
    out.set(Number(x.agenda_item_id), {
      id: Number(x.id),
      fingerprint: String(x.context_fingerprint),
      assessedOn: String(x.assessed_on),
      interpellation: x.interpellation as T6Assessment['interpellation'],
      actionNeeded: x.action_needed === true,
      priority: x.priority as T6Assessment['priority'],
      actionDate: (x.action_date as string | null) ?? null,
      reevaluateOn: (x.reevaluate_on as string | null) ?? null,
      reason: String(x.reason ?? ''),
      action: (x.action as string | null) ?? null,
      consequence: (x.consequence as string | null) ?? null,
      uncertainty: (x.uncertainty as string | null) ?? null,
      exceptionReason: (x.exception_reason as string | null) ?? null,
      promptVersion: (x.prompt_version as string | null) ?? null,
      traceId: (x.trace_id as string | null) ?? null,
      // Lot 61 (migration 0447) : contrat `t6-evaluation-v1`.
      contractVersion: (x.contract_version as string | null) ?? null,
      decision: (x.decision as T6Assessment['decision']) ?? undefined,
      category: (x.category as T6Assessment['category']) ?? undefined,
      reasonCode: (x.reason_code as string | null) ?? null,
      evidenceRefs: Array.isArray(x.evidence_refs) ? (x.evidence_refs as string[]) : [],
      uncertainties: Array.isArray(x.uncertainties) ? (x.uncertainties as string[]) : [],
    });
  }
  return out;
}

/** Clés d'occurrence possibles d'une échéance dans la télémétrie de la mascotte. */
const telemetryKeys = (id: number) => [`DATE-NEXT:${id}`, extActionOccurrenceKey(id), `MASC-BLOCKED:agenda:${id}`];

/**
 * Jours DISTINCTS où l'échéance a été présentée à cet utilisateur
 * (télémétrie « affiché »), dans la fenêtre d'anti-répétition et depuis la
 * dernière évaluation (même contexte). Par échéance.
 */
export async function loadDisplayHistory(
  accountId: number, userId: number, since: ReadonlyMap<number, string>, today: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (since.size === 0) return out;
  const cles = [...since.keys()].flatMap(telemetryKeys);
  const r = await rows(
    `SELECT occurrence_key, array_agg(DISTINCT to_char(created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD')) AS jours
       FROM home_mascot_events
      WHERE account_id = $1 AND user_id = $2 AND event_type = 'displayed' AND occurrence_key = ANY($3::text[])
        AND created_at > ($4::date - $5::int)
      GROUP BY occurrence_key`,
    [accountId, userId, cles, today, T6_REPEAT_WINDOW_DAYS],
  );
  const parId = new Map<number, Set<string>>();
  for (const x of r) {
    const m = /(\d+)$/.exec(String(x.occurrence_key));
    if (!m) continue;
    const id = Number(m[1]);
    const depuis = since.get(id);
    if (!depuis) continue;
    const s = parId.get(id) ?? new Set<string>();
    for (const j of (x.jours as string[] | null) ?? []) if (j >= depuis) s.add(j);
    parId.set(id, s);
  }
  for (const [id, s] of parId) out.set(id, s.size);
  return out;
}

/** Contexte documentaire des candidats à évaluer : description, documents liés (titres). Borné au compte. */
async function loadCandidateDetails(accountId: number, ids: number[]): Promise<Map<number, { description: string | null; documents: string[] }>> {
  const out = new Map<number, { description: string | null; documents: string[] }>();
  if (ids.length === 0) return out;
  const r = await rows(
    `SELECT i.id, left(i.description, 600) AS description,
            (SELECT array_agg(t ORDER BY t) FROM (
               SELECT COALESCE(NULLIF(f.retained_title, ''), NULLIF(f.original_filename, ''), f.filename) AS t
                 FROM agenda_file_links l JOIN asset_files f ON f.id = l.asset_file_id AND f.account_id = i.account_id AND f.deleted_at IS NULL
                WHERE l.agenda_item_id = i.id LIMIT 3) d) AS documents
       FROM agenda_items i
      WHERE i.account_id = $1 AND i.id = ANY($2::int[])`,
    [accountId, ids],
  );
  for (const x of r) {
    const desc = typeof x.description === 'string' ? x.description.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    out.set(Number(x.id), { description: desc || null, documents: ((x.documents as string[] | null) ?? []).map((t) => String(t).slice(0, 120)) });
  }
  return out;
}

/**
 * Enregistre les décisions EVALUATE validées (lot 61, contrat
 * `t6-evaluation-v1`) : une ligne par échéance, la plus récente l'emporte —
 * `t6_interpellation_assessments` sert de CACHE des évaluations valides
 * (réutilisées tant que l'échéance ne change pas de façon significative).
 * L'échéance est revérifiée DANS le compte : jamais une évaluation rattachée
 * à l'échéance d'un autre compte. Aucune préférence de rappel n'est écrite
 * (`suggestedReviewAt` reste une réévaluation système).
 */
export async function persistT6Assessments(
  accountId: number, today: string,
  refs: T6InterpellationBundle['refs'],
  list: readonly T6ValidatedDecision[],
  meta: { promptVersion: string; traceId: string | null },
): Promise<number> {
  let n = 0;
  for (const d of list) {
    const c = refs.get(d.subjectId);
    if (!c) continue;
    const a = assessmentFromDecision(d);
    const r = await rows(
      `INSERT INTO t6_interpellation_assessments
         (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation, action_needed, priority,
          action_date, reevaluate_on, reason, action, consequence, uncertainty, exception_reason, prompt_version, trace_id,
          contract_version, decision, category, reason_code, evidence_refs, uncertainties)
       SELECT $1, i.id, $3, $4, $5::date, $6, $7, $8, $9::date, $10::date, $11, $12, $13, $14, $15, $16, $17,
              $18, $19, $20, $21, $22::jsonb, $23::jsonb
         FROM agenda_items i WHERE i.id = $2 AND i.account_id = $1
       ON CONFLICT (account_id, subject_key) DO UPDATE SET
         agenda_item_id = EXCLUDED.agenda_item_id, context_fingerprint = EXCLUDED.context_fingerprint,
         assessed_on = EXCLUDED.assessed_on, interpellation = EXCLUDED.interpellation, action_needed = EXCLUDED.action_needed,
         priority = EXCLUDED.priority, action_date = EXCLUDED.action_date, reevaluate_on = EXCLUDED.reevaluate_on,
         reason = EXCLUDED.reason, action = EXCLUDED.action, consequence = EXCLUDED.consequence,
         uncertainty = EXCLUDED.uncertainty, exception_reason = EXCLUDED.exception_reason,
         prompt_version = EXCLUDED.prompt_version, trace_id = EXCLUDED.trace_id,
         contract_version = EXCLUDED.contract_version, decision = EXCLUDED.decision, category = EXCLUDED.category,
         reason_code = EXCLUDED.reason_code, evidence_refs = EXCLUDED.evidence_refs, uncertainties = EXCLUDED.uncertainties,
         updated_at = now()
       RETURNING id`,
      [accountId, c.agendaItemId, c.subjectKey, c.fingerprint, today, a.interpellation, a.actionNeeded, a.priority,
        a.actionDate, a.reevaluateOn, a.reason, a.action, a.consequence, a.uncertainty, a.exceptionReason,
        meta.promptVersion, meta.traceId,
        T6_ASSESSMENT_CONTRACT, d.decision, d.category, d.reasonCode, JSON.stringify(d.evidenceRefs), JSON.stringify(d.uncertainties)],
    );
    n += r.length;
  }
  return n;
}

// ── Candidats ────────────────────────────────────────────────────────────────

/** Échéances déjà portées par une action « À traiter » (ATP-004). */
function agendaInToProcess(raw: MascotRawData): Set<number> {
  const ids = new Set((raw.toProcess ?? []).filter((a) => a.targetType === 'AGENDA_ITEM').map((a) => a.targetId));
  (raw.toProcessAgendaIds ?? []).forEach((id) => ids.add(id));
  return ids;
}

export interface T6CandidateRow { candidate: T6Candidate; row: MascotAgendaRow }

/**
 * Échéances candidates (pur) : à venir (hors « à préciser ») et arrivées à
 * date depuis moins de 60 jours (hors prévisions) — mêmes sources et mêmes
 * exclusions que le chemin historique, une échéance = un candidat.
 */
export function t6Candidates(raw: MascotRawData): T6CandidateRow[] {
  const exclues = agendaInToProcess(raw);
  const acquittes = new Set((raw.acknowledgments ?? []).map((a) => `${a.occurrenceKey}|${a.cycleKey}`));
  // Lot 61 : échéance passée réglée par « À traiter » (aucune intervention attendue, ou tranchée).
  const regles = new Set(raw.toProcessSettledAgendaIds ?? []);
  const out: T6CandidateRow[] = [];
  for (const i of raw.agenda ?? []) {
    if (!i.date || exclues.has(i.id)) continue;
    const future = i.date > raw.today;
    if (future && i.requiresQualification) continue;
    if (!future && (i.forecast || daysBetween(i.date, raw.today) > EXT_ACTION_LOOKBACK_DAYS)) continue;
    // « C'est fait » déclaré pour ce cycle : le sujet est résolu.
    const fait = !future && !i.requiresQualification
      && (acquittes.has(`${extActionOccurrenceKey(i.id)}|${i.date}`) || regles.has(i.id));
    out.push({
      row: i,
      candidate: {
        subjectKey: agendaSubjectKey(i.id), agendaItemId: i.id, occurrenceKey: agendaOccurrenceKey(i.id, i.date),
        seriesKey: i.seriesKey ?? null, accountId: raw.accountId, assetId: i.assetId, dueDate: i.date,
        state: fait ? 'RESOLVED' : 'ACTIVE', requiresQualification: i.requiresQualification,
        fingerprint: agendaFingerprint({ title: i.title, date: i.date, forecast: i.forecast, requiresQualification: i.requiresQualification }),
      },
    });
  }
  return out;
}

// ── Préparation (décision de toutes les échéances candidates) ───────────────

export interface T6DecisionTrace extends T6DecisionResult {
  agendaItemId: number;
  dueDate: string | null;
  seriesKey: string | null;
  assessment: T6StoredAssessment | null;
  displayedDays: number;
}

export interface T6Preparation {
  thresholdDays: number;
  aiCapable: boolean;
  /** Échéances à présenter, dans l'ordre (priorité, puis date). */
  shown: MascotDecidedAgenda[];
  decisions: T6DecisionTrace[];
  /** Échéances écartées ou différées (texte libre : jamais réintroduites). */
  notInterpellated: Set<number>;
  /** Échéances que l'utilisateur a reportées ou refusées (questions suggérées : retirées). */
  userSilenced: Set<number>;
  /**
   * Lot 61 : échéances ÉCARTÉES après évaluation (décision IA validée non
   * retenue, ou préférence de l'utilisateur) — jamais réintroduites par une
   * question suggérée. Une échéance jamais évaluée (au-delà de l'horizon)
   * reste consultable : seule une question de consultation peut la citer.
   */
  discarded: Set<number>;
  /** Candidats à faire évaluer par T6 (MODE=EVALUATE, lot 61), ou null. */
  bundle: T6InterpellationBundle | null;
  /** Une lecture a échoué : décision prudente sans préférence ni évaluation. */
  degraded: boolean;
  /**
   * Lot 61 — état de l'évaluation pour la présentation : `PENDING`, une
   * échéance proche (dans le seuil) attend son évaluation ; `UNAVAILABLE`,
   * une échéance proche n'a pas pu être évaluée (T6 coupé, version BO sans
   * EVALUATE, lectures en échec) ; `OK` sinon. Jamais « rien à signaler »
   * tant qu'une échéance proche n'a pas été examinée.
   */
  evaluation: T6EvaluationState;
}

export type T6EvaluationState = 'OK' | 'PENDING' | 'UNAVAILABLE';

/** Codes d'une échéance proche en attente d'évaluation. */
const EN_ATTENTE = new Set(['AI_ASSESSMENT_PENDING', 'AWAITING_REEVALUATION_AFTER_SNOOZE']);

/** État de l'évaluation des échéances proches (pure, testée T6-EV). */
export function evaluationStateOf(decisions: readonly T6DecisionResult[], opts: { degraded?: boolean; recentFailure?: boolean } = {}): T6EvaluationState {
  const proches = decisions.filter((d) => !d.thresholdApplied);
  if (proches.some((d) => d.code === 'EVALUATION_UNAVAILABLE')) return 'UNAVAILABLE';
  if (proches.some((d) => EN_ATTENTE.has(d.code))) return opts.recentFailure || opts.degraded ? 'UNAVAILABLE' : 'PENDING';
  return 'OK';
}

export interface PrepareDeps {
  aiCapable: () => Promise<boolean>;
  thresholdDays: () => Promise<number>;
  /** Lot 61 : une évaluation EVALUATE de ce compte a échoué récemment (mode dégradé). */
  recentEvaluationFailure?: (accountId: number) => boolean;
  /** Après enregistrement d'évaluations (ex. : pré-génération de l'accueil). */
  onAssessed?: (count: number) => void;
}

/**
 * Décide, pour chaque échéance candidate du compte, s'il faut l'afficher,
 * la différer ou l'écarter — pour CET utilisateur (`userId` null :
 * pré-génération du compte, sans préférence personnelle).
 */
export async function prepareT6Interpellation(
  p: { accountId: number; userId: number | null; raw: MascotRawData },
  deps: PrepareDeps,
): Promise<T6Preparation> {
  const today = p.raw.today;
  const candidats = t6Candidates(p.raw);
  const [thresholdDays, aiCapableBrut] = await Promise.all([
    deps.thresholdDays().catch(() => DEFAULT_T6_THRESHOLD_DAYS),
    deps.aiCapable().catch(() => false),
  ]);
  let degraded = false;
  let prefs: T6ReminderPreference[] = [];
  let evaluations = new Map<number, T6StoredAssessment>();
  let aiCapable = aiCapableBrut;
  try {
    [prefs, evaluations] = await Promise.all([
      p.userId != null ? loadUserPreferences(p.accountId, p.userId) : Promise.resolve([]),
      loadAssessments(p.accountId, candidats.map((c) => c.candidate.agendaItemId)),
    ]);
  } catch (e) {
    // Tables absentes (déploiement) ou base indisponible : décision prudente.
    console.error('[mascotte] décision T6 : lectures indisponibles —', (e as Error).message);
    degraded = true;
    aiCapable = false;
    prefs = [];
    evaluations = new Map();
  }
  let historique = new Map<number, number>();
  if (p.userId != null && !degraded) {
    const depuis = new Map<number, string>();
    for (const c of candidats) {
      const a = evaluations.get(c.candidate.agendaItemId);
      if (a && a.fingerprint === c.candidate.fingerprint) depuis.set(c.candidate.agendaItemId, a.assessedOn);
    }
    historique = await loadDisplayHistory(p.accountId, p.userId, depuis, today).catch(() => new Map());
  }

  const decisions: T6DecisionTrace[] = candidats.map(({ candidate: c }) => {
    const assessment = evaluations.get(c.agendaItemId) ?? null;
    const displayedDays = historique.get(c.agendaItemId) ?? 0;
    const d = decideT6Interpellation({
      candidate: c, today, thresholdDays, aiCapable, assessment,
      preferences: preferencesFor(prefs, c.agendaItemId, c.seriesKey),
      history: { displayedDays },
    });
    return { ...d, agendaItemId: c.agendaItemId, dueDate: c.dueDate, seriesKey: c.seriesKey, assessment, displayedDays };
  });

  const parId = new Map(candidats.map((c) => [c.candidate.agendaItemId, c]));
  const shown: MascotDecidedAgenda[] = decisions
    .filter((d) => d.decision === 'SHOW_NOW')
    .sort(compareShown)
    .map((d) => ({
      agendaItemId: d.agendaItemId,
      interpellation: {
        mode: d.mode ?? 'LEGACY', priority: d.priority, code: d.code,
        // Lot 61 : motif et catégorie VALIDÉS de l'IA — nature de la carte et pose.
        reasonCode: d.mode === 'LEGACY' ? null : d.assessment?.reasonCode ?? null,
        category: d.mode === 'LEGACY' ? null : d.assessment?.category ?? null,
      },
      action: d.mode === 'LEGACY' ? null : d.action,
      reminder: {
        agendaItemId: d.agendaItemId,
        suggestedDate: suggestReminderDate({ today, dueDate: d.dueDate, assessment: d.assessment }),
        hasSeries: !!parId.get(d.agendaItemId)?.candidate.seriesKey,
      },
    }));
  const notInterpellated = new Set(decisions.filter((d) => d.decision !== 'SHOW_NOW').map((d) => d.agendaItemId));
  const userSilenced = new Set(decisions.filter((d) => d.userPreference != null && d.decision !== 'SHOW_NOW').map((d) => d.agendaItemId));
  const discarded = new Set(decisions.filter((d) => d.decision !== 'SHOW_NOW' && (d.aiDecision != null || d.userPreference != null)).map((d) => d.agendaItemId));

  // Candidats à faire évaluer : dans l'horizon d'évaluation, les plus proches d'abord.
  let bundle: T6InterpellationBundle | null = null;
  if (aiCapable) {
    const horizon = addDays(today, assessmentHorizonDays(thresholdDays));
    const aEvaluer = decisions
      .filter((d) => d.needsAssessment && d.dueDate && d.dueDate <= horizon)
      .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.agendaItemId - b.agendaItemId)
      .slice(0, T6_MAX_ASSESSMENTS_PER_CALL);
    if (aEvaluer.length > 0) {
      const details = await loadCandidateDetails(p.accountId, aEvaluer.map((d) => d.agendaItemId)).catch(() => new Map());
      const refs = new Map<string, T6CandidateRef>();
      const candidates: T6EvaluationCandidate[] = aEvaluer.map((d, k) => {
        const { candidate: c, row: i } = parId.get(d.agendaItemId)!;
        const subjectId = `C${k + 1}`;
        refs.set(subjectId, { subjectKey: c.subjectKey, agendaItemId: c.agendaItemId, fingerprint: c.fingerprint, daysUntilDue: d.daysUntilDue });
        const det = details.get(c.agendaItemId);
        const documents = det?.documents ?? [];
        const description = det?.description ?? null;
        // Références justificatives AUTORISÉES : seules celles-ci peuvent
        // fonder une décision (`evidenceRefs`, contrôlées à la validation).
        const evidence: T6EvidenceRef[] = [
          { ref: `${subjectId}.title`, kind: 'TITLE' },
          { ref: `${subjectId}.dueDate`, kind: 'DUE_DATE' },
          ...(description ? [{ ref: `${subjectId}.description`, kind: 'DESCRIPTION' as const }] : []),
          ...documents.map((_t: string, n: number) => ({ ref: `${subjectId}.doc${n + 1}`, kind: 'DOCUMENT' as const })),
          ...(i.assetName ? [{ ref: `${subjectId}.asset`, kind: 'ASSET' as const }] : []),
          ...(c.seriesKey ? [{ ref: `${subjectId}.series`, kind: 'SERIES' as const }] : []),
          ...(d.displayedDays > 0 ? [{ ref: `${subjectId}.history`, kind: 'HISTORY' as const }] : []),
        ];
        return {
          subjectId, title: i.title, description,
          assetName: i.assetName, assetCategory: i.assetCategory ?? null,
          dueDate: i.date, dateLabel: i.date ? formatDateFr(i.date) : null,
          daysUntilDue: d.daysUntilDue, dateNature: i.forecast ? 'prévisionnelle' as const : 'confirmée' as const,
          dateRole: roleOf(i), overdue: !!i.date && i.date <= today, requiresQualification: i.requiresQualification,
          recurring: !!c.seriesKey, documents, recentlyShownDays: d.displayedDays, evidence,
        };
      });
      bundle = {
        context: { schemaVersion: T6_EVALUATION_INPUT_SCHEMA_VERSION, today, thresholdDays, candidates },
        refs,
        persist: async (list, meta) => {
          const n = await persistT6Assessments(p.accountId, today, refs, list, meta);
          if (n > 0) deps.onAssessed?.(n);
          return n;
        },
      };
    }
  }

  const evaluation = evaluationStateOf(decisions, { degraded, recentFailure: aiCapable && (deps.recentEvaluationFailure?.(p.accountId) ?? false) });
  return { thresholdDays, aiCapable, shown, decisions, notInterpellated, userSilenced, discarded, bundle, degraded, evaluation };
}

// ── Reporting T6 (BO › Exécutions IA › Rapports) ─────────────────────────────

/**
 * Lignes du rapport T6 (pure) : une par échéance candidate, AFFICHÉE ou
 * ÉCARTÉE — décision, motif, seuil, rappel utilisateur, évaluation IA
 * (codes, dates). Aucune donnée personnelle recopiée : ni titre, ni bien, ni
 * description ; la justification de l'IA est RÉFÉRENCÉE (empreinte) dans
 * `t6_interpellation_assessments`, relue en direct par le BO.
 */
export function t6ReportEntries(decisions: readonly T6DecisionTrace[], thresholdDays: number): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const d of decisions) {
    const a = d.assessment;
    out.push({
      section: 'INTERPELLATION',
      tableName: 'agenda_items', recordId: d.agendaItemId, fieldKey: d.subjectKey,
      label: `Échéance #${d.agendaItemId}`, entityType: 'AGENDA_ITEM', entityId: d.agendaItemId,
      value: {
        decision: d.decision, code: d.code, priority: d.priority, deferredBy: d.deferredBy,
        nextReevaluationAt: d.nextReevaluationAt,
        // Lot 61 : décision de l'IA et écart avec la décision du serveur.
        aiDecision: d.aiDecision, divergence: d.aiDecision != null && d.aiDecision !== d.decision,
        dates: { dueDate: d.dueDate, actionDate: d.actionDate },
        threshold: { days: thresholdDays, applied: d.thresholdApplied, exception: d.thresholdException },
        userPreference: d.userPreference,
        assessment: a ? {
          contract: a.contractVersion ?? null, decision: a.decision ?? null, category: a.category ?? null,
          reasonCode: a.reasonCode ?? null, evidenceRefs: a.evidenceRefs ?? [], uncertainties: (a.uncertainties ?? []).length,
          interpellation: a.interpellation, actionNeeded: a.actionNeeded, priority: a.priority,
          assessedOn: a.assessedOn, reevaluateOn: a.reevaluateOn, fresh: d.assessmentFresh,
          exceptionMotivated: !!a.exceptionReason, uncertain: !!a.uncertainty, traceId: a.traceId ?? null,
        } : null,
        assessmentRequested: d.needsAssessment,
        recentlyShownDays: d.displayedDays,
        series: d.seriesKey != null,
      },
      recordStatus: d.decision,
      writeResult: 'NOT_WRITTEN',
      reasonCode: d.code,
      reason: d.explanation,
    });
    if (a?.id != null && a.reason) {
      out.push({
        section: 'INTERPELLATION_AI',
        tableName: 't6_interpellation_assessments', recordId: a.id, columnPath: 'reason', fieldKey: d.subjectKey,
        label: `Justification IA — échéance #${d.agendaItemId}`, entityType: 'AGENDA_ITEM', entityId: d.agendaItemId,
        ref: { sha256: reportSha256(serializeForHash(a.reason)), chars: a.reason.length },
        recordStatus: a.interpellation, writeResult: 'OBSERVED', reasonCode: a.interpellation,
        reason: `Évaluation IA du ${a.assessedOn} (${a.priority}).`,
      });
    }
  }
  return out;
}

/**
 * Écrit le rapport T6 du passage — seulement si les décisions ont CHANGÉ
 * depuis le dernier rapport du même compte et du même utilisateur (pas de
 * rapport à chaque affichage). Ne lève jamais.
 */
export interface T6FormulateTrace {
  /** Version effective du prompt maître (FORMULATE), contrat de sortie. */
  promptVersion: string | null;
  contract: 't6-output-v2';
  /** Sujets transmis à FORMULATE (identifiants techniques, jamais de texte). */
  transmitted: string[];
  /** Sujets finalement affichés. */
  displayed: string[];
  /** Issue : `t6`, `fallback` (texte de secours), `deterministic` (rien à formuler). */
  source: 't6' | 'fallback' | 'deterministic';
  status: string | null;
  /** Sujets repliés sur leur texte de secours (repli sujet par sujet). */
  fallbackSubjects?: number;
  /** État de présentation retenu (`MascotPresentationState.kind`). */
  presentation: string | null;
}

/** Lignes FORMULATE du rapport (pure) : sujets transmis et affichés, secours. */
export function t6FormulateEntries(f: T6FormulateTrace): ReportEntry[] {
  return [{
    section: 'FORMULATE',
    fieldKey: 'formulate', label: 'Formulation (MODE=FORMULATE)',
    value: {
      mode: 'FORMULATE', contract: f.contract, transmitted: f.transmitted, displayed: f.displayed,
      source: f.source, fallbackUsed: f.source === 'fallback' || (f.fallbackSubjects ?? 0) > 0,
      fallbackSubjects: f.fallbackSubjects ?? 0, presentation: f.presentation,
    },
    // Motif = issue affichée (jamais le statut technique volatil — cache, génération —
    // pour qu'un affichage identique n'écrive pas un nouveau rapport).
    recordStatus: f.source, writeResult: 'NOT_WRITTEN', reasonCode: f.source,
    reason: f.source === 'deterministic' ? 'Aucun sujet à formuler : message déterministe de l’état de présentation.'
      : f.source === 'fallback' ? 'Texte de secours affiché (formulation indisponible, en cours ou rejetée).'
        : 'Formulation T6 validée affichée.',
  }];
}

export async function writeT6InterpellationReport(p: {
  accountId: number; userId: number | null; mode: string; prep: T6Preparation;
  /** Lot 61 : formulation du passage (sujets transmis, affichés, secours). */
  formulate?: T6FormulateTrace | null;
}): Promise<number | null> {
  try {
    const repo = await import('@/services/ai/execution-report/repository');
    if (!(await repo.executionReportsReady())) return null;
    const entries = [
      ...t6ReportEntries(p.prep.decisions, p.prep.thresholdDays),
      ...(p.formulate ? t6FormulateEntries(p.formulate) : []),
    ];
    const empreinte = entriesFingerprint(entries);
    const [prev] = await rows(
      `SELECT entries_fingerprint FROM ai_execution_reports
        WHERE account_id = $1 AND treatment = 'T6' AND target_id IS NOT DISTINCT FROM $2::int
        ORDER BY id DESC LIMIT 1`,
      [p.accountId, p.userId],
    );
    if (prev && prev.entries_fingerprint === empreinte) return null;
    const compte = (k: string) => p.prep.decisions.filter((d) => d.decision === k).length;
    const traces = [...new Set(p.prep.decisions.map((d) => d.assessment?.traceId).filter((x): x is string => !!x))].slice(0, 50);
    return await repo.writeExecutionReport({
      accountId: p.accountId, treatment: 'T6', scope: 'HOME',
      targetType: p.userId != null ? 'USER' : null, targetId: p.userId,
      triggerCode: p.mode, traceIds: traces, status: 'NO_CHANGE',
      counters: {
        candidates: p.prep.decisions.length, shown: compte('SHOW_NOW'), deferred: compte('DEFER'), suppressed: compte('SUPPRESS'),
        assessmentRequested: p.prep.bundle?.refs.size ?? 0, thresholdDays: p.prep.thresholdDays,
        // Lot 61 : écarts IA / serveur, sujets transmis à FORMULATE et affichés.
        divergences: p.prep.decisions.filter((d) => d.aiDecision != null && d.aiDecision !== d.decision).length,
        formulateTransmitted: p.formulate?.transmitted.length ?? 0, displayed: p.formulate?.displayed.length ?? 0,
      },
      steps: [
        { step: 'candidates', status: 'OK', detail: { count: p.prep.decisions.length } },
        { step: 'decision', status: p.prep.degraded ? 'FAILED' : 'OK', error: p.prep.degraded ? 'lectures indisponibles : décision prudente' : null,
          detail: { thresholdDays: p.prep.thresholdDays, aiCapable: p.prep.aiCapable, evaluation: p.prep.evaluation } },
        { step: 'assessment_request', status: p.prep.bundle ? 'OK' : 'SKIPPED', detail: { mode: 'EVALUATE', candidates: p.prep.bundle?.refs.size ?? 0 } },
        { step: 'formulate', status: p.formulate ? 'OK' : 'SKIPPED', detail: p.formulate ? {
          mode: 'FORMULATE', promptVersion: p.formulate.promptVersion, contract: p.formulate.contract, source: p.formulate.source, status: p.formulate.status,
        } : null },
      ],
      sources: { thresholdDays: p.prep.thresholdDays, aiCapable: p.prep.aiCapable, userPreferences: p.userId != null, evaluation: p.prep.evaluation },
    }, entries);
  } catch (e) {
    console.error('[mascotte] rapport T6 non écrit :', (e as Error).message);
    return null;
  }
}

/** Empreinte (tests) d'un ensemble de décisions — indépendante du jour. */
export const decisionsFingerprint = (d: readonly T6DecisionTrace[]) => sha256(canonicalJson(d.map((x) => [x.subjectKey, x.decision, x.code])));

// ── Reporting EVALUATE (lot 61) ──────────────────────────────────────────────

/** Issue d'une exécution EVALUATE, telle que tracée (aucune donnée personnelle). */
export interface T6EvaluationTrace {
  status: string;
  promptVersion: string | null;
  inputContract: string;
  outputContract: string;
  traceId: string | null;
  error: string | null;
  /** subjectId → décision acceptée (motif fermé) ; rejets avec motif. */
  accepted: Array<{ subjectId: string; decision: string; category: string; reasonCode: string; priorityHint: string | null; evidenceRefs: string[] }>;
  rejected: Array<{ subjectId: string; reason: string }>;
  persisted: number;
}

/** Lignes du rapport EVALUATE (pure) : une par candidat évalué. */
export function t6EvaluationEntries(t: T6EvaluationTrace, refs: T6InterpellationBundle['refs']): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const [subjectId, c] of refs) {
    const a = t.accepted.find((x) => x.subjectId === subjectId);
    const r = t.rejected.find((x) => x.subjectId === subjectId);
    out.push({
      section: 'EVALUATE',
      tableName: 'agenda_items', recordId: c.agendaItemId, fieldKey: c.subjectKey,
      label: `Échéance #${c.agendaItemId} (${subjectId})`, entityType: 'AGENDA_ITEM', entityId: c.agendaItemId,
      value: a ? { subjectId, decision: a.decision, category: a.category, reasonCode: a.reasonCode, priorityHint: a.priorityHint, evidenceRefs: a.evidenceRefs }
        : { subjectId, rejected: r?.reason ?? t.error ?? t.status },
      recordStatus: a ? a.decision : 'REJECTED',
      // Écriture confirmée seulement si toutes les décisions acceptées ont été conservées.
      writeResult: a ? (t.persisted >= t.accepted.length ? 'WRITTEN' : 'DECIDED_NOT_CONFIRMED') : 'NOT_PERSISTED',
      reasonCode: a ? a.reasonCode : r ? `VALIDATION:${r.reason}` : t.status.toUpperCase(),
      reason: a ? 'Décision IA validée, conservée (cache des évaluations).'
        : r ? `Décision rejetée par la validation (${r.reason}) : candidat en attente, jamais affiché d’office.`
          : `Évaluation non obtenue (${t.status}${t.error ? ` : ${t.error.slice(0, 120)}` : ''}) : candidat en attente.`,
    });
  }
  return out;
}

/** Rapport d'une exécution EVALUATE (BO › Exécutions IA › Rapports). Ne lève jamais. */
export async function writeT6EvaluationReport(p: {
  accountId: number; mode: string; bundle: T6InterpellationBundle; trace: T6EvaluationTrace;
}): Promise<number | null> {
  try {
    const repo = await import('@/services/ai/execution-report/repository');
    if (!(await repo.executionReportsReady())) return null;
    const t = p.trace;
    const compte = (k: string) => t.accepted.filter((d) => d.decision === k).length;
    return await repo.writeExecutionReport({
      accountId: p.accountId, treatment: 'T6', scope: 'HOME', targetType: null, targetId: null,
      triggerCode: `evaluate:${p.mode}`, traceIds: t.traceId ? [t.traceId] : [],
      status: t.status !== 'generated' ? 'FAILED' : t.rejected.length ? 'PARTIAL' : 'SUCCESS',
      counters: {
        evaluated: p.bundle.refs.size, accepted: t.accepted.length, rejected: t.rejected.length, persisted: t.persisted,
        showNow: compte('SHOW_NOW'), defer: compte('DEFER'), suppress: compte('SUPPRESS'),
      },
      steps: [{
        step: 'evaluate', status: t.status === 'generated' ? 'OK' : 'FAILED', error: t.error,
        detail: { mode: 'EVALUATE', promptVersion: t.promptVersion, inputContract: t.inputContract, outputContract: t.outputContract },
      }],
      sources: { mode: 'EVALUATE', promptVersion: t.promptVersion },
    }, t6EvaluationEntries(t, p.bundle.refs));
  } catch (e) {
    console.error('[mascotte] rapport EVALUATE non écrit :', (e as Error).message);
    return null;
  }
}
