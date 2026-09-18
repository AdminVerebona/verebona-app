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

type Row = Record<string, unknown>;

export interface CostFilters {
  since?: Date;
  until?: Date;
  treatment?: Treatment;
  accountId?: number;
  configVersionId?: number;
}

export interface CostTotals {
  /** Dépense métier — ce qui sert les utilisateurs. */
  functionalMicros: number;
  /** Sondes, tests fournisseur, mode observation (MOD-013). */
  technicalMicros: number;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Appels dont le tarif était inconnu : coût non calculable, jamais inventé. */
  unpricedCalls: number;
}

export interface CostBreakdownRow {
  key: string;
  label: string;
  functionalMicros: number;
  technicalMicros: number;
  calls: number;
  unpricedCalls: number;
}

export interface CostReport {
  since: Date;
  until: Date;
  totals: CostTotals;
  byTreatment: CostBreakdownRow[];
  byModel: CostBreakdownRow[];
  byRank: CostBreakdownRow[];
  byVersion: CostBreakdownRow[];
  /** Vrai si au moins un appel n'a pas de tarif : l'agrégat est incomplet. */
  incomplete: boolean;
}

function whereClause(): string {
  return `
      WHERE e.created_at >= $1 AND e.created_at <= $2
        AND ($3::text IS NULL OR e.use_case_code = $3)
        AND ($4::int  IS NULL OR e.account_id = $4)
        AND ($5::int  IS NULL OR e.config_version_id = $5)`;
}

function params(f: CostFilters, since: Date, until: Date): unknown[] {
  return [
    since, until,
    f.treatment ? TREATMENT_DEFINITIONS[f.treatment].useCaseCode : null,
    f.accountId ?? null,
    f.configVersionId ?? null,
  ];
}

/**
 * Un appel est « non tarifé » quand il a consommé des tokens sans produire de
 * coût. Zéro token et zéro coût est un appel en échec avant facturation, pas un
 * tarif manquant — les confondre ferait croire à une grille incomplète à chaque
 * panne fournisseur.
 */
const UNPRICED = `(e.cost_micros IS NULL OR (e.cost_micros = 0 AND COALESCE(e.input_tokens, 0) > 0))`;

const AGG = `
  COALESCE(SUM(e.cost_micros) FILTER (WHERE e.is_billable), 0)::bigint      AS functional,
  COALESCE(SUM(e.cost_micros) FILTER (WHERE NOT e.is_billable), 0)::bigint  AS technical,
  COUNT(*)::int                                                            AS calls,
  COUNT(*) FILTER (WHERE ${UNPRICED})::int                                 AS unpriced`;

function toBreakdown(r: Row, label?: string): CostBreakdownRow {
  const key = r.key == null ? '—' : String(r.key);
  return {
    key,
    label: label ?? key,
    functionalMicros: Number(r.functional),
    technicalMicros: Number(r.technical),
    calls: Number(r.calls),
    unpricedCalls: Number(r.unpriced),
  };
}

const RANK_LABELS: Record<string, string> = {
  primary: 'Modèle principal',
  fallback_1: 'Premier repli',
  fallback_2: 'Second repli',
};

export async function getCostReport(f: CostFilters = {}): Promise<CostReport> {
  const until = f.until ?? new Date();
  const since = f.since ?? new Date(until.getTime() - 30 * 86_400_000);
  const p = params(f, since, until);
  const where = whereClause();

  const [totalsRows, treatmentRows, modelRows, rankRows, versionRows] = await Promise.all([
    pgClient.unsafe(
      `SELECT ${AGG},
              COUNT(*) FILTER (WHERE e.status = 'error')::int AS failed,
              COALESCE(SUM(e.input_tokens), 0)::bigint        AS input_tokens,
              COALESCE(SUM(e.output_tokens), 0)::bigint       AS output_tokens
         FROM ai_usage_event e ${where}`,
      p as never[],
    ),
    pgClient.unsafe(
      `SELECT e.use_case_code AS key, ${AGG}
         FROM ai_usage_event e ${where}
        GROUP BY e.use_case_code ORDER BY functional DESC`,
      p as never[],
    ),
    pgClient.unsafe(
      `SELECT e.model AS key, ${AGG}
         FROM ai_usage_event e ${where}
        GROUP BY e.model ORDER BY functional DESC LIMIT 20`,
      p as never[],
    ),
    pgClient.unsafe(
      `SELECT COALESCE(e.model_rank, 'inconnu') AS key, ${AGG}
         FROM ai_usage_event e ${where}
        GROUP BY e.model_rank ORDER BY functional DESC`,
      p as never[],
    ),
    pgClient.unsafe(
      `SELECT COALESCE(v.visible_number::text, 'sans version') AS key, ${AGG}
         FROM ai_usage_event e
         LEFT JOIN ai_config_versions v ON v.id = e.config_version_id
         ${where}
        GROUP BY v.visible_number ORDER BY functional DESC LIMIT 20`,
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
  };

  const treatmentLabel = (code: string): string => {
    const d = Object.values(TREATMENT_DEFINITIONS).find((x) => x.useCaseCode === code);
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
export function averageCostPerCall(totals: CostTotals): number | null {
  const priced = totals.calls - totals.unpricedCalls;
  if (priced <= 0) return null;
  return Math.round((totals.functionalMicros + totals.technicalMicros) / priced);
}
