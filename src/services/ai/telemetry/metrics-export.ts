/**
 * Export CSV des métriques AGRÉGÉES de l'assistant et de l'IA — CDC
 * Assistant §32.2 (indicateurs techniques), §32.3 (efficacité économique),
 * §32.6 (« exporter des métriques agrégées », filtres période, offre,
 * intention, modèle, version de prompt), §32.7 ; lot 23.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CONTIENT LE FICHIER
 *
 * Format « long » (une ligne = un indicateur d'un groupe), séparateur `;`,
 * UTF-8 avec BOM, fins de ligne CRLF — lisible tel quel par un tableur
 * français. Colonnes :
 *
 *   section ; jour ; intention ; mode ; statut ; offre ; traitement ;
 *   alias_modele ; modele ; version_prompt ; tache ; indicateur ; valeur
 *
 * Lignes `_meta` en tête (période, filtres et sections auxquelles chacun
 * s'applique, seuil d'anonymisation) et EN FIN (`tronque` : oui / non).
 * Puis trois sections, JOUR PAR JOUR (Europe/Paris) — le fichier est produit
 * en flux, un jour à la fois (mémoire bornée, revue I-4) :
 *   · `assistant_demandes`      (verebona_request_runs) par intention, mode,
 *     statut : demandes, réponses du cache, timeouts, latences p50/p95/p99,
 *     sources récupérées et affichées ;
 *   · `assistant_appels_modele` (verebona_ai_runs) par alias, modèle
 *     résolu, tâche du master (MODE), statut : appels, escalades, jetons,
 *     coût, latences ;
 *   · `ia_usage_par_offre`      (ai_usage_event, TOUS traitements) par
 *     traitement, offre COURANTE du compte et version RÉELLE du prompt
 *     maître (`master_prompt_version`) : appels, échecs, jetons, coût
 *     facturable.
 *
 * Seuil d'anonymisation (`COST_PLAN_MIN_ACCOUNTS` = 5 comptes distincts),
 * revue I-5 : un groupe sous le seuil (jour × intention, jour × modèle,
 * jour × traitement × offre) perd son libellé (« < 5 comptes ») ; avec un
 * filtre d'offre, il est SUPPRIMÉ (le libellé de l'offre est alors connu).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CLOISONNEMENT
 *
 * Aucun identifiant (compte, utilisateur, conversation, demande), aucun
 * contenu de conversation, aucun extrait : des compteurs, des durées, des
 * coûts et des énumérations techniques. Chaque cellule texte est neutralisée
 * contre l'injection de formules (`=`, `+`, `-`, `@`, tabulation, retour
 * chariot en tête → préfixe `'`) puis échappée (guillemets doublés).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { COST_PLAN_MIN_ACCOUNTS } from './observability.repository';

export const METRICS_EXPORT_COLUMNS = [
  'section', 'jour', 'intention', 'mode', 'statut', 'offre', 'traitement',
  'alias_modele', 'modele', 'version_prompt', 'tache', 'indicateur', 'valeur',
] as const;
type Column = (typeof METRICS_EXPORT_COLUMNS)[number];
export type MetricsExportRow = Partial<Record<Column, string | number | null>>;

/** Période maximale d'un export (jours). */
export const MAX_EXPORT_DAYS = 366;
/** Groupes SQL au plus par section ET PAR JOUR ; au-delà : ligne `tronque`. */
export const MAX_GROUPS_PER_SECTION = 20_000;
const QUERY_TIMEOUT_MS = 20_000;
const MASQUE = `< ${COST_PLAN_MIN_ACCOUNTS} comptes`;

// ── CSV ────────────────────────────────────────────────────────────────────

/** Premiers caractères interprétés comme formule par les tableurs. */
const FORMULE = /^[=+\-@\t\r]/;

