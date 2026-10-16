/**
 * Diagnostic BO des « À traiter » T3 (lot 57B — ticket P0 « T3 — Corriger
 * les À traiter non résolus et fiabiliser les logs », §3 et §4).
 *
 * Lecture SEULE, sans SQL côté exploitant : pour chaque exécution T3 globale
 * (`account_reconciliation_runs`, job de file porteur), l'issue, l'état de
 * chaque phase, les compteurs DISTINCTS (cartes ouvertes au début, examinées,
 * réellement retentées, résolues et fermées, maintenues, déléguées, en
 * erreur) et les appels IA par opération ; pour chaque carte
 * (`t3_open_action_evaluations`), son parcours complet. Filtres : compte,
 * job, passage, document, règle, action, résultat (effet ou motif).
 *
 * Tolérant : colonnes 0410 (ou 0338) absentes → champs nuls, jamais d'échec.
 * Aucune donnée métier : identifiants, codes, compteurs.
 */
import { pgClient } from '@/db';

export interface T3DiagnosticFilters {
  accountId?: number | null;
  jobId?: number | null;
  runId?: number | null;
  documentId?: number | null;
  ruleCode?: string | null;
  actionId?: number | null;
  /** Effet (CLOSED, STILL_OPEN…) ou motif (NO_CANDIDATE, JOB_PENDING…). */
  result?: string | null;
  /** Pagination des cartes : identifiant de journal strictement inférieur. */
  before?: number | null;
  limit?: number;
}

export interface T3RunDiagnostic {
  runId: number;
  accountId: number;
  jobId: number | null;
  jobStatus: string | null;
  businessResult: string | null;
  triggerType: string;
  triggerCode: string | null;
  scope: string | null;
  status: string;
  outcome: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  phases: Record<string, { status: string; error: string | null; counts?: Record<string, number> }> | null;
  counters: {
    openAtStart: number | null; examined: number | null; resolutionAttempted: number | null; resolved: number | null;
    keptAmbiguous: number | null; delegated: number | null; errors: number | null; journaled: number;
  };
  /** Appels IA du compte pendant le passage, par opération (télémétrie de la passerelle). */
  aiCallsByOperation: Record<string, number>;
  /** Cartes journalisées par motif. */
  byReasonCode: Record<string, number>;
}

export interface T3CardEvaluation {
  id: number;
  createdAt: string;
  accountId: number;
  runId: number | null;
  jobId: number | null;
  actionId: number;
  ruleCode: string;
  targetType: string | null;
  targetId: number | null;
  resolver: string;
  evaluationMode: string;
  actionEffect: string;
  reasonCode: string | null;
  resolutionAttempted: boolean;
  deterministicAttempted: boolean;
  aiCalled: boolean;
  candidateCount: number | null;
  previousResolution: string | null;
  newResolution: string | null;
  note: string | null;
  triggerCode: string | null;
  durationMs: number | null;
  lastStep: string | null;
  failedStep: string | null;
  delegatedJobId: number | null;
  delegatedJobStatus: string | null;
  knowledgeSources: Record<string, number> | null;
  missingSources: string[] | null;
  candidateOrigins: Record<string, number> | null;
  aiOperation: string | null;
  aiTraceId: string | null;
  aiStatus: string | null;
  aiError: string | null;
  decision: string | null;
  confidence: number | null;
  writeAttempted: boolean | null;
  writeVerified: boolean | null;
}

/**
 * Lot 58B : évaluation d'une règle documentaire (DATA-CONTRACT-END…) sur un
 * document, quel que soit le déclencheur (analyse T1, balayage, passage T3,
 * correction utilisateur) — table `document_rule_evaluations` (0418).
 */
