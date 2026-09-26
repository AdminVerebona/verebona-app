/**
 * Recherche transversale des exécutions — CDC BO IA SCR-07, NFR-001, NFR-004.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FILTRÉ ET PAGINÉ CÔTÉ SERVEUR, SANS EXCEPTION
 *
 * Le NFR-001 impose la pagination serveur des listes volumineuses ; le NFR-002
 * interdit de « charger massivement l'ensemble des logs sans filtre/limite ».
 * `ai_usage_event` grossit d'une ligne par appel modèle — la table de la
 * préproduction comptait déjà 256 lignes sur trente jours avec un seul usage
 * basculé.
 *
 * La borne est donc appliquée ici et plafonnée : un paramètre client ne peut
 * pas la lever.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE REQUÊTE T2 DÉTERMINISTE DOIT APPARAÎTRE AVEC ZÉRO APPEL
 *
 * C'est un critère d'acceptation du SCR-07, et il dit quelque chose du
 * périmètre : cette recherche porte sur les APPELS MODÈLES, et une demande
 * tranchée par les règles n'en produit aucun. Elle n'est donc pas « absente »
 * par oubli — elle est absente parce qu'elle n'a rien coûté, ce qui est
 * précisément l'information recherchée.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « OBJET SUPPRIMÉ : CONSERVER L'IDENTIFIANT HISTORIQUE »
 *
 * Le SCR-07 l'exige. Aucune jointure n'écarte donc une ligne dont le compte ou
 * le document a disparu : les jointures sont toutes en LEFT, et l'identifiant
 * est rendu même sans sa cible. Une trace qui s'efface avec son objet ne permet
 * plus d'expliquer ce qui s'est passé — c'est-à-dire exactement ce qu'on lui
 * demande.
 */
import { pgClient } from '@/db';
import type { Treatment } from '../config/treatments';
import { TREATMENT_DEFINITIONS } from '../config/treatments';

type Row = Record<string, unknown>;

export interface ExecutionFilters {
  treatment?: Treatment;
  status?: 'success' | 'error';
  accountId?: number;
  model?: string;
  configVersionId?: number;
  operationCode?: string;
  /** Erreurs seulement — raccourci du diagnostic, le plus utilisé. */
  errorsOnly?: boolean;
  since?: Date;
  until?: Date;
  /** Durée minimale, pour retrouver les appels lents (SCR-07, filtre « durée »). */
  minDurationMs?: number;
  /** LOG-UI-02 : utilisateur à l'origine de l'appel. */
  userId?: number;
  /**
   * LOG-UI-02, CST-UI-05 : rang du modèle réellement utilisé. `fallback` =
   * n'importe quel repli (drill-down des alertes « taux de fallback »).
   */
  rank?: 'primary' | 'fallback_1' | 'fallback_2' | 'fallback';
  /** LOG-UI-02 : exécution de file parente. */
  jobId?: number;
  limit?: number;
  offset?: number;
}

export interface ExecutionRow {
  id: number;
  createdAt: Date;
  useCaseCode: string | null;
  treatment: Treatment | null;
  operationCode: string | null;
  accountId: number | null;
  userId: number | null;
  provider: string | null;
  model: string | null;
  modelRank: string | null;
  usedFallback: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  durationMs: number | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  configVersionId: number | null;
  configVisibleNumber: number | null;
  appVersion: string | null;
  jobId: number | null;
  promptVersion: string | null;
}

/** Traitement correspondant à un code d'usage, sans requête. */
function treatmentOf(useCaseCode: string | null): Treatment | null {
  if (!useCaseCode) return null;
  const entry = Object.values(TREATMENT_DEFINITIONS).find((d) => d.useCaseCode === useCaseCode);
  return entry?.code ?? null;
}

