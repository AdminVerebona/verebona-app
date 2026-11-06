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
 *
 * Lot 113O (carte #713, migration 1521) — RÉSOLUTION, distincte de
 * l'acquittement : `raiseConditionAlert` tient UNE alerte non résolue par
 * condition stable (`condition_key`, sans date) — une répétition met à jour
 * `last_seen_at` / `occurrences` ; `resolveAlerts` la clôt quand sa condition
 * a disparu (automatique : `resolved_by` NULL), motif et code tracés, sans
 * jamais supprimer la ligne. Une alerte résolue n'est plus « ouverte »
 * (`listAlerts({ openOnly })`) mais reste consultable (`status: 'resolved'`).
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

interface AiAlert {
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
  /** Lot 113O (migration 1521) : résolution automatique ou manuelle, distincte de l'acquittement. */
  resolvedAt?: string | null;
  resolutionCode?: string | null;
  resolutionReason?: string | null;
  conditionKey?: string | null;
  lastSeenAt?: string | null;
  occurrences?: number;
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
    ...('resolved_at' in r ? {
      resolvedAt: r.resolved_at ? new Date(String(r.resolved_at)).toISOString() : null,
      resolutionCode: r.resolution_code == null ? null : String(r.resolution_code),
      resolutionReason: r.resolution_reason == null ? null : String(r.resolution_reason),
      conditionKey: r.condition_key == null ? null : String(r.condition_key),
      lastSeenAt: r.last_seen_at ? new Date(String(r.last_seen_at)).toISOString() : null,
      occurrences: r.occurrences == null ? 1 : Number(r.occurrences),
    } : {}),
  };
}

/**
 * Alertes, plus récentes d'abord. `openOnly` : ni acquittées ni résolues.
 * Lot 113O : `status` — `open` (= `openOnly`), `resolved` (historique des
 * résolutions), `all` ; `codes` / `excludeCodes` pour regrouper ou séparer.
 */
export async function listAlerts(filters: {
  openOnly?: boolean; kind?: AlertKind; treatment?: string; limit?: number;
  status?: 'open' | 'resolved' | 'all'; codes?: readonly string[]; excludeCodes?: readonly string[];
} = {}): Promise<AiAlert[]> {
  const status = filters.status ?? (filters.openOnly ? 'open' : 'all');
  const params = [
    status, filters.kind ?? null, filters.treatment ?? null, Math.min(filters.limit ?? 50, 200),
    filters.codes ? [...filters.codes] : null, filters.excludeCodes ? [...filters.excludeCodes] : null,
  ];
  const filtres = `($2::text IS NULL OR kind = $2)
        AND ($3::text IS NULL OR treatment = $3)
        AND ($5::text[] IS NULL OR code = ANY($5::text[]))
        AND ($6::text[] IS NULL OR NOT (code = ANY($6::text[])))`;
  try {
    const rows = await pgClient.unsafe(
      `SELECT id, kind, code, treatment, account_id, severity, message, details, drilldown_href,
              created_at, acknowledged_at, resolved_at, resolution_code, resolution_reason, condition_key, last_seen_at, occurrences
         FROM ai_alerts
        WHERE ($1::text = 'all'
               OR ($1::text = 'open' AND acknowledged_at IS NULL AND resolved_at IS NULL)
               OR ($1::text = 'resolved' AND resolved_at IS NOT NULL))
          AND ${filtres}
        ORDER BY ${status === 'resolved' ? 'resolved_at' : 'created_at'} DESC
        LIMIT $4`,
      params as never[],
    );
    return (rows as unknown as Row[]).map(toAlert);
  } catch (e) {
    // Migration 1521 absente : lecture historique (aucune résolution connue).
    if ((e as { code?: string }).code !== '42703') throw e;
    if (status === 'resolved') return [];
    const rows = await pgClient.unsafe(
      `SELECT id, kind, code, treatment, account_id, severity, message, details, drilldown_href,
              created_at, acknowledged_at
         FROM ai_alerts
        WHERE ($1::text <> 'open' OR acknowledged_at IS NULL)
          AND ${filtres}
        ORDER BY created_at DESC
        LIMIT $4`,
      params as never[],
    );
    return (rows as unknown as Row[]).map(toAlert);
  }
}