/**
 * Cellule CSV sûre : nombre fini tel quel, texte neutralisé (formule) puis
 * entouré de guillemets si besoin (séparateur, guillemet, saut de ligne,
 * espace en bord).
 */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'bigint') return v.toString();
  let s = String(v);
  if (FORMULE.test(s)) s = `'${s}`;
  if (/[";\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const CSV_HEADER = `﻿${METRICS_EXPORT_COLUMNS.join(';')}\r\n`;

export function csvLine(r: MetricsExportRow): string {
  return `${METRICS_EXPORT_COLUMNS.map((c) => csvCell(r[c])).join(';')}\r\n`;
}

export function toCsv(rows: readonly MetricsExportRow[]): string {
  return CSV_HEADER + rows.map(csvLine).join('');
}

// ── Paramètres ─────────────────────────────────────────────────────────────

export interface MetricsExportQuery {
  /** AAAA-MM-JJ inclus (Europe/Paris). */
  from: string;
  /** AAAA-MM-JJ inclus (Europe/Paris). */
  to: string;
  intent?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  plan?: string | null;
}

/** Sections auxquelles s'applique chaque filtre (écran et lignes `_meta`). */
export const FILTER_SCOPES: Readonly<Record<'intent' | 'model' | 'promptVersion' | 'plan', readonly string[]>> = {
  intent: ['assistant_demandes', 'assistant_appels_modele'],
  model: ['assistant_demandes', 'assistant_appels_modele', 'ia_usage_par_offre'],
  promptVersion: ['ia_usage_par_offre'],
  plan: ['assistant_demandes', 'assistant_appels_modele', 'ia_usage_par_offre'],
};

export class MetricsExportRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MetricsExportRefused';
  }
}

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const FILTRE = /^[A-Za-z0-9._:\-]{1,80}$/;

