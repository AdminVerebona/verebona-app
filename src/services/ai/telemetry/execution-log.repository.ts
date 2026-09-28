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
  /**
   * LOG-UI-02 : objet traité — type (`asset_file`, `asset`, `account`…) et/ou
   * identifiant. Lu sur la cible du job de file, sinon sur le fichier source
   * de l'appel.
   */
  objectType?: string;
  objectId?: string;
  /** LOG-UI-02 : déclencheur (`trigger_code` du job) ou origine (`manual`, `automatic`). */
  trigger?: string;
  /** CDC Mascotte BO-009 : génération T6 affichée, pré-génération ou texte de secours. */
  t6Mode?: 'displayed' | 'pregeneration' | 'fallback';
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
  /** LOG-UI-03 : objet traité (cible du job, sinon fichier source). */
  objectType: string | null;
  objectId: string | null;
  /** LOG-UI-03 : déclencheur du job (ou `null` pour un appel synchrone). */
  trigger: string | null;
  origin: string | null;
  /** BO-009 : mode déclaré par la mascotte (`displayed` / `pregeneration`), sinon null. */
  callerMode: string | null;
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
    objectType: r.object_type == null ? null : String(r.object_type),
    objectId: r.object_id == null ? null : String(r.object_id),
    trigger: r.trigger_code == null ? null : String(r.trigger_code),
    origin: r.job_origin == null ? null : String(r.job_origin),
    callerMode: typeof metadata.callerMode === 'string' ? metadata.callerMode : null,
  };
}

/**
 * Objet et déclencheur d'un appel : cible du job de file quand il y en a un,
 * sinon fichier source (`asset_file_id`). Expressions partagées par la liste,
 * les filtres et le détail.
 */
const OBJECT_TYPE = `COALESCE(j.target_type, CASE WHEN e.asset_file_id IS NOT NULL THEN 'asset_file' END)`;
const OBJECT_ID = `COALESCE(j.target_id, e.asset_file_id::text)`;
const OBJECT_COLS = `${OBJECT_TYPE} AS object_type, ${OBJECT_ID} AS object_id,
            j.trigger_code AS trigger_code, j.origin AS job_origin`;
const JOB_JOIN = `LEFT JOIN ai_job_queue j ON j.id = e.job_id`;

/**
 * Mode de génération T6 d'un appel — CDC Mascotte BO-009.
 *
 * ⚠️ Le classement suit l'ISSUE de la génération, pas le statut de l'appel.
 * Toutes les tentatives d'une même exécution gateway (principal, repli 1,
 * repli 2) partagent un `traceId`. Une tentative en échec suivie d'un repli
 * réussi dont le texte a été affiché n'est PAS un « texte de secours » : son
 * coût a produit un affichage. On lit donc `home_mascot_generations` par
 * `trace_id` (index partiel, migration 0210) :
 *   · une génération `generated` en mode `display` → `displayed` ;
 *   · une génération `generated` seulement en `pregen` (pré-génération, ou
 *     génération achevée après le délai d'affichage) → `pregeneration` ;
 *   · une génération non retenue (sortie rejetée…) → `fallback` ;
 *   · aucune génération rattachée à la trace : la chaîne entière a échoué
 *     (l'issue « erreur » ne porte pas de trace) → `fallback`.
 * `NULL` pour tout appel hors mascotte (pas de `callerMode`).
 */
