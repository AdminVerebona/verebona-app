/**
 * Lot 114 (carte #776, travail 10 — §6, AC17) — SUPERVISION DES SORTIES
 * STRUCTURÉES : ce que la passerelle a RÉELLEMENT transmis, mesuré sur les
 * traces d'appels déjà enregistrées (`ai_usage_event.metadata` :
 * `providerRequest`, `providerAttempts`, `runtimeContract` — lots 52B, 34D).
 *
 * Par période, opération, modèle et contrat :
 *   · appels portant le schéma imposé et ACCEPTÉS par le fournisseur ;
 *   · refus HTTP 400 de la requête portant le schéma ;
 *   · nouveaux essais du même modèle sans schéma (#437), et ceux qui ont abouti ;
 *   · appels partis sans schéma à cause d'un refus mémorisé ;
 *   · appels sans schéma pour motif statique, ou non demandé ;
 *   · réussite finale, requêtes fournisseur RÉELLES (essais internes compris),
 *     jetons, coût, latence P50 / P95, temps passé dans les requêtes refusées.
 *
 * Une réussite finale n'est PAS « zéro incident » : les refus et les essais
 * sans schéma sont comptés à part. Les traces sont HISTORIQUES : rien n'est
 * recalculé ni réécrit, la période choisie relit les appels tels qu'ils ont
 * eu lieu (y compris ceux d'anciennes versions de l'application).
 *
 * Coût par tentative : une requête refusée en HTTP 400 ne consomme aucun
 * jeton (le fournisseur ne génère rien) ; les jetons et le coût de l'appel
 * sont ceux de la tentative qui a répondu. Les DURÉES sont relevées par
 * tentative.
 *
 * AUCUN CONTENU : compteurs, codes, identifiants, versions et empreintes.
 */

type Row = Record<string, unknown>;

export interface SchemaUsageFilters {
  /** Période en jours (1 à 90). */
  days: number;
  operationCode?: string | null;
  model?: string | null;
  contractVersion?: number | null;
}

export interface SchemaUsageCounts {
  /** Appels d'analyse ayant sollicité le fournisseur. */
  calls: number;
  /** Première requête portant le schéma imposé. */
  schemaSent: number;
  /** … et à laquelle le fournisseur a répondu. */
  schemaAccepted: number;
  /** … refusée en HTTP 400. */
  schemaRefused400: number;
  /** … en échec pour une autre raison (délai, quota, réseau…) : rien n'est conclu sur le schéma. */
  schemaFailedOther: number;
  /** Nouveaux essais du même modèle sans schéma (refus explicite ou essai diagnostique). */
  retriesWithoutSchema: number;
  /** Appels ayant abouti après un nouvel essai sans schéma. */
  answeredAfterRetry: number;
  /** Appels partis sans schéma : refus mémorisé pour le couple. */
  skippedKnownRejection: number;
  /** Appels sans schéma : motif statique (schéma non transmissible). */
  omittedStatic: number;
  /** Appels sans schéma : non demandé pour l'opération, ou sorties structurées coupées. */
  notRequested: number;
  /** Appels de réexamen (essai réservé d'un couple refusé). */
  retests: number;
  /** Appels dont le résultat final est une réussite. */
  finalSuccess: number;
  /** Requêtes fournisseur réellement effectuées (essais internes compris). */
  providerRequests: number;
  inputTokens: number;
  outputTokens: number;
  /** Coût total en micro-unités ; `null` : au moins un appel sans tarif (non calculable). */
  costMicros: number | null;
  /** Temps passé dans les requêtes refusées ou en échec avant la réponse (ms). */
  failedAttemptMs: number;
}

export interface SchemaUsageGroup extends SchemaUsageCounts {
  operationCode: string;
  model: string;
  contractId: string | null;
  contractVersion: number | null;
  schemaHash: string | null;
  providerSchemaHash: string | null;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  rates: SchemaUsageRates;
}

