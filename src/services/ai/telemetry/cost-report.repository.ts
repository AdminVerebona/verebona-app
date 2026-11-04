/**
 * Agrégation des coûts IA — CDC BO IA SCR-09, §9.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « AUCUN RECALCUL HISTORIQUE APRÈS CHANGEMENT TARIFAIRE »
 *
 * Le SCR-09 l'impose, et c'est structurant : les coûts sont lus dans
 * `cost_micros`, figé au moment de l'appel, jamais recalculés à partir des
 * tokens et du tarif courant. Une grille qui change ne réécrit pas le passé —
 * sinon le coût affiché d'un mois clos changerait d'un jour à l'autre, et plus
 * aucun chiffre ne serait opposable.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « TARIF MANQUANT : AFFICHER COÛT NON CALCULABLE, PAS UN REPLI SILENCIEUX »
 *
 * D'où la distinction, partout, entre un coût nul et un coût inconnu. Un appel
 * sans tarif a `cost_micros` à zéro dans la table — indiscernable d'un appel
 * réellement gratuit si l'on se contente de sommer. Les deux sont donc comptés
 * séparément, et l'incomplétude est remontée avec l'agrégat plutôt que noyée
 * dedans.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FONCTIONNEL ET TECHNIQUE NE SE MÉLANGENT PAS
 *
 * Le SCR-09 sépare « fonctionnel/métier » et « technique/tests », et le MOD-013
 * classe les probes en technique. Sans cette séparation, une campagne de sondes
 * pendant une panne gonflerait la dépense métier du jour et ferait chercher une
 * dérive là où il n'y a qu'un incident. `is_billable` porte déjà la
 * distinction : les opérations internes et le mode observation sont à faux.
 */
import { pgClient } from '@/db';
import type { Treatment } from '../config/treatments';
import { TREATMENT_DEFINITIONS } from '../config/treatments';
import { t6ModeSql } from './execution-log.repository';
import type { T6ModeFilter } from './execution-filters';
import { activeCorrectionJoin, completenessOf, pricingStatusSql, unknownCostSql, type CostCompleteness } from './cost-status';

type Row = Record<string, unknown>;

interface CostFilters {
  since?: Date;
  until?: Date;
  treatment?: Treatment;
  accountId?: number;
  configVersionId?: number;
  /**
   * CDC Mascotte BO-009 : génération T6 affichée, pré-génération ou texte de
   * secours. Lu sur les appels détaillés seulement : les agrégats journaliers
   * (> 90 jours, archivés) n'en gardent pas la trace et sont alors exclus.
   */
  t6Mode?: T6ModeFilter;
}

interface CostTotals {
  /** Dépense métier — ce qui sert les utilisateurs. */
  functionalMicros: number;
  /** Sondes, tests fournisseur, mode observation (MOD-013). */
  technicalMicros: number;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Appels dont le coût reste INCONNU (après régularisation) : jamais inventé. */
  unpricedCalls: number;
  /** Lot 109L : coût initial figé à l'appel (avant régularisation). */
  initialMicros?: number;
  /** Lot 109L : appels régularisés et leur coût corrigé (compris dans les totaux, une seule fois). */
  regularizedCalls?: number;
  regularizedMicros?: number;
  /** Lot 109L : ventilation par statut tarifaire effectif. */
  byStatus?: { applied: number; zeroOrRounded: number; missing: number; insufficientUsage: number; legacyUndetermined: number; regularized: number };
  /** Lot 109L : appels chiffrés sur un tarif non confirmé (STALE). */
  staleTariffCalls?: number;
  /** Lot 109L : complet / partiel / inconnu. */
  completeness?: CostCompleteness;
}

interface CostBreakdownRow {
  key: string;
  label: string;
  functionalMicros: number;
  technicalMicros: number;
  calls: number;
  unpricedCalls: number;
  /** Lot 109L. */
  regularizedCalls?: number;
  completeness?: CostCompleteness;
}

