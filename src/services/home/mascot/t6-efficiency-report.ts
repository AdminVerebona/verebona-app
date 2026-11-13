/**
 * Lot 113AO (Trello #748, A6 / AC15) — MESURE des appels T6 sur une période,
 * à partir des seules données enregistrées (aucun appel IA, aucune
 * extrapolation, aucun texte restitué : des nombres seulement).
 *
 *   · appels FORMULATE par code de signal (`sourceCode`), jetons d'entrée et
 *     de sortie, coût CONNU (null dès qu'un appel n'a pas de coût figé :
 *     jamais compté zéro), appels facturables ;
 *   · sujets dont la formulation T6 est IDENTIQUE au texte déterministe
 *     transmis (`fallbackText`) — taux de « sorties sans apport » ;
 *   · générations ÉVITÉES : clés déterministes servies sans appel (contextes
 *     distincts = générations qui auraient été demandées), affichages servis ;
 *   · doublons : générations réussies de la même entrée, même compte, à moins
 *     de 2 minutes, traces distinctes ; demandes équivalentes refusées par la
 *     réservation durable ;
 *   · appels T6 par exécution de rattachement (T6F, T6E, autre traitement :
 *     anomalie d'attribution) ;
 *   · causes d'échec EVALUATE (états durables) et FORMULATE (journal).
 * Sert la recette avant / après en préproduction (BO, lien JSON).
 */
type Row = Record<string, unknown>;
export type T6ReportQuery = (sql: string, params?: unknown[]) => Promise<Row[]>;

export interface T6EfficiencyReport {
  period: { from: string; to: string };
  formulate: {
    calls: number; failedCalls: number; inputTokens: number; outputTokens: number;
    /** Coût figé connu (micro-unités) ; null : au moins un appel sans coût — non calculable. */
    costMicros: number | null; billableCalls: number;
    bySourceCode: Array<{ sourceCode: string; calls: number; inputTokens: number; outputTokens: number }>;
  };
  identicalToFallback: { generations: number; subjects: number; identicalSubjects: number; rate: number | null; generationsAllIdentical: number };
  avoided: { deterministicContexts: number; displaysServed: number; bySourceCode: Array<{ sourceCode: string; contexts: number }> };
  duplicates: { generationPairs: number; reservationRefusals: number; reservationTakeovers: number };
  attribution: Array<{ operation: string; execution: string; calls: number }>;
  errors: { evaluate: Array<{ status: string; kind: string; count: number }>; formulate: Array<{ kind: string; count: number }> };
  /** Tables optionnelles absentes (migration non appliquée) : mesure partielle, jamais inventée. */
  missing: string[];
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));

