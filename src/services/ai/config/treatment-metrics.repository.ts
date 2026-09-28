/**
 * Indicateurs de supervision par traitement — CDC BO IA SCR-02 à SCR-06.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST MESURÉ L'EST VRAIMENT, LE RESTE LE DIT
 *
 * Chaque écran de traitement demande des indicateurs précis. Certains se
 * calculent à partir de ce que l'application enregistre déjà ; d'autres
 * supposeraient une instrumentation qui n'existe pas.
 *
 * Aucun chiffre n'est estimé. Un indicateur non mesurable rend `null` et
 * l'écran écrit « pas encore mesuré » — un zéro serait lu comme une absence de
 * problème, ce qui est exactement le contraire de la vérité.
 *
 * C'est la même règle que pour les coûts : un coût inconnu n'est pas un coût
 * nul.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FENÊTRE GLISSANTE, ET BORNÉE
 *
 * Trente jours par défaut. Le NFR-002 interdit de charger l'ensemble des
 * historiques sans filtre, et ces requêtes tournent à chaque ouverture d'un
 * onglet : elles doivent rester petites.
 */
import { pgClient } from '@/db';
import type { Treatment } from './treatments';

type Row = Record<string, unknown>;

/** Un indicateur. `value` à `null` signifie « pas encore mesuré ». */
export interface Metric {
  key: string;
  label: string;
  value: number | null;
  /** Unité d'affichage : brut, pourcentage, durée. */
  unit?: 'count' | 'percent' | 'ms' | 'usd_micros' | 'decimal';
  /** Pourquoi la mesure n'existe pas, le cas échéant. */
  missingReason?: string;
}

/** Liste de détail (drill-down) jointe aux indicateurs — ex. rechecks T2 (T2-UI-08). */
export interface MetricTable {
  key: string;
  label: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number | null>>;
}

export interface TreatmentMetrics {
  treatment: Treatment;
  windowDays: number;
  metrics: Metric[];
  tables?: MetricTable[];
}

/**
 * Construit un indicateur.
 *
 * ⚠️ Une valeur nulle SANS raison affiche un tiret que personne ne sait
 * interpréter : donnée absente, mesure impossible, ou incident ? Le défaut par
 * défaut couvre le cas le plus fréquent — il n'y a rien eu sur la période — et
 * une raison explicite le remplace quand la cause est autre.
 */
const M = (
  key: string, label: string, value: number | null,
  unit: Metric['unit'] = 'count', missingReason?: string,
): Metric => ({
  key,
  label,
  value,
  unit,
  missingReason: value === null
    ? (missingReason ?? 'Aucune donnée sur la période.')
    : undefined,
});

/**
 * Délai maximal accordé à une requête d'indicateur.
 *
 * Ces requêtes tournent à l'ouverture d'un onglet de configuration. Sans borne,
 * une base lente ferait attendre l'écran entier pour un complément d'affichage
 * — l'administrateur ne pourrait plus corriger un prompt parce que la
 * supervision rame.
 */
const QUERY_TIMEOUT_MS = 3_000;

type QueryRunner = (sql: string, params: unknown[]) => Promise<Row[]>;
let injectedRunner: QueryRunner | null = null;

/** Remplace l'exécution des requêtes — réservé aux tests. */
export function setMetricsQueryRunner(r: QueryRunner | null): void {
  injectedRunner = r;
}

async function many(sql: string, params: unknown[] = []): Promise<Row[]> {
  if (injectedRunner) return injectedRunner(sql, params);
  // Les tests unitaires n'ouvrent aucune connexion : attendre la borne à chaque
  // requête ajouterait des secondes pour une valeur qui n'existe pas. Même
  // convention que `telemetry/execution-context`.
  if (process.env.NODE_ENV === 'test') return [];

  const rows = await Promise.race([
    pgClient.unsafe(sql, params as never[]),
    new Promise<[]>((resolve) => setTimeout(() => resolve([]), QUERY_TIMEOUT_MS).unref?.()),
  ]);
  return rows as unknown as Row[];
}