function dateValide(s: string): boolean {
  if (!JOUR.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Jour civil Europe/Paris d'un instant (AAAA-MM-JJ). */
export function parisDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const ajouterJours = (jour: string, n: number) => new Date(Date.parse(`${jour}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Contrôle et normalisation des paramètres (pur). Défaut : 30 derniers jours, Europe/Paris. */
export function parseMetricsExportQuery(sp: URLSearchParams, today: Date = new Date()): MetricsExportQuery {
  const to = sp.get('to') || parisDay(today);
  const from = sp.get('from') || (dateValide(to) ? ajouterJours(to, -29) : '');
  if (!dateValide(from) || !dateValide(to)) throw new MetricsExportRefused('INVALID_PERIOD', 'Période illisible : dates attendues au format AAAA-MM-JJ.');
  const jours = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (jours < 1) throw new MetricsExportRefused('INVALID_PERIOD', 'La date de début doit précéder la date de fin.');
  if (jours > MAX_EXPORT_DAYS) throw new MetricsExportRefused('PERIOD_TOO_LONG', `Période limitée à ${MAX_EXPORT_DAYS} jours.`);
  const filtre = (k: string): string | null => {
    const v = sp.get(k)?.trim();
    if (!v) return null;
    if (!FILTRE.test(v)) throw new MetricsExportRefused('INVALID_FILTER', `Filtre « ${k} » illisible.`);
    return v;
  };
  return { from, to, intent: filtre('intent'), model: filtre('model'), promptVersion: filtre('promptVersion'), plan: filtre('plan') };
}

// ── Requêtes ───────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
export type MetricsQueryRunner = (sql: string, params: unknown[]) => Promise<Row[]>;

const defaultRunner: MetricsQueryRunner = async (sql, params) => {
  const { pgClient } = await import('@/db');
  return (await pgClient.begin('read only', async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    return tx.unsafe(sql, params as never[]);
  })) as unknown as Row[];
};

/** Un jour civil Europe/Paris : $1 = jour. */
const JOUR_SQL = (col: string) =>
  `${col} >= ($1::date::timestamp AT TIME ZONE 'Europe/Paris') AND ${col} < (($1::date + 1)::timestamp AT TIME ZONE 'Europe/Paris')`;

const n = (v: unknown): number | null => (v == null ? null : Number(v));
const r2 = (v: unknown): number | null => (v == null ? null : Math.round(Number(v) * 100) / 100);
const ms = (v: unknown): number | null => (v == null ? null : Math.round(Number(v)));
const LIMITE = MAX_GROUPS_PER_SECTION + 1;

// Seuil : sous `COST_PLAN_MIN_ACCOUNTS` comptes, libellé masqué ($2) ; avec
// un filtre d'offre ($3 non nul), groupe supprimé.
const SQL_DEMANDES = `
  WITH base AS (
    SELECT r.intent, r.mode, r.status, r.account_id, r.latency_ms, r.cache_hit, r.error_code,
           r.retrieval_methods_json->>'strategy' AS strategy, r.candidate_count, r.source_count
      FROM verebona_request_runs r LEFT JOIN accounts a ON a.id = r.account_id
     WHERE ${JOUR_SQL('r.created_at')} AND r.status IS DISTINCT FROM 'pending'
       AND ($3::text IS NULL OR a.plan_type = $3)
       AND ($4::text IS NULL OR r.intent = $4)
       AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM verebona_ai_runs x
                                        WHERE x.request_id = r.request_id AND x.resolved_model_id = $5))
  ), g AS (SELECT intent, COUNT(DISTINCT account_id) AS comptes FROM base GROUP BY intent)
  SELECT CASE WHEN g.comptes >= ${COST_PLAN_MIN_ACCOUNTS} THEN COALESCE(b.intent, '—') ELSE $2 END AS intent,
         COALESCE(b.mode, '—') AS mode, COALESCE(b.status, '—') AS status, COUNT(*)::int AS demandes,
         COUNT(*) FILTER (WHERE b.cache_hit)::int AS cache_hits,
         COUNT(*) FILTER (WHERE b.error_code = 'REQUEST_TIMEOUT' OR b.strategy LIKE 'timeout.%')::int AS timeouts,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY b.latency_ms) AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY b.latency_ms) AS p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY b.latency_ms) AS p99,
         AVG(b.candidate_count)::float8 AS candidats, AVG(b.source_count)::float8 AS sources
    FROM base b JOIN g ON g.intent IS NOT DISTINCT FROM b.intent
   WHERE ($3::text IS NULL OR g.comptes >= ${COST_PLAN_MIN_ACCOUNTS})
   GROUP BY 1, 2, 3 ORDER BY 1, 2, 3 LIMIT ${LIMITE}`;

// `model_alias` est tracé « alias:opération » ; `prompt_version` y est la
// TÂCHE du master (MODE), pas la version du prompt maître.
const SQL_APPELS = `
  WITH base AS (
    SELECT x.account_id, split_part(x.model_alias, ':', 1) AS alias, x.resolved_model_id AS modele,
           x.prompt_version AS tache, x.status, x.fallback_used, x.input_tokens, x.output_tokens,
           x.estimated_cost_micros, x.latency_ms
      FROM verebona_ai_runs x LEFT JOIN accounts a ON a.id = x.account_id
     WHERE ${JOUR_SQL('x.created_at')}
       AND ($3::text IS NULL OR a.plan_type = $3)
       AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM verebona_request_runs r
                                        WHERE r.request_id = x.request_id AND r.intent = $4))
       AND ($5::text IS NULL OR x.resolved_model_id = $5)
  ), g AS (SELECT modele, COUNT(DISTINCT account_id) AS comptes FROM base GROUP BY modele)
  SELECT CASE WHEN g.comptes >= ${COST_PLAN_MIN_ACCOUNTS} THEN COALESCE(NULLIF(b.alias, ''), '—') ELSE $2 END AS alias,
         CASE WHEN g.comptes >= ${COST_PLAN_MIN_ACCOUNTS} THEN COALESCE(b.modele, '—') ELSE $2 END AS modele,
         COALESCE(b.tache, '—') AS tache, COALESCE(b.status, '—') AS status, COUNT(*)::int AS appels,
         COUNT(*) FILTER (WHERE b.fallback_used)::int AS escalades,
         COALESCE(SUM(b.input_tokens), 0)::bigint AS tin, COALESCE(SUM(b.output_tokens), 0)::bigint AS tout,
         COALESCE(SUM(b.estimated_cost_micros), 0)::bigint AS cout,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY b.latency_ms) AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY b.latency_ms) AS p95
    FROM base b JOIN g ON g.modele IS NOT DISTINCT FROM b.modele
   WHERE ($3::text IS NULL OR g.comptes >= ${COST_PLAN_MIN_ACCOUNTS})
   GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4 LIMIT ${LIMITE}`;

const SQL_USAGE = `
  WITH base AS (
    SELECT COALESCE(e.use_case_code, '—') AS uc, COALESCE(a.plan_type, '—') AS plan,
           COALESCE(e.master_prompt_version, '—') AS master, e.account_id, e.status,
           e.input_tokens, e.output_tokens, e.cost_micros, e.is_billable
      FROM ai_usage_event e LEFT JOIN accounts a ON a.id = e.account_id
     WHERE ${JOUR_SQL('e.created_at')} AND e.operation_type <> 'circuit_breaker_probe'
       AND ($3::text IS NULL OR a.plan_type = $3)
       AND ($4::text IS NULL OR e.model = $4)
       AND ($5::text IS NULL OR e.master_prompt_version = $5)
  ), g AS (SELECT uc, plan, COUNT(DISTINCT account_id) AS comptes FROM base GROUP BY 1, 2)
  SELECT b.uc, CASE WHEN g.comptes >= ${COST_PLAN_MIN_ACCOUNTS} THEN b.plan ELSE $2 END AS plan, b.master,
         COUNT(*)::int AS appels, COUNT(*) FILTER (WHERE b.status <> 'success')::int AS echecs,
         COALESCE(SUM(b.input_tokens), 0)::bigint AS tin, COALESCE(SUM(b.output_tokens), 0)::bigint AS tout,
         COALESCE(SUM(b.cost_micros) FILTER (WHERE b.is_billable), 0)::bigint AS cout
    FROM base b JOIN g ON g.uc = b.uc AND g.plan = b.plan
   WHERE ($3::text IS NULL OR g.comptes >= ${COST_PLAN_MIN_ACCOUNTS})
   GROUP BY 1, 2, 3 ORDER BY 1, 2, 3 LIMIT ${LIMITE}`;

export interface MetricsExportSummary {
  /** Lignes de données (hors `_meta`). */
  rows: number;
  /** Au moins une section d'un jour a dépassé `MAX_GROUPS_PER_SECTION`. */
  truncated: boolean;
  truncatedDays: string[];
}

/** Lignes `_meta` d'en-tête : période, filtres et leur portée, seuil. */
export function metaRows(q: MetricsExportQuery): MetricsExportRow[] {
  const out: MetricsExportRow[] = [
    { section: '_meta', indicateur: 'periode_debut', valeur: q.from },
    { section: '_meta', indicateur: 'periode_fin', valeur: q.to },
    { section: '_meta', indicateur: 'seuil_anonymisation_comptes', valeur: COST_PLAN_MIN_ACCOUNTS },
  ];
  for (const k of ['intent', 'model', 'promptVersion', 'plan'] as const) {
    const v = q[k];
    if (v) out.push({ section: '_meta', indicateur: `filtre_${k}`, valeur: `${v} (sections : ${FILTER_SCOPES[k].join(', ')})` });
  }
  return out;
}

/**
 * Lignes de l'export, JOUR PAR JOUR (générateur : mémoire bornée à un jour).
 * `summary` est complété au fil de l'eau ; la dernière ligne est `tronque`.
 */
export async function* metricsExportRows(
  q: MetricsExportQuery, run: MetricsQueryRunner = defaultRunner, summary: MetricsExportSummary = { rows: 0, truncated: false, truncatedDays: [] },
): AsyncGenerator<MetricsExportRow> {
  for (const r of metaRows(q)) yield r;
  const borne = (jour: string, rows: Row[]): Row[] => {
    if (rows.length <= MAX_GROUPS_PER_SECTION) return rows;
    summary.truncated = true;
    if (!summary.truncatedDays.includes(jour)) summary.truncatedDays.push(jour);
    return rows.slice(0, MAX_GROUPS_PER_SECTION);
  };
  const emettre = function* (g: MetricsExportRow, ind: Array<[string, number | null]>) {
    for (const [indicateur, valeur] of ind) {
      summary.rows += 1;
      yield { ...g, indicateur, valeur };
    }
  };
  const p = (jour: string) => [jour, MASQUE, q.plan ?? null, q.intent ?? null, q.model ?? null];

  for (let jour = q.from; jour <= q.to; jour = ajouterJours(jour, 1)) {
    for (const r of borne(jour, await run(SQL_DEMANDES, p(jour)))) {
      yield* emettre(
        { section: 'assistant_demandes', jour, intention: String(r.intent), mode: String(r.mode), statut: String(r.status) },
        [
          ['demandes', n(r.demandes)], ['reponses_cache', n(r.cache_hits)], ['timeouts', n(r.timeouts)],
          ['latence_p50_ms', ms(r.p50)], ['latence_p95_ms', ms(r.p95)], ['latence_p99_ms', ms(r.p99)],
          ['sources_recuperees_moy', r2(r.candidats)], ['sources_affichees_moy', r2(r.sources)],
        ],
      );
    }
    for (const r of borne(jour, await run(SQL_APPELS, p(jour)))) {
      yield* emettre(
        { section: 'assistant_appels_modele', jour, statut: String(r.status), traitement: 'T2',
          alias_modele: String(r.alias), modele: String(r.modele), tache: String(r.tache) },
        [
          ['appels', n(r.appels)], ['escalades', n(r.escalades)], ['tokens_entree', n(r.tin)], ['tokens_sortie', n(r.tout)],
          ['cout_estime_micro_usd', n(r.cout)], ['latence_p50_ms', ms(r.p50)], ['latence_p95_ms', ms(r.p95)],
        ],
      );
    }
    for (const r of borne(jour, await run(SQL_USAGE, [jour, MASQUE, q.plan ?? null, q.model ?? null, q.promptVersion ?? null]))) {
      yield* emettre(
        { section: 'ia_usage_par_offre', jour, traitement: String(r.uc), offre: String(r.plan), version_prompt: String(r.master) },
        [
          ['appels', n(r.appels)], ['echecs', n(r.echecs)], ['tokens_entree', n(r.tin)], ['tokens_sortie', n(r.tout)],
          ['cout_facturable_micro_usd', n(r.cout)],
        ],
      );
    }
  }
  yield {
    section: '_meta', indicateur: 'tronque',
    valeur: summary.truncated ? `oui (${MAX_GROUPS_PER_SECTION} groupes par section et par jour, jours : ${summary.truncatedDays.join(' ')})` : 'non',
  };
}

/** Toutes les lignes (tests, petits volumes). */
export async function buildMetricsExport(q: MetricsExportQuery, run: MetricsQueryRunner = defaultRunner): Promise<MetricsExportRow[]> {
  const out: MetricsExportRow[] = [];
  for await (const r of metricsExportRows(q, run)) out.push(r);
  return out;
}

/**
 * Flux CSV (UTF-8) : en-tête, puis une ligne par indicateur, jour par jour.
 * `done` se résout à la fin du flux (résumé) ou se rejette sur erreur.
 */
export function metricsExportStream(q: MetricsExportQuery, run: MetricsQueryRunner = defaultRunner): {
  stream: ReadableStream<Uint8Array>; done: Promise<MetricsExportSummary>;
} {
  const summary: MetricsExportSummary = { rows: 0, truncated: false, truncatedDays: [] };
  const enc = new TextEncoder();
  const it = metricsExportRows(q, run, summary);
  let fin!: (s: MetricsExportSummary) => void;
  let echec!: (e: unknown) => void;
  const done = new Promise<MetricsExportSummary>((res, rej) => { fin = res; echec = rej; });
  done.catch(() => undefined);
  let enTete = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!enTete) { enTete = true; controller.enqueue(enc.encode(CSV_HEADER)); return; }
        // Un lot de lignes par tirage : moins d'allers-retours, mémoire bornée.
        let lot = '';
        for (let i = 0; i < 500; i++) {
          const { value, done: termine } = await it.next();
          if (termine) {
            if (lot) controller.enqueue(enc.encode(lot));
            controller.close();
            fin(summary);
            return;
          }
          lot += csvLine(value);
        }
        controller.enqueue(enc.encode(lot));
      } catch (e) {
        echec(e);
        controller.error(e);
      }
    },
    async cancel(reason) {
      await it.return(undefined);
      echec(reason ?? new Error('export interrompu par le client'));
    },
  });
  return { stream, done };
}

export function metricsExportFilename(q: MetricsExportQuery): string {
  return `verebona-metriques-ia_${q.from}_${q.to}.csv`;
}