export async function t6EfficiencyReport(q: T6ReportQuery, p: { from: Date; to: Date }): Promise<T6EfficiencyReport> {
  const per = [p.from.toISOString(), p.to.toISOString()];
  const [t] = await q(`SELECT to_regclass('t6_formulate_reservations') IS NOT NULL AS res, to_regclass('t6_evaluation_runs') IS NOT NULL AS runs,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_usage_event' AND column_name = 'business_execution_id') AS bex`);
  const missing: string[] = [];
  if (!t?.res) missing.push('t6_formulate_reservations');
  if (!t?.runs) missing.push('t6_evaluation_runs');
  if (!t?.bex) missing.push('ai_usage_event.business_execution_id');

  const [f] = await q(
    `SELECT count(*)::int AS calls, count(*) FILTER (WHERE status <> 'success')::int AS failed,
            coalesce(sum(input_tokens), 0)::bigint AS tin, coalesce(sum(output_tokens), 0)::bigint AS tout,
            CASE WHEN bool_or(cost_micros IS NULL) THEN NULL ELSE coalesce(sum(cost_micros), 0)::bigint END AS cost,
            count(*) FILTER (WHERE is_billable)::int AS billable
       FROM ai_usage_event WHERE operation_type = 't6_formulate' AND created_at >= $1 AND created_at < $2`, per);
  // Code de signal : entrée transmise (journal des générations, même trace) ; sans ligne : « inconnu ».
  const parCode = await q(
    `WITH appels AS (
       SELECT e.id, coalesce(e.input_tokens, 0) AS tin, coalesce(e.output_tokens, 0) AS tout,
              (SELECT array_agg(DISTINCT s->>'sourceCode') FROM home_mascot_generations g, jsonb_array_elements(coalesce(g.input_json->'subjects', '[]'::jsonb)) s
                WHERE g.trace_id = e.metadata->>'traceId' AND g.account_id = e.account_id) AS codes
         FROM ai_usage_event e WHERE e.operation_type = 't6_formulate' AND e.created_at >= $1 AND e.created_at < $2)
     SELECT coalesce(array_to_string(codes, '+'), 'inconnu') AS code, count(*)::int AS calls, sum(tin)::bigint AS tin, sum(tout)::bigint AS tout
       FROM appels GROUP BY 1 ORDER BY 2 DESC`, per);
  const [id] = await q(
    `WITH g AS (
       SELECT g.id, s.ord, s.v->>'fallbackText' AS fb, g.output_json->'messages'->((s.ord - 1)::int)->>'text' AS txt
         FROM home_mascot_generations g, jsonb_array_elements(coalesce(g.input_json->'subjects', '[]'::jsonb)) WITH ORDINALITY AS s(v, ord)
        WHERE g.status = 'generated' AND g.created_at >= $1 AND g.created_at < $2)
     SELECT count(DISTINCT id)::int AS gens, count(*)::int AS subjects,
            count(*) FILTER (WHERE regexp_replace(trim(txt), '\\s+', ' ', 'g') = regexp_replace(trim(fb), '\\s+', ' ', 'g'))::int AS same,
            (SELECT count(*)::int FROM (SELECT id FROM g GROUP BY id
               HAVING bool_and(regexp_replace(trim(txt), '\\s+', ' ', 'g') = regexp_replace(trim(fb), '\\s+', ' ', 'g'))) x) AS all_same
       FROM g`, per);
  const avoided = t?.res ? await q(
    `SELECT coalesce(array_to_string(source_codes, '+'), 'inconnu') AS code, count(*)::int AS contexts, coalesce(sum(hits), 0)::int AS hits
       FROM t6_formulate_reservations WHERE status = 'DETERMINISTIC' AND created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 2 DESC`, per) : [];
  const [dup] = await q(
    `SELECT count(*)::int AS pairs FROM home_mascot_generations a JOIN home_mascot_generations b
         ON b.account_id = a.account_id AND b.id > a.id AND b.status = 'generated' AND b.trace_id IS DISTINCT FROM a.trace_id
        AND md5(b.input_json::text) = md5(a.input_json::text) AND b.created_at - a.created_at < INTERVAL '2 minutes'
      WHERE a.status = 'generated' AND a.input_json IS NOT NULL AND a.created_at >= $1 AND a.created_at < $2`, per);
  const [res] = t?.res ? await q(
    `SELECT coalesce(sum(contended), 0)::int AS refus, coalesce(sum(GREATEST(attempts - 1, 0)) FILTER (WHERE status <> 'DETERMINISTIC'), 0)::int AS reprises
       FROM t6_formulate_reservations WHERE updated_at >= $1 AND created_at < $2`, per) : [{}];
  const attribution = t?.bex ? await q(
    `SELECT operation_type AS op, coalesce(split_part(business_execution_id, ':', 1), CASE WHEN metadata ? 'businessExecutionIds' THEN 'T6E (groupé)' ELSE 'aucune' END) AS ex, count(*)::int AS calls
       FROM ai_usage_event WHERE operation_type IN ('t6_formulate', 't6_evaluate') AND created_at >= $1 AND created_at < $2 GROUP BY 1, 2 ORDER BY 1, 2`, per) : [];
  const evalErr = t?.runs ? await q(
    `SELECT status, coalesce(last_error_kind, 'aucune') AS kind, count(*)::int AS c FROM t6_evaluation_runs
      WHERE status IN ('FAILED', 'RETRY_WAIT', 'UNAVAILABLE') AND updated_at >= $1 AND updated_at < $2 GROUP BY 1, 2 ORDER BY 3 DESC`, per) : [];
  const formErr = await q(
    `SELECT coalesce(substring(error FROM '^\\[([a-z_]+)\\]'), status) AS kind, count(*)::int AS c FROM home_mascot_generations
      WHERE status IN ('error', 'validation_failed') AND created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 2 DESC`, per);

  const subjects = n(id?.subjects);
  return {
    period: { from: per[0], to: per[1] },
    formulate: {
      calls: n(f?.calls), failedCalls: n(f?.failed), inputTokens: n(f?.tin), outputTokens: n(f?.tout),
      costMicros: f?.cost == null ? null : n(f.cost), billableCalls: n(f?.billable),
      bySourceCode: parCode.map((r) => ({ sourceCode: String(r.code), calls: n(r.calls), inputTokens: n(r.tin), outputTokens: n(r.tout) })),
    },
    identicalToFallback: {
      generations: n(id?.gens), subjects, identicalSubjects: n(id?.same), rate: subjects ? Math.round((n(id?.same) / subjects) * 1000) / 1000 : null,
      generationsAllIdentical: n(id?.all_same),
    },
    avoided: {
      deterministicContexts: avoided.reduce((a, r) => a + n(r.contexts), 0), displaysServed: avoided.reduce((a, r) => a + n(r.hits), 0),
      bySourceCode: avoided.map((r) => ({ sourceCode: String(r.code), contexts: n(r.contexts) })),
    },
    duplicates: { generationPairs: n(dup?.pairs), reservationRefusals: n(res?.refus), reservationTakeovers: n(res?.reprises) },
    attribution: attribution.map((r) => ({ operation: String(r.op), execution: String(r.ex), calls: n(r.calls) })),
    errors: {
      evaluate: evalErr.map((r) => ({ status: String(r.status), kind: String(r.kind), count: n(r.c) })),
      formulate: formErr.map((r) => ({ kind: String(r.kind), count: n(r.c) })),
    },
    missing,
  };
}
