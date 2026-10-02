/**
 * Alertes d'exploitation de l'assistant — CDC §31.3, §15.13 (BO IA ALT-01).
 *
 * Règles évaluées :
 *
 *   · escalation_rate   : taux d'escalade > 10 % sur 24 h (§31.3) ;
 *   · token_drift       : jetons moyens par appel en hausse de plus de 30 %
 *                         sur 7 jours, comparés aux 7 jours précédents ;
 *   · model_mismatch    : modèle résolu différent du modèle attendu pour
 *                         l'alias sur plus de 1 % des appels (24 h) ;
 *   · model_deprecation : modèle actif annoncé déprécié — à J-30 (warning)
 *                         ou date dépassée (critique) (§15.13) ;
 *   · daily_cost_per_answer : coût MOYEN par réponse intelligente sur 24 h
 *                         supérieur à 0,005 USD (§31.3). L'alerte portait
 *                         sur chaque réponse prise isolément (un seul appel
 *                         coûteux suffisait) ; c'est la moyenne qui compte ;
 *   · cost_per_active_user : coût IA sur 30 jours rapporté aux utilisateurs
 *                         actifs, par offre, au-delà du coût compatible avec
 *                         la marge de l'offre (§31.3).
 *
 * Seuils tracés (§31.3 « toute modification reste tracée ») : à chaque
 * passage, le jeu de seuils en vigueur est comparé au dernier enregistré ;
 * un changement (ou le premier passage) écrit une alerte d'information
 * `assistant_thresholds_changed` avec l'ancien et le nouveau jeu. Chaque
 * alerte porte en outre le seuil appliqué dans ses détails.
 *
 * Mesures lues dans `verebona_ai_runs` (alias, modèle attendu et modèle
 * réellement appelé — migration 0204) et `ai_model_catalog.deprecation_date`.
 * Les alertes sont celles du BO IA (`ai_alerts`, tableau de bord) :
 * dédupliquées par jour, jamais d'arrêt automatique (COST-013).
 *
 * Évalué toutes les heures par le boucleur de la file IA
 * (`queue-worker.runEvaluators`, passage réservé en base).
 */
import { createHash } from 'crypto';
import type { AlertInput } from '@/services/ai/alerts/alerts.repository';
import { configuredAliases, configuredDeprecations, resolveAliases } from '../registries/model-registry';
import { getAssistantConfig } from '../config/assistant-config';

type Row = Record<string, unknown>;

/** Offres du compte (contrainte `accounts_plan_type_check`). */
export const PLAN_TYPES = ['STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO'] as const;

export interface AlertThresholds {
  escalationRate: number;
  tokenDrift: number;
  mismatchRate: number;
  deprecationDays: number;
  minSample: number;
  /** Coût moyen par réponse intelligente sur 24 h, en USD (§31.3 : 0,005). */
  costPerAnswerUsd: number;
  /**
   * Coût IA maximal par utilisateur actif sur 30 jours, en USD, par offre :
   * au-delà, le coût n'est plus compatible avec la marge de l'offre (§31.3).
   */
  costPerActiveUserUsd: Record<string, number>;
  /** Utilisateurs actifs minimum pour affirmer un coût par utilisateur. */
  minActiveUsers: number;
  /** Plafond mensuel par compte (micro-unités) et part d'alerte (§6.6). */
  monthlyBudgetMicros: number;
  budgetAlertRatio: number;
}

/**
 * Seuils (§31.3), surchargeables sans changer le code (§43). Tout changement
 * est tracé dans `ai_alerts` au passage suivant de l'évaluateur.
 *
 * Coût par utilisateur actif : 0,30 USD / 30 jours par défaut, soit 150
 * réponses intelligentes à l'objectif de 0,002 USD — valeur provisoire, à
 * recalibrer après le pilote sur la marge réelle de chaque offre
 * (`VEREBONA_ASSISTANT_ALERT_COST_PER_ACTIVE_USER_USD`, et par offre
 * `…_USD_PREMIUM`, `…_USD_PREMIUM_DUO`…).
 */
