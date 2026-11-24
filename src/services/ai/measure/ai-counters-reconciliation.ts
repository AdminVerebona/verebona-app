/**
 * Carte #828 (écart B) — requêtes de RÉCONCILIATION des compteurs IA, en LECTURE SEULE.
 *
 * Trois nombres ne sont jamais interchangeables :
 *   1. les requêtes réseau réellement émises (mesure de la passerelle, portée par le passage :
 *      `provider_calls` quand `ai_counters_semantics = 'MEASURED_V1'`, détail dans `ai_activity`) ;
 *   2. les événements d'usage CONSTATÉS par la passerelle (`ai_activity.total.usageEvents`) ;
 *   3. les lignes durablement écrites dans `ai_usage_event` (dont `metadata.networkRequests`).
 * Ils se concilient par les identifiants de trace du relevé (`ai_activity.traceIds`) :
 *
 *   requêtes du passage − requêtes des événements NON enregistrés = Σ metadata.networkRequests des lignes
 *   événements constatés − événements NON enregistrés             = nombre de lignes
 *
 * Un écart non nul est une anomalie de comptage. Un passage dont les traces sont tronquées (plus de 500) ou
 * sans mesure (`DECLARED`, historique) n'est PAS réconciliable par cette voie : il est dit tel, jamais forcé.
 *
 * Ces textes sont ceux de la fiche de recette 117C : le scénario C828-E2E les exécute tels quels (un total qui
 * diverge fait échouer le test).
 */

type RunTable = 'account_reconciliation_runs' | 'reconciliation_runs';

/**
 * Réconciliation passage ↔ événements d'usage. `$1` : identifiant du compte ; `$2` : nombre de passages (les plus
 * récents). Une ligne par passage MESURÉ ; `ecart_requetes` et `ecart_evenements` doivent valoir 0.
 */
export function runCountersReconciliationSql(table: RunTable): string {
  return `SELECT r.id AS run_id, r.status, r.ai_counters_semantics AS semantique,
       r.provider_calls AS requetes_du_passage,
       coalesce((r.ai_activity->'total'->>'logicalRequests')::int, 0) AS demandes_logiques,
       coalesce((r.ai_activity->'total'->>'providerAttempts')::int, 0) + coalesce((r.ai_activity->'total'->>'repairAttempts')::int, 0) AS tentatives,
       coalesce((r.ai_activity->'total'->>'usageEvents')::int, 0) AS evenements_constates,
       coalesce((r.ai_activity->'total'->>'usageEventsNotPersisted')::int, 0) AS evenements_non_enregistres,
       coalesce((r.ai_activity->'total'->>'networkRequestsNotPersisted')::int, 0) AS requetes_non_enregistrees,
       coalesce((r.ai_activity->>'traceIdsTruncated')::boolean, false) AS traces_tronquees,
       e.evenements AS evenements_enregistres, e.requetes AS requetes_des_evenements,
       r.provider_calls - coalesce((r.ai_activity->'total'->>'networkRequestsNotPersisted')::int, 0) - e.requetes AS ecart_requetes,
       coalesce((r.ai_activity->'total'->>'usageEvents')::int, 0)
         - coalesce((r.ai_activity->'total'->>'usageEventsNotPersisted')::int, 0) - e.evenements AS ecart_evenements
  FROM ${table} r
 CROSS JOIN LATERAL (
       SELECT count(*)::int AS evenements,
              coalesce(sum(CASE WHEN jsonb_typeof(u.metadata->'networkRequests') = 'number'
                                THEN (u.metadata->>'networkRequests')::int ELSE 0 END), 0)::int AS requetes
         FROM ai_usage_event u
        WHERE u.created_at >= r.started_at - interval '5 minutes'
          AND u.metadata->>'traceId' IN (SELECT jsonb_array_elements_text(coalesce(r.ai_activity->'traceIds', '[]'::jsonb)))
     ) e
 WHERE r.account_id = $1 AND r.ai_counters_semantics = 'MEASURED_V1' AND r.provider_calls IS NOT NULL
 ORDER BY r.id DESC LIMIT $2`;
}

/**
 * Passages T3 d'un compte par NATURE du compteur d'appels (`$1` : compte). Seule la nature `MEASURED` entre dans
 * « appels réels = 0 / > 0 » ; `DECLARED` et `UNKNOWN` (historique) sont comptés à part, jamais comme zéro.
 */
