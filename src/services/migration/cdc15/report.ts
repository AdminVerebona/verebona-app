/**
 * Rapport et exécutions des rattrapages CDC 15 (migration 0225).
 *
 * Écrit en SQL : `cdc15_migration_runs` (une ligne par exécution, curseurs
 * de reprise, compteurs) et `cdc15_migration_report` (une ligne par décision,
 * valeurs masquées). En simulation (`dry_run`), ces deux tables sont les
 * SEULES écrites — et pas du tout avec `--no-db-report` (rapport JSON seul).
 */
import type postgres from 'postgres';
import { maskReportValue } from './mask';
import { DECISIONS, type Decision, type MigStep, type ReportEntry } from './types';

export interface RunRow {
  runId: string;
  runMode: 'dry_run' | 'apply';
  steps: MigStep[];
  accountId: number | null;
  options: Record<string, unknown>;
  cursors: Partial<Record<MigStep, number>>;
  counts: Partial<Record<MigStep, Record<Decision, number>>>;
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'PARTIAL';
  startedAt: string;
  finishedAt: string | null;
}

/** Ligne SQL du rapport (pure, testée) : valeurs masquées, identifiant en texte. */
export function toReportRow(runId: string, runMode: 'dry_run' | 'apply', e: ReportEntry) {
  return {
    run_id: runId,
    run_mode: runMode,
    step: e.step,
    account_id: e.accountId ?? null,
    asset_id: e.assetId ?? null,
    entity_type: e.entityType,
    entity_id: e.entityId === undefined || e.entityId === null ? null : String(e.entityId),
    field_key: e.fieldKey ?? null,
    before_value: JSON.stringify(maskReportValue(e.fieldKey, e.before)),
    after_value: JSON.stringify(maskReportValue(e.fieldKey, e.after)),
    decision: e.decision,
    reason: e.reason ?? null,
    details: JSON.stringify(maskReportValue(e.fieldKey, e.details ?? {})),
  };
}

/** Tampon d'écriture du rapport (une instruction par vidage). */
export class ReportSink {
  private buffer: ReturnType<typeof toReportRow>[] = [];
  readonly entries: ReportEntry[] = [];

  constructor(
    private readonly sql: postgres.Sql | null,
    private readonly runId: string,
    private readonly runMode: 'dry_run' | 'apply',
    /** Entrées gardées en mémoire (rapport JSON) — bornées. */
    private readonly keepInMemory = 5000,
  ) {}

  async add(e: ReportEntry): Promise<void> {
    if (this.entries.length < this.keepInMemory) this.entries.push(e);
    if (!this.sql) return;
    this.buffer.push(toReportRow(this.runId, this.runMode, e));
    if (this.buffer.length >= 200) await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.sql || this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    await this.sql`
      INSERT INTO cdc15_migration_report ${this.sql(rows, 'run_id', 'run_mode', 'step', 'account_id', 'asset_id', 'entity_type',
        'entity_id', 'field_key', 'before_value', 'after_value', 'decision', 'reason', 'details')}`;
  }
}

export async function createRun(sql: postgres.Sql, r: Omit<RunRow, 'cursors' | 'counts' | 'status' | 'startedAt' | 'finishedAt'>): Promise<void> {
  await sql`
    INSERT INTO cdc15_migration_runs (run_id, run_mode, steps, account_id, options)
    VALUES (${r.runId}, ${r.runMode}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(r.steps)}::jsonb)), ${r.accountId}, ${JSON.stringify(r.options)}::jsonb)`;
}

export async function saveCursor(sql: postgres.Sql, runId: string, step: MigStep | string, cursor: number): Promise<void> {
  await sql`
    UPDATE cdc15_migration_runs SET cursors = cursors || jsonb_build_object(${step}::text, ${cursor}::bigint)
     WHERE run_id = ${runId}`;
}

export async function finishRun(
  sql: postgres.Sql, runId: string, status: RunRow['status'], counts: RunRow['counts'],
): Promise<void> {
  await sql`
    UPDATE cdc15_migration_runs SET status = ${status}, counts = counts || ${JSON.stringify(counts)}::jsonb, finished_at = now()
     WHERE run_id = ${runId}`;
}