export interface SchemaUsageRates {
  /** Part des appels où le schéma imposé a été accepté, parmi ceux où il était demandé. `null` : aucun. */
  acceptedRate: number | null;
  /** Part des requêtes portant le schéma refusées en HTTP 400. */
  refusal400Rate: number | null;
  /** Part des appels où le schéma était demandé et n'a PAS été accepté (refus, refus mémorisé, motif statique, autre échec). */
  jsonModeRate: number | null;
  /** Requêtes fournisseur par appel. */
  requestsPerCall: number | null;
}

export interface SchemaUsageDay extends Pick<SchemaUsageCounts, 'calls' | 'schemaSent' | 'schemaAccepted' | 'schemaRefused400' | 'skippedKnownRejection' | 'omittedStatic' | 'notRequested'> {
  day: string;
  acceptedRate: number | null;
}

export interface SchemaUsageReport {
  days: number;
  from: string;
  to: string;
  filters: { operationCode: string | null; model: string | null; contractVersion: number | null };
  totals: SchemaUsageCounts & { rates: SchemaUsageRates };
  groups: SchemaUsageGroup[];
  trend: SchemaUsageDay[];
  /** Lecture impossible (délai, base) : indicateurs absents — jamais zéro. */
  unavailable: string | null;
}

const ratio = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);

/** Taux d'un ensemble de compteurs (pure). Dénominateur nul : `null`, jamais 0. */
export function schemaUsageRates(c: Pick<SchemaUsageCounts, 'calls' | 'schemaSent' | 'schemaAccepted' | 'schemaRefused400' | 'notRequested' | 'providerRequests'>): SchemaUsageRates {
  const demandes = c.calls - c.notRequested;
  return {
    acceptedRate: ratio(c.schemaAccepted, demandes),
    refusal400Rate: ratio(c.schemaRefused400, c.schemaSent),
    jsonModeRate: demandes > 0 ? ratio(demandes - c.schemaAccepted, demandes) : null,
    requestsPerCall: c.calls > 0 ? Math.round((c.providerRequests / c.calls) * 100) / 100 : null,
  };
}

const ZERO: SchemaUsageCounts = {
  calls: 0, schemaSent: 0, schemaAccepted: 0, schemaRefused400: 0, schemaFailedOther: 0, retriesWithoutSchema: 0, answeredAfterRetry: 0,
  skippedKnownRejection: 0, omittedStatic: 0, notRequested: 0, retests: 0, finalSuccess: 0, providerRequests: 0, inputTokens: 0, outputTokens: 0,
  costMicros: 0, failedAttemptMs: 0,
};

type NumericKey = Exclude<keyof SchemaUsageCounts, 'costMicros'>;
const NUMERIC_KEYS: readonly NumericKey[] = [
  'calls', 'schemaSent', 'schemaAccepted', 'schemaRefused400', 'schemaFailedOther', 'retriesWithoutSchema', 'answeredAfterRetry',
  'skippedKnownRejection', 'omittedStatic', 'notRequested', 'retests', 'finalSuccess', 'providerRequests', 'inputTokens', 'outputTokens', 'failedAttemptMs',
];