export const RUNS_BY_COUNTER_NATURE_SQL = `SELECT
       CASE WHEN r.ai_counters_semantics = 'MEASURED_V1' AND r.provider_calls IS NOT NULL THEN 'MEASURED'
            WHEN r.ai_counters_semantics = 'DECLARED' THEN 'DECLARED'
            ELSE 'UNKNOWN' END AS nature,
       count(*)::int AS passages,
       count(*) FILTER (WHERE r.ai_counters_semantics = 'MEASURED_V1' AND r.provider_calls = 0)::int AS sans_appel_prouve,
       count(*) FILTER (WHERE r.ai_counters_semantics = 'MEASURED_V1' AND r.provider_calls > 0)::int AS avec_appel_prouve,
       count(*) FILTER (WHERE r.ai_counters_semantics IS NULL AND r.provider_calls IS NOT NULL)::int AS valeur_d_origine_conservee,
       coalesce(sum(r.ai_requests_declared) FILTER (WHERE r.ai_counters_semantics = 'DECLARED'), 0)::int AS demandes_declarees,
       min(r.started_at) AS premier, max(r.started_at) AS dernier
  FROM account_reconciliation_runs r
 WHERE r.account_id = $1 AND r.status IN ('completed', 'partial')
 GROUP BY 1 ORDER BY 1`;

/**
 * Pertes de persistance d'événements d'usage (toutes instances, `$1` : nombre de jours) : compteur durable par
 * jour, compte et opération (écrit au mieux : si la base était indisponible, seuls le journal applicatif et la
 * mesure du passage en gardent la trace).
 */
export const USAGE_EVENT_LOSSES_SQL = `SELECT d.day AS jour, d.account_id, d.treatment, d.operation_code, sum(d.count)::int AS evenements_perdus,
       max(d.technical_code) AS code_technique, min(d.first_at) AS premier, max(d.last_at) AS dernier
  FROM ai_degraded_events d
 WHERE d.component = 'USAGE_JOURNAL' AND d.day >= (now() AT TIME ZONE 'Europe/Paris')::date - $1::int
 GROUP BY 1, 2, 3, 4 ORDER BY 1 DESC, 5 DESC`;

/**
 * Captures d'échange SANS événement d'usage rattaché (`$1` : compte, `$2` : nombre de jours) : la trace de
 * rapprochement d'un événement perdu, quand la capture des appels est active.
 */
export const ORPHAN_CAPTURES_SQL = `SELECT c.id, c.captured_at, c.trace_id, c.operation_code, c.model, c.model_rank,
       jsonb_array_length(coalesce(c.provider_steps, '[]'::jsonb)) AS requetes_capturees
  FROM ai_call_captures c
 WHERE c.account_id = $1 AND c.usage_event_id IS NULL AND c.captured_at >= now() - ($2 || ' days')::interval
 ORDER BY c.id DESC LIMIT 200`;

/**
 * Budget commun des appels émis SANS protection (écart A ; `$1` : nombre d'heures) : par heure et par portée,
 * appels admis et appels refusés avant contact — le volume réel, toutes instances.
 */
export const DEGRADED_BUDGET_SQL = `SELECT b.hour_start AS heure, b.treatment, b.operation_code, b.account_id, b.admitted AS admis, b.refused AS refuses,
       b.first_at AS premier, b.last_at AS dernier
  FROM ai_degraded_call_budget b
 WHERE b.hour_start >= now() - ($1 || ' hours')::interval
 ORDER BY b.hour_start DESC, b.admitted + b.refused DESC LIMIT 200`;

/**
 * Passages en mode dégradé (écart A ; `$1` : nombre de jours) : composant, raison, effet, volume — dont les
 * contournements d'urgence (`DISABLED_BY_CONFIG`) avec leur première et leur dernière observation.
 */
export const DEGRADED_EVENTS_SQL = `SELECT d.component, d.reason, d.impact, d.treatment, d.operation_code,
       count(DISTINCT coalesce(d.account_id, 0))::int AS comptes, sum(d.count)::int AS occurrences,
       max(d.technical_code) AS code_technique, min(d.first_at) AS premier, max(d.last_at) AS dernier
  FROM ai_degraded_events d
 WHERE d.day >= (now() AT TIME ZONE 'Europe/Paris')::date - $1::int
 GROUP BY 1, 2, 3, 4, 5 ORDER BY max(d.last_at) DESC`;