export interface DocumentRuleEvaluation {
  id: number;
  createdAt: string;
  lastSeenAt: string;
  seenCount: number;
  accountId: number;
  fileId: number;
  ruleCode: string;
  fieldKey: string | null;
  trigger: string;
  runRef: string | null;
  engineVersion: string;
  targetPresent: boolean | null;
  userValidated: boolean | null;
  sources: Record<string, number>;
  missingSources: string[];
  observations: Array<{ source: string; key: string | null; raw: string | null; normalized: string | null; status: string }>;
  proposals: Array<{ value: string | null; confidence: number }>;
  titleHint: { dates: string[]; confirmed: string[]; excerpt: string | null } | null;
  pertinence: string | null;
  pertinenceReason: string | null;
  aiOperation: string | null;
  aiTraceId: string | null;
  aiStatus: string | null;
  decision: string;
  reasonCode: string | null;
  actionId: number | null;
  writeVerified: boolean | null;
  error: string | null;
  failedStep: string | null;
  // ── Lot 61 (0444) : décision centrale, contrat de décision, trace complète ──
  /** AUTO_RESOLVED | NO_ACTION | DEFER | CREATE_ACTION | KEEP | ERROR (null : évaluation antérieure). */
  outcome?: string | null;
  situation?: string | null;
  /** Contrat de décision interne (problème, intervention, temporalité, fiabilité, motif) et intervention identifiée. */
  decisionContract?: Record<string, unknown> | null;
  reevaluateAt?: string | null;
  configRef?: string | null;
  knowledgeRev?: string | null;
  derivation?: Record<string, unknown> | null;
  writeResult?: Record<string, unknown> | null;
  actionIds?: Record<string, number[]> | null;
  /** Passages d'une évaluation dédupliquée (déclencheur, référence, date), ≤ 20. */
  passages?: Array<{ at: string; trigger: string; runRef: string | null }> | null;
  errorKind?: string | null;
}

export interface T3OpenActionsDiagnostic {
  generatedAt: string;
  migrations: { journal0371: boolean; diagnostic0410: boolean; documentRules0418?: boolean };
  runs: T3RunDiagnostic[];
  cards: T3CardEvaluation[];
  /** Lot 58B : évaluations des règles documentaires (filtres compte, document, règle, résultat). */
  documentRules?: DocumentRuleEvaluation[];
  /** Pagination : identifiant à passer en `before` pour la page suivante. */
  nextBefore: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (v: unknown): string | null => (v ? new Date(String(v)).toISOString() : null);
const obj = <T>(v: unknown): T | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return null; } }
  return v as T;
};

async function migrations(): Promise<T3OpenActionsDiagnostic['migrations']> {
  const rows = (await pgClient.unsafe(
    `SELECT to_regclass('t3_open_action_evaluations') IS NOT NULL AS j,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                     AND table_name = 't3_open_action_evaluations' AND column_name = 'reason_code') AS d,
            to_regclass('document_rule_evaluations') IS NOT NULL AS r`,
  )) as unknown as Array<{ j: boolean; d: boolean; r: boolean }>;
  return { journal0371: rows[0]?.j === true, diagnostic0410: rows[0]?.d === true, documentRules0418: rows[0]?.r === true };
}

/** Nettoie les filtres (entiers positifs, codes bornés). Pure. */
export function cleanFilters(f: T3DiagnosticFilters): Required<Omit<T3DiagnosticFilters, 'limit'>> & { limit: number } {
  const id = (v: unknown) => { const n = num(v); return n !== null && Number.isInteger(n) && n > 0 ? n : null; };
  const code = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_:-]{1,60}$/.test(v.trim()) ? v.trim() : null);
  return {
    accountId: id(f.accountId), jobId: id(f.jobId), runId: id(f.runId), documentId: id(f.documentId), ruleCode: code(f.ruleCode),
    actionId: id(f.actionId), result: code(f.result), before: id(f.before), limit: Math.min(200, Math.max(1, Number(f.limit) || 50)),
  };
}

export async function getT3OpenActionsDiagnostic(input: T3DiagnosticFilters, now: Date = new Date()): Promise<T3OpenActionsDiagnostic> {
  const f = cleanFilters(input);
  const mig = await migrations();
  const runs = await loadRuns(f);
  const cards = mig.journal0371 ? await loadCards(f, mig.diagnostic0410) : [];
  // Les évaluations de règles documentaires ne portent ni job ni passage :
  // affichées quand le filtre vise un compte, un document ou une règle.
  const documentRules = mig.documentRules0418 && (f.accountId || f.documentId || f.ruleCode) && !f.jobId && !f.runId && !f.actionId
    ? await loadDocumentRules(f) : [];
  return {
    generatedAt: now.toISOString(), migrations: mig, runs, cards, documentRules,
    nextBefore: cards.length === f.limit ? cards[cards.length - 1].id : null,
  };
}