export function t6ModeSql(alias: string): string {
  return `(CASE
    WHEN ${alias}.metadata->>'callerMode' IS NULL THEN NULL
    ELSE COALESCE((
      SELECT CASE
               WHEN bool_or(g.status = 'generated' AND g.mode = 'display') THEN 'displayed'
               WHEN bool_or(g.status = 'generated') THEN 'pregeneration'
               ELSE 'fallback'
             END
        FROM home_mascot_generations g
       WHERE g.trace_id = ${alias}.metadata->>'traceId'
      HAVING COUNT(*) > 0
    ), 'fallback')
  END)`;
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
    f.objectType ?? null,           // $14
    f.objectId ?? null,             // $15
    f.trigger ?? null,              // $16
    f.t6Mode ?? null,               // $17
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
        AND ($13::int IS NULL OR e.job_id = $13)
        AND ($14::text IS NULL OR ${OBJECT_TYPE} = $14)
        AND ($15::text IS NULL OR ${OBJECT_ID} = $15)
        AND ($16::text IS NULL OR j.trigger_code = $16 OR j.origin = $16)
        AND ($17::text IS NULL OR ${t6ModeSql('e')} = $17)`;

  const rows = await pgClient.unsafe(
    `SELECT e.id, e.created_at, e.use_case_code, e.operation_code, e.account_id, e.user_id,
            e.provider, e.model, e.model_rank, e.is_fallback, e.input_tokens, e.output_tokens,
            e.cost_micros, e.duration_ms, e.status, e.error_code, e.error_message,
            e.config_version_id, e.app_version, e.job_id, e.metadata,
            v.visible_number AS config_visible_number, ${OBJECT_COLS}
       FROM ai_usage_event e
       -- LEFT : une version supprimée ne doit pas faire disparaître la trace.
       LEFT JOIN ai_config_versions v ON v.id = e.config_version_id
       ${JOB_JOIN}
       ${where}
      ORDER BY e.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params as never[],
  );

  const countRows = await pgClient.unsafe(
    `SELECT COUNT(*)::int AS total FROM ai_usage_event e ${JOB_JOIN} ${where}`,
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
  /** LOG-UI-04 : instantanés d'entrée (références figées, jamais le contenu brut). */
  inputs: ExecutionInput[];
  /** LOG-UI-04 : modifications produites par l'exécution. */
  modifications: ExecutionModification[];
  /** LOG-UI-07 : requête T2 rattachée et sources réellement utilisées. */
  t2: { requestId: string; sources: import('./t2-request-detail.repository').T2Source[] } | null;
}

export interface ExecutionInput {
  label: string;
  value: unknown;
}

export interface ExecutionModification {
  kind: string;
  label: string;
  detail: string | null;
  at: string | null;
}

const DETAIL_COLS = `e.id, e.created_at, e.use_case_code, e.operation_code, e.account_id, e.user_id,
            e.provider, e.model, e.model_rank, e.is_fallback, e.input_tokens, e.output_tokens,
            e.cost_micros, e.duration_ms, e.status, e.error_code, e.error_message,
            e.config_version_id, e.app_version, e.job_id, e.metadata, e.asset_file_id,
            v.visible_number AS config_visible_number, ${OBJECT_COLS}`;