export function alertThresholds(): AlertThresholds {
  const n = (name: string, def: number) => {
    const brut = process.env[name];
    const v = Number(brut);
    return brut != null && brut !== '' && Number.isFinite(v) && v >= 0 ? v : def;
  };
  const cfg = getAssistantConfig();
  const parUtilisateur = n('VEREBONA_ASSISTANT_ALERT_COST_PER_ACTIVE_USER_USD', 0.30);
  return {
    escalationRate: n('VEREBONA_ASSISTANT_ALERT_ESCALATION_RATE', 0.10),
    tokenDrift: n('VEREBONA_ASSISTANT_ALERT_TOKEN_DRIFT', 0.30),
    mismatchRate: n('VEREBONA_ASSISTANT_ALERT_MODEL_MISMATCH_RATE', 0.01),
    deprecationDays: n('VEREBONA_ASSISTANT_ALERT_DEPRECATION_DAYS', 30),
    minSample: n('VEREBONA_ASSISTANT_ALERT_MIN_SAMPLE', 20),
    costPerAnswerUsd: cfg.costAlertPerResponseUsd,
    costPerActiveUserUsd: Object.fromEntries(PLAN_TYPES.map((p) => [p, n(`VEREBONA_ASSISTANT_ALERT_COST_PER_ACTIVE_USER_USD_${p}`, parUtilisateur)])),
    minActiveUsers: n('VEREBONA_ASSISTANT_ALERT_MIN_ACTIVE_USERS', 5),
    monthlyBudgetMicros: cfg.monthlyBudgetMicros,
    budgetAlertRatio: cfg.budgetAlertRatio,
  };
}

/** Empreinte stable d'un jeu de seuils (clés triées). */
export function thresholdsFingerprint(t: AlertThresholds): string {
  const trier = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, trier((v as Record<string, unknown>)[k])]))
    : v);
  return createHash('sha256').update(JSON.stringify(trier(t))).digest('hex').slice(0, 16);
}

export interface AssistantAlertMetrics {
  /** Demandes avec au moins un appel modèle (24 h), et celles qui ont escaladé. */
  requestsWithAi: number;
  escalatedRequests: number;
  /** Jetons moyens par appel réussi : 7 derniers jours, 7 jours précédents. */
  avgTokensRecent: number | null;
  avgTokensPrevious: number | null;
  callsRecent: number;
  callsPrevious: number;
  /** Appels (24 h) dont le modèle attendu est connu, et ceux qui en diffèrent. */
  callsWithExpectation: number;
  mismatchedCalls: number;
  /** Modèles actifs de l'assistant et leur date de fin annoncée. */
  deprecations: Array<{ model: string; alias: string; date: string }>;
  /** Réponses intelligentes (≥ 1 appel modèle facturé) sur 24 h, et leur coût total (micro-USD). */
  answers24h?: number;
  cost24hMicros?: number;
  /** Par offre, sur 30 jours : coût IA total (micro-USD) et utilisateurs actifs de l'assistant. */
  costByPlan?: Array<{ planType: string; costMicros: number; activeUsers: number }>;
}