async function loadRuns(f: ReturnType<typeof cleanFilters>): Promise<T3RunDiagnostic[]> {
  // Passages T3 GLOBAUX (compte) : filtrés par compte, job ou passage ; à défaut, les plus récents.
  const rows = (await pgClient.unsafe(
    `SELECT to_jsonb(r) AS r, q.status AS job_status, q.business_result AS business_result, q.trigger_code AS job_trigger,
            q.business_result_detail AS detail
       FROM account_reconciliation_runs r
       LEFT JOIN ai_job_queue q ON q.id = (to_jsonb(r) ->> 'queue_job_id')::int
      WHERE r.status <> 'queued'
        AND ($1::int IS NULL OR r.account_id = $1)
        AND ($2::int IS NULL OR (to_jsonb(r) ->> 'queue_job_id')::int = $2)
        AND ($3::int IS NULL OR r.id = $3)
      ORDER BY r.id DESC LIMIT 10`,
    [f.accountId, f.jobId, f.runId] as never[],
  )) as unknown as Array<{ r: Record<string, unknown>; job_status: string | null; business_result: string | null; job_trigger: string | null; detail: unknown }>;
  const out: T3RunDiagnostic[] = [];
  for (const row of rows) {
    const r = obj<Record<string, unknown>>(row.r) ?? {};
    const runId = Number(r.id);
    const accountId = Number(r.account_id);
    const detail = obj<Record<string, unknown>>(row.detail) ?? {};
    const oa = obj<Record<string, unknown>>(detail.openActions) ?? {};
    const phases = obj<T3RunDiagnostic['phases']>(r.phases_json) ?? obj<T3RunDiagnostic['phases']>(detail.phases);
    const oaPhase = phases?.OPEN_ACTIONS?.counts ?? {};
    const [journal, ia] = await Promise.all([
      pgClient.unsafe(
        `SELECT coalesce(to_jsonb(e) ->> 'reason_code', action_effect) AS code, count(*)::int AS n
           FROM t3_open_action_evaluations e WHERE account_run_id = $1 GROUP BY 1`,
        [runId] as never[],
      ).catch(() => []) as unknown as Promise<Array<{ code: string; n: number }>>,
      pgClient.unsafe(
        `SELECT coalesce(operation_code, '?') AS op, count(*)::int AS n FROM ai_usage_event
          WHERE account_id = $1 AND created_at >= $2::timestamptz AND created_at <= coalesce($3::timestamptz, now())
          GROUP BY 1 ORDER BY 2 DESC`,
        [accountId, iso(r.started_at) ?? new Date(0).toISOString(), iso(r.finished_at)] as never[],
      ).catch(() => []) as unknown as Promise<Array<{ op: string; n: number }>>,
    ]);
    const c = (k: string) => num(oaPhase[k]) ?? num(oa[k]);
    out.push({
      runId, accountId, jobId: num(r.queue_job_id), jobStatus: row.job_status, businessResult: row.business_result,
      triggerType: String(r.trigger_type ?? ''), triggerCode: row.job_trigger, scope: (r.scope as string) ?? null, status: String(r.status),
      outcome: (r.outcome as string) ?? (detail.outcome as string) ?? null, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), phases,
      counters: {
        openAtStart: c('openAtStart'), examined: c('examined'), resolutionAttempted: c('resolutionAttempted'), resolved: c('resolved'),
        keptAmbiguous: c('keptAmbiguous'), delegated: c('delegated'), errors: c('errors'),
        journaled: journal.reduce((n, x) => n + Number(x.n), 0),
      },
      aiCallsByOperation: Object.fromEntries(ia.map((x) => [x.op, Number(x.n)])),
      byReasonCode: Object.fromEntries(journal.map((x) => [x.code, Number(x.n)])),
    });
  }
  return out;
}

