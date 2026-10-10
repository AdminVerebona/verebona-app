/**
 * Observabilité IA — CDC 15 §18 (lot 17).
 *
 * Indicateurs minimaux par domaine (T1, T2, T3, T4, configuration IA,
 * exports), calculés sur une PÉRIODE, filtrables par environnement et par
 * version de configuration. Affichés dans le tableau de bord IA existant
 * (`/admin/ai-dashboard`), avec le composant de supervision des onglets de
 * traitement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST MESURÉ L'EST VRAIMENT, LE RESTE LE DIT
 *
 * Même règle que `config/treatment-metrics.repository.ts` : une mesure
 * impossible (requête en échec, délai dépassé, donnée non tracée) rend `null`
 * AVEC sa raison — jamais zéro, qui se lirait comme une absence de problème.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FILTRES
 *
 * · Période : `[now - days, now)`, 1 à 90 jours.
 * · Environnement : chaque environnement a SA base (GEN-003). Toutes les
 *   lignes lues ici appartiennent donc à l'environnement courant ; en
 *   demander un autre rend des indicateurs nuls avec la raison (le BO de cet
 *   environnement est le seul à les lire).
 * · Version de configuration :
 *     – EXACTE sur `ai_usage_event.config_version_id` (appels, coûts,
 *       moteur, modèle, repli, raisonnement, max tokens, déclencheur) ;
 *     – APPROCHÉE sur les tables métier (faits, preuves, agenda, demandes
 *       T2), qui ne portent pas la version : on retient la PÉRIODE D'EFFET
 *       de la version, du premier au dernier appel tracé sous elle dans la
 *       fenêtre (+ 5 min de marge d'écriture) ; sans appel, de son
 *       activation à l'activation suivante. Le rapport le dit (`version.scope`).
 *     – Sans objet pour les exports (aucun appel IA).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PERFORMANCE (NFR-002)
 *
 * · Chaque requête est bornée par la période, sur une colonne de date
 *   indexée (index `*_obs_idx` de la migration 0226, CONCURRENTLY ; index
 *   existants pour `ai_usage_event.created_at`, `reconciliation_runs.started_at`,
 *   `agenda_item_removals (account_id, removed_at)`).
 * · Les avertissements T1 et les candidats T4 sont lus dans le résultat
 *   d'analyse (`document_analysis_runs.raw_response_json`, texte) : on
 *   n'en lit qu'un ÉCHANTILLON des `T1_SAMPLE` analyses les plus récentes de
 *   la période, et l'écran l'indique quand il ne couvre pas tout.
 * · Un calcul = UNE connexion réservée, UNE transaction `READ ONLY`,
 *   `SET LOCAL statement_timeout = QUERY_TIMEOUT_MS` : PostgreSQL annule
 *   lui-même une requête trop longue (rien ne continue de tourner), chaque
 *   requête est isolée dans un SAVEPOINT, et l'indicateur concerné devient
 *   « indisponible », pas nul. Budget total `DOMAIN_BUDGET_MS` par domaine
 *   (14 requêtes au plus par domaine — T2 —, filtre de version compris).
 * · Un seul calcul à la fois par instance : une demande concurrente reçoit
 *   le dernier résultat connu (`stale`) ou « en cours » (`busy`).
 * · `raw_response_json` illisible : ligne comptée et ignorée, jamais
 *   d'échec de tout l'échantillon (`IS JSON` sur PostgreSQL ≥ 16, sinon
 *   lecture applicative).
 * · Cache mémoire de `CACHE_TTL_MS` par (domaine, période, version,
 *   environnement) : ouvrir, fermer et rouvrir un onglet ne relance rien.
 *
 * AUCUN CONTENU UTILISATEUR : seulement des compteurs, des codes et des
 * énumérations (motifs, stratégies, types de source, états).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { hostname } from 'node:os';
import { pgClient } from '@/db';
import { businessEventCounters } from '@/services/verebona-assistant/events/business-events';
import { scopeIncidentCounters } from '@/services/verebona-assistant/security/scope-incidents';
import type { Metric, MetricTable } from '../config/treatment-metrics.repository';
import { getAiEnvironment, parseEnvironment } from '../config/environment';
import type { AnalysisWarningCode } from '../source-analysis/types';
import { truthSourceOf, T2_TRUTH_SOURCES, type T2TruthSource } from './t2-observability';

type Row = Record<string, unknown>;

export const OBSERVABILITY_DOMAINS = ['T1', 'T2', 'T3', 'T4', 'CONFIG', 'EXPORTS'] as const;
export type ObservabilityDomain = (typeof OBSERVABILITY_DOMAINS)[number];

export const OBSERVABILITY_DOMAIN_LABELS: Readonly<Record<ObservabilityDomain, string>> = {
  T1: 'T1 — Sources',
  T2: 'T2 — Assistant',
  T3: 'T3 — Rationalisation',
  T4: 'T4 — Échéances',
  CONFIG: 'Configuration IA',
  EXPORTS: 'Exports',
};

export function isObservabilityDomain(v: unknown): v is ObservabilityDomain {
  return typeof v === 'string' && (OBSERVABILITY_DOMAINS as readonly string[]).includes(v);
}

export const MAX_WINDOW_DAYS = 90;
export const T1_SAMPLE = 500;
/** PostgreSQL < 16 (pas de `IS JSON`) : lecture applicative, échantillon réduit. */
export const T1_SAMPLE_APP = 200;
/** `statement_timeout` de chaque requête (posé côté base, `SET LOCAL`). */
export const QUERY_TIMEOUT_MS = 3_000;
/** Budget total d'un domaine : au-delà, les requêtes restantes ne partent pas. */
export const DOMAIN_BUDGET_MS = 12_000;
const CACHE_TTL_MS = 120_000;
const CACHE_MAX = 100;
/** Marge d'écriture après le dernier appel d'une version (période approchée). */
const VERSION_TAIL_MS = 5 * 60_000;

export interface ObservabilityQuery {
  domain: ObservabilityDomain;
  days: number;
  configVersionId?: number | null;
  environment?: string | null;
}

export interface ObservabilityReport {
  domain: ObservabilityDomain;
  windowDays: number;
  period: { from: string; to: string };
  environment: { current: string | null; requested: string | null; readable: boolean };
  version: {
    id: number;
    label: string;
    /** `exact` : filtre sur la version tracée ; `period` : période d'effet ; `none` : sans objet. */
    scope: 'exact+period' | 'none';
    period: { from: string; to: string } | null;
  } | null;
  metrics: Metric[];
  tables: MetricTable[];
  notes: string[];
  generatedAt: string;
  cached: boolean;
  /** Valeurs d'un calcul précédent rendues pendant qu'un autre calcul tourne. */
  stale?: boolean;
  /** Un autre calcul occupe l'instance et aucun résultat n'est en cache : réessayer. */
  busy?: boolean;
}

// ── Exécution des requêtes ───────────────────────────────────────────────────

type QueryRunner = (sql: string, params: unknown[]) => Promise<Row[]>;
let injectedRunner: QueryRunner | null = null;

/**
 * Remplace l'exécution des requêtes — réservé aux tests unitaires. Sans
 * runner injecté, chaque calcul passe par une transaction réelle (ci-dessous).
 */
export function setObservabilityQueryRunner(r: QueryRunner | null): void {
  injectedRunner = r;
  cache.clear();
  serverVersion = null;
}

class QueryUnavailable extends Error {}

/** Filtre sur une version de configuration inexistante. */
export class ObservabilityVersionNotFound extends Error {
  readonly code = 'VERSION_NOT_FOUND';
  constructor(readonly versionId: number) {
    super(`Version de configuration inconnue : ${versionId}.`);
  }
}

/**
 * Session de calcul (relecture lot 17) — UNE connexion réservée, UNE
 * transaction `READ ONLY` avec `SET LOCAL statement_timeout` :
 *
 *   · le délai est appliqué PAR POSTGRESQL, qui annule la requête (57014) —
 *     un délai seulement côté Node laissait la requête tourner et garder sa
 *     connexion ;
 *   · chaque requête dans un SAVEPOINT : une requête annulée ou en erreur ne
 *     condamne pas la transaction, les suivantes s'exécutent ;
 *   · une seule connexion par calcul, et un seul calcul à la fois par
 *     instance (`inFlight`, plus bas) : l'observabilité ne prend jamais plus
 *     d'une connexion du pool ;
 *   · `READ ONLY` : aucune écriture possible depuis cet écran.
 */
/**
 * Session courante, portée par le contexte asynchrone (`AsyncLocalStorage`) :
 * deux sessions simultanées (calcul d'un domaine, lecture des questions sans
 * réponse) ne se marchent jamais dessus.
 */
const session = new AsyncLocalStorage<{ exec: QueryRunner; deadline: number }>();

async function runSession<T>(fn: () => Promise<T>, budgetMs = Number.POSITIVE_INFINITY): Promise<T> {
  const deadline = Date.now() + budgetMs;
  if (injectedRunner) return session.run({ exec: injectedRunner, deadline }, fn);
  return (await pgClient.begin('read only', async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    const exec: QueryRunner = (q, p) => tx.savepoint((sp) => sp.unsafe(q, p as never[])) as unknown as Promise<Row[]>;
    return session.run({ exec, deadline }, fn);
  })) as T;
}