export interface AlertVerdict {
  code: 'escalation_rate' | 'token_drift' | 'model_mismatch' | 'model_deprecation'
    | 'daily_cost_per_answer' | 'cost_per_active_user';
  severity: 'warning' | 'critical';
  message: string;
  details: Record<string, unknown>;
  /** Clé de déduplication, sans la date (ajoutée à l'émission). */
  key: string;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;
const usd = (micros: number) => `${(micros / 1_000_000).toFixed(4)} USD`;

/** Évaluation PURE des règles (testée sans base). */
export function evaluateAssistantAlertRules(
  m: AssistantAlertMetrics,
  now: Date = new Date(),
  t = alertThresholds(),
): AlertVerdict[] {
  const out: AlertVerdict[] = [];

  if (m.requestsWithAi >= t.minSample) {
    const taux = m.escalatedRequests / m.requestsWithAi;
    if (taux > t.escalationRate) {
      out.push({
        code: 'escalation_rate', severity: 'warning', key: 'escalation_rate',
        message: `Assistant : taux d'escalade de ${pct(taux)} sur 24 h (seuil ${pct(t.escalationRate)}).`,
        details: { rate: taux, threshold: t.escalationRate, requests: m.requestsWithAi, escalated: m.escalatedRequests },
      });
    }
  }

  if (m.callsRecent >= t.minSample && m.callsPrevious >= t.minSample
      && m.avgTokensRecent != null && m.avgTokensPrevious != null && m.avgTokensPrevious > 0) {
    const derive = (m.avgTokensRecent - m.avgTokensPrevious) / m.avgTokensPrevious;
    if (derive > t.tokenDrift) {
      out.push({
        code: 'token_drift', severity: 'warning', key: 'token_drift',
        message: `Assistant : jetons moyens par appel en hausse de ${pct(derive)} sur 7 jours (seuil ${pct(t.tokenDrift)}).`,
        details: { drift: derive, threshold: t.tokenDrift, recent: m.avgTokensRecent, previous: m.avgTokensPrevious },
      });
    }
  }

  if (m.callsWithExpectation >= t.minSample) {
    const taux = m.mismatchedCalls / m.callsWithExpectation;
    if (taux > t.mismatchRate) {
      out.push({
        code: 'model_mismatch', severity: 'warning', key: 'model_mismatch',
        message: `Assistant : modèle résolu différent du modèle attendu pour ${pct(taux)} des appels (seuil ${pct(t.mismatchRate)}).`,
        details: { rate: taux, threshold: t.mismatchRate, calls: m.callsWithExpectation, mismatched: m.mismatchedCalls },
      });
    }
  }

  // §31.3 : moyenne JOURNALIÈRE par réponse, pas chaque réponse isolée.
  const reponses = m.answers24h ?? 0;
  const seuilReponse = t.costPerAnswerUsd * 1_000_000;
  if (seuilReponse > 0 && reponses >= t.minSample) {
    const moyenne = (m.cost24hMicros ?? 0) / reponses;
    if (moyenne > seuilReponse) {
      out.push({
        code: 'daily_cost_per_answer', severity: 'warning', key: 'daily_cost_per_answer',
        message: `Assistant : coût moyen de ${usd(moyenne)} par réponse sur 24 h (seuil ${usd(seuilReponse)}).`,
        details: { averageMicros: Math.round(moyenne), thresholdMicros: seuilReponse, answers: reponses, totalMicros: m.cost24hMicros ?? 0 },
      });
    }
  }

  // §31.3 : coût par utilisateur actif incompatible avec la marge de l'offre.
  for (const p of m.costByPlan ?? []) {
    const seuilUsd = t.costPerActiveUserUsd[p.planType];
    if (seuilUsd == null || seuilUsd <= 0 || p.activeUsers < t.minActiveUsers) continue;
    const parUtilisateur = p.costMicros / p.activeUsers;
    const seuil = seuilUsd * 1_000_000;
    if (parUtilisateur > seuil) {
      out.push({
        code: 'cost_per_active_user', severity: 'warning', key: `cost_per_active_user:${p.planType}`,
        message: `Assistant : coût IA de ${usd(parUtilisateur)} par utilisateur actif sur 30 jours pour l'offre ${p.planType} (seuil ${usd(seuil)}, marge de l'offre).`,
        details: { planType: p.planType, perUserMicros: Math.round(parUtilisateur), thresholdMicros: seuil, activeUsers: p.activeUsers, costMicros: p.costMicros },
      });
    }
  }

  const jour = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const d of m.deprecations) {
    const fin = Date.parse(`${d.date}T00:00:00Z`);
    if (!Number.isFinite(fin)) continue;
    const jours = Math.round((fin - jour) / 86_400_000);
    if (jours > t.deprecationDays) continue;
    out.push({
      code: 'model_deprecation',
      severity: jours <= 0 ? 'critical' : 'warning',
      key: `model_deprecation:${d.model}`,
      message: jours <= 0
        ? `Assistant : le modèle ${d.model} (${d.alias}) est déprécié depuis le ${d.date} — remplacement à tester et activer.`
        : `Assistant : le modèle ${d.model} (${d.alias}) est annoncé déprécié le ${d.date} (dans ${jours} j) — remplacement à tester.`,
      details: { model: d.model, alias: d.alias, date: d.date, daysLeft: jours },
    });
  }
  return out;
}

// ── Mesures en base ─────────────────────────────────────────────────────────

export interface AssistantAlertDeps {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  raiseAlert(a: AlertInput): Promise<boolean>;
  resolveActiveModels(): Promise<Array<{ model: string; alias: string }>>;
}

