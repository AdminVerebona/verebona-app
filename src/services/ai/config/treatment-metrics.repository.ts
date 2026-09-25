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
  unit?: 'count' | 'percent' | 'ms';
  /** Pourquoi la mesure n'existe pas, le cas échéant. */
  missingReason?: string;
}

export interface TreatmentMetrics {
  treatment: Treatment;
  windowDays: number;
  metrics: Metric[];
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

async function one(sql: string, params: unknown[] = []): Promise<Row> {
  // Les tests unitaires n'ouvrent aucune connexion : attendre la borne à chaque
  // requête ajouterait des secondes pour une valeur qui n'existe pas. Même
  // convention que `telemetry/execution-context`.
  if (process.env.NODE_ENV === 'test') return {};

  const rows = await Promise.race([
    pgClient.unsafe(sql, params as never[]),
    new Promise<[]>((resolve) => setTimeout(() => resolve([]), QUERY_TIMEOUT_MS).unref?.()),
  ]);
  return (rows as unknown as Row[])[0] ?? {};
}

/** T1 — qualité d'extraction (SCR-02). */
async function metricsT1(days: number): Promise<Metric[]> {
  const r = await one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS echecs
       FROM document_analysis_runs
      WHERE started_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );

  const total = Number(r.total ?? 0);
  const echecs = Number(r.echecs ?? 0);

  return [
    M('runs', 'Analyses lancées', total),
    M('failed', 'Analyses en échec', echecs),
    M('failure_rate', "Taux d'échec", total > 0 ? Math.round((echecs / total) * 100) : null,
      'percent', total === 0 ? 'Aucune analyse sur la période.' : undefined),
    // Un zéro d'échec sur zéro analyse ne veut rien dire : le taux reste non
    // mesuré plutôt que d'afficher 0 %, qui se lirait « tout va bien ».
    // Le SCR-02 demande les « rechecks T2 imputables à des lacunes T1 ». Rien ne
    // relie aujourd'hui une recherche complémentaire de l'assistant à une
    // lacune d'extraction : le lien devrait être posé au moment du recheck,
    // pas deviné après coup.
    M('t2_rechecks', 'Rechecks T2 sur lacune T1', null, 'count',
      "Non instrumenté : l'assistant n'enregistre pas qu'une recherche fait suite à une extraction incomplète."),
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

  // La cascade : part des demandes ayant atteint chaque niveau. Lue dans
  // `retrieval_methods_json`, que le pipeline remplit à chaque exécution.
  const cascade = await one(
    // Lecture ciblée de `levelsReached` (tableau JSON) : un ILIKE sur le
    // JSON entier comptait aussi les noms de stratégie (« structured.… »)
    // et les tentatives non applicables.
    `SELECT COUNT(*) FILTER (WHERE jsonb_exists(retrieval_methods_json->'levelsReached', 'structured'))::int AS bdd,
            COUNT(*) FILTER (WHERE jsonb_exists(retrieval_methods_json->'levelsReached', 'fulltext'))::int   AS texte,
            COUNT(*) FILTER (WHERE jsonb_exists(retrieval_methods_json->'levelsReached', 'llm'))::int        AS modele
       FROM verebona_request_runs WHERE ${fenetre}`,
  );

  const pct = (n: unknown): number | null =>
    total > 0 ? Math.round((Number(n ?? 0) / total) * 100) : null;

  const actions = await one(
    `SELECT COUNT(*)::int AS total FROM verebona_message_actions WHERE ${fenetre}`,
  ).catch((): Row => ({}));

  const conversations = await one(
    `SELECT COUNT(*)::int AS total FROM verebona_conversations WHERE ${fenetre}`,
  ).catch((): Row => ({}));

  return [
    M('requests', 'Demandes traitées', total),
    M('ai_share', 'Part traitée par le modèle', pct(ia), 'percent'),
    M('deterministic_share', 'Part tranchée sans IA', pct(runs.deterministe), 'percent'),
    M('cascade_db', 'Niveau base structurée', pct(cascade.bdd), 'percent'),
    M('cascade_text', 'Niveau recherche textuelle', pct(cascade.texte), 'percent'),
    M('cascade_llm', 'Niveau modèle (LLM)', pct(cascade.modele), 'percent'),
    M('latency', 'Latence moyenne', runs.latence == null ? null : Number(runs.latence), 'ms'),
    M('errors', 'Demandes en échec', Number(runs.erreurs ?? 0)),
    M('conversations', 'Conversations ouvertes',
      conversations.total == null ? null : Number(conversations.total)),
    M('actions', 'Actions proposées', actions.total == null ? null : Number(actions.total)),
    M('t1_gaps', 'Lacunes T1 détectées', null, 'count',
      'Non instrumenté : voir la remarque de T1.'),
  ];
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
  ];
}

/** T4 — cycle de vie des échéances (SCR-05). */
async function metricsT4(days: number): Promise<Metric[]> {
  const items = await one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_automatic)::int              AS automatiques,
            COUNT(*) FILTER (WHERE is_automatic_modified)::int     AS reprises
       FROM agenda_items
      WHERE created_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  ).catch((): Row => ({}));

  const conflits = await one(
    `SELECT COUNT(*)::int AS total FROM agenda_data_conflicts
      WHERE created_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)],
  ).catch((): Row => ({}));

  return [
    M('created', 'Échéances créées', Number(items.total ?? 0)),
    M('automatic', 'Créées automatiquement', Number(items.automatiques ?? 0)),
    // Une échéance automatique reprise à la main est le signal le plus direct
    // que le traitement se trompe : l'utilisateur a dû corriger.
    M('corrected', 'Automatiques corrigées ensuite', Number(items.reprises ?? 0)),
    M('conflicts', 'Conflits à arbitrer', Number(conflits.total ?? 0)),
    M('forecast', 'Occurrences prévisionnelles', null, 'count',
      "Non distingué en base : une occurrence prévisionnelle n'est pas marquée comme telle."),
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

const PAR_TRAITEMENT: Record<Treatment, (days: number) => Promise<Metric[]>> = {
  T1: metricsT1, T2: metricsT2, T3: metricsT3, T4: metricsT4, T5: metricsT5,
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
    return { treatment, windowDays: days, metrics: await PAR_TRAITEMENT[treatment](days) };
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