/**
 * UNE requête de lecture dans sa propre session (connexion réservée, READ
 * ONLY, `statement_timeout` côté base) — pour les autres écrans
 * d'observabilité (questions sans réponse §32.5). Délai dépassé : lève
 * (`délai dépassé, requête annulée par la base`).
 */
export async function readOnlyObservabilityQuery(sql: string, params: unknown[] = []): Promise<Row[]> {
  return runSession(() => many(sql, params));
}

/** Une requête dans une session — réservé aux tests (annulation côté base). */
export const observabilityQueryForTests = readOnlyObservabilityQuery;

async function many(sql: string, params: unknown[]): Promise<Row[]> {
  const ctx = session.getStore();
  if (!ctx) throw new Error('[observabilité] requête hors session');
  if (Date.now() > ctx.deadline) throw new QueryUnavailable('budget du domaine dépassé');
  try {
    return await ctx.exec(sql, params);
  } catch (e) {
    // 57014 : query_canceled (statement_timeout).
    if ((e as { code?: string }).code === '57014') throw new QueryUnavailable('délai dépassé, requête annulée par la base');
    throw e;
  }
}

/** Résultat d'une requête, ou `null` si elle a échoué (indicateurs « indisponibles »). */
async function tryMany(sql: string, params: unknown[], errors: string[], what: string): Promise<Row[] | null> {
  try {
    return await many(sql, params);
  } catch (e) {
    errors.push(`${what} : mesure indisponible (${e instanceof QueryUnavailable ? e.message : 'requête en échec'}).`);
    return null;
  }
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));

const UNAVAILABLE = 'Mesure indisponible (requête en échec ou délai dépassé) — voir les notes.';

/**
 * Indicateur. `row === null` : requête en échec → valeur nulle et raison.
 */
function M(
  key: string, label: string, row: Row | null, value: (r: Row) => number | null,
  unit: Metric['unit'] = 'count', missingReason?: string,
): Metric {
  if (row === null) return { key, label, value: null, unit, missingReason: UNAVAILABLE };
  const v = value(row);
  return {
    key, label, value: v, unit,
    missingReason: v === null ? (missingReason ?? 'Aucune donnée sur la période.') : undefined,
  };
}

const pct = (part: number, total: number): number | null => (total > 0 ? Math.round((part / total) * 100) : null);

// ── Période et version ───────────────────────────────────────────────────────

interface Scope {
  from: Date;
  to: Date;
  /** Période des tables métier (période d'effet de la version si filtre). */
  business: { from: Date; to: Date } | null;
  versionId: number | null;
}

async function resolveVersion(
  id: number, from: Date, to: Date, errors: string[],
): Promise<{ label: string; period: { from: Date; to: Date } | null } | 'unknown'> {
  const rows = await tryMany(
    `SELECT v.id, v.visible_number, v.label, v.status, v.activated_at,
            (SELECT min(n.activated_at) FROM ai_config_versions n
              WHERE n.environment = v.environment AND n.activated_at > v.activated_at) AS next_activated_at,
            (SELECT min(e.created_at) FROM ai_usage_event e
              WHERE e.config_version_id = v.id AND e.created_at >= $2 AND e.created_at < $3) AS first_call,
            (SELECT max(e.created_at) FROM ai_usage_event e
              WHERE e.config_version_id = v.id AND e.created_at >= $2 AND e.created_at < $3) AS last_call
       FROM ai_config_versions v WHERE v.id = $1`,
    [id, from.toISOString(), to.toISOString()], errors, 'Version de configuration',
  );
  if (rows === null) return { label: `#${id}`, period: null };
  const r = rows[0];
  if (!r) return 'unknown';
  const label = `v${r.visible_number ?? '?'}${r.label ? ` — ${String(r.label)}` : ''} (${String(r.status)})`;
  const date = (v: unknown): Date | null => (v == null ? null : new Date(String(v)));
  const first = date(r.first_call);
  const last = date(r.last_call);
  let p: { from: Date; to: Date } | null = null;
  if (first && last) {
    p = { from: first, to: new Date(Math.min(to.getTime(), last.getTime() + VERSION_TAIL_MS)) };
  } else if (date(r.activated_at)) {
    const start = date(r.activated_at)!;
    const end = date(r.next_activated_at) ?? to;
    p = { from: new Date(Math.max(start.getTime(), from.getTime())), to: new Date(Math.min(end.getTime(), to.getTime())) };
  }
  if (p && p.from.getTime() >= p.to.getTime()) p = null;
  return { label, period: p };
}

// ── Domaines ─────────────────────────────────────────────────────────────────

interface DomainResult { metrics: Metric[]; tables: MetricTable[]; notes: string[] }

/** Appels, coût, replis d'un cas d'usage — `ai_usage_event`, filtre de version EXACT. */
async function usageMetrics(useCase: string, s: Scope, errors: string[]): Promise<Metric[]> {
  const rows = await tryMany(
    `SELECT COUNT(*)::int AS calls,
            COALESCE(SUM(cost_micros) FILTER (WHERE is_billable), 0)::bigint AS cost,
            COUNT(*) FILTER (WHERE model_rank IN ('fallback_1', 'fallback_2') OR is_fallback)::int AS fallbacks
       FROM ai_usage_event
      WHERE created_at >= $1 AND created_at < $2 AND use_case_code = $3
        AND operation_type <> 'circuit_breaker_probe'
        AND ($4::int IS NULL OR config_version_id = $4::int)`,
    [s.from.toISOString(), s.to.toISOString(), useCase, s.versionId], errors, 'Appels IA',
  );
  const r = rows ? rows[0] ?? {} : null;
  return [
    M('ai_calls', 'Appels IA', r, (x) => n(x.calls)),
    M('ai_cost', 'Coût IA (métier)', r, (x) => n(x.cost), 'usd_micros'),
    M('ai_fallbacks', 'Replis de modèle', r, (x) => n(x.fallbacks)),
  ];
}

/** Paramètres de période métier ; `null` si la version n'a pas de période d'effet. */
function bp(s: Scope): [string, string] | null {
  return s.business ? [s.business.from.toISOString(), s.business.to.toISOString()] : null;
}

const NO_BUSINESS_PERIOD = 'Version sans période d’effet dans la fenêtre (aucun appel tracé, pas d’activation) : rien à attribuer.';

function nullMetrics(defs: Array<[string, string]>, reason: string): Metric[] {
  return defs.map(([key, label]) => ({ key, label, value: null, unit: 'count' as const, missingReason: reason }));
}

/** Codes d'avertissement T1 comptés comme erreurs de cible / de fait. */
export const T1_TARGET_ERROR_CODES = [
  'UNVERIFIED_IDENTIFIER', 'FACT_REQUALIFIED_GENERIC', 'UNIT_MISMATCH',
  'FACT_REJECTED_BY_RULE', 'EXCERPT_NOT_FOUND', 'AMBIGUOUS_ASSET',
] as const;

const T1_ERROR_LABELS: Readonly<Record<string, string>> = {
  UNVERIFIED_IDENTIFIER: 'Cible non vérifiée',
  FACT_REQUALIFIED_GENERIC: 'Faits requalifiés génériques',
  UNIT_MISMATCH: 'Unités incohérentes',
  FACT_REJECTED_BY_RULE: 'Faits rejetés par règle',
  EXCERPT_NOT_FOUND: 'Extraits introuvables',
  AMBIGUOUS_ASSET: 'Bien ambigu',
};

/**
 * Liste blanche des codes d'avertissement affichés : les `AnalysisWarningCode`
 * du contrat. Un code inconnu (texte libre, ancienne version) est regroupé en
 * « AUTRE » — l'écran n'affiche jamais une valeur lue telle quelle.
 */
export const T1_WARNING_CODES = [
  'NO_EXPLOITABLE_CONTENT', 'PARTIAL_EXTRACTION', 'UNVERIFIED_IDENTIFIER', 'AMBIGUOUS_ASSET', 'MULTI_ASSET_DOCUMENT',
  'LOW_CONFIDENCE_OVERALL', 'SOURCE_UNREACHABLE', 'FIELD_WITHOUT_EVIDENCE', 'TABLE_STRUCTURE_UNCERTAIN',
  'FACT_REQUALIFIED_GENERIC', 'FACT_REJECTED_BY_RULE', 'UNIT_MISMATCH', 'FACTS_TRUNCATED', 'FACT_INVALID_DROPPED',
  'EXCERPT_NOT_FOUND', 'MASTER_FALLBACK_STEPS', 'LINE_COUNT_UNKNOWN', 'FORBIDDEN_TARGET_REQUALIFIED',
  'ASSET_TARGET_CONTRADICTION',
  // Lot 34F : anomalies de complétude de la source.
  'SOURCE_UNIT_FAILED', 'COVERAGE_INCOMPLETE',
] as const satisfies readonly AnalysisWarningCode[];
// Exhaustivité vérifiée à la compilation : un code ajouté au contrat doit
// l'être ici.
type CodeManquant = Exclude<AnalysisWarningCode, (typeof T1_WARNING_CODES)[number]>;
const _exhaustif: [CodeManquant] extends [never] ? true : CodeManquant = true;
void _exhaustif;
export const OTHER_WARNING_CODE = 'AUTRE';

const knownWarning = (code: unknown): string =>
  typeof code === 'string' && (T1_WARNING_CODES as readonly string[]).includes(code) ? code : OTHER_WARNING_CODE;