interface CostReport {
  since: Date;
  until: Date;
  totals: CostTotals;
  byTreatment: CostBreakdownRow[];
  byModel: CostBreakdownRow[];
  byRank: CostBreakdownRow[];
  byVersion: CostBreakdownRow[];
  /** CST-UI-06, COST-003, COST-014 : comptes les plus coûteux (pas de budget par compte). */
  byAccount: CostBreakdownRow[];
  /** Vrai si au moins un appel n'a pas de tarif : l'agrégat est incomplet. */
  incomplete: boolean;
}

function whereClause(): string {
  return `
      WHERE e.created_at >= $1 AND e.created_at <= $2
        AND ($3::text IS NULL OR e.use_case_code = $3)
        AND ($4::int  IS NULL OR e.account_id = $4)
        AND ($5::int  IS NULL OR e.config_version_id = $5)
        AND ($6::text IS NULL OR e.t6_mode = $6)`;
}

/**
 * ⚠️ LES DATES PARTENT EN CHAÎNE ISO, JAMAIS EN OBJET `Date`.
 *
 * `pgClient.unsafe()` ne sérialise pas les `Date` — contrairement aux requêtes
 * en gabarit balisé, qui le font. Leur passer un objet lève :
 *
 *   TypeError: The "string" argument must be of type string or an instance of
 *   Buffer or ArrayBuffer. Received an instance of Date
 *
 * C'est ce qui a mis le tableau de bord et l'écran Coûts hors service le
 * 21/09/2026, sans que rien ne le laisse voir : l'erreur survient dans le
 * pilote, pas dans la requête, et ne cite donc aucune colonne.
 *
 * Les comparaisons SQL portent déjà un `::timestamptz` : une chaîne ISO y est
 * convertie sans ambiguïté, fuseau compris.
 */
function params(f: CostFilters, since: Date, until: Date): unknown[] {
  return [
    since.toISOString(), until.toISOString(),
    f.treatment ? TREATMENT_DEFINITIONS[f.treatment].useCaseCode : null,
    f.accountId ?? null,
    f.configVersionId ?? null,
    f.t6Mode ?? null,
  ];
}

/**
 * Lot 109L (point C) : l'heuristique `cost_micros = 0 AND input_tokens > 0`
 * est REMPLACÉE par le statut tarifaire effectif (`cost-status.ts`) — écrit à
 * la trace, déduit pour les traces anciennes. Un coût connu arrondi à zéro
 * n'est plus « sans tarif » ; un appel à jetons de sortie seuls l'est s'il n'a
 * pas de tarif. Conservée pour le mode dégradé (migration 1150 absente).
 */
const LEGACY_UNPRICED = `(cost_micros IS NULL OR (cost_micros = 0 AND COALESCE(input_tokens, 0) > 0))`;

/**
 * Source normalisée : appels en base (≤ 90 jours) + agrégats journaliers des
 * appels archivés sur S3 (`ai_usage_daily_rollup`, WF-25). Chaque ligne porte
 * son nombre d'appels (`n`) : les agrégats se somment, ils ne se comptent pas.
 * Sans elle, l'écran Coûts perdrait tout ce qui a plus de 90 jours.
 *
 * Lot 109L : coût EFFECTIF = correction active (régularisation) sinon coût
 * initial — jamais les deux (aucun double comptage) ; un appel régularisé
 * n'est plus inconnu. Les agrégats journaliers anciens portent le compteur de
 * l'ancienne heuristique : leurs « sans tarif » sont « historique sans preuve »
 * tant qu'une correction d'agrégat ne les a pas reconstitués.
 */