export async function loadRun(sql: postgres.Sql, runId: string): Promise<RunRow | null> {
  const [r] = await sql<Array<{
    run_id: string; run_mode: 'dry_run' | 'apply'; steps: MigStep[]; account_id: number | null; options: Record<string, unknown>;
    cursors: Record<string, number>; counts: RunRow['counts']; status: RunRow['status']; started_at: Date | string; finished_at: Date | string | null;
  }>>`SELECT * FROM cdc15_migration_runs WHERE run_id = ${runId}`;
  if (!r) return null;
  return {
    runId: r.run_id, runMode: r.run_mode, steps: r.steps, accountId: r.account_id, options: r.options,
    cursors: Object.fromEntries(Object.entries(r.cursors ?? {}).map(([k, v]) => [k, Number(v)])) as RunRow['cursors'],
    counts: r.counts ?? {}, status: r.status, startedAt: new Date(r.started_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  };
}

/** Synthèse d'une exécution (consultation « mode rapport »). */
export interface RunSummary {
  run: RunRow;
  byStep: Array<{ step: MigStep; decision: Decision; reason: string | null; count: number }>;
  samples: Array<{ step: MigStep; decision: Decision; reason: string | null; accountId: number | null; assetId: number | null;
    entityType: string; entityId: string | null; fieldKey: string | null; before: unknown; after: unknown }>;
}

export async function summarizeRun(sql: postgres.Sql, runId: string, opts: { samples?: number; decision?: Decision } = {}): Promise<RunSummary | null> {
  const run = await loadRun(sql, runId);
  if (!run) return null;
  const byStep = await sql<Array<{ step: MigStep; decision: Decision; reason: string | null; count: number }>>`
    SELECT step, decision, reason, count(*)::int AS count FROM cdc15_migration_report
     WHERE run_id = ${runId} GROUP BY step, decision, reason ORDER BY step, decision, reason`;
  const decisions = opts.decision ? [opts.decision] : DECISIONS.filter((d) => d !== 'NO_CHANGE');
  const samples = await sql<RunSummary['samples']>`
    SELECT step, decision, reason, account_id AS "accountId", asset_id AS "assetId", entity_type AS "entityType",
           entity_id AS "entityId", field_key AS "fieldKey", before_value AS before, after_value AS after
      FROM cdc15_migration_report
     WHERE run_id = ${runId} AND decision = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(decisions)}::jsonb)))
     ORDER BY id LIMIT ${opts.samples ?? 20}`;
  return { run, byStep: [...byStep], samples: [...samples] };
}

/** Rendu texte d'une synthèse (pur, testé). */
export function formatRunSummary(s: RunSummary): string {
  const l: string[] = [];
  l.push(`Exécution ${s.run.runId} — ${s.run.runMode === 'apply' ? 'APPLIQUÉE' : 'SIMULATION'} — ${s.run.status}`);
  l.push(`Étapes : ${s.run.steps.join(', ')}${s.run.accountId ? ` · compte ${s.run.accountId}` : ' · tous comptes'} · début ${s.run.startedAt}${s.run.finishedAt ? ` · fin ${s.run.finishedAt}` : ''}`);
  const avert = Array.isArray(s.run.options?.warnings) ? (s.run.options.warnings as string[]) : [];
  for (const w of avert) l.push(`AVERTISSEMENT : ${w}`);
  for (const r of s.byStep) l.push(`  ${r.step}  ${r.decision.padEnd(12)} ${String(r.count).padStart(6)}  ${r.reason ?? ''}`);
  if (s.samples.length) {
    l.push('Exemples :');
    for (const x of s.samples) {
      l.push(`  ${x.step} ${x.decision} ${x.reason ?? ''} · compte ${x.accountId ?? '-'} · bien ${x.assetId ?? '-'} · ${x.entityType}#${x.entityId ?? '-'}`
        + `${x.fieldKey ? ` · ${x.fieldKey}` : ''} : ${JSON.stringify(x.before)} → ${JSON.stringify(x.after)}`);
    }
  }
  return l.join('\n');
}