async function one(sql: string, params: unknown[] = []): Promise<Row> {
  return (await many(sql, params))[0] ?? {};
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Coûts et replis d'un traitement, lus dans `ai_usage_event` (figés à
 * l'appel, jamais recalculés). Le métier et le technique restent séparés
 * (OPS-026) ; les sondes du disjoncteur sont techniques.
 */
async function costMetrics(useCaseCode: string, days: number): Promise<{ metrics: Metric[]; row: Row }> {
  const r = await one(
    `SELECT COUNT(*) FILTER (WHERE operation_type <> 'circuit_breaker_probe')::int AS calls,
            COALESCE(SUM(cost_micros) FILTER (WHERE is_billable), 0)::bigint      AS functional,
            COALESCE(SUM(cost_micros) FILTER (WHERE NOT is_billable), 0)::bigint  AS technical,
            COUNT(*) FILTER (WHERE status = 'success' AND operation_type <> 'circuit_breaker_probe')::int AS ok,
            COUNT(*) FILTER (WHERE status = 'success' AND operation_type <> 'circuit_breaker_probe'
                             AND (model_rank IN ('fallback_1', 'fallback_2') OR is_fallback))::int AS fallbacks
       FROM ai_usage_event
      WHERE use_case_code = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
    [useCaseCode, String(days)],
  ).catch((): Row => ({}));
  const ok = Number(r.ok ?? 0);
  return {
    row: r,
    metrics: [
      M('cost', 'Coût IA (métier)', num(r.functional) ?? 0, 'usd_micros'),
      M('technical_cost', 'Coût technique (sondes, tests)', num(r.technical) ?? 0, 'usd_micros'),
      M('fallback_rate', 'Taux de repli modèle', ok > 0 ? Math.round((Number(r.fallbacks ?? 0) / ok) * 100) : null,
        'percent', ok === 0 ? 'Aucun appel réussi sur la période.' : undefined),
    ],
  };
}

/** T1 — qualité d'extraction (SCR-02, T1-UI-10, T1-UI-11, T1-025). */
async function metricsT1(days: number): Promise<Metric[]> {
  const r = await one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS echecs,
            (AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)
               FILTER (WHERE finished_at IS NOT NULL))::int AS duree
       FROM document_analysis_runs
      WHERE started_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );

  // T1-025 / T1-UI-10 : les rechecks ciblés de T2 posent un signal de lacune
  // T1 (`t1_quality_signals`) ; la revalidation elle-même est tracée dans
  // `verebona_fact_revalidations`, reliée au signal par `signal_id`.
  const gaps = await one(
    `SELECT (SELECT COUNT(*) FROM t1_quality_signals
              WHERE created_at >= NOW() - ($1 || ' days')::interval)::int AS signaux,
            (SELECT COUNT(*) FROM verebona_fact_revalidations
              WHERE created_at >= NOW() - ($1 || ' days')::interval)::int AS rechecks,
            (SELECT COUNT(*) FROM verebona_fact_revalidations
              WHERE signal_id IS NOT NULL AND created_at >= NOW() - ($1 || ' days')::interval)::int AS rechecks_lacune`,
    [String(days)],
  ).catch((): Row => ({}));

  const total = Number(r.total ?? 0);
  const echecs = Number(r.echecs ?? 0);
  const cost = await costMetrics('SOURCE_ANALYSIS', days);

  return [
    M('runs', 'Analyses lancées', total),
    M('failed', 'Analyses en échec', echecs),
    // Un zéro d'échec sur zéro analyse ne veut rien dire : le taux reste non
    // mesuré plutôt que d'afficher 0 %, qui se lirait « tout va bien ».
    M('failure_rate', "Taux d'échec", total > 0 ? Math.round((echecs / total) * 100) : null,
      'percent', total === 0 ? 'Aucune analyse sur la période.' : undefined),
    M('duration', 'Durée moyenne d\'analyse', num(r.duree), 'ms'),
    ...cost.metrics,
    M('t1_gaps', 'Lacunes T1 signalées', num(gaps.signaux) ?? 0),
    M('t2_rechecks', 'Rechecks T2 sur lacune T1', num(gaps.rechecks_lacune) ?? 0),
  ];
}

/** T2 — cascade, conversations, actions (SCR-03). */
async function metricsT2(days: number): Promise<Metric[]> {
  const fenetre = `created_at >= NOW() - ('${days}' || ' days')::interval`;

  const runs = await one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE mode = 'ai')::int            AS ia,
            COUNT(*) FILTER (WHERE mode <> 'ai')::int           AS deterministe,
            AVG(latency_ms)::int                                AS latence,
            COUNT(*) FILTER (WHERE status = 'error')::int       AS erreurs
       FROM verebona_request_runs WHERE ${fenetre}`,
  );

  const total = Number(runs.total ?? 0);
  const ia = Number(runs.ia ?? 0);

  // CDC Assistant §32.2 : latence p50 / p95 / p99, taux de réparation,
  // d'escalade, d'actions invalides et de cache — lus dans la trace de chaque
  // demande (`retrieval_methods_json` : aiCalls, aiEvents, securityEvents).
  const qualite = await one(
    `SELECT percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms)::int AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)::int AS p99,
            COUNT(*) FILTER (WHERE COALESCE((retrieval_methods_json->>'aiCalls')::int, 0) > 0)::int AS avec_ia,
            COUNT(*) FILTER (WHERE ${EVENEMENT_IA("'REPAIR:%'")})::int     AS reparees,
            COUNT(*) FILTER (WHERE ${EVENEMENT_IA("'ESCALATION:%'")})::int AS escaladees,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements(${TABLEAU_JSON("retrieval_methods_json->'securityEvents'")}) ev
               WHERE ev->>'code' = 'MODEL_ACTION_REJECTED'))::int             AS actions_invalides,
            COUNT(*) FILTER (WHERE cache_hit)::int                           AS cache
       FROM verebona_request_runs WHERE ${fenetre} AND status <> 'pending'`,
  ).catch((): Row => ({}));
  const avecIa = Number(qualite.avec_ia ?? 0);
  const tauxIa = (n: unknown): number | null => (avecIa > 0 ? Math.round((Number(n ?? 0) / avecIa) * 1000) / 10 : null);
  const sansIa = 'Aucune demande avec appel modèle sur la période.';

  // La cascade : part des demandes ayant atteint chaque niveau. Lue dans
  // `retrieval_methods_json`, que le pipeline remplit à chaque exécution.
  const cascade = await one(
    // Lecture ciblée de `levelsReached` (tableau JSON) : un ILIKE sur le
    // JSON entier comptait aussi les noms de stratégie (« structured.… »)
    // et les tentatives non applicables.
    `SELECT COUNT(*) FILTER (WHERE jsonb_exists(retrieval_methods_json->'levelsReached', 'structured'))::int AS bdd,
            COUNT(*) FILTER (WHERE jsonb_exists(retrieval_methods_json->'levelsReached', 'fulltext'))::int   AS texte,
            COUNT(*) FILTER (WHERE jsonb_exists(retrieval_methods_json->'levelsReached', 'semantic'))::int   AS semantique,
            COUNT(*) FILTER (WHERE jsonb_exists(retrieval_methods_json->'levelsReached', 'llm'))::int        AS modele
       FROM verebona_request_runs WHERE ${fenetre}`,
  );

  const pct = (n: unknown): number | null =>
    total > 0 ? Math.round((Number(n ?? 0) / total) * 100) : null;

  const actions = await one(
    `SELECT COUNT(*)::int AS total FROM verebona_message_actions WHERE ${fenetre}`,
  ).catch((): Row => ({}));

  // T2-UI-09 : volumes, expiration, purge — jamais le contenu.
  const conversations = await one(
    `SELECT COUNT(*) FILTER (WHERE ${fenetre})::int                         AS ouvertes,
            COUNT(*) FILTER (WHERE status = 'active')::int                  AS actives,
            COUNT(*) FILTER (WHERE expires_at <= NOW() + interval '7 days'
                             AND expires_at > NOW())::int                   AS expirent,
            COUNT(*) FILTER (WHERE expires_at <= NOW())::int                AS a_purger
       FROM verebona_conversations`,
  ).catch((): Row => ({}));

  // T2-UI-10 : commandes — succès, échecs, annulations, plans.
  // `UNDONE` (T2-038 / T2-039) : exécuté PUIS annulé par l'utilisateur dans
  // les 15 minutes. Compté à part — ni succès (l'effet a été défait), ni
  // abandon (il y a eu exécution) — pour que les états se somment au total.
  const commandes = await one(
    `SELECT COUNT(*)::int                                                   AS plans,
            COUNT(*) FILTER (WHERE status = 'EXECUTED')::int                AS succes,
            COUNT(*) FILTER (WHERE status IN ('FAILED', 'PARTIAL'))::int    AS echecs,
            COUNT(*) FILTER (WHERE status IN ('CANCELLED', 'REFUSED', 'EXPIRED'))::int AS abandons,
            COUNT(*) FILTER (WHERE status = 'UNDONE')::int                  AS annules
       FROM verebona_command_plans WHERE ${fenetre}`,
  ).catch((): Row => ({}));

  // T2-UI-06 / T2-UI-07 : coût et appels moyens par requête TOTALE — une
  // réponse déterministe compte pour zéro appel et zéro coût.
  const cost = await costMetrics('INTELLIGENT_ASSISTANT', days);
  const calls = Number(cost.row.calls ?? 0);
  const functional = Number(cost.row.functional ?? 0);
  const parRequete = (v: number): number | null => (total > 0 ? Math.round((v / total) * 100) / 100 : null);

  // T2-UI-08 : rechecks ciblés (source, fait, résultat, coût).
  const rechecks = await one(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(cost_micros), 0)::bigint AS cout
       FROM verebona_fact_revalidations WHERE ${fenetre}`,
  ).catch((): Row => ({}));

  return [
    M('requests', 'Demandes traitées', total),
    M('ai_share', 'Part traitée par le modèle', pct(ia), 'percent'),
    M('deterministic_share', 'Part tranchée sans IA', pct(runs.deterministe), 'percent'),
    M('cascade_db', 'Niveau base structurée', pct(cascade.bdd), 'percent'),
    M('cascade_text', 'Niveau recherche textuelle', pct(cascade.texte), 'percent'),
    M('cascade_semantic', 'Niveau sémantique', pct(cascade.semantique), 'percent'),
    M('cascade_llm', 'Niveau modèle (LLM)', pct(cascade.modele), 'percent'),
    M('avg_cost', 'Coût moyen par requête', total > 0 ? Math.round(functional / total) : null, 'usd_micros'),
    M('avg_ai_cost', 'Coût moyen par requête avec IA', ia > 0 ? Math.round(functional / ia) : null, 'usd_micros',
      ia === 0 ? 'Aucune requête traitée par le modèle.' : undefined),
    M('avg_calls', 'Appels IA moyens par requête', parRequete(calls), 'decimal'),
    ...cost.metrics,
    M('latency', 'Latence moyenne', runs.latence == null ? null : Number(runs.latence), 'ms'),
    M('latency_p50', 'Latence p50', num(qualite.p50), 'ms'),
    M('latency_p95', 'Latence p95', num(qualite.p95), 'ms'),
    M('latency_p99', 'Latence p99', num(qualite.p99), 'ms'),
    M('repair_rate', 'Taux de réparation (sorties modèle)', tauxIa(qualite.reparees), 'percent', sansIa),
    M('escalation_rate', 'Taux d’escalade', tauxIa(qualite.escaladees), 'percent', sansIa),
    M('invalid_action_rate', 'Taux d’actions invalides (modèle)', tauxIa(qualite.actions_invalides), 'percent', sansIa),
    M('cache_hit_rate', 'Taux de cache (retrieval, réponses)', pct(qualite.cache), 'percent'),
    M('errors', 'Demandes en échec', Number(runs.erreurs ?? 0)),
    M('conversations', 'Conversations ouvertes', num(conversations.ouvertes)),
    M('conversations_active', 'Conversations actives', num(conversations.actives)),
    M('conversations_expiring', 'Conversations expirant sous 7 j', num(conversations.expirent)),
    M('conversations_to_purge', 'Conversations expirées à purger', num(conversations.a_purger)),
    M('actions', 'Actions proposées', actions.total == null ? null : Number(actions.total)),
    M('command_plans', 'Plans de commande', num(commandes.plans)),
    M('command_success', 'Commandes exécutées', num(commandes.succes)),
    M('command_failed', 'Commandes en échec / partielles', num(commandes.echecs)),
    M('command_abandoned', 'Plans refusés / expirés / abandonnés', num(commandes.abandons)),
    M('command_undone', 'Commandes exécutées puis annulées (« Annuler », 15 min)', num(commandes.annules)),
    M('rechecks', 'Rechecks ciblés', num(rechecks.total)),
    M('rechecks_cost', 'Coût des rechecks', num(rechecks.cout), 'usd_micros'),
  ];
}

/** Élément d'un tableau JSON de trace, en SQL (tableau absent ou mal formé : vide). */
const TABLEAU_JSON = (expr: string) => `CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END`;
/** La trace porte-t-elle un événement modèle correspondant au motif LIKE ? */
const EVENEMENT_IA = (motif: string) =>
  `EXISTS (SELECT 1 FROM jsonb_array_elements_text(${TABLEAU_JSON("retrieval_methods_json->'aiEvents'")}) e WHERE e LIKE ${motif})`;

/**
 * Motif d'une demande NON RÉSOLUE — CDC Assistant §32.5. Une demande résolue
 * (réponse soutenue, action, clarification levée…) n'a pas de motif.
 */
const MOTIF_NON_RESOLU_SQL = `CASE
    WHEN status = 'error' OR machine_final_state IN ('ERROR_FINAL', 'ERROR_RECOVERABLE') THEN 'incident'
    WHEN intent IN ('OUT_OF_SCOPE', 'SENSITIVE_ADVICE', 'UNSAFE_OR_MALICIOUS')
      OR retrieval_methods_json->'scope'->>'kind' IN ('FULLY_BLOCKED', 'AMBIGUOUS') THEN 'hors_perimetre'
    WHEN intent = 'UNSUPPORTED_ACTION' THEN 'action_non_supportee'
    WHEN machine_final_state = 'CLARIFYING' OR retrieval_methods_json->>'sufficiency' = 'AMBIGUOUS_TARGET' THEN 'ambiguite'
    WHEN intent IN ('PRODUCT_HELP_HOW_TO', 'PRODUCT_HELP_EXPLAIN', 'PRODUCT_HELP_STATUS', 'NAVIGATION_FIND', 'EXPORT_HELP')
      AND COALESCE(source_count, 0) = 0 THEN 'aide_absente'
    WHEN mode = 'fallback' OR retrieval_methods_json->>'answeredBy' = 'fallback' THEN 'aucune_donnee'
  END`;

/** Libellés des motifs du §32.5 (formulations anonymisées). */
export const MOTIFS_NON_RESOLUS: Record<string, string> = {
  aucune_donnee: 'Aucune donnée',
  ambiguite: 'Ambiguïté',
  aide_absente: 'Absence d’article d’aide',
  action_non_supportee: 'Action non supportée',
  incident: 'Incident technique',
  hors_perimetre: 'Demande hors périmètre',
};

/**
 * Demandes non résolues regroupées par intention et motif (§32.5) — des
 * comptes, JAMAIS le contenu des questions.
 */
async function unresolvedT2(days: number): Promise<MetricTable> {
  const rows = await many(
    `SELECT COALESCE(intent, 'UNKNOWN') AS intent, motif, COUNT(*)::int AS total
       FROM (SELECT intent, ${MOTIF_NON_RESOLU_SQL} AS motif
               FROM verebona_request_runs
              WHERE created_at >= NOW() - ($1 || ' days')::interval
                AND status NOT IN ('pending', 'cancelled')) d
      WHERE motif IS NOT NULL
      GROUP BY 1, 2
      ORDER BY total DESC, intent ASC
      LIMIT 30`,
    [String(days)],
  ).catch((): Row[] => []);
  return {
    key: 'unresolved',
    label: 'Demandes non résolues, par intention et motif',
    columns: [{ key: 'intent', label: 'Intention' }, { key: 'reason', label: 'Motif' }, { key: 'count', label: 'Demandes' }],
    rows: rows.map((r) => ({
      intent: String(r.intent),
      reason: MOTIFS_NON_RESOLUS[String(r.motif)] ?? String(r.motif),
      count: num(r.total),
    })),
  };
}

/** Derniers rechecks ciblés (T2-UI-08) : source, fait, résultat, coût — sans la question. */
async function tablesT2(days: number): Promise<MetricTable[]> {
  const rows = await many(
    `SELECT r.created_at, r.account_id, r.file_id, r.fact_key, r.trigger_reason, r.mode, r.status,
            r.ai_calls, r.cost_micros
       FROM verebona_fact_revalidations r
      WHERE r.created_at >= NOW() - ($1 || ' days')::interval
      ORDER BY r.created_at DESC LIMIT 20`,
    [String(days)],
  ).catch((): Row[] => []);
  const rechecks: MetricTable = {
    key: 'rechecks',
    label: 'Derniers rechecks ciblés',
    columns: [
      { key: 'date', label: 'Date' }, { key: 'account', label: 'Compte' }, { key: 'source', label: 'Source' },
      { key: 'fact', label: 'Fait' }, { key: 'trigger', label: 'Motif' }, { key: 'result', label: 'Résultat' },
      { key: 'calls', label: 'Appels' }, { key: 'cost', label: 'Coût (µ$)' },
    ],
    rows: rows.map((r) => ({
      date: r.created_at == null ? null : new Date(String(r.created_at)).toISOString(),
      account: num(r.account_id),
      source: r.file_id == null ? null : `Fichier ${r.file_id}`,
      fact: r.fact_key == null ? null : String(r.fact_key),
      trigger: r.trigger_reason == null ? null : String(r.trigger_reason),
      result: `${r.status ?? '—'} (${r.mode ?? '—'})`,
      calls: num(r.ai_calls),
      cost: num(r.cost_micros),
    })),
  };
  // §32.5 : demandes non résolues regroupées (intention × motif).
  return [rechecks, await unresolvedT2(days)];
}

/** Libellés des motifs de lacune T1 (`t1_quality_signals.problem`). */
const T1_GAP_LABELS: Record<string, string> = {
  MISSING: 'Information absente',
  POORLY_STRUCTURED: 'Mal structurée',
  LOW_CONFIDENCE: 'Confiance insuffisante',
  WEAK_EVIDENCE: 'Preuve insuffisante',
  CONFLICT: 'Conflit',
};

/** Résultat du recheck T2 lié au signal (`verebona_fact_revalidations.status`). */
const RECHECK_LABELS: Record<string, string> = {
  CONFIRMED: 'Confirmé',
  CORRECTED: 'Corrigé',
  NOT_FOUND: 'Introuvable',
  AMBIGUOUS: 'Ambigu',
  FAILED: 'Échec',
};

/**
 * Dernières lacunes T1 (T1-UI-10, SCR-02) : fichier, fait, motif, date, et
 * recheck T2 lié s'il existe. Ni la question posée ni le champ
 * `information` (issu de la conversation) : seulement des références.
 */
async function tablesT1(days: number): Promise<MetricTable[]> {
  const rows = await many(
    `SELECT s.id, s.created_at, s.account_id, s.file_id, s.fact_key, s.problem, s.t1_model,
            r.status AS recheck_status, r.mode AS recheck_mode
       FROM t1_quality_signals s
       LEFT JOIN LATERAL (
         SELECT v.status, v.mode FROM verebona_fact_revalidations v
          WHERE v.signal_id = s.id
          ORDER BY v.created_at DESC LIMIT 1
       ) r ON TRUE
      WHERE s.created_at >= NOW() - ($1 || ' days')::interval
      ORDER BY s.created_at DESC LIMIT 20`,
    [String(days)],
  ).catch((): Row[] => []);
  return [{
    key: 't1_gaps',
    label: 'Dernières lacunes T1 signalées',
    columns: [
      { key: 'date', label: 'Date' }, { key: 'account', label: 'Compte' }, { key: 'source', label: 'Fichier' },
      { key: 'fact', label: 'Fait' }, { key: 'problem', label: 'Motif' }, { key: 'model', label: 'Modèle T1' },
      { key: 'recheck', label: 'Recheck T2' },
    ],
    rows: rows.map((r) => ({
      date: r.created_at == null ? null : new Date(String(r.created_at)).toISOString(),
      account: num(r.account_id),
      source: r.file_id == null ? null : `Fichier ${r.file_id}`,
      fact: r.fact_key == null ? null : String(r.fact_key),
      problem: r.problem == null ? null : (T1_GAP_LABELS[String(r.problem)] ?? String(r.problem)),
      model: r.t1_model == null ? null : String(r.t1_model),
      recheck: r.recheck_status == null
        ? 'Aucun'
        : `${RECHECK_LABELS[String(r.recheck_status)] ?? String(r.recheck_status)}${r.recheck_mode ? ` (${r.recheck_mode})` : ''}`,
    })),
  }];
}

/** T3 — exécutions et conflits (SCR-04). */
async function metricsT3(days: number): Promise<Metric[]> {
  const r = await one(
    `SELECT COUNT(*)::int                                  AS runs,
            COUNT(DISTINCT account_id)::int                AS comptes,
            COALESCE(SUM(decisions_count), 0)::int         AS decisions,
            COALESCE(SUM(applied_count), 0)::int           AS appliquees,
            COALESCE(SUM(conflict_count), 0)::int          AS conflits,
            COUNT(*) FILTER (WHERE shadow)::int            AS observation
       FROM reconciliation_runs
      WHERE started_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  ).catch((): Row => ({}));

  return [
    M('runs', 'Exécutions', Number(r.runs ?? 0)),
    M('accounts', 'Comptes concernés', Number(r.comptes ?? 0)),
    M('decisions', 'Décisions produites', Number(r.decisions ?? 0)),
    // L'écart entre décisions et applications se lit d'un coup d'œil : en mode
    // observation il doit être total, et tout écart en mode actif signale un
    // refus de la matrice d'autorité.
    M('applied', 'Décisions appliquées', Number(r.appliquees ?? 0)),
    M('conflicts', 'Conflits détectés', Number(r.conflits ?? 0)),
    M('shadow_runs', 'Exécutions en observation', Number(r.observation ?? 0)),
    ...(await costMetrics('DATA_RECONCILIATION', days)).metrics,
  ];
}