/** Version du serveur (`IS JSON` : PostgreSQL ≥ 16), lue une fois par processus. */
let serverVersion: number | null = null;

async function pgVersion(errors: string[]): Promise<number> {
  if (serverVersion !== null) return serverVersion;
  const r = await tryMany(`SELECT current_setting('server_version_num')::int AS v`, [], errors, 'Version PostgreSQL');
  const v = Number(r?.[0]?.v);
  if (r && Number.isFinite(v) && v > 0) serverVersion = v;
  return Number.isFinite(v) ? v : 0;
}

interface AnalysisSample {
  runs: number; sampled: number; invalid: number; warnings: Map<string, number>; candidates: number;
}

/**
 * Échantillon des résultats d'analyse T1 de la période : avertissements par
 * code, candidats agenda. Partagé par T1 et T4.
 *
 * `raw_response_json` est du TEXTE : un seul résultat illisible ne doit pas
 * rendre tout l'échantillon indisponible. PostgreSQL ≥ 16 : conversion sous
 * `CASE WHEN … IS JSON OBJECT` (une ligne invalide est comptée, pas convertie) ;
 * avant 16 : lecture applicative, `JSON.parse` ligne à ligne, échantillon
 * réduit (`T1_SAMPLE_APP`).
 */
async function analysisSample(p: [string, string], errors: string[]): Promise<AnalysisSample | null> {
  const totals = await tryMany(
    `SELECT COUNT(*)::int AS runs FROM document_analysis_runs WHERE created_at >= $1 AND created_at < $2`,
    p, errors, 'Analyses T1',
  );
  if (!totals) return null;
  const warnings = new Map<string, number>();
  const add = (code: unknown, k: number) => {
    const c = knownWarning(code);
    warnings.set(c, (warnings.get(c) ?? 0) + k);
  };
  let sampled = 0;
  let invalid = 0;
  let candidates = 0;

  if ((await pgVersion(errors)) >= 160000) {
    const rows = await tryMany(
      `WITH r AS (
         SELECT raw_response_json AS t FROM document_analysis_runs
          WHERE created_at >= $1 AND created_at < $2 AND raw_response_json IS NOT NULL
          ORDER BY created_at DESC LIMIT $3
       ), v AS (SELECT CASE WHEN t IS JSON OBJECT THEN t::jsonb END AS j FROM r),
       j AS (SELECT v.j FROM v WHERE v.j IS NOT NULL)
       SELECT 'warning' AS kind, w->>'code' AS code, COUNT(*)::int AS n
         FROM j CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(j.j->'warnings') = 'array' THEN j.j->'warnings' ELSE '[]'::jsonb END) w
        GROUP BY w->>'code'
       UNION ALL SELECT 'sampled', NULL, COUNT(*)::int FROM r
       UNION ALL SELECT 'invalid', NULL, COUNT(*)::int FROM v WHERE v.j IS NULL
       UNION ALL SELECT 'candidates', NULL, COALESCE(SUM(
                CASE WHEN jsonb_typeof(j.j->'agendaCandidates') = 'array' THEN jsonb_array_length(j.j->'agendaCandidates') ELSE 0 END), 0)::int FROM j`,
      [...p, T1_SAMPLE], errors, 'Résultats d’analyse T1',
    );
    if (!rows) return null;
    for (const r of rows) {
      if (r.kind === 'warning') add(r.code, n(r.n));
      if (r.kind === 'sampled') sampled = n(r.n);
      if (r.kind === 'invalid') invalid = n(r.n);
      if (r.kind === 'candidates') candidates = n(r.n);
    }
  } else {
    const rows = await tryMany(
      `SELECT raw_response_json AS t FROM document_analysis_runs
        WHERE created_at >= $1 AND created_at < $2 AND raw_response_json IS NOT NULL
        ORDER BY created_at DESC LIMIT $3`,
      [...p, T1_SAMPLE_APP], errors, 'Résultats d’analyse T1',
    );
    if (!rows) return null;
    for (const r of rows) {
      sampled += 1;
      let j: unknown;
      try {
        j = JSON.parse(String(r.t));
      } catch {
        j = null;
      }
      if (!j || typeof j !== 'object' || Array.isArray(j)) { invalid += 1; continue; }
      const o = j as { warnings?: unknown; agendaCandidates?: unknown };
      if (Array.isArray(o.warnings)) for (const w of o.warnings) add((w as { code?: unknown })?.code, 1);
      if (Array.isArray(o.agendaCandidates)) candidates += o.agendaCandidates.length;
    }
  }
  return { runs: n(totals[0]?.runs), sampled, invalid, warnings, candidates };
}

