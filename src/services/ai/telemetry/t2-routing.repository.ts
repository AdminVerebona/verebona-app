/**
 * Routage T2 (cascade de l'assistant) — CDC BO IA LOG-UI-06, LOG-UI-07,
 * T2-046, T2-011, NFR-004, SCR-07 (« une requête T2 déterministe apparaît
 * avec zéro appel »).
 *
 * Le chemin existait en base — `verebona_request_runs` (mode, cascade,
 * sources) et `verebona_ai_runs` (appels, coût, repli) — sans être exposé au
 * BO. Lecture seule, filtrée et bornée côté serveur (NFR-001, NFR-002).
 *
 * LOG-UI-08 : aucun contenu conversationnel n'est lu ici (ni question, ni
 * réponse) — seulement la mécanique de routage.
 */
import { pgClient } from '@/db';

type Row = Record<string, unknown>;

export interface T2RequestRow {
  id: number;
  requestId: string;
  createdAt: string;
  accountId: number;
  userId: number | null;
  intent: string | null;
  mode: string | null;
  status: string | null;
  errorCode: string | null;
  latencyMs: number | null;
  sourceCount: number | null;
  candidateCount: number | null;
  cacheHit: boolean | null;
  /** Trace de la cascade (niveaux atteints, raisons de non-escalade). */
  cascade: unknown;
  aiCalls: number;
  costMicros: number;
  fallbackUsed: boolean;
  routeReasons: string[];
  models: string[];
}

export interface T2RequestFilters {
  accountId?: number;
  userId?: number;
  /** `true` : seulement les requêtes tranchées sans IA (0 appel). */
  deterministicOnly?: boolean;
  /** `true` : seulement les requêtes escaladées vers le modèle. */
  aiOnly?: boolean;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export async function searchT2Requests(f: T2RequestFilters = {}): Promise<{ rows: T2RequestRow[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const params = [
    f.accountId ?? null, f.userId ?? null,
    f.since?.toISOString() ?? null, f.until?.toISOString() ?? null,
    f.deterministicOnly ? true : null, f.aiOnly ? true : null,
  ];
  const base = `
    FROM verebona_request_runs r
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS calls,
             COALESCE(SUM(a.estimated_cost_micros), 0)::bigint AS cost,
             BOOL_OR(COALESCE(a.fallback_used, FALSE)) AS fallback,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.route_reason), NULL) AS reasons,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.resolved_model_id), NULL) AS models
        FROM verebona_ai_runs a
       WHERE a.request_id = r.request_id AND a.account_id = r.account_id
    ) ai ON TRUE
    WHERE ($1::int IS NULL OR r.account_id = $1)
      AND ($2::int IS NULL OR r.user_id = $2)
      AND ($3::timestamptz IS NULL OR r.created_at >= $3)
      AND ($4::timestamptz IS NULL OR r.created_at <= $4)
      AND ($5::bool IS NULL OR ai.calls = 0)
      AND ($6::bool IS NULL OR ai.calls > 0)`;
  const rows = (await pgClient.unsafe(
    `SELECT r.id, r.request_id, r.created_at, r.account_id, r.user_id, r.intent, r.mode, r.status,
            r.error_code, r.latency_ms, r.source_count, r.candidate_count, r.cache_hit,
            r.retrieval_methods_json, ai.calls, ai.cost, ai.fallback, ai.reasons, ai.models
       ${base}
      ORDER BY r.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params as never[],
  )) as unknown as Row[];
  const [c] = (await pgClient.unsafe(`SELECT COUNT(*)::int AS total ${base}`, params as never[])) as unknown as Row[];
  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      requestId: String(r.request_id),
      createdAt: new Date(String(r.created_at)).toISOString(),
      accountId: Number(r.account_id),
      userId: r.user_id == null ? null : Number(r.user_id),
      intent: r.intent == null ? null : String(r.intent),
      mode: r.mode == null ? null : String(r.mode),
      status: r.status == null ? null : String(r.status),
      errorCode: r.error_code == null ? null : String(r.error_code),
      latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
      sourceCount: r.source_count == null ? null : Number(r.source_count),
      candidateCount: r.candidate_count == null ? null : Number(r.candidate_count),
      cacheHit: r.cache_hit == null ? null : Boolean(r.cache_hit),
      cascade: r.retrieval_methods_json ?? null,
      aiCalls: Number(r.calls ?? 0),
      costMicros: Number(r.cost ?? 0),
      fallbackUsed: Boolean(r.fallback),
      routeReasons: (r.reasons as string[] | null) ?? [],
      models: (r.models as string[] | null) ?? [],
    })),
    total: Number(c?.total ?? 0),
    limit,
    offset,
  };
}

/** COST-015 : usage T2 comparé au coût — requêtes totales, dont escaladées. */
export async function getT2UsageSummary(since: Date): Promise<{ requests: number; withAi: number; costMicros: number }> {
  const [r] = (await pgClient.unsafe(
    `SELECT COUNT(*)::int AS requests,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM verebona_ai_runs a WHERE a.request_id = r.request_id AND a.account_id = r.account_id))::int AS with_ai,
            COALESCE((SELECT SUM(estimated_cost_micros) FROM verebona_ai_runs WHERE created_at >= $1), 0)::bigint AS cost
       FROM verebona_request_runs r WHERE r.created_at >= $1`,
    [since.toISOString()] as never[],
  )) as unknown as Row[];
  return { requests: Number(r?.requests ?? 0), withAi: Number(r?.with_ai ?? 0), costMicros: Number(r?.cost ?? 0) };
}