/** T4 — cycle de vie des échéances (SCR-05). */
async function metricsT4(days: number): Promise<Metric[]> {
  const items = await one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_automatic)::int              AS automatiques,
            COUNT(*) FILTER (WHERE is_automatic_modified)::int     AS reprises,
            COUNT(*) FILTER (WHERE occurrence_nature = 'FORECAST')::int AS previsionnelles
       FROM agenda_items
      WHERE created_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  ).catch((): Row => ({}));

  // Confirmations : prévisions devenues CONFIRMED sur la période (0159).
  const confirmees = await one(
    `SELECT COUNT(*)::int AS total FROM agenda_items
      WHERE confirmed_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  ).catch((): Row => ({}));

  const conflits = await one(
    `SELECT COUNT(*)::int AS total FROM agenda_data_conflicts
      WHERE created_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  ).catch((): Row => ({}));

  // T4-UI-06 : consolidations — doublons certains (EXACT_DUPLICATE) venus
  // d'une autre source que l'échéance existante (`agenda-persistence#
  // recordConsolidation`). Compté par couple (échéance, fichier source) :
  // une trace rejouée ne gonfle pas l'indicateur.
  const consolidees = await one(
    `SELECT COUNT(DISTINCT (agenda_item_id, detail_json ->> 'sourceFileId'))::int AS total
       FROM agenda_occurrence_events
      WHERE event_type = 'DUPLICATE_CONSOLIDATED'
        AND detail_json ->> 'reasonCode' = 'EXACT_DUPLICATE'
        AND created_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  ).catch((): Row => ({}));

  // Rappels d'échéance envoyés (notifications DEADLINE_*).
  const rappels = await one(
    `SELECT COUNT(*)::int AS total FROM notifications
      WHERE type LIKE 'DEADLINE_%' AND created_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  ).catch((): Row => ({}));

  return [
    M('created', 'Échéances créées', Number(items.total ?? 0)),
    M('automatic', 'Créées automatiquement', Number(items.automatiques ?? 0)),
    // Une échéance automatique reprise à la main est le signal le plus direct
    // que le traitement se trompe : l'utilisateur a dû corriger.
    M('corrected', 'Automatiques corrigées ensuite', Number(items.reprises ?? 0)),
    M('consolidated', 'Consolidées (doublons rattachés)', num(consolidees.total) ?? 0),
    M('conflicts', 'Conflits à arbitrer', Number(conflits.total ?? 0)),
    M('forecast', 'Occurrences prévisionnelles', num(items.previsionnelles)),
    M('confirmed', 'Occurrences confirmées', num(confirmees.total)),
    M('reminders', 'Rappels envoyés', num(rappels.total)),
    ...(await costMetrics('AGENDA_INTELLIGENCE', days)).metrics,
  ];
}