function sourceSql(mode: 'v1150' | 'legacy'): string {
  if (mode === 'legacy') {
    return `(
    SELECT created_at, use_case_code, account_id, config_version_id, model, model_rank, is_billable,
           cost_micros, cost_micros AS initial_cost, 0::bigint AS regularized_cost, 0 AS regularized_n,
           input_tokens, output_tokens, 1 AS n,
           (u.status = 'error')::int AS failed_n, (${LEGACY_UNPRICED})::int AS unpriced_n,
           0 AS applied_n, 0 AS zero_n, (${LEGACY_UNPRICED})::int AS missing_n, 0 AS unmeasured_n, 0 AS legacy_n, 0 AS stale_n,
           ${t6ModeSql('u')} AS t6_mode
      FROM ai_usage_event u
    UNION ALL
    SELECT (day::timestamp AT TIME ZONE 'UTC') AS created_at, use_case_code, account_id, config_version_id, model,
           model_rank, is_billable, cost_micros, cost_micros, 0::bigint, 0, input_tokens, output_tokens, calls AS n,
           failed_calls AS failed_n, unpriced_calls AS unpriced_n, 0, 0, 0, 0, unpriced_calls, 0, NULL::text AS t6_mode
      FROM ai_usage_daily_rollup
  ) e`;
  }
  const st = pricingStatusSql('u');
  return `(
    SELECT u.created_at, u.use_case_code, u.account_id, u.config_version_id, u.model, u.model_rank, u.is_billable,
           COALESCE(c.corrected_cost_micros, u.cost_micros) AS cost_micros, u.cost_micros AS initial_cost,
           COALESCE(c.corrected_cost_micros, 0) AS regularized_cost, (c.id IS NOT NULL)::int AS regularized_n,
           u.input_tokens, u.output_tokens, 1 AS n,
           (u.status = 'error')::int AS failed_n, (c.id IS NULL AND ${unknownCostSql('u')})::int AS unpriced_n,
           (c.id IS NULL AND ${st} = 'applied')::int AS applied_n,
           (c.id IS NULL AND ${st} = 'zero_or_rounded')::int AS zero_n,
           (c.id IS NULL AND ${st} = 'missing')::int AS missing_n,
           (c.id IS NULL AND ${st} = 'insufficient_usage')::int AS unmeasured_n,
           (c.id IS NULL AND ${st} = 'legacy_undetermined')::int AS legacy_n,
           (c.id IS NULL AND COALESCE(u.metadata->'pricing'->>'stale', 'false') = 'true')::int AS stale_n,
           ${t6ModeSql('u')} AS t6_mode
      FROM ai_usage_event u
      ${activeCorrectionJoin('u', 'c')}
    UNION ALL
    SELECT (r.day::timestamp AT TIME ZONE 'UTC') AS created_at, r.use_case_code, r.account_id, r.config_version_id, r.model,
           r.model_rank, r.is_billable, COALESCE(rc.corrected_cost_micros, r.cost_micros) AS cost_micros, r.cost_micros AS initial_cost,
           COALESCE(rc.corrected_cost_micros, 0) AS regularized_cost, CASE WHEN rc.id IS NOT NULL THEN r.unpriced_calls ELSE 0 END AS regularized_n,
           r.input_tokens, r.output_tokens, r.calls AS n,
           r.failed_calls AS failed_n, CASE WHEN rc.id IS NULL THEN r.unpriced_calls ELSE 0 END AS unpriced_n,
           r.calls - r.unpriced_calls AS applied_n, 0 AS zero_n, 0 AS missing_n, 0 AS unmeasured_n,
           CASE WHEN rc.id IS NULL THEN r.unpriced_calls ELSE 0 END AS legacy_n, 0 AS stale_n,
           NULL::text AS t6_mode
      FROM ai_usage_daily_rollup r
      LEFT JOIN ai_cost_corrections rc ON rc.target_kind = 'rollup' AND rc.target_id = r.id AND rc.reverted_at IS NULL
  ) e`;
}

