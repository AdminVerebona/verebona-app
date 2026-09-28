/**
 * Alertes d'exploitation de l'assistant — CDC §31.3, §15.13 (BO IA ALT-01).
 *
 * Les alertes coût (par réponse, plafond mensuel) existaient ; manquaient :
 *
 *   · escalation_rate   : taux d'escalade > 10 % sur 24 h (§31.3) ;
 *   · token_drift       : jetons moyens par appel en hausse de plus de 30 %
 *                         sur 7 jours, comparés aux 7 jours précédents ;
 *   · model_mismatch    : modèle résolu différent du modèle attendu pour
 *                         l'alias sur plus de 1 % des appels (24 h) ;
 *   · model_deprecation : modèle actif annoncé déprécié — à J-30 (warning)
 *                         ou date dépassée (critique) (§15.13).
 *
 * Mesures lues dans `verebona_ai_runs` (alias, modèle attendu et modèle
 * réellement appelé — migration 0204) et `ai_model_catalog.deprecation_date`.
 * Les alertes sont celles du BO IA (`ai_alerts`, tableau de bord) :
 * dédupliquées par jour, jamais d'arrêt automatique (COST-013).
 *
 * Évalué toutes les heures par le boucleur de la file IA
 * (`queue-worker.runEvaluators`, passage réservé en base).
 */
import type { AlertInput } from '@/services/ai/alerts/alerts.repository';
import { configuredAliases, configuredDeprecations, resolveAliases } from '../registries/model-registry';

type Row = Record<string, unknown>;

/** Seuils (§31.3), surchargeables sans changer le code (§43). */
export function alertThresholds(): { escalationRate: number; tokenDrift: number; mismatchRate: number; deprecationDays: number; minSample: number } {
  const n = (name: string, def: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : def;
  };
  return {
    escalationRate: n('VEREBONA_ASSISTANT_ALERT_ESCALATION_RATE', 0.10),
    tokenDrift: n('VEREBONA_ASSISTANT_ALERT_TOKEN_DRIFT', 0.30),
    mismatchRate: n('VEREBONA_ASSISTANT_ALERT_MODEL_MISMATCH_RATE', 0.01),
    deprecationDays: n('VEREBONA_ASSISTANT_ALERT_DEPRECATION_DAYS', 30),
    minSample: n('VEREBONA_ASSISTANT_ALERT_MIN_SAMPLE', 20),
  };
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
}

export interface AlertVerdict {
  code: 'escalation_rate' | 'token_drift' | 'model_mismatch' | 'model_deprecation';
  severity: 'warning' | 'critical';
  message: string;
  details: Record<string, unknown>;
  /** Clé de déduplication, sans la date (ajoutée à l'émission). */
  key: string;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;

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
    const r = await resolveAliases('generate_answer');
    const a = configuredAliases();
    return [
      ...(r.default ? [{ model: r.default, alias: a.default }] : []),
      ...(r.escalation ? [{ model: r.escalation, alias: a.escalation }] : []),
    ];
  },
};

/** Un passage : mesure, évalue, alerte (dédupliqué par jour). Ne lève jamais. */
export async function evaluateAssistantAlerts(
  deps: AssistantAlertDeps = defaultDeps,
  now: Date = new Date(),
): Promise<AlertVerdict[]> {
  try {
    const m = await measureAssistantAlertMetrics(deps);
    const verdicts = evaluateAssistantAlertRules(m, now);
    const jour = now.toISOString().slice(0, 10);
    for (const v of verdicts) {
      await deps.raiseAlert({
        kind: 'anomaly',
        code: `assistant_${v.code}`,
        treatment: 'T2',
        severity: v.severity,
        message: v.message,
        details: v.details,
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