function sampleNote(s: AnalysisSample): string | null {
  const parts = [
    s.runs > s.sampled
      ? `Avertissements T1 et candidats T4 : échantillon des ${s.sampled} analyses les plus récentes sur ${s.runs} (borne de performance).`
      : null,
    s.invalid > 0 ? `${s.invalid} résultat(s) d’analyse illisible(s) ignoré(s) dans l’échantillon.` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

async function domainT1(s: Scope, errors: string[]): Promise<DomainResult> {
  const usage = await usageMetrics('SOURCE_ANALYSIS', s, errors);
  const p = bp(s);
  const defs: Array<[string, string]> = [
    ['facts_extracted', 'Faits extraits'], ['facts_canonical', 'Faits canonicalisés'],
    ['facts_generic', 'Génériques non mappés'], ['facts_unresolved_target', 'Faits à cible non résolue'],
  ];
  if (!p) return { metrics: [...usage, ...nullMetrics(defs, NO_BUSINESS_PERIOD)], tables: [], notes: [] };

  const facts = await tryMany(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE canonical_key IS NOT NULL)::int AS canonical,
            COUNT(*) FILTER (WHERE canonical_key IS NULL)::int AS generic,
            COUNT(*) FILTER (WHERE target_type IS NOT NULL AND target_entity_id IS NULL)::int AS unresolved,
            COUNT(*) FILTER (WHERE evidence_origin = 'VISUAL_ANALYSIS')::int AS visual,
            COUNT(*) FILTER (WHERE evidence_origin <> 'VISUAL_ANALYSIS' AND location ? 'table')::int AS tabular,
            COUNT(*) FILTER (WHERE evidence_origin <> 'VISUAL_ANALYSIS' AND NOT (location ? 'table'))::int AS textual
       FROM document_facts
      WHERE created_at >= $1 AND created_at < $2 AND provenance = 'T1_EXTRACTION'`,
    p, errors, 'Faits T1',
  );
  const f = facts ? facts[0] ?? {} : null;
  const sample = await analysisSample(p, errors);
  const w = (code: string) => () => sample!.warnings.get(code) ?? 0;
  const sRow: Row | null = sample ? {} : null;
  const targetErrors = sample ? T1_TARGET_ERROR_CODES.reduce((a, c) => a + (sample.warnings.get(c) ?? 0), 0) : 0;

  const metrics: Metric[] = [
    M('analyses', 'Analyses de documents', sample ? { runs: sample.runs } : null, (x) => n(x.runs)),
    M('facts_extracted', 'Faits extraits', f, (x) => n(x.total)),
    M('facts_canonical', 'Faits canonicalisés', f, (x) => n(x.canonical)),
    M('facts_canonical_rate', 'Taux de canonicalisation', f, (x) => pct(n(x.canonical), n(x.total)), 'percent',
      'Aucun fait extrait sur la période.'),
    M('facts_generic', 'Génériques non mappés', f, (x) => n(x.generic)),
    M('facts_unresolved_target', 'Faits à cible non résolue', f, (x) => n(x.unresolved)),
    M('target_errors', 'Erreurs de cible et de fait', sRow, () => targetErrors),
    ...T1_TARGET_ERROR_CODES.map((c) => M(`warning_${c.toLowerCase()}`, T1_ERROR_LABELS[c], sRow, w(c))),
    M('provenance_text', 'Provenance : texte', f, (x) => n(x.textual)),
    M('provenance_visual', 'Provenance : visuel', f, (x) => n(x.visual)),
    M('provenance_table', 'Provenance : tableau', f, (x) => n(x.tabular)),
    M('master_fallback_steps', 'Replis master → étapes', sRow, w('MASTER_FALLBACK_STEPS')),
    ...usage,
  ];
  const tables: MetricTable[] = sample ? [{
    key: 't1_warnings',
    label: 'Avertissements d’analyse par code',
    columns: [{ key: 'code', label: 'Code' }, { key: 'count', label: 'Occurrences' }],
    rows: [...sample.warnings.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
  }] : [];
  const notes = [sample && sampleNote(sample)].filter((x): x is string => !!x);
  return { metrics, tables, notes };
}

/** Motifs de rétractation T3 (décisions de réconciliation). */
export const T3_RETRACTION_CODES = ['NO_REMAINING_EVIDENCE', 'STALE_AUTO_VALUE_REPLACED'] as const;

async function domainT3(s: Scope, errors: string[]): Promise<DomainResult> {
  const usage = await usageMetrics('DATA_RECONCILIATION', s, errors);
  const p = bp(s);
  const defs: Array<[string, string]> = [
    ['evidence_active', 'Preuves ACTIVE'], ['evidence_superseded', 'Preuves SUPERSEDED'], ['evidence_withdrawn', 'Preuves WITHDRAWN'],
    ['fields_updated', 'Champs mis à jour'], ['user_overwrites_blocked', 'Écrasements USER bloqués'],
    ['conflicts_open', 'Conflits ouverts'], ['retractions', 'Rétractations'],
  ];
  if (!p) return { metrics: [...usage, ...nullMetrics(defs, NO_BUSINESS_PERIOD)], tables: [], notes: [] };

  const ev = await tryMany(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')::int AS active,
            COUNT(*) FILTER (WHERE lifecycle_status = 'SUPERSEDED')::int AS superseded,
            COUNT(*) FILTER (WHERE lifecycle_status = 'WITHDRAWN')::int AS withdrawn
       FROM field_evidence WHERE extracted_at >= $1 AND extracted_at < $2`,
    p, errors, 'Preuves',
  );
  const wr = await tryMany(
    `SELECT COUNT(*) FILTER (WHERE outcome = 'written' AND NOT dry_run)::int AS written,
            COUNT(*) FILTER (WHERE outcome = 'protected' AND NOT dry_run)::int AS protected,
            COUNT(*) FILTER (WHERE outcome = 'conflict' AND NOT dry_run)::int AS conflict,
            COUNT(*) FILTER (WHERE outcome = 'invalid' AND NOT dry_run)::int AS invalid,
            COUNT(*) FILTER (WHERE dry_run AND divergence IS NOT NULL)::int AS shadow_divergences
       FROM canonical_field_writes
      WHERE created_at >= $1 AND created_at < $2
        AND origin IN ('DOCUMENT_EXTRACTION', 'RECONCILIATION', 'SYSTEM_RULE')`,
    p, errors, 'Écritures canoniques',
  );
  const cf = await tryMany(
    `SELECT COUNT(*)::int AS opened, COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS still_open
       FROM to_process_actions
      WHERE created_at >= $1 AND created_at < $2 AND action_kind = 'ARBITRATE'`,
    p, errors, 'Conflits',
  );
  const dec = await tryMany(
    `SELECT d.reason_code AS code, COUNT(*)::int AS n
       FROM reconciliation_runs r JOIN reconciliation_decisions d ON d.run_id = r.id
      WHERE r.started_at >= $1 AND r.started_at < $2
      GROUP BY d.reason_code ORDER BY n DESC LIMIT 30`,
    p, errors, 'Décisions de réconciliation',
  );
  const e = ev ? ev[0] ?? {} : null;
  const w = wr ? wr[0] ?? {} : null;
  const c = cf ? cf[0] ?? {} : null;
  const byCode = new Map((dec ?? []).map((r) => [String(r.code), n(r.n)]));
  const d: Row | null = dec ? {} : null;
  return {
    metrics: [
      M('evidence_active', 'Preuves ACTIVE', e, (x) => n(x.active)),
      M('evidence_superseded', 'Preuves SUPERSEDED', e, (x) => n(x.superseded)),
      M('evidence_withdrawn', 'Preuves WITHDRAWN', e, (x) => n(x.withdrawn)),
      M('fields_updated', 'Champs mis à jour', w, (x) => n(x.written)),
      M('user_overwrites_blocked', 'Écrasements USER bloqués', w, (x) => n(x.protected)),
      M('write_conflicts', 'Écritures refusées (valeur changée)', w, (x) => n(x.conflict)),
      M('write_invalid', 'Écritures invalides', w, (x) => n(x.invalid)),
      M('shadow_divergences', 'Divergences en observation', w, (x) => n(x.shadow_divergences)),
      M('conflicts_opened', 'Conflits ouverts sur la période', c, (x) => n(x.opened)),
      M('conflicts_open', 'Conflits toujours ouverts', c, (x) => n(x.still_open)),
      M('retractions', 'Rétractations', d, () => T3_RETRACTION_CODES.reduce((a, k) => a + (byCode.get(k) ?? 0), 0)),
      M('retraction_no_evidence', 'Retraits (NO_REMAINING_EVIDENCE)', d, () => byCode.get('NO_REMAINING_EVIDENCE') ?? 0),
      M('retraction_stale_replaced', 'Remplacements (STALE_AUTO_VALUE_REPLACED)', d, () => byCode.get('STALE_AUTO_VALUE_REPLACED') ?? 0),
      ...usage,
    ],
    tables: dec ? [{
      key: 't3_decisions',
      label: 'Décisions de réconciliation par motif',
      columns: [{ key: 'code', label: 'Motif' }, { key: 'count', label: 'Décisions' }],
      rows: [...byCode.entries()].map(([code, count]) => ({ code, count })),
    }] : [],
    notes: [],
  };
}

async function domainT4(s: Scope, errors: string[]): Promise<DomainResult> {
  const usage = await usageMetrics('AGENDA_INTELLIGENCE', s, errors);
  const p = bp(s);
  const defs: Array<[string, string]> = [
    ['candidates', 'Candidats'], ['events_created', 'Événements créés'], ['events_updated', 'Événements mis à jour'],
    ['events_removed', 'Événements retirés'], ['orphans', 'Orphelins sans source'], ['proposal_cards', 'Cartes AGENDA-PROPOSAL'],
  ];
  if (!p) return { metrics: [...usage, ...nullMetrics(defs, NO_BUSINESS_PERIOD)], tables: [], notes: [] };

  const it = await tryMany(
    `SELECT COUNT(*)::int AS created,
            COUNT(*) FILTER (WHERE a.event_nature = 'HISTORICAL')::int AS historical,
            COUNT(*) FILTER (WHERE a.event_nature = 'DEADLINE')::int AS deadline,
            COUNT(*) FILTER (WHERE a.home_category = 'action')::int AS action,
            COUNT(*) FILTER (WHERE a.home_category = 'information')::int AS information,
            COUNT(*) FILTER (WHERE a.home_category IS NULL)::int AS unknown,
            COUNT(*) FILTER (WHERE a.origin_ref_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM agenda_item_sources x WHERE x.agenda_item_id = a.id))::int AS orphans
       FROM agenda_items a
      WHERE a.created_at >= $1 AND a.created_at < $2 AND a.is_automatic`,
    p, errors, 'Événements automatiques',
  );
  const src = await tryMany(
    `SELECT effect_type AS code, COUNT(*)::int AS n FROM agenda_item_sources
      WHERE created_at >= $1 AND created_at < $2 GROUP BY effect_type`,
    p, errors, 'Sources d’événements',
  );
  const rm = await tryMany(
    `SELECT COALESCE(reason, '—') AS code, COUNT(*)::int AS n FROM agenda_item_removals
      WHERE removed_at >= $1 AND removed_at < $2 GROUP BY 1 ORDER BY n DESC LIMIT 20`,
    p, errors, 'Retraits d’événements',
  );
  const cards = await tryMany(
    `SELECT COUNT(*)::int AS opened, COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
            COUNT(*) FILTER (WHERE resolution_reason IN ('USER_ARBITRATED', 'USER_COMPLETED'))::int AS accepted
       FROM to_process_actions
      WHERE created_at >= $1 AND created_at < $2 AND rule_code = 'AGENDA-PROPOSAL'`,
    p, errors, 'Cartes AGENDA-PROPOSAL',
  );
  const sample = await analysisSample(p, errors);
  const i = it ? it[0] ?? {} : null;
  const effects = new Map((src ?? []).map((r) => [String(r.code), n(r.n)]));
  const sr: Row | null = src ? {} : null;
  const removals = (rm ?? []).map((r) => ({ code: String(r.code), count: n(r.n) }));
  const k = cards ? cards[0] ?? {} : null;
  return {
    metrics: [
      M('candidates', 'Candidats proposés par T1', sample ? {} : null, () => sample!.candidates),
      M('events_created', 'Événements créés', i, (x) => n(x.created)),
      M('events_updated', 'Événements mis à jour (source rattachée)', sr, () => effects.get('resolved_existing') ?? 0),
      M('events_removed', 'Événements retirés', rm ? {} : null, () => removals.reduce((a, r) => a + r.count, 0)),
      M('events_historical', 'HISTORICAL', i, (x) => n(x.historical)),
      M('events_deadline', 'DEADLINE', i, (x) => n(x.deadline)),
      M('orphans', 'Orphelins sans source', i, (x) => n(x.orphans)),
      M('rejected_orphans', 'Candidats rejetés (orphelins)', sr, () => effects.get('rejected_orphan') ?? 0),
      M('conflicts_pending', 'Rattachements en conflit', sr, () => effects.get('conflict_pending') ?? 0),
      M('class_action', 'Classés « action »', i, (x) => n(x.action)),
      M('class_information', 'Classés « information »', i, (x) => n(x.information)),
      M('class_unknown', 'Classement inconnu', i, (x) => n(x.unknown)),
      M('proposal_cards', 'Cartes AGENDA-PROPOSAL', k, (x) => n(x.opened)),
      M('proposal_cards_open', 'Cartes AGENDA-PROPOSAL ouvertes', k, (x) => n(x.open)),
      M('proposal_cards_accepted', 'Cartes AGENDA-PROPOSAL traitées', k, (x) => n(x.accepted)),
      ...usage,
    ],
    tables: rm ? [{
      key: 't4_removals',
      label: 'Retraits d’événements par motif',
      columns: [{ key: 'code', label: 'Motif' }, { key: 'count', label: 'Retraits' }],
      rows: removals,
    }] : [],
    notes: [sample && sampleNote(sample)].filter((x): x is string => !!x),
  };
}

const TRUTH_LABELS: Readonly<Record<T2TruthSource, string>> = {
  canonique: 'Canonique', fait: 'Fait T1', tableau: 'Tableau T1', document: 'Document', agenda: 'Agenda',
  export: 'Export', regle_offre: 'Règle d’offre', centre_aide: 'Centre d’aide', modele: 'Modèle (sans source)',
  clarification: 'Clarification', aucune: 'Sans résultat', autre: 'Autre',
};

/** Seuil d'affichage de la distribution du coût d'une offre (anonymisation). */
export const COST_PLAN_MIN_ACCOUNTS = 5;
const MASQUE_COMPTES = `< ${COST_PLAN_MIN_ACCOUNTS} comptes`;

const usd = (micros: unknown): string => `${(n(micros) / 1_000_000).toFixed(4)} $`;

/** Instance qui répond (compteurs en mémoire) : conteneur Scalingo, sinon hôte. */
function instanceLabel(): string {
  return (process.env.CONTAINER || process.env.HOSTNAME || hostname() || 'instance').slice(0, 40);
}

/**
 * Indicateurs techniques T2 — CDC Assistant §32.2 (lot 19) : timeouts,
 * erreurs par service, jetons, coût par compte et par offre (agrégé, AUCUN
 * identifiant de compte), volume de sources récupérées / affichées,
 * incidents de cloisonnement, versions de modèles et de prompts. Plus les
 * compteurs d'événements métier §25.7 et d'incidents de cloisonnement de
 * l'INSTANCE qui répond (mémoire, depuis son démarrage — arbitrage lot 19 :
 * non persistés, non agrégés entre instances, remis à zéro au redémarrage).
 * Coût par offre : offre ACTUELLE du compte (arbitrage lot 19) ; médiane et
 * maximum masqués sous `COST_PLAN_MIN_ACCOUNTS` comptes.
 */
async function t2Technical(s: Scope, p: [string, string], total: number, errors: string[]): Promise<DomainResult> {
  const W = `created_at >= $1 AND created_at < $2`;
  const usageWhere = `created_at >= $1 AND created_at < $2 AND use_case_code = 'INTELLIGENT_ASSISTANT'
                      AND operation_type <> 'circuit_breaker_probe' AND ($3::int IS NULL OR config_version_id = $3::int)`;
  const usageParams = [s.from.toISOString(), s.to.toISOString(), s.versionId];

  const runs = await tryMany(
    `SELECT COUNT(*) FILTER (WHERE error_code = 'REQUEST_TIMEOUT'
              OR retrieval_methods_json->>'strategy' LIKE 'timeout.%')::int AS timeouts,
            COALESCE(SUM(candidate_count), 0)::bigint AS retrieved,
            COALESCE(SUM(source_count), 0)::bigint AS shown,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(retrieval_methods_json->'securityEvents') = 'array'
                                                      THEN retrieval_methods_json->'securityEvents' ELSE '[]'::jsonb END) ev
               WHERE ev->>'code' = 'MODEL_UNKNOWN_SOURCE_REJECTED'))::int AS scope_incidents
       FROM verebona_request_runs WHERE ${W} AND status <> 'pending'`,
    p, errors, 'Indicateurs techniques T2',
  );
  const reqErrors = await tryMany(
    `SELECT COALESCE(error_code, '—') AS code, COUNT(*)::int AS n FROM verebona_request_runs
      WHERE ${W} AND status = 'error' GROUP BY 1 ORDER BY n DESC LIMIT 15`,
    p, errors, 'Erreurs des demandes',
  );
  const services = await tryMany(
    `SELECT COALESCE(operation_code, operation_type, '—') AS service, COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE status <> 'success')::int AS errors,
            COALESCE(SUM(input_tokens), 0)::bigint AS tin, COALESCE(SUM(output_tokens), 0)::bigint AS tout
       FROM ai_usage_event WHERE ${usageWhere}
      GROUP BY 1 ORDER BY calls DESC LIMIT 20`,
    usageParams, errors, 'Appels modèle par service',
  );
  // Coût par compte et par offre : distribution par compte (médiane, max),
  // jamais l'identifiant. Offre COURANTE du compte (`accounts.plan_type`).
  const plans = await tryMany(
    `WITH par_compte AS (
       SELECT account_id, COUNT(*)::int AS calls,
              COALESCE(SUM(cost_micros) FILTER (WHERE is_billable), 0)::bigint AS cost
         FROM ai_usage_event WHERE ${usageWhere} AND account_id IS NOT NULL
        GROUP BY account_id
     )
     SELECT CASE WHEN GROUPING(a.plan_type) = 1 THEN '*' ELSE COALESCE(a.plan_type, '—') END AS plan,
            COUNT(*)::int AS accounts, SUM(pc.calls)::int AS calls, SUM(pc.cost)::bigint AS cost,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pc.cost)::bigint AS median, MAX(pc.cost)::bigint AS max
       FROM par_compte pc LEFT JOIN accounts a ON a.id = pc.account_id
      GROUP BY GROUPING SETS ((a.plan_type), ())`,
    usageParams, errors, 'Coût par offre',
  );
  const versions = await tryMany(
    `SELECT COALESCE(model, '—') AS model, COALESCE(metadata->>'promptVersion', '—') AS prompt,
            COALESCE(master_prompt_version, '—') AS master, COUNT(*)::int AS n
       FROM ai_usage_event WHERE ${usageWhere}
      GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 20`,
    usageParams, errors, 'Versions de modèles et de prompts',
  );

  const r = runs ? runs[0] ?? {} : null;
  const sv: Row | null = services ? {} : null;
  const somme = (k: string) => (services ?? []).reduce((a, x) => a + n(x[k]), 0);
  const reqErr = (reqErrors ?? []).reduce((a, x) => a + n(x.n), 0);
  const tous = (plans ?? []).find((x) => x.plan === '*');
  const pl: Row | null = plans ? (tous ?? {}) : null;
  const vr: Row | null = versions ? {} : null;
  const distincts = (k: string) => new Set((versions ?? []).map((x) => String(x[k])).filter((v) => v !== '—')).size;
  const evenements = businessEventCounters();
  const incidents = scopeIncidentCounters();
  const depuis = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const instance = instanceLabel();

  const tables: MetricTable[] = [];
  if (services || reqErrors) {
    tables.push({
      key: 't2_service_errors', label: 'Erreurs par service',
      columns: [{ key: 'service', label: 'Service' }, { key: 'calls', label: 'Appels' }, { key: 'errors', label: 'Erreurs' }, { key: 'rate', label: 'Taux' }],
      rows: [
        ...(services ?? []).map((x) => ({
          service: `modèle · ${String(x.service)}`, calls: n(x.calls), errors: n(x.errors),
          rate: n(x.calls) > 0 ? `${Math.round((n(x.errors) / n(x.calls)) * 1000) / 10} %` : '—',
        })),
        ...(reqErrors ?? []).map((x) => ({
          service: `assistant · ${String(x.code)}`, calls: total, errors: n(x.n),
          rate: total > 0 ? `${Math.round((n(x.n) / total) * 1000) / 10} %` : '—',
        })),
      ],
    });
  }
  if (plans) {
    tables.push({
      key: 't2_cost_by_plan', label: 'Coût par offre (distribution par compte, sans identifiant)',
      columns: [{ key: 'plan', label: 'Offre' }, { key: 'accounts', label: 'Comptes' }, { key: 'calls', label: 'Appels' },
        { key: 'cost', label: 'Coût' }, { key: 'median', label: 'Médiane / compte' }, { key: 'max', label: 'Max / compte' }],
      // Moins de COST_PLAN_MIN_ACCOUNTS comptes : médiane et maximum masqués
      // (ils désigneraient presque un compte précis).
      rows: plans.filter((x) => x.plan !== '*').map((x) => {
        const masque = n(x.accounts) < COST_PLAN_MIN_ACCOUNTS;
        return {
          plan: String(x.plan), accounts: n(x.accounts), calls: n(x.calls), cost: usd(x.cost),
          median: masque ? MASQUE_COMPTES : usd(x.median), max: masque ? MASQUE_COMPTES : usd(x.max),
        };
      }),
    });
  }
  if (versions) {
    tables.push({
      key: 't2_versions', label: 'Versions de modèles et de prompts',
      columns: [{ key: 'model', label: 'Modèle' }, { key: 'prompt', label: 'Prompt' }, { key: 'master', label: 'Master' }, { key: 'count', label: 'Appels' }],
      rows: versions.map((x) => ({ model: String(x.model), prompt: String(x.prompt), master: String(x.master), count: n(x.n) })),
    });
  }
  tables.push({
    key: 't2_business_events', label: `Événements métier §25.7 — instance ${instance}, depuis ${depuis.slice(0, 16).replace('T', ' ')} UTC`,
    columns: [{ key: 'code', label: 'Événement' }, { key: 'count', label: 'Publiés' }],
    rows: Object.entries(evenements).map(([code, count]) => ({ code, count })),
  });

  return {
    metrics: [
      M('timeout_rate', 'Taux de timeout', r, (x) => (total > 0 ? Math.round((n(x.timeouts) / total) * 1000) / 10 : null), 'percent', 'Aucune demande sur la période.'),
      M('timeouts', 'Demandes en timeout', r, (x) => n(x.timeouts)),
      M('service_errors', 'Erreurs (modèle + assistant)', sv && reqErrors ? {} : null, () => somme('errors') + reqErr),
      M('tokens_in', 'Jetons d’entrée', sv, () => somme('tin')),
      M('tokens_out', 'Jetons de sortie', sv, () => somme('tout')),
      M('accounts_using', 'Comptes ayant appelé le modèle', pl, (x) => n(x.accounts)),
      M('avg_cost_per_account', 'Coût moyen par compte', pl, (x) => (n(x.accounts) > 0 ? Math.round(n(x.cost) / n(x.accounts)) : null), 'usd_micros', 'Aucun compte sur la période.'),
      M('sources_retrieved', 'Sources récupérées', r, (x) => n(x.retrieved)),
      M('sources_shown', 'Sources affichées', r, (x) => n(x.shown)),
      M('scope_incidents', 'Incidents de cloisonnement (sources hors périmètre rejetées)', r, (x) => n(x.scope_incidents)),
      M('scope_incidents_instance', 'Surcharges de compte refusées (instance)', {}, () => incidents.CLIENT_ACCOUNT_OVERRIDE),
      M('model_versions', 'Modèles utilisés', vr, () => distincts('model')),
      M('prompt_versions', 'Versions de prompt utilisées', vr, () => distincts('prompt') + distincts('master')),
    ],
    tables,
    notes: [
      `Compteurs d’instance (événements métier §25.7, surcharges de compte refusées) : instance « ${instance} », en mémoire depuis son démarrage — non agrégés entre instances, remis à zéro au redémarrage.`,
      'Coût par offre : offre ACTUELLE de chaque compte ; aucun identifiant de compte n’est affiché.',
    ],
  };
}

/**
 * Indicateurs d'usage — CDC Assistant §32.3 (lot 21, D-J7) : ouvertures,
 * clics sur l'action principale et les autres, ouvertures de source, copies,
 * retours. Événements ANONYMES (`verebona_usage_events`) : aucun compte.
 * Taux rapportés au nombre de demandes de la période.
 */
async function t2Usage(p: [string, string], total: number, errors: string[]): Promise<DomainResult> {
  const rows = await tryMany(
    `SELECT event_type AS type, COALESCE(value, '—') AS value, COALESCE(plan, '—') AS plan, COUNT(*)::int AS n
       FROM verebona_usage_events WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 200`,
    p, errors, 'Indicateurs d’usage',
  );
  const r: Row | null = rows ? {} : null;
  const compte = (type: string, value?: string) => (rows ?? [])
    .filter((x) => x.type === type && (value === undefined || x.value === value)).reduce((a, x) => a + n(x.n), 0);
  const taux = (k: number) => (total > 0 ? Math.round((k / total) * 1000) / 10 : null);
  const parOffre = new Map<string, Record<string, number>>();
  for (const x of rows ?? []) {
    const o = parOffre.get(String(x.plan)) ?? {};
    o[String(x.type)] = (o[String(x.type)] ?? 0) + n(x.n);
    parOffre.set(String(x.plan), o);
  }
  return {
    metrics: [
      M('usage_opens', 'Ouvertures de Verebona', r, () => compte('ASSISTANT_OPEN')),
      M('usage_primary_clicks', 'Clics sur l’action principale', r, () => compte('ACTION_CLICK', 'primary')),
      M('usage_primary_click_rate', 'Réponses menant à l’action principale', r, () => taux(compte('ACTION_CLICK', 'primary')), 'percent', 'Aucune demande sur la période.'),
      M('usage_other_clicks', 'Clics sur une autre action', r, () => compte('ACTION_CLICK', 'secondary')),
      M('usage_source_opens', 'Ouvertures de source', r, () => compte('SOURCE_OPEN')),
      M('usage_source_open_rate', 'Taux d’ouverture d’une source', r, () => taux(compte('SOURCE_OPEN')), 'percent', 'Aucune demande sur la période.'),
      M('usage_copies', 'Réponses copiées', r, () => compte('ANSWER_COPY')),
      M('usage_feedback_positive', 'Retours positifs', r, () => compte('FEEDBACK', 'helpful')),
      M('usage_feedback_negative', 'Retours négatifs', r, () => compte('FEEDBACK', 'not_helpful')),
    ],
    tables: rows ? [{
      key: 't2_usage_by_plan', label: 'Usage par offre (§32.3, anonyme)',
      columns: [{ key: 'plan', label: 'Offre' }, { key: 'opens', label: 'Ouvertures' }, { key: 'clicks', label: 'Clics' },
        { key: 'sources', label: 'Sources' }, { key: 'copies', label: 'Copies' }, { key: 'feedback', label: 'Retours' }],
      rows: [...parOffre.entries()].map(([plan, o]) => ({
        plan, opens: o.ASSISTANT_OPEN ?? 0, clicks: o.ACTION_CLICK ?? 0, sources: o.SOURCE_OPEN ?? 0,
        copies: o.ANSWER_COPY ?? 0, feedback: o.FEEDBACK ?? 0,
      })),
    }] : [],
    notes: ['Indicateurs d’usage : événements anonymes envoyés par l’application (aucun compte, aucun utilisateur), conservés 13 mois.'],
  };
}

async function domainT2(s: Scope, errors: string[]): Promise<DomainResult> {
  const usage = await usageMetrics('INTELLIGENT_ASSISTANT', s, errors);
  const p = bp(s);
  const defs: Array<[string, string]> = [
    ['requests', 'Demandes'], ['no_result', 'Sans résultat'], ['clarifications', 'Clarifications'],
    ['revalidations', 'Revalidations'], ['claims_rejected', 'Claims rejetées'],
  ];
  if (!p) return { metrics: [...usage, ...nullMetrics(defs, NO_BUSINESS_PERIOD)], tables: [], notes: [] };

  const W = `created_at >= $1 AND created_at < $2`;
  const tot = await tryMany(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE machine_final_state = 'CLARIFYING'
              OR retrieval_methods_json->>'strategy' LIKE 'clarification.%')::int AS clarifications,
            COALESCE(SUM(CASE WHEN jsonb_typeof(retrieval_methods_json->'revalidations') = 'array'
              THEN jsonb_array_length(retrieval_methods_json->'revalidations') ELSE 0 END), 0)::int AS revalidations,
            COUNT(*) FILTER (WHERE jsonb_typeof(retrieval_methods_json->'revalidations') = 'array'
              AND jsonb_array_length(retrieval_methods_json->'revalidations') > 0)::int AS revalidated_requests,
            AVG(source_count)::float8 AS avg_sources,
            COUNT(*) FILTER (WHERE retrieval_methods_json ? 'observability')::int AS traced
       FROM verebona_request_runs WHERE ${W}`,
    p, errors, 'Demandes T2',
  );
  const strat = await tryMany(
    `SELECT retrieval_methods_json->>'strategy' AS strategy,
            retrieval_methods_json->'observability'->>'truthSource' AS truth,
            COUNT(*)::int AS n
       FROM verebona_request_runs WHERE ${W} GROUP BY 1, 2`,
    p, errors, 'Stratégies T2',
  );
  const claims = await tryMany(
    `SELECT split_part(e, ':', 2) AS code, COUNT(*)::int AS n
       FROM verebona_request_runs r
       CROSS JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(r.retrieval_methods_json->'aiEvents') = 'array'
              THEN r.retrieval_methods_json->'aiEvents' ELSE '[]'::jsonb END) e
      WHERE r.created_at >= $1 AND r.created_at < $2 AND e LIKE 'CLAIM_UNSUPPORTED:%'
      GROUP BY 1 ORDER BY n DESC LIMIT 20`,
    p, errors, 'Claims rejetées',
  );
  const intents = await tryMany(
    `SELECT COALESCE(intent, '—') AS code, COUNT(*)::int AS n FROM verebona_request_runs
      WHERE ${W} GROUP BY 1 ORDER BY n DESC LIMIT 20`,
    p, errors, 'Intentions',
  );
  const targets = await tryMany(
    `SELECT COALESCE(retrieval_methods_json->'observability'->'target'->>'type', 'aucune') AS type,
            COALESCE(retrieval_methods_json->'observability'->'target'->>'origin', '—') AS origin,
            COUNT(*)::int AS n
       FROM verebona_request_runs WHERE ${W} AND retrieval_methods_json ? 'observability'
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`,
    p, errors, 'Cibles',
  );
  const types = await tryMany(
    `SELECT t.key AS code, SUM(CASE WHEN t.value ~ '^[0-9]+$' THEN t.value::int ELSE 0 END)::int AS n
       FROM verebona_request_runs r
       CROSS JOIN LATERAL jsonb_each_text(
         CASE WHEN jsonb_typeof(r.retrieval_methods_json->'observability'->'sourceTypes') = 'object'
              THEN r.retrieval_methods_json->'observability'->'sourceTypes' ELSE '{}'::jsonb END) t
      WHERE r.created_at >= $1 AND r.created_at < $2
      GROUP BY 1 ORDER BY n DESC LIMIT 20`,
    p, errors, 'Types de source',
  );

  const t = tot ? tot[0] ?? {} : null;
  const truth = new Map<T2TruthSource, number>();
  for (const r of strat ?? []) {
    const ts = (T2_TRUTH_SOURCES as readonly string[]).includes(String(r.truth))
      ? (r.truth as T2TruthSource)
      : truthSourceOf(r.strategy == null ? null : String(r.strategy));
    truth.set(ts, (truth.get(ts) ?? 0) + n(r.n));
  }
  const st: Row | null = strat ? {} : null;
  const claimRows = (claims ?? []).map((r) => ({ code: String(r.code || '—'), count: n(r.n) }));
  const total = t ? n(t.total) : 0;
  const tables: MetricTable[] = [];
  if (strat) {
    tables.push({
      key: 't2_truth', label: 'Source de vérité ayant répondu',
      columns: [{ key: 'code', label: 'Source' }, { key: 'count', label: 'Demandes' }],
      rows: T2_TRUTH_SOURCES.filter((k) => truth.has(k)).map((k) => ({ code: TRUTH_LABELS[k], count: truth.get(k)! }))
        .sort((a, b) => b.count - a.count),
    });
  }
  if (claims) tables.push({ key: 't2_claims', label: 'Claims rejetées par motif (CLAIM_UNSUPPORTED)', columns: [{ key: 'code', label: 'Motif' }, { key: 'count', label: 'Claims' }], rows: claimRows });
  if (intents) tables.push({ key: 't2_intents', label: 'Intentions', columns: [{ key: 'code', label: 'Intention' }, { key: 'count', label: 'Demandes' }], rows: intents.map((r) => ({ code: String(r.code), count: n(r.n) })) });
  if (targets) tables.push({ key: 't2_targets', label: 'Cibles (type · origine)', columns: [{ key: 'type', label: 'Type' }, { key: 'origin', label: 'Origine' }, { key: 'count', label: 'Demandes' }], rows: targets.map((r) => ({ type: String(r.type), origin: String(r.origin), count: n(r.n) })) });
  if (types) tables.push({ key: 't2_source_types', label: 'Sources citées par type', columns: [{ key: 'code', label: 'Type' }, { key: 'count', label: 'Sources' }], rows: types.map((r) => ({ code: String(r.code), count: n(r.n) })) });

  const notes: string[] = [];
  if (t && n(t.traced) < total) {
    notes.push(`Cible et types de source : tracés depuis le lot 17 (${n(t.traced)} demandes sur ${total}) ; les demandes antérieures n’en portent pas.`);
  }
  // §32.2 (lot 19) : indicateurs techniques et compteurs d'instance.
  const tech = await t2Technical(s, p, total, errors);
  // §32.3 (lot 21, D-J7) : indicateurs d'usage anonymes.
  const usage32 = await t2Usage(p, total, errors);
  return {
    metrics: [
      M('requests', 'Demandes', t, (x) => n(x.total)),
      M('no_result', 'Sans résultat', st, () => truth.get('aucune') ?? 0),
      M('no_result_rate', 'Taux sans résultat', st, () => pct(truth.get('aucune') ?? 0, total), 'percent', 'Aucune demande sur la période.'),
      M('clarifications', 'Clarifications', t, (x) => n(x.clarifications)),
      M('revalidations', 'Revalidations', t, (x) => n(x.revalidations)),
      M('revalidated_requests', 'Demandes avec revalidation', t, (x) => n(x.revalidated_requests)),
      M('claims_rejected', 'Claims rejetées', claims ? {} : null, () => claimRows.reduce((a, r) => a + r.count, 0)),
      M('avg_sources', 'Sources par demande (moyenne)', t, (x) => (x.avg_sources == null ? null : Math.round(Number(x.avg_sources) * 100) / 100), 'decimal'),
      ...usage,
      ...tech.metrics,
      ...usage32.metrics,
    ],
    tables: [...tables, ...tech.tables, ...usage32.tables],
    notes: [...notes, ...tech.notes, ...usage32.notes],
  };
}

async function domainConfig(s: Scope, errors: string[]): Promise<DomainResult> {
  const params = [s.from.toISOString(), s.to.toISOString(), s.versionId];
  const where = `created_at >= $1 AND created_at < $2 AND operation_type <> 'circuit_breaker_probe'
                 AND ($3::int IS NULL OR config_version_id = $3::int)`;
  const agg = await tryMany(
    `SELECT COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE config_version_id IS NOT NULL)::int AS with_version,
            COUNT(*) FILTER (WHERE metadata->>'engine' = 'new')::int AS engine_new,
            COUNT(*) FILTER (WHERE metadata->>'engine' = 'legacy')::int AS engine_legacy,
            COUNT(*) FILTER (WHERE model_rank IN ('fallback_1', 'fallback_2') OR is_fallback)::int AS fallbacks,
            COUNT(*) FILTER (WHERE metadata ? 'reasoning')::int AS with_reasoning,
            COUNT(*) FILTER (WHERE metadata ? 'maxOutputTokens')::int AS with_max_tokens,
            COUNT(*) FILTER (WHERE metadata ? 'trigger')::int AS with_trigger,
            COUNT(DISTINCT config_version_id)::int AS versions,
            COUNT(DISTINCT model)::int AS models
       FROM ai_usage_event WHERE ${where}`,
    params, errors, 'Appels IA',
  );
  const detail = await tryMany(
    `SELECT COALESCE(use_case_code, '—') AS use_case, config_version_id AS version,
            COALESCE(metadata->>'engine', '—') AS engine, COALESCE(model, '—') AS model,
            COALESCE(model_rank, CASE WHEN is_fallback THEN 'fallback' ELSE '—' END) AS rank,
            COALESCE(metadata->>'reasoning', '—') AS reasoning,
            COALESCE(metadata->>'maxOutputTokens', '—') AS max_tokens,
            COALESCE(metadata->>'trigger', '—') AS trigger, COUNT(*)::int AS n
       FROM ai_usage_event WHERE ${where}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8 ORDER BY n DESC LIMIT 60`,
    params, errors, 'Détail de configuration',
  );
  const a = agg ? agg[0] ?? {} : null;
  const calls = a ? n(a.calls) : 0;
  const untraced = (k: string) => (x: Row) => (calls > 0 ? calls - n(x[k]) : 0);
  return {
    metrics: [
      M('calls', 'Appels IA', a, (x) => n(x.calls)),
      M('with_version', 'Appels avec version tracée', a, (x) => pct(n(x.with_version), calls), 'percent', 'Aucun appel sur la période.'),
      M('versions', 'Versions ayant servi', a, (x) => n(x.versions)),
      M('engine_new', 'Moteur new', a, (x) => n(x.engine_new)),
      M('engine_legacy', 'Moteur legacy', a, (x) => n(x.engine_legacy)),
      M('engine_untraced', 'Moteur non tracé', a, (x) => calls - n(x.engine_new) - n(x.engine_legacy)),
      M('models', 'Modèles distincts', a, (x) => n(x.models)),
      M('fallbacks', 'Replis de modèle', a, (x) => n(x.fallbacks)),
      M('reasoning_untraced', 'Raisonnement non tracé', a, untraced('with_reasoning')),
      M('max_tokens_untraced', 'Max tokens non tracé', a, untraced('with_max_tokens')),
      M('trigger_traced', 'Appels avec déclencheur', a, (x) => n(x.with_trigger)),
    ],
    tables: detail ? [{
      key: 'config_detail',
      label: 'Configuration effective des appels',
      columns: [
        { key: 'use_case', label: 'Cas d’usage' }, { key: 'version', label: 'Version' }, { key: 'engine', label: 'Moteur' },
        { key: 'model', label: 'Modèle' }, { key: 'rank', label: 'Rang' }, { key: 'reasoning', label: 'Raisonnement' },
        { key: 'max_tokens', label: 'Max tokens' }, { key: 'trigger', label: 'Déclencheur' }, { key: 'count', label: 'Appels' },
      ],
      rows: detail.map((r) => ({
        use_case: String(r.use_case), version: r.version == null ? '—' : `#${String(r.version)}`, engine: String(r.engine),
        model: String(r.model), rank: String(r.rank), reasoning: String(r.reasoning), max_tokens: String(r.max_tokens),
        trigger: String(r.trigger), count: n(r.n),
      })),
    }] : [],
    notes: ['Le déclencheur n’est tracé que pour les appels issus de la file (T1, T3, T4) ; T2, T5 et T6 sont synchrones.'],
  };
}