/**
 * Lot 113O — alerte d'une CONDITION durable : au plus une alerte non résolue
 * par `conditionKey` (index unique partiel, migration 1521) ; une répétition
 * met à jour message, détails, sévérité, `last_seen_at` et `occurrences`.
 * Rend l'identifiant et `created` (nouvelle alerte). Migration absente : repli
 * sur `raiseAlert` (clé datée historique), jamais d'échec.
 */
export async function raiseConditionAlert(a: Omit<AlertInput, 'dedupeKey'> & { conditionKey: string; fallbackDedupeKey: string }): Promise<{ id: number | null; created: boolean }> {
  try {
    const rows = await pgClient.unsafe(
      `INSERT INTO ai_alerts
         (kind, code, treatment, account_id, severity, message, details, drilldown_href, dedupe_key, config_version_id,
          condition_key, last_seen_at, occurrences)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9 || ':' || floor(extract(epoch FROM clock_timestamp()) * 1000)::text || ':' || floor(random() * 1e6)::text, $10,
               $11, NOW(), 1)
       ON CONFLICT (condition_key) WHERE condition_key IS NOT NULL AND resolved_at IS NULL
       DO UPDATE SET last_seen_at = NOW(), occurrences = ai_alerts.occurrences + 1,
                     message = EXCLUDED.message, details = EXCLUDED.details, severity = EXCLUDED.severity,
                     drilldown_href = EXCLUDED.drilldown_href
       RETURNING id, (xmax = 0) AS created`,
      [
        a.kind, a.code, a.treatment ?? null, a.accountId ?? null, a.severity ?? 'warning',
        a.message.slice(0, 1000), JSON.stringify(a.details ?? {}), a.drilldownHref ?? null,
        a.conditionKey, a.configVersionId ?? null, a.conditionKey,
      ] as never[],
    );
    const r = (rows as unknown as Row[])[0];
    return { id: r ? Number(r.id) : null, created: Boolean(r?.created) };
  } catch (e) {
    const code = (e as { code?: string }).code;
    // 42703 / 42P10 : colonnes ou index 1521 absents — comportement historique.
    if (code !== '42703' && code !== '42P10') throw e;
    const created = await raiseAlert({ ...a, dedupeKey: a.fallbackDedupeKey });
    return { id: null, created };
  }
}

/**
 * Lot 113O — RÉSOUT des alertes (jamais supprimées) : `resolvedBy` NULL =
 * résolution automatique (condition disparue). Idempotent : une alerte déjà
 * résolue n'est pas touchée. Rend le nombre d'alertes résolues.
 */
export async function resolveAlerts(ids: readonly number[], r: { code: string; reason: string; resolvedBy?: number | null; supersededBy?: number | null }): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    const rows = await pgClient.unsafe(
      `UPDATE ai_alerts SET resolved_at = NOW(), resolved_by = $2, resolution_code = $3, resolution_reason = $4, superseded_by = $5
        WHERE id = ANY($1::int[]) AND resolved_at IS NULL RETURNING id`,
      [[...ids], r.resolvedBy ?? null, r.code.slice(0, 60), r.reason.slice(0, 500), r.supersededBy ?? null] as never[],
    );
    return (rows as unknown as Row[]).length;
  } catch (e) {
    if ((e as { code?: string }).code === '42703') return 0;
    throw e;
  }
}

/** Lot 113O — alertes NON RÉSOLUES de codes donnés (acquittées comprises : la condition peut durer). */
export async function listUnresolvedAlerts(codes: readonly string[]): Promise<Array<AiAlert & { conditionKey: string | null }>> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT id, kind, code, treatment, account_id, severity, message, details, drilldown_href, created_at, acknowledged_at,
              resolved_at, resolution_code, resolution_reason, condition_key, last_seen_at, occurrences
         FROM ai_alerts WHERE code = ANY($1::text[]) AND resolved_at IS NULL ORDER BY id`,
      [[...codes]] as never[],
    );
    return (rows as unknown as Row[]).map((r) => ({ ...toAlert(r), conditionKey: r.condition_key == null ? null : String(r.condition_key) }));
  } catch (e) {
    if ((e as { code?: string }).code === '42703') return [];
    throw e;
  }
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