/** T5 — gouvernance des prompts (SCR-06). */
async function metricsT5(days: number): Promise<Metric[]> {
  const r = await one(
    `SELECT COUNT(*)::int                                          AS total,
            COUNT(*) FILTER (WHERE status = 'PROPOSED')::int       AS proposees,
            COUNT(*) FILTER (WHERE status = 'ACTIVE')::int         AS activees,
            COUNT(*) FILTER (WHERE status = 'REJECTED')::int       AS rejetees
       FROM ai_prompt_changes
      WHERE created_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  ).catch((): Row => ({}));

  return [
    M('requests', 'Demandes de modification', Number(r.total ?? 0)),
    M('proposed', 'En attente de validation', Number(r.proposees ?? 0)),
    M('activated', 'Activées', Number(r.activees ?? 0)),
    M('rejected', 'Rejetées', Number(r.rejetees ?? 0)),
  ];
}

/**
 * T6 — mascotte d'accueil (CDC Mascotte BO-009) : formulations affichées,
 * pré-générations non affichées et textes de secours, distingués.
 */
async function metricsT6(days: number): Promise<Metric[]> {
  const r = await one(
    `SELECT COUNT(*) FILTER (WHERE mode = 'display' AND status = 'generated')::int AS affichees,
            COUNT(*) FILTER (WHERE mode = 'pregen' AND status = 'generated')::int  AS pregen,
            COUNT(*) FILTER (WHERE status IN ('fallback', 'validation_failed', 'error', 'disabled'))::int AS secours,
            COUNT(*) FILTER (WHERE status = 'validation_failed')::int               AS invalides,
            COUNT(*) FILTER (WHERE status = 'cache_hit')::int                       AS cache
       FROM home_mascot_generations
      WHERE created_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  ).catch((): Row => ({}));

  return [
    M('displayed', 'Formulations affichées', Number(r.affichees ?? 0)),
    M('pregenerated', 'Pré-générations (non affichées)', Number(r.pregen ?? 0)),
    M('cache', 'Servies depuis le cache', Number(r.cache ?? 0)),
    M('fallback', 'Textes de secours', Number(r.secours ?? 0)),
    M('invalid', 'Sorties rejetées par la validation', Number(r.invalides ?? 0)),
  ];
}