export async function getExecutionDetail(id: number): Promise<ExecutionDetail | null> {
  const rows = await pgClient.unsafe(
    `SELECT ${DETAIL_COLS} FROM ai_usage_event e
       LEFT JOIN ai_config_versions v ON v.id = e.config_version_id
       ${JOB_JOIN}
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
         ${JOB_JOIN}
        WHERE e.metadata->>'traceId' = $1
        ORDER BY e.created_at, e.id LIMIT 20`,
      [traceId] as never[],
    )) as unknown as Row[]).map(toRow)
    : [call];

  const steps = traceId ? await getExecutionSteps(traceId) : [];

  let job: ExecutionDetail['job'] = null;
  let jobPayload: unknown = null;
  if (call.jobId) {
    const j = ((await pgClient.unsafe(
      `SELECT id, treatment, status, origin, trigger_code, attempts, config_version_id,
              created_at, started_at, finished_at, last_error, account_id, target_type, target_id, payload
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
      jobPayload = j.payload ?? null;
    }
  }

  const window = executionWindow(calls.length ? calls : [call], job);
  const assetFileId = r.asset_file_id == null ? null : Number(r.asset_file_id);
  const [inputs, modifications, t2] = await Promise.all([
    buildInputs(call, r, job, jobPayload, assetFileId).catch((): ExecutionInput[] => []),
    loadModifications(call, traceId, job, window, assetFileId).catch((): ExecutionModification[] => []),
    call.treatment === 'T2' ? loadT2Link(call).catch(() => null) : Promise.resolve(null),
  ]);
  return { call, traceId, calls, steps, job, inputs, modifications, t2 };
}

/** Fenêtre de l'exécution : job de file si présent, sinon appels de la trace ± 5 min. */
function executionWindow(calls: ExecutionRow[], job: ExecutionDetail['job']): { from: string; to: string } {
  const MARGE = 5 * 60_000;
  if (job?.startedAt) {
    const fin = job.finishedAt ?? new Date(job.startedAt.getTime() + 60 * 60_000);
    return { from: new Date(job.startedAt.getTime() - MARGE).toISOString(), to: new Date(fin.getTime() + MARGE).toISOString() };
  }
  const t = calls.map((c) => c.createdAt.getTime());
  return { from: new Date(Math.min(...t) - MARGE).toISOString(), to: new Date(Math.max(...t) + MARGE).toISOString() };
}

/**
 * Instantanés d'entrée — références figées au moment de l'exécution : version
 * de prompt et de configuration, tarif figé, charge utile du job, empreinte
 * des entrées des étapes, empreinte et version du fichier analysé (T1),
 * événements déclencheurs (T3). Jamais le texte envoyé au modèle.
 */
async function buildInputs(
  call: ExecutionRow, r: Row, job: ExecutionDetail['job'],
  jobPayload: unknown, assetFileId: number | null,
): Promise<ExecutionInput[]> {
  const meta = (r.metadata ?? {}) as Record<string, unknown>;
  const out: ExecutionInput[] = [
    { label: 'Version de prompt', value: call.promptVersion },
    { label: 'Version de configuration', value: call.configVisibleNumber ?? call.configVersionId },
    { label: 'Code déployé', value: call.appVersion },
    { label: 'Tarif figé', value: meta.pricing ?? null },
  ];
  if (job) out.push({ label: 'Charge utile du job', value: jobPayload });
  const hashes = [...new Set((await pgClient.unsafe(
    `SELECT DISTINCT input_hash FROM ai_pipeline_step WHERE trace_id = $1 AND input_hash IS NOT NULL LIMIT 10`,
    [String(meta.traceId ?? '')] as never[],
  ).catch(() => []) as unknown as Row[]).map((x) => String(x.input_hash)))];
  if (hashes.length) out.push({ label: 'Empreinte des entrées (étapes)', value: hashes });

  if (call.treatment === 'T1' && assetFileId) {
    const [run] = (await pgClient.unsafe(
      `SELECT id, input_file_hash, document_version_id, prompt_version, model, status, started_at
         FROM document_analysis_runs WHERE asset_file_id = $1
        ORDER BY ABS(EXTRACT(EPOCH FROM (started_at - $2::timestamptz))) LIMIT 1`,
      [assetFileId, call.createdAt.toISOString()] as never[],
    )) as unknown as Row[];
    if (run) {
      out.push({
        label: 'Source analysée', value: {
          fichier: assetFileId, analyse: Number(run.id), empreinte: run.input_file_hash,
          versionDocument: run.document_version_id, prompt: run.prompt_version, modèle: run.model,
        },
      });
    }
  }
  if (call.treatment === 'T3' && call.accountId) {
    const [run] = (await pgClient.unsafe(
      `SELECT id, trigger_type, trigger_event, trigger_object_type, trigger_object_id, scope, events_json
         FROM account_reconciliation_runs WHERE account_id = $1
        ORDER BY ABS(EXTRACT(EPOCH FROM (COALESCE(started_at, not_before) - $2::timestamptz))) LIMIT 1`,
      [call.accountId, call.createdAt.toISOString()] as never[],
    ).catch(() => [])) as unknown as Row[];
    if (run) {
      out.push({
        label: 'Déclenchement T3', value: {
          passage: Number(run.id), type: run.trigger_type, événement: run.trigger_event,
          objet: run.trigger_object_type ? `${run.trigger_object_type} ${run.trigger_object_id}` : null,
          périmètre: run.scope, événements: run.events_json,
        },
      });
    }
  }
  return out;
}

/**
 * Modifications produites (LOG-UI-04) :
 * · T3 : décisions des passages de rationalisation de la trace (ou, pour un
 *   job, du compte pendant la fenêtre du job) ;
 * · T4 : événements du cycle de vie des échéances du compte dans la fenêtre ;
 * · T1 : faits extraits du fichier analysé dans la fenêtre.
 * Rattachement par trace quand il existe, sinon temporel (fenêtre bornée).
 */
async function loadModifications(
  call: ExecutionRow, traceId: string | null, job: ExecutionDetail['job'],
  w: { from: string; to: string }, assetFileId: number | null,
): Promise<ExecutionModification[]> {
  const accountId = job?.accountId ?? call.accountId;
  if (call.treatment === 'T3') {
    const rows = (await pgClient.unsafe(
      `SELECT d.field_key, d.action, d.reason_code, d.confidence, d.asset_id, d.created_at, r.shadow
         FROM reconciliation_decisions d
         JOIN reconciliation_runs r ON r.id = d.run_id
        WHERE ($1::text IS NOT NULL AND r.trace_id::text = $1)
           OR ($2::int IS NOT NULL AND r.account_id = $2 AND r.started_at BETWEEN $3::timestamptz AND $4::timestamptz)
        ORDER BY d.created_at LIMIT 100`,
      [traceId, accountId, w.from, w.to] as never[],
    )) as unknown as Row[];
    return rows.map((d) => ({
      kind: String(d.action),
      label: `Bien ${d.asset_id} · ${d.field_key}`,
      detail: `${d.reason_code} (${d.confidence})${d.shadow ? ' — observation, non appliqué' : ''}`,
      at: new Date(String(d.created_at)).toISOString(),
    }));
  }
  if (call.treatment === 'T4' && accountId) {
    const rows = (await pgClient.unsafe(
      `SELECT e.event_type, e.agenda_item_id, e.detail_json, e.created_at, i.title
         FROM agenda_occurrence_events e
         LEFT JOIN agenda_items i ON i.id = e.agenda_item_id
        WHERE e.account_id = $1 AND e.created_at BETWEEN $2::timestamptz AND $3::timestamptz
        ORDER BY e.created_at LIMIT 100`,
      [accountId, w.from, w.to] as never[],
    )) as unknown as Row[];
    return rows.map((e) => ({
      kind: String(e.event_type),
      label: `Échéance ${e.agenda_item_id}${e.title ? ` — ${e.title}` : ''}`,
      detail: e.detail_json ? JSON.stringify(e.detail_json).slice(0, 300) : null,
      at: new Date(String(e.created_at)).toISOString(),
    }));
  }
  if (call.treatment === 'T1' && assetFileId) {
    const rows = (await pgClient.unsafe(
      `SELECT fact_key, value_text, value_number, value_unit, created_at
         FROM document_facts
        WHERE file_id = $1 AND created_at BETWEEN $2::timestamptz AND $3::timestamptz
        ORDER BY created_at LIMIT 100`,
      [assetFileId, w.from, w.to] as never[],
    )) as unknown as Row[];
    return rows.map((f) => ({
      kind: 'fact_extracted',
      label: String(f.fact_key),
      detail: [f.value_text ?? f.value_number, f.value_unit].filter((x) => x != null).join(' ') || null,
      at: new Date(String(f.created_at)).toISOString(),
    }));
  }
  return [];
}

/**
 * Requête T2 de l'appel. `ai_usage_event` ne porte pas l'identifiant de
 * requête de l'assistant : le rapprochement se fait sur `verebona_ai_runs`
 * (même compte, même modèle, instant le plus proche, ±2 min).
 */
async function loadT2Link(call: ExecutionRow): Promise<ExecutionDetail['t2']> {
  if (!call.accountId) return null;
  const [run] = (await pgClient.unsafe(
    `SELECT request_id FROM verebona_ai_runs
      WHERE account_id = $1 AND created_at BETWEEN $2::timestamptz - interval '2 minutes' AND $2::timestamptz + interval '2 minutes'
      ORDER BY (resolved_model_id IS NOT DISTINCT FROM $3) DESC,
               ABS(EXTRACT(EPOCH FROM (created_at - $2::timestamptz)))
      LIMIT 1`,
    [call.accountId, call.createdAt.toISOString(), call.model] as never[],
  )) as unknown as Row[];
  if (!run?.request_id) return null;
  const { getT2RequestSources } = await import('./t2-request-detail.repository');
  const requestId = String(run.request_id);
  return { requestId, sources: await getT2RequestSources(requestId) };
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
