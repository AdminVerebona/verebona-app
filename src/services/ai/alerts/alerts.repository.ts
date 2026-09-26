/**
 * Alertes système du BO IA — CDC BO IA ALT-01, WF-22, WF-44, COST-011,
 * COST-013, T1-UI-09, T3-UI-06, T4-UI-05 (migration 0175).
 *
 * Une alerte est un CONSTAT, jamais une action : aucune n'arrête un
 * traitement par elle-même (COST-013). Seul un garde-fou configuré en
 * réaction « suspension » suspend, et c'est l'évaluateur de garde-fous qui le
 * fait, pas l'alerte.
 *
 * Toutes les écritures sont idempotentes par `dedupe_key` : un évaluateur qui
 * repasse sur la même condition (même fenêtre) ne duplique rien.
 */
import { pgClient } from '@/db';

type Row = Record<string, unknown>;

export type AlertKind = 'guardrail' | 'budget' | 'anomaly';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertInput {
  kind: AlertKind;
  code: string;
  treatment?: string | null;
  accountId?: number | null;
  severity?: AlertSeverity;
  message: string;
  details?: Record<string, unknown>;
  /** Lien préfiltré vers les exécutions responsables (COST-009, WF-22 étape 143). */
  drilldownHref?: string | null;
  dedupeKey: string;
  configVersionId?: number | null;
}

export interface AiAlert {
  id: number;
  kind: AlertKind;
  code: string;
  treatment: string | null;
  accountId: number | null;
  severity: AlertSeverity;
  message: string;
  details: Record<string, unknown>;
  drilldownHref: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
}

/** Rend `true` si l'alerte est nouvelle (première occurrence de la condition). */
export async function raiseAlert(a: AlertInput): Promise<boolean> {
  const rows = await pgClient.unsafe(
    `INSERT INTO ai_alerts
       (kind, code, treatment, account_id, severity, message, details, drilldown_href, dedupe_key, config_version_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      a.kind, a.code, a.treatment ?? null, a.accountId ?? null, a.severity ?? 'warning',
      a.message.slice(0, 1000), JSON.stringify(a.details ?? {}), a.drilldownHref ?? null,
      a.dedupeKey, a.configVersionId ?? null,
    ] as never[],
  );
  return (rows as unknown as Row[]).length > 0;
}

function toAlert(r: Row): AiAlert {
  return {
    id: Number(r.id),
    kind: String(r.kind) as AlertKind,
    code: String(r.code),
    treatment: r.treatment == null ? null : String(r.treatment),
    accountId: r.account_id == null ? null : Number(r.account_id),
    severity: String(r.severity) as AlertSeverity,
    message: String(r.message),
    details: (r.details ?? {}) as Record<string, unknown>,
    drilldownHref: r.drilldown_href == null ? null : String(r.drilldown_href),
    createdAt: new Date(String(r.created_at)).toISOString(),
    acknowledgedAt: r.acknowledged_at ? new Date(String(r.acknowledged_at)).toISOString() : null,
  };
}

export async function listAlerts(filters: {
  openOnly?: boolean; kind?: AlertKind; treatment?: string; limit?: number;
} = {}): Promise<AiAlert[]> {
  const rows = await pgClient.unsafe(
    `SELECT id, kind, code, treatment, account_id, severity, message, details, drilldown_href,
            created_at, acknowledged_at
       FROM ai_alerts
      WHERE ($1::boolean IS NOT TRUE OR acknowledged_at IS NULL)
        AND ($2::text IS NULL OR kind = $2)
        AND ($3::text IS NULL OR treatment = $3)
      ORDER BY created_at DESC
      LIMIT $4`,
    [filters.openOnly ?? false, filters.kind ?? null, filters.treatment ?? null, Math.min(filters.limit ?? 50, 200)] as never[],
  );
  return (rows as unknown as Row[]).map(toAlert);
}

export async function acknowledgeAlert(id: number, userId: number): Promise<boolean> {
  const rows = await pgClient.unsafe(
    `UPDATE ai_alerts SET acknowledged_at = NOW(), acknowledged_by = $2
      WHERE id = $1 AND acknowledged_at IS NULL RETURNING id`,
    [id, userId] as never[],
  );
  return (rows as unknown as Row[]).length > 0;
}

/**
 * Réserve un passage d'évaluateur : rend `true` si ce processus doit évaluer
 * maintenant (dernier passage plus ancien que `everySeconds`). Une seule
 * instruction : deux instances ne réservent jamais le même passage.
 */
export async function claimEvaluatorRun(name: string, everySeconds: number): Promise<boolean> {
  const rows = await pgClient.unsafe(
    `INSERT INTO ai_evaluator_runs (name, last_run_at) VALUES ($1, NOW())
     ON CONFLICT (name) DO UPDATE SET last_run_at = NOW()
       WHERE ai_evaluator_runs.last_run_at < NOW() - ($2 || ' seconds')::interval
     RETURNING name`,
    [name, String(everySeconds)] as never[],
  );
  return (rows as unknown as Row[]).length > 0;
}
