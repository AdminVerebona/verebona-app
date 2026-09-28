/**
 * Alimentation de la Supervision pour les domaines « Exports / transmissions »
 * et « IA » — CDC Back-Office V1 SUP-004, SUP-008, SUP-009, AI-001.
 *
 * Ces domaines n'avaient aucun producteur. Plutôt que d'instrumenter les
 * services d'export et d'IA (hors périmètre), un balayage LIT leurs tables
 * (lecture seule) et ouvre / résout les anomalies correspondantes :
 *
 *   Exports
 *   · génération en erreur sans génération réussie ultérieure du même type
 *     pour le même bien (l'utilisateur a pu relancer : SUP-009) ;
 *   · génération bloquée (en attente / en cours depuis plus d'une heure).
 *   IA
 *   · traitement suspendu automatiquement par le disjoncteur (MOD-011) ;
 *   · jobs de la file en échec définitif (FAILED, après les reprises avec
 *     backoff) sans job réussi ultérieur du même traitement.
 *
 * Résolution automatique (SUP-008) dès que la condition disparaît. Une
 * condition déjà signalée n'est pas re-signalée à chaque balayage : seule une
 * NOUVELLE occurrence (postérieure au dernier signalement) incrémente le
 * compteur (SUP-010).
 *
 * Les écritures ne portent que sur `admin_anomalies` / occurrences, via
 * `anomaly.service`.
 */
import { pgClient } from '@/db';
import {
  autoResolveAnomaly,
  buildFingerprint,
  reportAnomaly,
  type ReportAnomalyInput,
} from '@/services/admin/anomaly.service';

/** Délai laissé à l'utilisateur pour relancer un export en erreur (SUP-009). */
export const EXPORT_ERROR_GRACE_MINUTES = 15;
/** Au-delà, une génération « en attente / en cours » est bloquée. */
export const EXPORT_STUCK_MINUTES = 60;
/** Fenêtre d'observation des échecs. */
export const SWEEP_LOOKBACK_DAYS = 7;
/** Intervalle minimal entre deux balayages déclenchés par l'écran. */
export const SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000;

export interface Condition {
  fingerprint: string;
  occurredAt: Date;
  input: ReportAnomalyInput;
}

export const exportFailureFingerprint = (assetId: number, exportType: string) =>
  buildFingerprint('exports', 'generation', 'asset', assetId, exportType);
export const exportStuckFingerprint = (exportId: number) => buildFingerprint('exports', 'stuck', exportId);
export const aiSuspendedFingerprint = (treatment: string) => buildFingerprint('ai', 'treatment-suspended', treatment);
export const aiJobsFailedFingerprint = (treatment: string) => buildFingerprint('ai', 'jobs-failed', treatment);

/**
 * Pur : faut-il signaler la condition ? Oui si aucune anomalie ouverte, ou si
 * l'occurrence est postérieure au dernier signalement (nouvelle occurrence).
 */
export function shouldReport(openLastSeenAt: Date | null, occurredAt: Date): boolean {
  if (!openLastSeenAt) return true;
  return occurredAt.getTime() > openLastSeenAt.getTime();
}

/** Pur : empreintes ouvertes dont la condition a disparu (à résoudre). */
export function fingerprintsToResolve(openFingerprints: string[], current: Condition[], prefix: string): string[] {
  const active = new Set(current.map((c) => c.fingerprint));
  return openFingerprints.filter((f) => f.startsWith(prefix) && !active.has(f));
}

function errorMessage(payload: unknown): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(String(payload));
    return typeof parsed?.message === 'string' ? parsed.message : String(payload);
  } catch {
    return String(payload);
  }
}

type Row = Record<string, unknown>;

// ── Sources (lecture seule) ─────────────────────────────────────────────────

export async function collectExportConditions(): Promise<Condition[]> {
  const failed = await pgClient.unsafe<Row[]>(
    `SELECT e.asset_id, e.account_id, e.user_id, e.export_type,
            max(e.created_at) AS last_error_at, count(*)::int AS n,
            (array_agg(e.error_payload ORDER BY e.created_at DESC))[1] AS last_error,
            (array_agg(e.id ORDER BY e.created_at DESC))[1] AS last_id
       FROM export_generation e
      WHERE e.status = 'error'
        AND e.created_at > now() - make_interval(days => $1)
        AND e.created_at < now() - make_interval(mins => $2)
        AND NOT EXISTS (
              SELECT 1 FROM export_generation r
               WHERE r.asset_id = e.asset_id AND r.export_type = e.export_type
                 AND r.status = 'ready' AND r.created_at > e.created_at)
      GROUP BY e.asset_id, e.account_id, e.user_id, e.export_type`,
    [SWEEP_LOOKBACK_DAYS, EXPORT_ERROR_GRACE_MINUTES],
  );
  const stuck = await pgClient.unsafe<Row[]>(
    `SELECT id, asset_id, account_id, user_id, export_type, status, created_at
       FROM export_generation
      WHERE status IN ('pending', 'generating')
        AND created_at < now() - make_interval(mins => $1)
        AND created_at > now() - make_interval(days => $2)`,
    [EXPORT_STUCK_MINUTES, SWEEP_LOOKBACK_DAYS],
  );
  const out: Condition[] = [];
  for (const r of failed) {
    const assetId = Number(r.asset_id);
    const type = String(r.export_type);
    out.push({
      fingerprint: exportFailureFingerprint(assetId, type),
      occurredAt: new Date(r.last_error_at as string),
      input: {
        domain: 'exports',
        fingerprint: exportFailureFingerprint(assetId, type),
        title: `Génération d’export en échec (${type})`,
        accountId: r.account_id == null ? null : Number(r.account_id),
        userId: r.user_id == null ? null : Number(r.user_id),
        detail: { exportId: Number(r.last_id), assetId, exportType: type, failedAttempts: Number(r.n), error: errorMessage(r.last_error) },
      },
    });
  }
  for (const r of stuck) {
    const id = Number(r.id);
    out.push({
      fingerprint: exportStuckFingerprint(id),
      occurredAt: new Date(r.created_at as string),
      input: {
        domain: 'exports',
        fingerprint: exportStuckFingerprint(id),
        title: `Génération d’export bloquée (${String(r.export_type)})`,
        accountId: r.account_id == null ? null : Number(r.account_id),
        userId: r.user_id == null ? null : Number(r.user_id),
        detail: { exportId: id, assetId: Number(r.asset_id), status: String(r.status), thresholdMinutes: EXPORT_STUCK_MINUTES },
      },
    });
  }
  return out;
}