/** Motifs d'exclusion d'une pièce jointe au dossier. */
export const EXPORT_MISSING_REASONS = ['missing', 'corrupted', 'protected', 'unreadable', 'too_large'] as const;
export const EXPORT_SCOPE_REASONS = ['occupant_data', 'sensitive_not_explicit'] as const;

async function domainExports(s: Scope, errors: string[]): Promise<DomainResult> {
  const p: [string, string] = [s.from.toISOString(), s.to.toISOString()];
  const g = await tryMany(
    `WITH g AS (
       SELECT status, snapshot_json->'dataSource' AS ds FROM export_generation
        WHERE created_at >= $1 AND created_at < $2
     )
     SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('ready', 'partial'))::int AS done,
            COUNT(*) FILTER (WHERE status IN ('failed', 'error'))::int AS failed,
            COUNT(*) FILTER (WHERE ds->>'source' = 'canonical')::int AS canonical,
            COUNT(*) FILTER (WHERE ds->>'source' = 'legacy')::int AS legacy,
            COUNT(*) FILTER (WHERE ds->>'mode' = 'shadow')::int AS shadow,
            COALESCE(SUM((ds->'shadowDiff'->>'fields')::int), 0)::int AS diff_fields,
            COALESCE(SUM((ds->'shadowDiff'->>'documentsOnlyLegacy')::int + (ds->'shadowDiff'->>'documentsOnlyCanonical')::int), 0)::int AS diff_documents,
            COALESCE(SUM((ds->'shadowDiff'->>'events')::int), 0)::int AS diff_events,
            COUNT(*) FILTER (WHERE ds->'shadowDiff'->>'failed' = 'true')::int AS shadow_failed,
            COUNT(*) FILTER (WHERE ds->'shadowDiff' IS NOT NULL AND (
              COALESCE((ds->'shadowDiff'->>'fields')::int, 0) + COALESCE((ds->'shadowDiff'->>'events')::int, 0)
              + COALESCE((ds->'shadowDiff'->>'documentsOnlyLegacy')::int, 0) + COALESCE((ds->'shadowDiff'->>'documentsOnlyCanonical')::int, 0)) > 0)::int AS divergent,
            COALESCE(SUM(CASE WHEN jsonb_typeof(ds->'unconfirmedDocuments') = 'array'
              THEN jsonb_array_length(ds->'unconfirmedDocuments') ELSE 0 END), 0)::int AS unconfirmed_dropped,
            COALESCE(SUM((ds->'shadowDiff'->>'addedUnconfirmed')::int), 0)::int AS unconfirmed_shadow
       FROM g`,
    p, errors, 'Générations d’export',
  );
  const items = await tryMany(
    `SELECT i.reason AS code, COUNT(*)::int AS n
       FROM export_generation g JOIN export_generation_items i ON i.generation_id = g.id
      WHERE g.created_at >= $1 AND g.created_at < $2 AND i.status = 'excluded'
      GROUP BY i.reason ORDER BY n DESC LIMIT 20`,
    p, errors, 'Pièces exclues',
  );
  const errs = await tryMany(
    `SELECT COALESCE(error_code, '—') AS code, COUNT(*)::int AS n FROM export_generation
      WHERE created_at >= $1 AND created_at < $2 AND status IN ('failed', 'error')
      GROUP BY 1 ORDER BY n DESC LIMIT 20`,
    p, errors, 'Échecs d’export',
  );
  const r = g ? g[0] ?? {} : null;
  const ex = new Map((items ?? []).map((x) => [String(x.code), n(x.n)]));
  const it: Row | null = items ? {} : null;
  const sum = (codes: readonly string[]) => () => codes.reduce((a, c) => a + (ex.get(c) ?? 0), 0);
  const tables: MetricTable[] = [];
  if (items) tables.push({ key: 'export_exclusions', label: 'Pièces exclues par motif', columns: [{ key: 'code', label: 'Motif' }, { key: 'count', label: 'Pièces' }], rows: [...ex.entries()].map(([code, count]) => ({ code, count })) });
  if (errs) tables.push({ key: 'export_errors', label: 'Générations en échec par code', columns: [{ key: 'code', label: 'Code' }, { key: 'count', label: 'Générations' }], rows: errs.map((x) => ({ code: String(x.code), count: n(x.n) })) });
  return {
    metrics: [
      M('generations', 'Générations', r, (x) => n(x.total)),
      M('generations_failed', 'Générations en échec', r, (x) => n(x.failed)),
      M('source_canonical', 'Source canonique', r, (x) => n(x.canonical)),
      M('source_legacy', 'Source historique', r, (x) => n(x.legacy)),
      M('shadow_runs', 'Comparaisons shadow', r, (x) => n(x.shadow)),
      M('shadow_divergent', 'Dossiers divergents (shadow)', r, (x) => n(x.divergent)),
      M('shadow_diff_fields', 'Écarts de champs (CanonicalAssetView / snapshot)', r, (x) => n(x.diff_fields)),
      M('shadow_diff_documents', 'Écarts de pièces', r, (x) => n(x.diff_documents)),
      M('shadow_diff_events', 'Écarts d’événements', r, (x) => n(x.diff_events)),
      M('shadow_failed', 'Comparaisons en échec', r, (x) => n(x.shadow_failed)),
      M('linked_missing', 'Documents liés absents ou illisibles', it, sum(EXPORT_MISSING_REASONS)),
      M('scope_exclusions', 'Exclusions de périmètre', it, sum(EXPORT_SCOPE_REASONS)),
      M('unconfirmed_dropped', 'Rattachements non confirmés écartés', r, (x) => n(x.unconfirmed_dropped) + n(x.unconfirmed_shadow)),
    ],
    tables,
    notes: [
      'Exports V12 uniquement (`export_generation`). Le filtre de version IA est sans objet : un export n’appelle aucun modèle.',
      'Exclusions de périmètre : pièces écartées pour données d’occupant ou sensibilité non confirmée explicitement.',
    ],
  };
}