/** État du cache des réponses (écart C ; aucune clé métier lue : comptes par état seulement). */
export const RESPONSE_CACHE_STATE_SQL = `SELECT state, (expires_at > now()) AS vivant, count(*)::int AS lignes,
       coalesce(sum(hit_count), 0)::int AS reponses_servies, coalesce(sum(renewed_count), 0)::int AS renouvellements,
       min(created_at) AS plus_ancienne, max(created_at) AS plus_recente
  FROM ai_operation_idempotency
 WHERE key_hash NOT LIKE 'help-corpus:%' AND key_hash NOT LIKE 'resources-corpus:%'
 GROUP BY 1, 2 ORDER BY 1, 2`;

/** Migrations exigées avant la mise en production (R14) : une ligne par fichier attendu. */
export const REQUIRED_MIGRATIONS_SQL = `SELECT filename, applied_at FROM _migrations
 WHERE filename ~ '^(0856|0857|0858|0859|1860|1861|1940)_' ORDER BY filename`;

export interface RunReconciliationRow {
  run_id: number; status: string; semantique: string; requetes_du_passage: number; demandes_logiques: number; tentatives: number;
  evenements_constates: number; evenements_non_enregistres: number; requetes_non_enregistrees: number; traces_tronquees: boolean;
  evenements_enregistres: number; requetes_des_evenements: number; ecart_requetes: number; ecart_evenements: number;
}

type Query = (text: string, params?: unknown[]) => Promise<unknown>;