async function loadCards(f: ReturnType<typeof cleanFilters>, enrichi: boolean): Promise<T3CardEvaluation[]> {
  const rows = (await pgClient.unsafe(
    `SELECT to_jsonb(e) AS e FROM t3_open_action_evaluations e
      WHERE ($1::int IS NULL OR e.account_id = $1)
        AND ($2::int IS NULL OR e.queue_job_id = $2)
        AND ($3::int IS NULL OR e.account_run_id = $3)
        AND ($4::int IS NULL OR (e.target_type = 'DOCUMENT' AND e.target_id = $4))
        AND ($5::text IS NULL OR e.rule_code = $5)
        AND ($6::int IS NULL OR e.action_id = $6)
        AND ($7::text IS NULL OR e.action_effect = $7 ${enrichi ? 'OR e.reason_code = $7' : ''})
        AND ($8::bigint IS NULL OR e.id < $8)
      ORDER BY e.id DESC LIMIT $9`,
    [f.accountId, f.jobId, f.runId, f.documentId, f.ruleCode, f.actionId, f.result, f.before, f.limit] as never[],
  )) as unknown as Array<{ e: Record<string, unknown> }>;
  return rows.map(({ e: brut }) => {
    const e = obj<Record<string, unknown>>(brut) ?? {};
    return {
      id: Number(e.id), createdAt: iso(e.created_at) ?? '', accountId: Number(e.account_id), runId: num(e.account_run_id), jobId: num(e.queue_job_id),
      actionId: Number(e.action_id), ruleCode: String(e.rule_code), targetType: (e.target_type as string) ?? null, targetId: num(e.target_id),
      resolver: String(e.resolver), evaluationMode: String(e.evaluation_mode), actionEffect: String(e.action_effect),
      reasonCode: (e.reason_code as string) ?? null, resolutionAttempted: e.resolution_attempted === true,
      deterministicAttempted: e.deterministic_attempted === true, aiCalled: e.ai_called === true, candidateCount: num(e.candidate_count),
      previousResolution: (e.previous_resolution as string) ?? null, newResolution: (e.new_resolution as string) ?? null,
      note: (e.note as string) ?? null, triggerCode: (e.trigger_code as string) ?? null, durationMs: num(e.duration_ms),
      lastStep: (e.last_step as string) ?? null, failedStep: (e.failed_step as string) ?? null,
      delegatedJobId: num(e.delegated_job_id), delegatedJobStatus: (e.delegated_job_status as string) ?? null,
      knowledgeSources: obj(e.knowledge_sources), missingSources: obj(e.missing_sources), candidateOrigins: obj(e.candidate_origins),
      aiOperation: (e.ai_operation as string) ?? null, aiTraceId: (e.ai_trace_id as string) ?? null, aiStatus: (e.ai_status as string) ?? null,
      aiError: (e.ai_error as string) ?? null, decision: (e.decision as string) ?? null, confidence: num(e.confidence),
      writeAttempted: typeof e.write_attempted === 'boolean' ? e.write_attempted : null,
      writeVerified: typeof e.write_verified === 'boolean' ? e.write_verified : null,
    };
  });
}

async function loadDocumentRules(f: ReturnType<typeof cleanFilters>): Promise<DocumentRuleEvaluation[]> {
  const rows = (await pgClient.unsafe(
    `SELECT to_jsonb(e) AS e FROM document_rule_evaluations e
      WHERE ($1::int IS NULL OR e.account_id = $1)
        AND ($2::int IS NULL OR e.file_id = $2)
        AND ($3::text IS NULL OR e.rule_code = $3)
        AND ($4::text IS NULL OR e.decision = $4 OR e.reason_code = $4 OR e.pertinence = $4 OR to_jsonb(e) ->> 'outcome' = $4)
      ORDER BY e.id DESC LIMIT $5`,
    [f.accountId, f.documentId, f.ruleCode, f.result, f.limit] as never[],
  ).catch(() => [])) as unknown as Array<{ e: Record<string, unknown> }>;
  return rows.map(({ e: brut }) => {
    const e = obj<Record<string, unknown>>(brut) ?? {};
    return {
      id: Number(e.id), createdAt: iso(e.created_at) ?? '', lastSeenAt: iso(e.last_seen_at) ?? '', seenCount: Number(e.seen_count ?? 1),
      accountId: Number(e.account_id), fileId: Number(e.file_id), ruleCode: String(e.rule_code), fieldKey: (e.field_key as string) ?? null,
      trigger: String(e.trigger_code), runRef: (e.run_ref as string) ?? null, engineVersion: String(e.engine_version),
      targetPresent: typeof e.target_present === 'boolean' ? e.target_present : null,
      userValidated: typeof e.user_validated === 'boolean' ? e.user_validated : null,
      sources: obj(e.sources) ?? {}, missingSources: obj(e.missing_sources) ?? [], observations: obj(e.observations) ?? [],
      proposals: obj(e.proposals) ?? [], titleHint: obj(e.title_hint), pertinence: (e.pertinence as string) ?? null,
      pertinenceReason: (e.pertinence_reason as string) ?? null, aiOperation: (e.ai_operation as string) ?? null,
      aiTraceId: (e.ai_trace_id as string) ?? null, aiStatus: (e.ai_status as string) ?? null, decision: String(e.decision),
      reasonCode: (e.reason_code as string) ?? null, actionId: num(e.action_id),
      writeVerified: typeof e.write_verified === 'boolean' ? e.write_verified : null, error: (e.error as string) ?? null,
      failedStep: (e.failed_step as string) ?? null,
      outcome: (e.outcome as string) ?? null, situation: (e.situation as string) ?? null,
      decisionContract: obj(e.decision_contract), reevaluateAt: iso(e.reevaluate_at), configRef: (e.config_ref as string) ?? null,
      knowledgeRev: (e.knowledge_rev as string) ?? null, derivation: obj(e.derivation), writeResult: obj(e.write_result),
      actionIds: obj(e.action_ids), passages: obj(e.passages), errorKind: (e.error_kind as string) ?? null,
    };
  });
}