const PAR_TRAITEMENT: Record<Treatment, (days: number) => Promise<Metric[]>> = {
  T1: metricsT1, T2: metricsT2, T3: metricsT3, T4: metricsT4, T5: metricsT5, T6: metricsT6,
};

const TABLES: Partial<Record<Treatment, (days: number) => Promise<MetricTable[]>>> = {
  T1: tablesT1,
  T2: tablesT2,
};

/**
 * Indicateurs d'un traitement.
 *
 * Une requête en échec — table absente, schéma différent — rend des indicateurs
 * non mesurés plutôt que de faire échouer l'écran. Un onglet de configuration
 * doit rester éditable même si sa supervision est muette.
 */
export async function getTreatmentMetrics(
  treatment: Treatment,
  windowDays = 30,
): Promise<TreatmentMetrics> {
  const days = Math.min(Math.max(windowDays, 1), 365);
  try {
    const [metrics, tables] = await Promise.all([
      PAR_TRAITEMENT[treatment](days),
      TABLES[treatment]?.(days).catch(() => []) ?? Promise.resolve(undefined),
    ]);
    return { treatment, windowDays: days, metrics, ...(tables ? { tables } : {}) };
  } catch (e) {
    console.error(`[metrics] ${treatment} indisponible :`, (e as Error).message);
    return {
      treatment,
      windowDays: days,
      metrics: [M('unavailable', 'Supervision', null, 'count',
        'Indicateurs momentanément indisponibles.')],
    };
  }
}