/** Exécute la réconciliation (lecture seule) et rend les passages qui DIVERGENT — hors traces tronquées, dites à part. */
export async function reconcileRunCounters(q: Query, table: RunTable, accountId: number, limit = 50): Promise<{
  rows: RunReconciliationRow[]; diverging: RunReconciliationRow[]; notReconcilable: RunReconciliationRow[];
}> {
  const rows = (await q(runCountersReconciliationSql(table), [accountId, limit])) as RunReconciliationRow[];
  const ok = (r: RunReconciliationRow) => Number(r.ecart_requetes) === 0 && Number(r.ecart_evenements) === 0;
  return {
    rows,
    diverging: rows.filter((r) => !r.traces_tronquees && !ok(r)),
    notReconcilable: rows.filter((r) => r.traces_tronquees),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Écart D — requêtes de la recette de préproduction (R12, R13), lecture seule
// ══════════════════════════════════════════════════════════════════════════

/**
 * R13 — événements d'usage T3 d'une fenêtre (`$1` début, `$2` fin, horodatages avec fuseau) par branche,
 * déclencheur, compte, modèle et rang, nature de l'appel, statut et NATURE DE LA MESURE :
 *   · MESUREE              la ligne porte `metadata.networkRequests` (carte #811) ;
 *   · PROUVEE_PAR_REPONSE  ligne antérieure à la mesure, mais une réponse ou une consommation prouve UNE requête ;
 *   · INDETERMINEE         ligne antérieure, en erreur et sans jeton : envoi non prouvable — ni comptée, ni exclue.
 * Un événement n'est pas un appel ; un appel répété n'est pas un doublon tant que sa cause n'est pas établie.
 */
export const R13_USAGE_EVENTS_SQL = `SELECT (u.created_at AT TIME ZONE 'Europe/Paris')::date AS jour, u.operation_code AS branche,
       coalesce(u.metadata->>'trigger', q.trigger_code, '(aucun)') AS declencheur, u.account_id, u.model, u.model_rank,
       coalesce(u.metadata->>'callKind', 'analysis') AS nature_appel, u.status,
       CASE WHEN jsonb_typeof(u.metadata->'networkRequests') = 'number' THEN 'MESUREE'
            WHEN u.status = 'success' OR coalesce(u.input_tokens, 0) + coalesce(u.output_tokens, 0) > 0 THEN 'PROUVEE_PAR_REPONSE'
            ELSE 'INDETERMINEE' END AS nature_mesure,
       count(*)::int AS evenements, count(DISTINCT u.job_id)::int AS travaux,
       count(DISTINCT u.metadata->>'traceId')::int AS demandes_logiques,
       coalesce(sum(CASE WHEN jsonb_typeof(u.metadata->'networkRequests') = 'number' THEN (u.metadata->>'networkRequests')::int END), 0)::int AS requetes_mesurees,
       count(*) FILTER (WHERE jsonb_typeof(u.metadata->'jobAttempt') = 'number' AND (u.metadata->>'jobAttempt')::int > 1)::int AS pendant_une_reprise_du_travail,
       count(*) FILTER (WHERE u.is_fallback)::int AS en_repli,
       coalesce(sum(u.input_tokens), 0)::bigint AS jetons_entree, coalesce(sum(u.output_tokens), 0)::bigint AS jetons_sortie,
       round(coalesce(sum(u.cost_micros), 0) / 1e6, 4) AS cout_usd,
       count(*) FILTER (WHERE u.cost_micros IS NULL)::int AS cout_non_calcule
  FROM ai_usage_event u
  LEFT JOIN ai_job_queue q ON q.id = u.job_id
 WHERE u.use_case_code = 'DATA_RECONCILIATION' AND u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz
 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9 ORDER BY evenements DESC`;

/** R13 — cache et réutilisations des mêmes jours (`$1`, `$2` : dates), pour ne pas confondre réponse servie et appel. */
export const R13_REUSE_SQL = `SELECT day AS jour, treatment, operation_code, kind, sum(count)::int AS n
  FROM ai_reuse_counters WHERE day BETWEEN $1::date AND $2::date AND treatment = 'T3'
 GROUP BY 1, 2, 3, 4 ORDER BY 1, 3, 4`;

/** R12 — les données du cas historique existent-elles encore ? (`$1` compte, `$2` bien, `$3` preuve, `$4` travaux) */
export const R12_CASE_DATA_SQL = `SELECT 'bien' AS objet, a.id::text AS id, (a.deleted_at IS NULL) AS present, a.deleted_at::text AS detail
  FROM assets a WHERE a.id = $2 AND a.account_id = $1
UNION ALL
SELECT 'preuve', e.id::text, true, e.field_key || ' / ' || coalesce(e.canonical_key, '—') || ' / ' || coalesce(e.lifecycle_status::text, '—')
  FROM field_evidence e WHERE e.id = $3 AND e.account_id = $1
UNION ALL
SELECT 'travail', j.id::text, true, j.status::text || ' / ' || coalesce(j.trigger_code, '—') || ' / ' || j.created_at::text
  FROM ai_job_queue j WHERE j.id = ANY($4::int[]) AND j.account_id = $1
ORDER BY 1, 2`;

/** R12 — mémoire des décisions du champ (`$1` compte, `$2` bien, `$3` motif de clé, ex. '%constructionYear%'). */
export const R12_DECISION_MEMORY_SQL = `SELECT id, status, outcome, ai_source, reuse_count, last_reused_at, created_at, superseded_at, superseded_reason, forced
  FROM t3_decision_memory
 WHERE account_id = $1 AND asset_id = $2 AND field_key ILIKE $3 ORDER BY id`;

/** R12 — arbitrage du champ : une seule ligne, non réécrite ? (`$1` compte, `$2` bien, `$3` motif de clé) */
export const R12_ARBITRATION_SQL = `SELECT id, status, created_at, updated_at FROM inconsistency_registry
 WHERE account_id = $1 AND asset_id = $2 AND field_key ILIKE $3 ORDER BY id`;

/** R12 — appels de l'arbitrage sur le compte, par jour (`$1` compte) : lignes, requêtes mesurées, lignes sans mesure, coût. */
export const R12_CALLS_BY_DAY_SQL = `SELECT (created_at AT TIME ZONE 'Europe/Paris')::date AS jour, count(*)::int AS evenements,
       coalesce(sum(CASE WHEN jsonb_typeof(metadata->'networkRequests') = 'number' THEN (metadata->>'networkRequests')::int END), 0)::int AS requetes_mesurees,
       count(*) FILTER (WHERE NOT (metadata ? 'networkRequests'))::int AS evenements_sans_mesure,
       round(coalesce(sum(cost_micros), 0) / 1e6, 4) AS cout_usd
  FROM ai_usage_event
 WHERE account_id = $1 AND operation_code = 't3_value_conflict'
 GROUP BY 1 ORDER BY 1`;
