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
  DEFAULT_T6_THRESHOLD_DAYS, T6_INTERPELLATION_CONTEXT_SCHEMA, T6_MAX_ASSESSMENTS_PER_CALL, T6_REPEAT_WINDOW_DAYS,
  addDays, agendaFingerprintParts, agendaOccurrenceKey, agendaSubjectKey, assessmentHorizonDays, compareShown,
  daysBetween, decideT6Interpellation, suggestReminderDate,
  type T6Assessment, type T6Candidate, type T6DecisionResult, type T6InterpellationBundle, type T6ReminderPreference,
  type T6StoredAssessment,
} from './t6-interpellation';

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
            a.exception_reason, a.prompt_version, a.trace_id
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
 * Enregistre les évaluations validées (une ligne par échéance, la plus
 * récente l'emporte). L'échéance est revérifiée DANS le compte : jamais une
 * évaluation rattachée à l'échéance d'un autre compte.
 */
export async function persistT6Assessments(
  accountId: number, today: string,
  refs: T6InterpellationBundle['refs'],
  list: Array<T6Assessment & { ref: string }>,
  meta: { promptVersion: string; traceId: string | null },
): Promise<number> {
  let n = 0;
  for (const a of list) {
    const c = refs.get(a.ref);
    if (!c) continue;
    const r = await rows(
      `INSERT INTO t6_interpellation_assessments
         (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation, action_needed, priority,
          action_date, reevaluate_on, reason, action, consequence, uncertainty, exception_reason, prompt_version, trace_id)
       SELECT $1, i.id, $3, $4, $5::date, $6, $7, $8, $9::date, $10::date, $11, $12, $13, $14, $15, $16, $17
         FROM agenda_items i WHERE i.id = $2 AND i.account_id = $1
       ON CONFLICT (account_id, subject_key) DO UPDATE SET
         agenda_item_id = EXCLUDED.agenda_item_id, context_fingerprint = EXCLUDED.context_fingerprint,
         assessed_on = EXCLUDED.assessed_on, interpellation = EXCLUDED.interpellation, action_needed = EXCLUDED.action_needed,
         priority = EXCLUDED.priority, action_date = EXCLUDED.action_date, reevaluate_on = EXCLUDED.reevaluate_on,
         reason = EXCLUDED.reason, action = EXCLUDED.action, consequence = EXCLUDED.consequence,
         uncertainty = EXCLUDED.uncertainty, exception_reason = EXCLUDED.exception_reason,
         prompt_version = EXCLUDED.prompt_version, trace_id = EXCLUDED.trace_id, updated_at = now()
       RETURNING id`,
      [accountId, c.agendaItemId, c.subjectKey, c.fingerprint, today, a.interpellation, a.actionNeeded, a.priority,
        a.actionDate, a.reevaluateOn, a.reason, a.action, a.consequence, a.uncertainty, a.exceptionReason,
        meta.promptVersion, meta.traceId],
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
  const out: T6CandidateRow[] = [];
  for (const i of raw.agenda ?? []) {
    if (!i.date || exclues.has(i.id)) continue;
    const future = i.date > raw.today;
    if (future && i.requiresQualification) continue;
    if (!future && (i.forecast || daysBetween(i.date, raw.today) > EXT_ACTION_LOOKBACK_DAYS)) continue;
    // « C'est fait » déclaré pour ce cycle : le sujet est résolu.
    const fait = !future && !i.requiresQualification && acquittes.has(`${extActionOccurrenceKey(i.id)}|${i.date}`);
    out.push({
      row: i,
      candidate: {
        subjectKey: agendaSubjectKey(i.id), agendaItemId: i.id, occurrenceKey: agendaOccurrenceKey(i.id, i.date),
        seriesKey: i.seriesKey ?? null, accountId: raw.accountId, assetId: i.assetId, dueDate: i.date,
        state: fait ? 'RESOLVED' : 'ACTIVE',
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
  /** Candidats à faire évaluer par T6 (R13), ou null. */
  bundle: T6InterpellationBundle | null;
  /** Une lecture a échoué : décision prudente sans préférence ni évaluation. */
  degraded: boolean;
}

export interface PrepareDeps {
  aiCapable: () => Promise<boolean>;
  thresholdDays: () => Promise<number>;
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
      interpellation: { mode: d.mode ?? 'LEGACY', priority: d.priority, code: d.code },
      action: d.mode === 'LEGACY' ? null : d.action,
      reminder: {
        agendaItemId: d.agendaItemId,
        suggestedDate: suggestReminderDate({ today, dueDate: d.dueDate, assessment: d.assessment }),
        hasSeries: !!parId.get(d.agendaItemId)?.candidate.seriesKey,
      },
    }));
  const notInterpellated = new Set(decisions.filter((d) => d.decision !== 'SHOW_NOW').map((d) => d.agendaItemId));
  const userSilenced = new Set(decisions.filter((d) => d.userPreference != null && d.decision !== 'SHOW_NOW').map((d) => d.agendaItemId));

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
      const refs = new Map<string, { subjectKey: string; agendaItemId: number; fingerprint: string }>();
      const candidates = aEvaluer.map((d, k) => {
        const { candidate: c, row: i } = parId.get(d.agendaItemId)!;
        const ref = `C${k + 1}`;
        refs.set(ref, { subjectKey: c.subjectKey, agendaItemId: c.agendaItemId, fingerprint: c.fingerprint });
        const det = details.get(c.agendaItemId);
        return {
          ref, title: i.title, description: det?.description ?? null,
          assetName: i.assetName, assetCategory: i.assetCategory ?? null,
          dueDate: i.date, dateLabel: i.date ? formatDateFr(i.date) : null,
          daysUntilDue: d.daysUntilDue, dateNature: i.forecast ? 'prévisionnelle' as const : 'confirmée' as const,
          dateRole: roleOf(i), overdue: !!i.date && i.date <= today, requiresQualification: i.requiresQualification,
          recurring: !!c.seriesKey, documents: det?.documents ?? [], recentlyShownDays: d.displayedDays,
        };
      });
      bundle = {
        context: { schemaVersion: T6_INTERPELLATION_CONTEXT_SCHEMA, today, thresholdDays, candidates },
        refs,
        persist: async (list, meta) => {
          const n = await persistT6Assessments(p.accountId, today, refs, list, meta);
          if (n > 0) deps.onAssessed?.(n);
          return n;
        },
      };
    }
  }

  return { thresholdDays, aiCapable, shown, decisions, notInterpellated, userSilenced, bundle, degraded };
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
        dates: { dueDate: d.dueDate, actionDate: d.actionDate },
        threshold: { days: thresholdDays, applied: d.thresholdApplied, exception: d.thresholdException },
        userPreference: d.userPreference,
        assessment: a ? {
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
export async function writeT6InterpellationReport(p: {
  accountId: number; userId: number | null; mode: string; prep: T6Preparation;
}): Promise<number | null> {
  try {
    const repo = await import('@/services/ai/execution-report/repository');
    if (!(await repo.executionReportsReady())) return null;
    const entries = t6ReportEntries(p.prep.decisions, p.prep.thresholdDays);
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
      },
      steps: [
        { step: 'candidates', status: 'OK', detail: { count: p.prep.decisions.length } },
        { step: 'decision', status: p.prep.degraded ? 'FAILED' : 'OK', error: p.prep.degraded ? 'lectures indisponibles : décision prudente' : null,
          detail: { thresholdDays: p.prep.thresholdDays, aiCapable: p.prep.aiCapable } },
        { step: 'assessment_request', status: p.prep.bundle ? 'OK' : 'SKIPPED', detail: { candidates: p.prep.bundle?.refs.size ?? 0 } },
      ],
      sources: { thresholdDays: p.prep.thresholdDays, aiCapable: p.prep.aiCapable, userPreferences: p.userId != null },
    }, entries);
  } catch (e) {
    console.error('[mascotte] rapport T6 non écrit :', (e as Error).message);
    return null;
  }
}

/** Empreinte (tests) d'un ensemble de décisions — indépendante du jour. */
export const decisionsFingerprint = (d: readonly T6DecisionTrace[]) => sha256(canonicalJson(d.map((x) => [x.subjectKey, x.decision, x.code])));