export async function measureAssistantAlertMetrics(deps: Pick<AssistantAlertDeps, 'query' | 'resolveActiveModels'>): Promise<AssistantAlertMetrics> {
  const aliases = configuredAliases();
  const [esc] = await deps.query(
    `SELECT COUNT(DISTINCT request_id)::int AS requetes,
            COUNT(DISTINCT request_id) FILTER (WHERE fallback_used OR model_alias LIKE $1)::int AS escaladees
       FROM verebona_ai_runs
      WHERE created_at > NOW() - interval '24 hours' AND status <> 'cached'`,
    [`${aliases.escalation}:%`],
  ).catch((): Row[] => [{}]);
  const [tok] = await deps.query(
    `SELECT AVG(input_tokens + output_tokens) FILTER (WHERE created_at > NOW() - interval '7 days')::float AS recent,
            COUNT(*) FILTER (WHERE created_at > NOW() - interval '7 days')::int AS n_recent,
            AVG(input_tokens + output_tokens) FILTER (WHERE created_at <= NOW() - interval '7 days')::float AS previous,
            COUNT(*) FILTER (WHERE created_at <= NOW() - interval '7 days')::int AS n_previous
       FROM verebona_ai_runs
      WHERE status = 'ok' AND created_at > NOW() - interval '14 days'`,
  ).catch((): Row[] => [{}]);
  const [mis] = await deps.query(
    `SELECT COUNT(*) FILTER (WHERE expected_model_id IS NOT NULL)::int AS attendus,
            COUNT(*) FILTER (WHERE expected_model_id IS NOT NULL AND resolved_model_id <> expected_model_id)::int AS ecarts
       FROM verebona_ai_runs
      WHERE status = 'ok' AND resolved_model_id IS NOT NULL AND created_at > NOW() - interval '24 hours'`,
  ).catch((): Row[] => [{}]);

  // Coût moyen par réponse (24 h) : coût de TOUTES les tentatives facturées
  // (réparations, escalades et échecs compris), rapporté aux demandes ayant
  // obtenu une réponse du modèle. Les réponses servies par le cache modèle ne
  // coûtent rien et ne diluent pas la moyenne.
  const [cout] = await deps.query(
    `SELECT COUNT(DISTINCT request_id) FILTER (WHERE status = 'ok')::int AS reponses,
            COALESCE(SUM(estimated_cost_micros) FILTER (WHERE status <> 'cached'), 0)::bigint AS total
       FROM verebona_ai_runs
      WHERE created_at > NOW() - interval '24 hours'`,
  ).catch((): Row[] => [{}]);
  // Coût par utilisateur actif (30 jours), par offre du compte.
  const parOffre = await deps.query(
    `WITH couts AS (
       SELECT account_id, SUM(estimated_cost_micros)::bigint AS cout
         FROM verebona_ai_runs WHERE created_at > NOW() - interval '30 days' GROUP BY account_id
     ), actifs AS (
       SELECT account_id, COUNT(DISTINCT user_id)::int AS n
         FROM verebona_request_runs
        WHERE created_at > NOW() - interval '30 days' AND user_id IS NOT NULL
        GROUP BY account_id
     )
     SELECT acc.plan_type, COALESCE(SUM(c.cout), 0)::bigint AS cout, COALESCE(SUM(a.n), 0)::int AS actifs
       FROM actifs a
       JOIN accounts acc ON acc.id = a.account_id
       LEFT JOIN couts c ON c.account_id = a.account_id
      GROUP BY acc.plan_type`,
  ).catch((): Row[] => []);

  const actifs = await deps.resolveActiveModels().catch(() => []);
  const saisies = configuredDeprecations();
  const catalogue = actifs.length
    ? await deps.query(
      `SELECT model, to_char(deprecation_date, 'YYYY-MM-DD') AS date
         FROM ai_model_catalog WHERE model = ANY($1::text[]) AND deprecation_date IS NOT NULL`,
      [actifs.map((a) => a.model)],
    ).catch((): Row[] => [])
    : [];
  const dates = new Map<string, string>(catalogue.map((r) => [String(r.model), String(r.date)]));
  for (const [m, d] of saisies) dates.set(m, d);
  const deprecations = actifs
    .filter((a) => dates.has(a.model))
    .map((a) => ({ model: a.model, alias: a.alias, date: dates.get(a.model)! }));

  const num = (v: unknown) => (v == null ? 0 : Number(v));
  return {
    requestsWithAi: num(esc?.requetes),
    escalatedRequests: num(esc?.escaladees),
    avgTokensRecent: tok?.recent == null ? null : Number(tok.recent),
    avgTokensPrevious: tok?.previous == null ? null : Number(tok.previous),
    callsRecent: num(tok?.n_recent),
    callsPrevious: num(tok?.n_previous),
    callsWithExpectation: num(mis?.attendus),
    mismatchedCalls: num(mis?.ecarts),
    deprecations,
    answers24h: num(cout?.reponses),
    cost24hMicros: num(cout?.total),
    costByPlan: parOffre.map((r) => ({ planType: String(r.plan_type), costMicros: num(r.cout), activeUsers: num(r.actifs) })),
  };
}