/** Somme de groupes (pure) ; un coût non calculable dans un groupe rend le total non calculable. */
export function sumSchemaUsage(groups: readonly SchemaUsageCounts[]): SchemaUsageCounts {
  const t: SchemaUsageCounts = { ...ZERO };
  for (const g of groups) {
    for (const k of NUMERIC_KEYS) t[k] += g[k];
    t.costMicros = t.costMicros === null || g.costMicros === null ? null : t.costMicros + g.costMicros;
  }
  return t;
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const nn = (v: unknown): number | null => (v == null ? null : Number(v));
const sn = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

function countsOf(r: Row): SchemaUsageCounts {
  return {
    calls: n(r.calls), schemaSent: n(r.schema_sent), schemaAccepted: n(r.schema_accepted), schemaRefused400: n(r.schema_refused_400),
    schemaFailedOther: n(r.schema_failed_other), retriesWithoutSchema: n(r.retries_without_schema), answeredAfterRetry: n(r.answered_after_retry),
    skippedKnownRejection: n(r.skipped_known_rejection), omittedStatic: n(r.omitted_static), notRequested: n(r.not_requested), retests: n(r.retests),
    finalSuccess: n(r.final_success), providerRequests: n(r.provider_requests), inputTokens: n(r.input_tokens), outputTokens: n(r.output_tokens),
    costMicros: n(r.cost_unknown) > 0 ? null : n(r.cost_micros), failedAttemptMs: n(r.failed_attempt_ms),
  };
}

/** Motifs STATIQUES d'absence de schéma (`provider-schema.ts`). */
export const STATIC_OMISSION_REASONS = ['too_complex', 'unrepresentable', 'provider_contract', 'projection_lossy'] as const;

/** Colonnes d'agrégat communes (par groupe et par jour). `e` : ligne d'appel ; `pr` : requête ; `a0` : première tentative. */
const AGG = `
  COUNT(*)::int AS calls,
  COUNT(*) FILTER (WHERE pr->>'responseSchemaSent' = 'true')::int AS schema_sent,
  COUNT(*) FILTER (WHERE pr->>'responseSchemaSent' = 'true' AND a0->>'outcome' = 'SUCCESS')::int AS schema_accepted,
  COUNT(*) FILTER (WHERE pr->>'responseSchemaSent' = 'true' AND a0->>'outcome' = 'FAILED' AND a0->>'httpStatus' = '400')::int AS schema_refused_400,
  COUNT(*) FILTER (WHERE pr->>'responseSchemaSent' = 'true' AND a0->>'outcome' = 'FAILED' AND COALESCE(a0->>'httpStatus', '') <> '400')::int AS schema_failed_other,
  COUNT(*) FILTER (WHERE pr->>'schemaOmittedReason' = 'recent_rejection')::int AS skipped_known_rejection,
  COUNT(*) FILTER (WHERE pr->>'schemaOmittedReason' = ANY($5::text[]))::int AS omitted_static,
  COUNT(*) FILTER (WHERE pr->>'responseSchemaSent' <> 'true'
                     AND COALESCE(pr->>'schemaOmittedReason', 'not_requested') <> 'recent_rejection'
                     AND NOT (COALESCE(pr->>'schemaOmittedReason', '') = ANY($5::text[])))::int AS not_requested`;

/**
 * Rapport d'usage du schéma imposé. `run` : exécuteur de lecture (par défaut
 * la session en lecture seule de l'observabilité, délai borné côté base).
 * Lecture impossible : `unavailable` renseigné, aucun compteur inventé.
 */
export async function getSchemaUsageReport(
  f: SchemaUsageFilters, now: Date = new Date(),
  run?: (sql: string, params: unknown[]) => Promise<Row[]>,
): Promise<SchemaUsageReport> {
  const days = Math.min(Math.max(Math.floor(f.days) || 7, 1), 90);
  const to = now;
  const from = new Date(now.getTime() - days * 86_400_000);
  const filters = { operationCode: f.operationCode || null, model: f.model || null, contractVersion: f.contractVersion ?? null };
  const base: SchemaUsageReport = {
    days, from: from.toISOString(), to: to.toISOString(), filters,
    totals: { ...ZERO, rates: schemaUsageRates(ZERO) }, groups: [], trend: [], unavailable: null,
  };
  const exec = run ?? (async (sql: string, params: unknown[]) => (await import('../../telemetry/observability.repository')).readOnlyObservabilityQuery(sql, params));
  const params = [from.toISOString(), to.toISOString(), filters.operationCode, filters.model, [...STATIC_OMISSION_REASONS], filters.contractVersion === null ? null : String(filters.contractVersion)];
  const source = `
    FROM (
      SELECT COALESCE(e.operation_code, e.operation_type) AS operation_code, e.model, e.status, e.input_tokens, e.output_tokens, e.cost_micros, e.duration_ms, e.created_at,
             e.metadata->'providerRequest' AS pr, e.metadata->'providerAttempts' AS attempts, e.metadata->'providerAttempts'->0 AS a0,
             e.metadata->'runtimeContract' AS rc, e.metadata->'providerMeta'->>'structuredOutput' AS so
        FROM ai_usage_event e
       WHERE e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
         AND e.metadata ? 'providerRequest'
         AND COALESCE(e.metadata->>'callKind', 'analysis') = 'analysis'
         AND ($3::text IS NULL OR COALESCE(e.operation_code, e.operation_type) = $3)
         AND ($4::text IS NULL OR e.model = $4)
         AND ($6::text IS NULL OR e.metadata->'runtimeContract'->>'contractVersion' = $6)
    ) x`;
  try {
    const groups = await exec(
      `SELECT operation_code, model, rc->>'contractId' AS contract_id, rc->>'contractVersion' AS contract_version,
              rc->>'schemaHash' AS schema_hash, pr->>'providerSchemaHash' AS provider_schema_hash,
              ${AGG},
              COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(attempts, '[]'::jsonb)) a
                             WHERE a->>'kind' IN ('schema_rejected_retry', 'diagnostic_retry'))), 0)::int AS retries_without_schema,
              COUNT(*) FILTER (WHERE so = 'schema_rejected_retried_without')::int AS answered_after_retry,
              COUNT(*) FILTER (WHERE pr->'schemaCompat'->>'retest' = 'true')::int AS retests,
              COUNT(*) FILTER (WHERE status = 'success')::int AS final_success,
              COALESCE(SUM(GREATEST(jsonb_array_length(COALESCE(attempts, '[]'::jsonb)), 1)), 0)::int AS provider_requests,
              COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens, COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
              COALESCE(SUM(cost_micros), 0)::bigint AS cost_micros,
              COUNT(*) FILTER (WHERE cost_micros IS NULL AND (input_tokens > 0 OR output_tokens > 0))::int AS cost_unknown,
              COALESCE(SUM((SELECT SUM((a->>'durationMs')::numeric) FROM jsonb_array_elements(COALESCE(attempts, '[]'::jsonb)) a
                             WHERE a->>'outcome' = 'FAILED')), 0)::bigint AS failed_attempt_ms,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::int AS duration_p50,
              (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS duration_p95
         ${source}
        GROUP BY 1, 2, 3, 4, 5, 6
        ORDER BY calls DESC, operation_code, model
        LIMIT 200`,
      params,
    );
    const trend = await exec(
      `SELECT to_char(created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS day, ${AGG}
         ${source}
        GROUP BY 1 ORDER BY 1`,
      params,
    );
    base.groups = groups.map((r) => {
      const c = countsOf(r);
      return {
        operationCode: String(r.operation_code), model: String(r.model), contractId: sn(r.contract_id), contractVersion: nn(r.contract_version),
        schemaHash: sn(r.schema_hash), providerSchemaHash: sn(r.provider_schema_hash), ...c,
        durationP50Ms: nn(r.duration_p50), durationP95Ms: nn(r.duration_p95), rates: schemaUsageRates(c),
      };
    });
    const totals = sumSchemaUsage(base.groups);
    base.totals = { ...totals, rates: schemaUsageRates(totals) };
    base.trend = trend.map((r) => {
      const c = { calls: n(r.calls), schemaSent: n(r.schema_sent), schemaAccepted: n(r.schema_accepted), schemaRefused400: n(r.schema_refused_400),
        skippedKnownRejection: n(r.skipped_known_rejection), omittedStatic: n(r.omitted_static), notRequested: n(r.not_requested) };
      return { day: String(r.day), ...c, acceptedRate: ratio(c.schemaAccepted, c.calls - c.notRequested) };
    });
  } catch (e) {
    base.unavailable = String((e as Error)?.message ?? e).slice(0, 200);
  }
  return base;
}
