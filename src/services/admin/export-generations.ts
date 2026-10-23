/**
 * Lot 81C — suivi des générations d'export du back-office
 * (`admin_export_generations`, migration 0632). Serveur uniquement.
 *
 * Journal TECHNIQUE (comme `admin_audit_log`) : une ligne RUNNING à
 * l'ouverture d'une génération, mise à jour à sa fin (COMPLETE / PARTIAL /
 * FAILED, bilan par section, erreur exploitable). Les écritures se font sur
 * une connexion du pool DISTINCTE de la session de lecture (READ ONLY) de
 * l'export ; un échec d'écriture du suivi n'interrompt jamais l'export
 * (journalisé). Une génération restée RUNNING au-delà de
 * `STALE_RUNNING_MS` (processus arrêté) est rendue FAILED à la lecture.
 *
 * Aussi : bornes de générations SIMULTANÉES par instance (protection de la
 * mémoire du conteneur et du pool : pagination technique, pas un plafond
 * de données).
 */
import type { ExtractionStatus } from '@/services/admin/account-data/model';

export type ExportKind = 'ACCOUNT_DATA' | 'TECH_DIAGNOSTIC';

/** Générations simultanées par instance (au-delà : 429, réessayer). */
export const MAX_CONCURRENT: Readonly<Record<ExportKind, number>> = { ACCOUNT_DATA: 3, TECH_DIAGNOSTIC: 2 };
const running: Record<ExportKind, number> = { ACCOUNT_DATA: 0, TECH_DIAGNOSTIC: 0 };

/** Réserve une place de génération ; `release` à appeler une fois (idempotent). */
export function tryAcquireExportSlot(kind: ExportKind): { release: () => void } | null {
  if (running[kind] >= MAX_CONCURRENT[kind]) return null;
  running[kind]++;
  let done = false;
  return { release: () => { if (!done) { done = true; running[kind]--; } } };
}

/** Au-delà, une génération encore RUNNING est considérée interrompue (processus arrêté). */
export const STALE_RUNNING_MS = 2 * 60 * 60_000;

export interface GenerationStart {
  id: string;
  kind: ExportKind;
  mode: string;
  adminUserId: number | null;
  targetType: string | null;
  targetId: number | null;
  targetAccountId: number | null;
  perimeter: Record<string, unknown>;
}

export interface GenerationEnd {
  status: ExtractionStatus;
  snapshotAt?: string | null;
  pgSnapshot?: string | null;
  rowsExpected?: number | null;
  rowsExported?: number | null;
  batches?: number | null;
  bytes?: number | null;
  files?: number | null;
  sections?: unknown[];
  error?: string | null;
  fileName?: string | null;
}

export async function startGeneration(g: GenerationStart): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO admin_export_generations (id, kind, mode, admin_user_id, target_type, target_id, target_account_id, perimeter)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT (id) DO NOTHING`,
      [g.id, g.kind, g.mode, g.adminUserId, g.targetType, g.targetId, g.targetAccountId, JSON.stringify(g.perimeter)] as never[],
    );
  } catch (e) {
    console.error('[admin/export-generations] début non journalisé :', (e as Error)?.message ?? e);
  }
}

export async function finishGeneration(id: string, e: GenerationEnd): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `UPDATE admin_export_generations
          SET status = $2, snapshot_at = $3::timestamptz, pg_snapshot = $4, rows_expected = $5, rows_exported = $6, batches = $7, bytes = $8,
              files = $9, sections = $10::jsonb, error = $11, file_name = $12, finished_at = now()
        WHERE id = $1`,
      [id, e.status, e.snapshotAt ?? null, e.pgSnapshot ?? null, e.rowsExpected ?? null, e.rowsExported ?? null, e.batches ?? null, e.bytes ?? null,
        e.files ?? null, JSON.stringify(e.sections ?? []), e.error ? e.error.slice(0, 4000) : null, e.fileName ?? null] as never[],
    );
  } catch (err) {
    console.error('[admin/export-generations] fin non journalisée :', (err as Error)?.message ?? err);
  }
}

export interface GenerationRow {
  id: string;
  kind: ExportKind;
  mode: string;
  adminUserId: number | null;
  targetType: string | null;
  targetId: number | null;
  targetAccountId: number | null;
  perimeter: Record<string, unknown>;
  status: ExtractionStatus | 'RUNNING';
  /** RUNNING depuis plus de `STALE_RUNNING_MS` : interrompue (processus arrêté), jamais complète. */
  interrupted: boolean;
  snapshotAt: string | null;
  rowsExpected: number | null;
  rowsExported: number | null;
  batches: number | null;
  bytes: number | null;
  files: number | null;
  sections: unknown[];
  error: string | null;
  fileName: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Générations récentes (pagination technique : `pageSize` ≤ 100, toutes les pages accessibles). */
export async function listGenerations(opts: { page?: number; pageSize?: number; kind?: ExportKind | null; now?: Date } = {}): Promise<{ items: GenerationRow[]; total: number; page: number; pageSize: number }> {
  const { readOnlyExecutor } = await import('@/services/business-operations/diagnostics/service');
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 20)));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const now = (opts.now ?? new Date()).getTime();
  return readOnlyExecutor(async (q) => {
    const [c] = await q(`SELECT count(*)::int AS n FROM admin_export_generations WHERE ($1::text IS NULL OR kind = $1)`, [opts.kind ?? null]);
    const rows = await q(
      `SELECT id::text, kind, mode, admin_user_id, target_type, target_id, target_account_id, perimeter, status, snapshot_at, rows_expected, rows_exported,
              batches, bytes, files, sections, error, file_name, started_at, finished_at
         FROM admin_export_generations WHERE ($1::text IS NULL OR kind = $1)
        ORDER BY started_at DESC, id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, [opts.kind ?? null]);
    const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
    const n = (v: unknown) => (v == null ? null : Number(v));
    return {
      total: Number(c?.n ?? 0), page, pageSize,
      items: rows.map((r) => {
        const startedAt = iso(r.started_at)!;
        const interrupted = r.status === 'RUNNING' && now - Date.parse(startedAt) > STALE_RUNNING_MS;
        return {
          id: String(r.id), kind: r.kind as ExportKind, mode: String(r.mode), adminUserId: n(r.admin_user_id), targetType: r.target_type == null ? null : String(r.target_type),
          targetId: n(r.target_id), targetAccountId: n(r.target_account_id), perimeter: (r.perimeter ?? {}) as Record<string, unknown>,
          status: interrupted ? 'FAILED' : (String(r.status) as GenerationRow['status']), interrupted,
          snapshotAt: iso(r.snapshot_at), rowsExpected: n(r.rows_expected), rowsExported: n(r.rows_exported), batches: n(r.batches), bytes: n(r.bytes), files: n(r.files),
          sections: Array.isArray(r.sections) ? r.sections : [],
          error: interrupted ? 'génération interrompue (processus arrêté avant la fin) — relancer la génération' : (r.error == null ? null : String(r.error)),
          fileName: r.file_name == null ? null : String(r.file_name), startedAt, finishedAt: iso(r.finished_at),
        };
      }),
    };
  });
}