const defaultDeps: AssistantAlertDeps = {
  async query(sql, params = []) {
    const { pgClient } = await import('@/db');
    return (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
  },
  async raiseAlert(a) {
    return (await import('@/services/ai/alerts/alerts.repository')).raiseAlert(a);
  },
  async resolveActiveModels() {
    const r = await resolveAliases('t2_answer');
    const a = configuredAliases();
    return [
      ...(r.default ? [{ model: r.default, alias: a.default }] : []),
      ...(r.escalation ? [{ model: r.escalation, alias: a.escalation }] : []),
    ];
  },
};

/**
 * Trace des seuils (§31.3) : le jeu en vigueur est comparé au dernier
 * enregistré dans `ai_alerts` ; s'il diffère (ou n'a jamais été enregistré),
 * une alerte d'information est écrite avec l'ancien et le nouveau jeu.
 * Dédupliquée par transition (dernière trace → nouveau jeu) : chaque
 * changement, retour arrière compris, est tracé une fois sur toutes les
 * instances. Rend `true` si un changement a été tracé.
 */
export async function traceAlertThresholds(
  deps: Pick<AssistantAlertDeps, 'query' | 'raiseAlert'>,
  t: AlertThresholds = alertThresholds(),
): Promise<boolean> {
  const empreinte = thresholdsFingerprint(t);
  const [dernier] = await deps.query(
    `SELECT id, details FROM ai_alerts WHERE code = 'assistant_thresholds_changed' ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).catch((): Row[] => []);
  const precedent = (dernier?.details ?? null) as { fingerprint?: string; thresholds?: unknown } | null;
  if (precedent?.fingerprint === empreinte) return false;
  return deps.raiseAlert({
    kind: 'anomaly',
    code: 'assistant_thresholds_changed',
    treatment: 'T2',
    severity: 'info',
    message: precedent
      ? 'Assistant : seuils d\'alerte modifiés (§31.3) — ancien et nouveau jeu en détail.'
      : 'Assistant : seuils d\'alerte en vigueur enregistrés (§31.3).',
    details: { fingerprint: empreinte, thresholds: t, previousFingerprint: precedent?.fingerprint ?? null, previous: precedent?.thresholds ?? null },
    drilldownHref: '/admin/ai-executions?treatment=T2',
    // Transition précédent → nouveau, rattachée à la dernière trace : un
    // retour à un jeu déjà connu (A → B → A) est tracé à son tour, et deux
    // instances qui constatent le même changement n'écrivent qu'une ligne.
    dedupeKey: `assistant:thresholds:${dernier?.id ?? 'initial'}:${precedent?.fingerprint ?? 'none'}->${empreinte}`,
  }).catch(() => false);
}

/** Un passage : trace les seuils, mesure, évalue, alerte (dédupliqué par jour). Ne lève jamais. */
export async function evaluateAssistantAlerts(
  deps: AssistantAlertDeps = defaultDeps,
  now: Date = new Date(),
): Promise<AlertVerdict[]> {
  try {
    const t = alertThresholds();
    await traceAlertThresholds(deps, t);
    const m = await measureAssistantAlertMetrics(deps);
    const verdicts = evaluateAssistantAlertRules(m, now, t);
    const jour = now.toISOString().slice(0, 10);
    const empreinte = thresholdsFingerprint(t);
    for (const v of verdicts) {
      const cout = v.code === 'daily_cost_per_answer' || v.code === 'cost_per_active_user';
      await deps.raiseAlert({
        kind: cout ? 'budget' : 'anomaly',
        code: `assistant_${v.code}`,
        treatment: 'T2',
        severity: v.severity,
        message: v.message,
        // Jeu de seuils appliqué : rattache l'alerte à sa configuration tracée.
        details: { ...v.details, thresholdsFingerprint: empreinte },
        drilldownHref: v.code === 'model_deprecation' ? '/admin/ai-provider' : '/admin/ai-executions?treatment=T2',
        dedupeKey: `assistant:${v.key}:${jour}`,
      }).catch(() => false);
    }
    return verdicts;
  } catch (e) {
    console.error('[verebona][alertes] évaluation impossible (non bloquant) :', (e as Error).message);
    return [];
  }
}