// ── Point d'entrée ───────────────────────────────────────────────────────────

const cache = new Map<string, { expires: number; report: ObservabilityReport }>();
let inFlight: { key: string; promise: Promise<ObservabilityReport> } | null = null;

export function clearObservabilityCache(): void {
  cache.clear();
}

function currentEnvironment(): string | null {
  try {
    return getAiEnvironment();
  } catch {
    return null;
  }
}

/**
 * Indicateurs §18 d'un domaine. `now` est injectable pour les tests.
 */
export async function getObservability(q: ObservabilityQuery, now: Date = new Date()): Promise<ObservabilityReport> {
  const days = Math.min(Math.max(Math.trunc(q.days) || 30, 1), MAX_WINDOW_DAYS);
  const versionId = q.configVersionId && Number.isInteger(q.configVersionId) && q.configVersionId > 0 ? q.configVersionId : null;
  const current = currentEnvironment();
  const requested = q.environment ? parseEnvironment(q.environment) ?? q.environment : null;

  const key = JSON.stringify([q.domain, days, versionId, requested]);
  const hit = cache.get(key);
  if (hit && hit.expires > now.getTime()) return { ...hit.report, cached: true };

  const to = now;
  const from = new Date(now.getTime() - days * 86_400_000);
  const errors: string[] = [];
  const base = {
    domain: q.domain, windowDays: days,
    period: { from: from.toISOString(), to: to.toISOString() },
    generatedAt: now.toISOString(), cached: false,
  };

  // Autre environnement : autre base (GEN-003).
  if (requested && current && requested !== current) {
    return {
      ...base,
      environment: { current, requested, readable: false },
      version: null,
      metrics: [], tables: [],
      notes: [`L’environnement « ${requested} » a sa propre base : ses indicateurs se lisent dans son back-office. Cet écran lit « ${current} ».`],
    };
  }

  // Un seul calcul à la fois par instance (une seule connexion du pool) :
  // la même demande attend le calcul en cours ; une autre reçoit son
  // dernier résultat connu, ou « en cours ».
  if (inFlight) {
    if (inFlight.key === key) return inFlight.promise;
    if (hit) return { ...hit.report, cached: true, stale: true };
    return {
      ...base,
      environment: { current, requested, readable: true },
      version: null, metrics: [], tables: [], busy: true,
      notes: ['Un autre calcul d’observabilité est en cours sur cette instance : réessayer dans quelques secondes.'],
    };
  }

  const compute = async (): Promise<ObservabilityReport> =>
    runSession(async () => {
        const useVersion = versionId !== null && q.domain !== 'EXPORTS';
        let version: ObservabilityReport['version'] = null;
        let business: Scope['business'] = { from, to };
        const notes: string[] = [];
        if (useVersion) {
          const v = await resolveVersion(versionId!, from, to, errors);
          if (v === 'unknown') {
            throw new ObservabilityVersionNotFound(versionId!);
          }
          business = v.period;
          version = {
            id: versionId!, label: v.label, scope: 'exact+period',
            period: v.period ? { from: v.period.from.toISOString(), to: v.period.to.toISOString() } : null,
          };
          notes.push('Version : filtre EXACT sur les appels IA ; les données métier (faits, preuves, agenda, demandes) sont rattachées par PÉRIODE D’EFFET de la version (approximation : elles ne portent pas la version).');
        } else if (versionId !== null) {
          version = { id: versionId, label: `#${versionId}`, scope: 'none', period: null };
        }

        const scope: Scope = { from, to, business, versionId: useVersion ? versionId : null };
        const run = {
          T1: domainT1, T2: domainT2, T3: domainT3, T4: domainT4, CONFIG: domainConfig, EXPORTS: domainExports,
        }[q.domain];
        const r = await run(scope, errors);

        const report: ObservabilityReport = {
          ...base,
          environment: { current, requested, readable: true },
          version,
          metrics: r.metrics,
          tables: r.tables,
          notes: [...notes, ...r.notes, ...errors],
        };
        // Un rapport incomplet (requête en échec) n'est pas mis en cache : la
        // prochaine ouverture retente.
        if (errors.length === 0) {
          cache.delete(key);
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
          cache.set(key, { expires: now.getTime() + CACHE_TTL_MS, report });
        }
        return report;
      }, DOMAIN_BUDGET_MS);
  const promise = compute();
  inFlight = { key, promise };
  try {
    return await promise;
  } finally {
    inFlight = null;
  }
}