const AGG = `
  COALESCE(SUM(e.cost_micros) FILTER (WHERE e.is_billable), 0)::bigint      AS functional,
  COALESCE(SUM(e.cost_micros) FILTER (WHERE NOT e.is_billable), 0)::bigint  AS technical,
  COALESCE(SUM(e.n), 0)::int                                               AS calls,
  COALESCE(SUM(e.unpriced_n), 0)::int                                      AS unpriced,
  COALESCE(SUM(e.regularized_n), 0)::int                                   AS regularized`;

function toBreakdown(r: Row, label?: string): CostBreakdownRow {
  const key = r.key == null ? '—' : String(r.key);
  return {
    key,
    label: label ?? key,
    functionalMicros: Number(r.functional),
    technicalMicros: Number(r.technical),
    calls: Number(r.calls),
    unpricedCalls: Number(r.unpriced),
    regularizedCalls: Number(r.regularized ?? 0),
    completeness: completenessOf(Number(r.calls), Number(r.unpriced)),
  };
}

const RANK_LABELS: Record<string, string> = {
  primary: 'Modèle principal',
  fallback_1: 'Premier repli',
  fallback_2: 'Second repli',
};

export async function getCostReport(f: CostFilters = {}): Promise<CostReport> {
  try {
    return await costReportIn('v1150', f);
  } catch (e) {
    // Migration 1150 absente (colonne ou table) : lecture historique, signalée.
    const code = (e as { code?: string }).code;
    if (code !== '42P01' && code !== '42703') throw e;
    console.warn('[ai-costs] migration 1150 absente — rapport des coûts en lecture historique (heuristique « sans tarif »).');
    return costReportIn('legacy', f);
  }
}