export async function collectAiConditions(): Promise<Condition[]> {
  const out: Condition[] = [];
  const suspended = await pgClient.unsafe<Row[]>(
    `SELECT treatment, suspended_reason, suspended_at, next_probe_at, consecutive_chain_failures
       FROM ai_treatment_state
      WHERE state = 'SUSPENDED' AND suspended_by_breaker = true`,
  );
  for (const r of suspended) {
    const t = String(r.treatment);
    out.push({
      fingerprint: aiSuspendedFingerprint(t),
      occurredAt: new Date((r.suspended_at as string) ?? Date.now()),
      input: {
        domain: 'ai',
        fingerprint: aiSuspendedFingerprint(t),
        title: `Traitement IA ${t} suspendu automatiquement`,
        detail: {
          treatment: t,
          reason: (r.suspended_reason as string) ?? null,
          nextProbeAt: r.next_probe_at ? new Date(r.next_probe_at as string).toISOString() : null,
          consecutiveChainFailures: r.consecutive_chain_failures == null ? null : Number(r.consecutive_chain_failures),
        },
      },
    });
  }
  const failedJobs = await pgClient.unsafe<Row[]>(
    `SELECT j.treatment, count(*)::int AS n, max(j.finished_at) AS last_failed_at,
            (array_agg(j.last_error ORDER BY j.finished_at DESC NULLS LAST))[1] AS last_error,
            (array_agg(j.id ORDER BY j.finished_at DESC NULLS LAST))[1] AS last_id
       FROM ai_job_queue j
      WHERE j.status = 'FAILED'
        AND coalesce(j.finished_at, j.created_at) > now() - make_interval(days => $1)
        AND NOT EXISTS (
              SELECT 1 FROM ai_job_queue d
               WHERE d.treatment = j.treatment AND d.status = 'DONE'
                 AND d.finished_at > coalesce(j.finished_at, j.created_at))
      GROUP BY j.treatment`,
    [SWEEP_LOOKBACK_DAYS],
  );
  for (const r of failedJobs) {
    const t = String(r.treatment);
    out.push({
      fingerprint: aiJobsFailedFingerprint(t),
      occurredAt: new Date((r.last_failed_at as string) ?? Date.now()),
      input: {
        domain: 'ai',
        fingerprint: aiJobsFailedFingerprint(t),
        title: `Jobs IA ${t} en échec définitif`,
        detail: { treatment: t, failedJobs: Number(r.n), lastJobId: Number(r.last_id), error: (r.last_error as string) ?? null },
      },
    });
  }
  return out;
}

// ── Application ─────────────────────────────────────────────────────────────

async function openAnomalies(prefix: string): Promise<Map<string, Date>> {
  const rows = await pgClient.unsafe<{ fingerprint: string; last_seen_at: string }[]>(
    `SELECT fingerprint, last_seen_at FROM admin_anomalies WHERE status = 'open' AND fingerprint LIKE $1`,
    [`${prefix}%`],
  );
  return new Map(rows.map((r) => [r.fingerprint, new Date(r.last_seen_at)]));
}

export interface SweepDomainResult {
  reported: number;
  resolved: number;
  error: string | null;
}

async function applyConditions(prefix: string, collect: () => Promise<Condition[]>, origin: string): Promise<SweepDomainResult> {
  try {
    const conditions = await collect();
    const open = await openAnomalies(prefix);
    let reported = 0;
    for (const c of conditions) {
      if (!shouldReport(open.get(c.fingerprint) ?? null, c.occurredAt)) continue;
      if ((await reportAnomaly(c.input)) !== null) reported++;
    }
    let resolved = 0;
    for (const f of fingerprintsToResolve([...open.keys()], conditions, prefix)) {
      if (await autoResolveAnomaly(f, { origin, cause: null })) resolved++;
    }
    return { reported, resolved, error: null };
  } catch (error) {
    // Table absente (environnement sans IA) ou base injoignable : rien n'est
    // conclu, rien n'est résolu.
    console.error(`[supervision-sweep] ${prefix} :`, (error as Error).message);
    return { reported: 0, resolved: 0, error: (error as Error).message };
  }
}

export async function runSupervisionSweep(): Promise<{ exports: SweepDomainResult; ai: SweepDomainResult }> {
  const exportsResult = await applyConditions('exports:', collectExportConditions, 'export_sweep_condition_cleared');
  const aiResult = await applyConditions('ai:', collectAiConditions, 'ai_sweep_condition_cleared');
  return { exports: exportsResult, ai: aiResult };
}

let lastSweepAt = 0;
let running: Promise<unknown> | null = null;

/**
 * Balayage déclenché à l'ouverture de la Supervision, au plus toutes les
 * 5 minutes par instance. Ne lève jamais.
 */
export async function runSupervisionSweepThrottled(now = Date.now()): Promise<void> {
  if (running || now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = now;
  running = runSupervisionSweep().catch(() => undefined);
  try {
    await running;
  } finally {
    running = null;
  }
}