function toRow(r: Row): ExecutionRow {
  const useCaseCode = r.use_case_code == null ? null : String(r.use_case_code);
  const metadata = (r.metadata ?? {}) as Record<string, unknown>;
  return {
    id: Number(r.id),
    createdAt: new Date(String(r.created_at)),
    useCaseCode,
    treatment: treatmentOf(useCaseCode),
    operationCode: r.operation_code == null ? null : String(r.operation_code),
    accountId: r.account_id == null ? null : Number(r.account_id),
    userId: r.user_id == null ? null : Number(r.user_id),
    provider: r.provider == null ? null : String(r.provider),
    model: r.model == null ? null : String(r.model),
    modelRank: r.model_rank == null ? null : String(r.model_rank),
    usedFallback: Boolean(r.is_fallback),
    inputTokens: r.input_tokens == null ? null : Number(r.input_tokens),
    outputTokens: r.output_tokens == null ? null : Number(r.output_tokens),
    costMicros: r.cost_micros == null ? null : Number(r.cost_micros),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    status: String(r.status),
    errorCode: r.error_code == null ? null : String(r.error_code),
    errorMessage: r.error_message == null ? null : String(r.error_message),
    configVersionId: r.config_version_id == null ? null : Number(r.config_version_id),
    configVisibleNumber: r.config_visible_number == null ? null : Number(r.config_visible_number),
    appVersion: r.app_version == null ? null : String(r.app_version),
    jobId: r.job_id == null ? null : Number(r.job_id),
    // Le SCR-07 : « le prompt complet peut être référencé par version/ID sans
    // être dupliqué dans chaque ligne ». On rend la référence, pas le texte.
    promptVersion: typeof metadata.promptVersion === 'string' ? metadata.promptVersion : null,
  };
}

const MAX_LIMIT = 200;

export interface ExecutionPage {
  rows: ExecutionRow[];
  total: number;
  limit: number;
  offset: number;
}