async function costReportIn(mode: 'v1150' | 'legacy', f: CostFilters): Promise<CostReport> {
  const until = f.until ?? new Date();
  const since = f.since ?? new Date(until.getTime() - 30 * 86_400_000);
  const p = params(f, since, until);
  const where = whereClause();
  const SOURCE = sourceSql(mode);

  const [totalsRows, treatmentRows, modelRows, rankRows, versionRows, accountRows] = await Promise.all([
    pgClient.unsafe(
      `SELECT ${AGG},
              COALESCE(SUM(e.failed_n), 0)::int               AS failed,
              COALESCE(SUM(e.input_tokens), 0)::bigint        AS input_tokens,
              COALESCE(SUM(e.output_tokens), 0)::bigint       AS output_tokens,
              COALESCE(SUM(e.initial_cost), 0)::bigint        AS initial_cost,
              COALESCE(SUM(e.regularized_cost), 0)::bigint    AS regularized_cost,
              COALESCE(SUM(e.applied_n), 0)::int AS applied_n, COALESCE(SUM(e.zero_n), 0)::int AS zero_n,
              COALESCE(SUM(e.missing_n), 0)::int AS missing_n, COALESCE(SUM(e.unmeasured_n), 0)::int AS unmeasured_n,
              COALESCE(SUM(e.legacy_n), 0)::int AS legacy_n, COALESCE(SUM(e.stale_n), 0)::int AS stale_n
         FROM ${SOURCE} ${where}`,
      p as never[],
    ),
    pgClient.unsafe(
      `SELECT e.use_case_code AS key, ${AGG}
         FROM ${SOURCE} ${where}
        GROUP BY e.use_case_code ORDER BY functional DESC`,
      p as never[],
    ),
    pgClient.unsafe(
      `SELECT e.model AS key, ${AGG}
         FROM ${SOURCE} ${where}
        GROUP BY e.model ORDER BY functional DESC LIMIT 20`,
      p as never[],
    ),
    pgClient.unsafe(
      `SELECT COALESCE(e.model_rank, 'inconnu') AS key, ${AGG}
         FROM ${SOURCE} ${where}
        GROUP BY e.model_rank ORDER BY functional DESC`,
      p as never[],
    ),
    pgClient.unsafe(
      `SELECT COALESCE(v.visible_number::text, 'sans version') AS key, ${AGG}
         FROM ${SOURCE}
         LEFT JOIN ai_config_versions v ON v.id = e.config_version_id
         ${where}
        GROUP BY v.visible_number ORDER BY functional DESC LIMIT 20`,
      p as never[],
    ),
    pgClient.unsafe(
      `SELECT e.account_id::text AS key, ${AGG}
         FROM ${SOURCE} ${where} AND e.account_id IS NOT NULL
        GROUP BY e.account_id ORDER BY functional DESC LIMIT 20`,
      p as never[],
    ),
  ]);

  const t = (totalsRows as unknown as Row[])[0] ?? {};
  const totals: CostTotals = {
    functionalMicros: Number(t.functional ?? 0),
    technicalMicros: Number(t.technical ?? 0),
    calls: Number(t.calls ?? 0),
    failedCalls: Number(t.failed ?? 0),
    inputTokens: Number(t.input_tokens ?? 0),
    outputTokens: Number(t.output_tokens ?? 0),
    unpricedCalls: Number(t.unpriced ?? 0),
    initialMicros: Number(t.initial_cost ?? 0),
    regularizedCalls: Number(t.regularized ?? 0),
    regularizedMicros: Number(t.regularized_cost ?? 0),
    byStatus: {
      applied: Number(t.applied_n ?? 0), zeroOrRounded: Number(t.zero_n ?? 0), missing: Number(t.missing_n ?? 0),
      insufficientUsage: Number(t.unmeasured_n ?? 0), legacyUndetermined: Number(t.legacy_n ?? 0), regularized: Number(t.regularized ?? 0),
    },
    staleTariffCalls: Number(t.stale_n ?? 0),
  };
  totals.completeness = completenessOf(totals.calls, totals.unpricedCalls);

  const treatmentLabel = (code: string): string => {
    const d = Object.values(TREATMENT_DEFINITIONS).find((x) => x.useCaseCode === code);
    // Lot 49 : AI_GOVERNANCE n'est plus « T5 » — usage technique (sondes,
    // tests fournisseur, évaluations ; anciens appels T5 compris). Mêmes
    // lignes, même somme : aucun double comptage.
    if (!d && code === 'AI_GOVERNANCE') return 'Technique · Gouvernance IA (sondes, tests, historique T5 retiré)';
    return d ? `${d.code} · ${d.label}` : code;
  };

  return {
    since,
    until,
    totals,
    byTreatment: (treatmentRows as unknown as Row[]).map((r) =>
      toBreakdown(r, r.key == null ? 'hors référentiel' : treatmentLabel(String(r.key)))),
    byModel: (modelRows as unknown as Row[]).map((r) => toBreakdown(r)),
    byRank: (rankRows as unknown as Row[]).map((r) =>
      toBreakdown(r, RANK_LABELS[String(r.key)] ?? 'Rang inconnu')),
    byVersion: (versionRows as unknown as Row[]).map((r) =>
      toBreakdown(r, r.key === 'sans version' ? 'Sans version' : `v${r.key}`)),
    byAccount: (accountRows as unknown as Row[]).map((r) => toBreakdown(r, `Compte ${r.key}`)),
    incomplete: totals.unpricedCalls > 0,
  };
}

/**
 * Coût moyen par appel, en micro-dollars.
 *
 * Calculé sur les seuls appels TARIFÉS. Diviser la dépense par le nombre total
 * d'appels ferait baisser la moyenne à chaque tarif manquant, et donnerait
 * l'illusion d'une économie là où il y a un trou de mesure.
 */
export function averageCostPerCall(totals: Pick<CostTotals, 'calls' | 'unpricedCalls' | 'functionalMicros' | 'technicalMicros'>): number | null {
  const priced = totals.calls - totals.unpricedCalls;
  if (priced <= 0) return null;
  return Math.round((totals.functionalMicros + totals.technicalMicros) / priced);
}