export async function searchExecutions(f: ExecutionFilters = {}): Promise<ExecutionPage> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), MAX_LIMIT);
  const offset = Math.max(f.offset ?? 0, 0);

  // Le traitement est filtré par son code d'usage : la colonne stockée est
  // `use_case_code`, et traduire ici évite d'exposer ce détail à l'appelant.
  const useCaseCode = f.treatment ? TREATMENT_DEFINITIONS[f.treatment].useCaseCode : null;

  const params = [
    useCaseCode,                    // $1
    f.status ?? null,               // $2
    f.accountId ?? null,            // $3
    f.model ?? null,                // $4
    f.configVersionId ?? null,      // $5
    f.operationCode ?? null,        // $6
    f.errorsOnly ? true : null,     // $7
    // Chaîne ISO, jamais un objet `Date` : `pgClient.unsafe()` ne les sérialise
    // pas, et lève dans le pilote sans citer de colonne. Même défaut que sur
    // l'écran Coûts, trouvé en même temps.
    f.since?.toISOString() ?? null, // $8
    f.until?.toISOString() ?? null, // $9
    f.minDurationMs ?? null,        // $10
    f.userId ?? null,               // $11
    f.rank ?? null,                 // $12
    f.jobId ?? null,                // $13
  ];

  const where = `
      WHERE ($1::text IS NULL OR e.use_case_code = $1)
        AND ($2::text IS NULL OR e.status = $2)
        AND ($3::int  IS NULL OR e.account_id = $3)
        AND ($4::text IS NULL OR e.model = $4)
        AND ($5::int  IS NULL OR e.config_version_id = $5)
        AND ($6::text IS NULL OR e.operation_code = $6)
        AND ($7::bool IS NULL OR e.status = 'error')
        AND ($8::timestamptz IS NULL OR e.created_at >= $8)
        AND ($9::timestamptz IS NULL OR e.created_at <= $9)
        AND ($10::int IS NULL OR e.duration_ms >= $10)
        AND ($11::int IS NULL OR e.user_id = $11)
        AND ($12::text IS NULL
             OR ($12 = 'fallback' AND (e.model_rank IN ('fallback_1', 'fallback_2') OR e.is_fallback))
             OR e.model_rank = $12)
        AND ($13::int IS NULL OR e.job_id = $13)`;

  const rows = await pgClient.unsafe(
    `SELECT e.id, e.created_at, e.use_case_code, e.operation_code, e.account_id, e.user_id,
            e.provider, e.model, e.model_rank, e.is_fallback, e.input_tokens, e.output_tokens,
            e.cost_micros, e.duration_ms, e.status, e.error_code, e.error_message,
            e.config_version_id, e.app_version, e.job_id, e.metadata,
            v.visible_number AS config_visible_number
       FROM ai_usage_event e
       -- LEFT : une version supprimée ne doit pas faire disparaître la trace.
       LEFT JOIN ai_config_versions v ON v.id = e.config_version_id
       ${where}
      ORDER BY e.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params as never[],
  );

  const countRows = await pgClient.unsafe(
    `SELECT COUNT(*)::int AS total FROM ai_usage_event e ${where}`,
    params as never[],
  );

  return {
    rows: (rows as unknown as Row[]).map(toRow),
    total: Number((countRows as unknown as Row[])[0]?.total ?? 0),
    limit,
    offset,
  };
}

/**
 * Détail d'une exécution — LOG-UI-04, SCR-07, NFR-004.
 *
 * À partir d'un appel, reconstitue l'exécution : tous les appels de la même
 * trace (principal puis replis), les étapes de pipeline rattachées, le job de
 * file parent (déclencheur, origine, tentatives, version figée) et la version
 * de configuration appliquée. `getExecutionSteps` existait sans être exposé.
 */
export interface ExecutionDetail {
  call: ExecutionRow;
  traceId: string | null;
  calls: ExecutionRow[];
  steps: ExecutionStep[];
  job: {
    id: number; treatment: string; status: string; origin: string; triggerCode: string | null;
    attempts: number; configVersionId: number | null; createdAt: Date; startedAt: Date | null;
    finishedAt: Date | null; lastError: string | null; accountId: number | null;
    targetType: string | null; targetId: string | null;
  } | null;
}

const DETAIL_COLS = `e.id, e.created_at, e.use_case_code, e.operation_code, e.account_id, e.user_id,
            e.provider, e.model, e.model_rank, e.is_fallback, e.input_tokens, e.output_tokens,
            e.cost_micros, e.duration_ms, e.status, e.error_code, e.error_message,
            e.config_version_id, e.app_version, e.job_id, e.metadata,
            v.visible_number AS config_visible_number`;

export async function getExecutionDetail(id: number): Promise<ExecutionDetail | null> {
  const rows = await pgClient.unsafe(
    `SELECT ${DETAIL_COLS} FROM ai_usage_event e
       LEFT JOIN ai_config_versions v ON v.id = e.config_version_id
      WHERE e.id = $1 LIMIT 1`,
    [id] as never[],
  );
  const r = (rows as unknown as Row[])[0];
  if (!r) return null;
  const call = toRow(r);
  const traceId = typeof (r.metadata as Record<string, unknown> | null)?.traceId === 'string'
    ? String((r.metadata as Record<string, unknown>).traceId) : null;

  const calls = traceId
    ? ((await pgClient.unsafe(
      `SELECT ${DETAIL_COLS} FROM ai_usage_event e
         LEFT JOIN ai_config_versions v ON v.id = e.config_version_id
        WHERE e.metadata->>'traceId' = $1
        ORDER BY e.created_at, e.id LIMIT 20`,
      [traceId] as never[],
    )) as unknown as Row[]).map(toRow)
    : [call];

  const steps = traceId ? await getExecutionSteps(traceId) : [];

  let job: ExecutionDetail['job'] = null;
  if (call.jobId) {
    const j = ((await pgClient.unsafe(
      `SELECT id, treatment, status, origin, trigger_code, attempts, config_version_id,
              created_at, started_at, finished_at, last_error, account_id, target_type, target_id
         FROM ai_job_queue WHERE id = $1 LIMIT 1`,
      [call.jobId] as never[],
    )) as unknown as Row[])[0];
    if (j) {
      job = {
        id: Number(j.id), treatment: String(j.treatment), status: String(j.status), origin: String(j.origin),
        triggerCode: j.trigger_code == null ? null : String(j.trigger_code), attempts: Number(j.attempts),
        configVersionId: j.config_version_id == null ? null : Number(j.config_version_id),
        createdAt: new Date(String(j.created_at)),
        startedAt: j.started_at ? new Date(String(j.started_at)) : null,
        finishedAt: j.finished_at ? new Date(String(j.finished_at)) : null,
        lastError: j.last_error == null ? null : String(j.last_error),
        accountId: j.account_id == null ? null : Number(j.account_id),
        targetType: j.target_type == null ? null : String(j.target_type),
        targetId: j.target_id == null ? null : String(j.target_id),
      };
    }
  }
  return { call, traceId, calls, steps, job };
}

export interface ExecutionStep {
  stepName: string;
  stepOrder: number;
  provider: string | null;
  model: string | null;
  durationMs: number | null;
  status: string;
  costMicros: number | null;
  isFallback: boolean;
  fallbackReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  promptVersion: string | null;
  outputPreview: string | null;
}

/**
 * Étapes d'une exécution, retrouvées par leur identifiant de trace.
 *
 * `trace_id` relie les étapes entre elles alors que `operation_id` les relie à
 * une opération : c'est le premier qui correspond à ce que l'écran appelle une
 * exécution, et le seul que porte `ai_usage_event`.
 */
export async function getExecutionSteps(traceId: string): Promise<ExecutionStep[]> {
  const rows = await pgClient.unsafe(
    `SELECT step_name, step_order, provider, model, duration_ms, status,
            cost_micros, is_fallback, fallback_reason, error_code, error_message,
            prompt_version, output_preview
       FROM ai_pipeline_step
      WHERE trace_id = $1
      ORDER BY step_order, id`,
    [traceId] as never[],
  );

  return (rows as unknown as Row[]).map((r) => ({
    stepName: String(r.step_name),
    stepOrder: Number(r.step_order),
    provider: r.provider == null ? null : String(r.provider),
    model: r.model == null ? null : String(r.model),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    status: String(r.status),
    costMicros: r.cost_micros == null ? null : Number(r.cost_micros),
    isFallback: Boolean(r.is_fallback),
    fallbackReason: r.fallback_reason == null ? null : String(r.fallback_reason),
    errorCode: r.error_code == null ? null : String(r.error_code),
    errorMessage: r.error_message == null ? null : String(r.error_message),
    promptVersion: r.prompt_version == null ? null : String(r.prompt_version),
    outputPreview: r.output_preview == null ? null : String(r.output_preview),
  }));
}

/**
 * Répartition des erreurs sur une fenêtre — point d'entrée du diagnostic.
 *
 * Le NFR-004 veut qu'une erreur soit « diagnostiçable par traitement, compte,
 * objet, version, modèle, étape, cause et coût ». Encore faut-il savoir par où
 * commencer : ce regroupement répond à « qu'est-ce qui échoue le plus », avant
 * même d'ouvrir une ligne.
 */
export async function getErrorBreakdown(sinceDays = 7): Promise<Array<{
  useCaseCode: string | null; treatment: Treatment | null;
  errorCode: string | null; model: string | null; count: number; lastSeen: Date;
}>> {
  const rows = await pgClient.unsafe(
    `SELECT use_case_code, error_code, model,
            COUNT(*)::int AS count, MAX(created_at) AS last_seen
       FROM ai_usage_event
      WHERE status = 'error' AND created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY use_case_code, error_code, model
      ORDER BY count DESC
      LIMIT 50`,
    [String(sinceDays)] as never[],
  );

  return (rows as unknown as Row[]).map((r) => {
    const useCaseCode = r.use_case_code == null ? null : String(r.use_case_code);
    return {
      useCaseCode,
      treatment: treatmentOf(useCaseCode),
      errorCode: r.error_code == null ? null : String(r.error_code),
      model: r.model == null ? null : String(r.model),
      count: Number(r.count),
      lastSeen: new Date(String(r.last_seen)),
    };
  });
}
