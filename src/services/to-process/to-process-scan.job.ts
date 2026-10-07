/**
 * Balayage de la file « À traiter » (CDC V2.0 §9.2, §10) : production des
 * actions nées d'un état de la base, puis promotion des priorités.
 *
 * Traitement partagé par GET /api/cron/to-process/scan et la tâche planifiée
 * interne `to-process-scan` (lot 25, horaire). Même bail en base
 * (`to-process-scan`) pour les deux : un appel externe pendant le passage
 * interne est refusé (`null`), jamais exécuté en parallèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 28 — UN BALAYAGE QUI TOURNE, ET QUI LE PROUVE
 *
 * Chaque passage est TRACÉ (`to_process_scan_runs`, migration 0256) : début,
 * fin, déclencheur, comptes parcourus, actions créées / mises à jour /
 * fermées, promotions, erreurs. La trace est lue par le BO (Exploitation ›
 * Tâches planifiées). Une absence de passage se voit, une erreur aussi.
 *
 * Tous les comptes sont parcourus, par identifiant croissant. Un passage
 * borné (délai de la tâche, `limit`) s'arrête proprement et laisse un
 * CURSEUR : le passage suivant reprend après le dernier compte traité. Plus
 * de « 500 premiers comptes » balayés à chaque fois et les autres jamais.
 *
 * Distinct des notifications « À traiter » (`notifications-to-process-scan`),
 * qui détectent les NOUVELLES actions pour prévenir l'utilisateur et n'en
 * produisent aucune.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { asc, eq, gt } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { accounts } from '@/db/schema';
import { withJobLockOrSkip } from '@/lib/job-lock';
import { innerLockTtlMs, TO_PROCESS_SCAN_TIMEOUT_MS } from '@/services/scheduling/task-timeouts';
import { closeActionsForDeletedTargets, produceAccountActions } from './producers.service';
import { promoteDueActions } from './priority-scheduler.service';

export const TO_PROCESS_SCAN_LOCK = 'to-process-scan';
/** Couvre la durée maximale d'une exécution planifiée (2 × délai + marge). */
export const TO_PROCESS_SCAN_LOCK_TTL_MS = innerLockTtlMs(TO_PROCESS_SCAN_TIMEOUT_MS);

/** Comptes au plus par passage (le suivant reprend au curseur). */
export const TO_PROCESS_SCAN_DEFAULT_LIMIT = 5000;
/** Lignes de trace conservées. */
const TRACE_RETENTION = 500;

export type ScanTrigger = 'schedule' | 'manual' | 'startup' | 'route';

export interface ToProcessScanResult {
  accounts: number;
  created: number;
  updated: number;
  closed: number;
  promoted: number;
  demoted: number;
  refused: number;
  /** Comptes (ou familles) en échec sur ce passage. */
  errors: number;
  /** Passage interrompu (délai, limite) : le suivant reprend au curseur. */
  partial: boolean;
  /** Ligne de trace (`to_process_scan_runs`), null si la table manque. */
  runId: number | null;
}

/** Ligne de trace, telle que le BO la lit. */
export interface ToProcessScanRun {
  id: number;
  trigger: ScanTrigger;
  status: 'running' | 'ok' | 'partial' | 'error';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  accounts: number;
  created: number;
  updated: number;
  closed: number;
  promoted: number;
  demoted: number;
  errors: number;
  errorSample: string | null;
  nextCursor: number | null;
}

type Raw = Record<string, unknown>;
const q = async (sql: string, params: unknown[] = []): Promise<Raw[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as Raw[];

/** Trace absente (migration 0256 pas encore passée) : le balayage tourne quand même. */
async function traceStart(trigger: ScanTrigger): Promise<number | null> {
  try {
    const [r] = await q(`INSERT INTO to_process_scan_runs (trigger) VALUES ($1) RETURNING id`, [trigger]);
    return Number(r.id);
  } catch (e) {
    console.warn('[to-process-scan] trace indisponible :', (e as Error).message);
    return null;
  }
}

async function traceFinish(runId: number | null, r: Omit<ToProcessScanResult, 'runId'>, startedAt: number, errorSample: string | null, nextCursor: number | null): Promise<void> {
  if (runId === null) return;
  const status = r.errors > 0 && r.accounts > 0 && r.errors >= r.accounts ? 'error' : r.partial ? 'partial' : 'ok';
  try {
    await q(
      `UPDATE to_process_scan_runs
          SET status = $2, finished_at = now(), duration_ms = $3, accounts = $4, created = $5, updated = $6,
              closed = $7, promoted = $8, demoted = $9, errors = $10, error_sample = $11, next_cursor = $12
        WHERE id = $1`,
      [runId, status, Date.now() - startedAt, r.accounts, r.created, r.updated, r.closed, r.promoted, r.demoted,
        r.errors, errorSample ? errorSample.slice(0, 500) : null, nextCursor],
    );
    await q(`DELETE FROM to_process_scan_runs WHERE id <= $1::bigint - $2::bigint`, [runId, TRACE_RETENTION]);
  } catch (e) {
    console.warn('[to-process-scan] trace non écrite :', (e as Error).message);
  }
}

/**
 * Curseur laissé par le dernier passage terminé (0 = début). Un passage
 * complet le remet à zéro ; un passage interrompu le pose ; un passage ciblé
 * sur un compte le transmet tel quel.
 */
async function resumeCursor(): Promise<number> {
  try {
    const [r] = await q(
      `SELECT next_cursor FROM to_process_scan_runs
        WHERE status <> 'running' ORDER BY id DESC LIMIT 1`,
    );
    return r?.next_cursor != null ? Number(r.next_cursor) : 0;
  } catch {
    return 0;
  }
}

/**
 * `null` : un autre passage détient le bail. Une erreur d'acquisition (base
 * indisponible) est LEVÉE, jamais confondue avec un passage ignoré.
 *
 * `deadline` : instant au-delà duquel le passage s'arrête après le compte en
 * cours (tâche planifiée : délai de la tâche). `accountId` : un seul compte
 * (déclenchement manuel ciblé), sans curseur.
 */
export async function runToProcessFullScan(
  opts: { accountId?: number; limit?: number; trigger?: ScanTrigger; deadline?: number } = {},
): Promise<ToProcessScanResult | null> {
  const limit = opts.limit ?? TO_PROCESS_SCAN_DEFAULT_LIMIT;
  const deadline = opts.deadline ?? Date.now() + TO_PROCESS_SCAN_TIMEOUT_MS - 60_000;
  return withJobLockOrSkip(TO_PROCESS_SCAN_LOCK, TO_PROCESS_SCAN_LOCK_TTL_MS, async () => {
    const startedAt = Date.now();
    const runId = await traceStart(opts.trigger ?? 'route');
    const from = await resumeCursor();

    const cibles = opts.accountId
      ? await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, opts.accountId))
      : await db.select({ id: accounts.id }).from(accounts)
        .where(gt(accounts.id, from)).orderBy(asc(accounts.id)).limit(limit + 1);

    // Une ligne de plus que la limite : elle dit s'il reste des comptes.
    const plusQueLaLimite = !opts.accountId && cibles.length > limit;
    const aTraiter = plusQueLaLimite ? cibles.slice(0, limit) : cibles;

    const totaux = { created: 0, updated: 0, closed: 0, promoted: 0, demoted: 0, refused: 0, errors: 0 };
    let parcourus = 0;
    let dernier: number | null = null;
    let interrompu = false;
    let errorSample: string | null = null;

    for (const compte of aTraiter) {
      if (parcourus > 0 && Date.now() >= deadline) {
        interrompu = true;
        break;
      }
      try {
        const production = await produceAccountActions(compte.id);
        totaux.created += production.created;
        totaux.updated += production.updated;
        totaux.closed += production.closed;
        if (production.errors.length > 0) {
          totaux.errors += 1;
          errorSample ??= `compte ${compte.id} — ${production.errors[0]}`;
        }
        totaux.closed += await closeActionsForDeletedTargets(compte.id);

        const promotion = await promoteDueActions(compte.id);
        totaux.promoted += promotion.promoted;
        totaux.demoted += promotion.demoted;
        totaux.refused += promotion.refused;
      } catch (e) {
        // Un compte en échec ne doit pas arrêter le balayage des autres : le
        // passage suivant le rattrapera. L'échec est compté et tracé.
        totaux.errors += 1;
        errorSample ??= `compte ${compte.id} — ${(e as Error).message}`;
        console.error('[to-process-scan] compte', compte.id, (e as Error).message);
      }
      parcourus += 1;
      dernier = compte.id;
    }

    const partial = interrompu || plusQueLaLimite;
    const result = { accounts: parcourus, ...totaux, partial };
    const curseur = opts.accountId ? (from || null) : partial ? dernier : null;
    await traceFinish(runId, result, startedAt, errorSample, curseur);
    return { ...result, runId };
  });
}

/** Derniers passages, du plus récent au plus ancien (BO Exploitation). */
export async function listToProcessScanRuns(limit = 20): Promise<ToProcessScanRun[]> {
  const rows = await q(
    `SELECT id, trigger, status, started_at, finished_at, duration_ms, accounts, created, updated, closed,
            promoted, demoted, errors, error_sample, next_cursor
       FROM to_process_scan_runs ORDER BY id DESC LIMIT $1`,
    [Math.max(1, Math.min(100, Math.floor(limit)))],
  );
  const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
  return rows.map((r) => ({
    id: Number(r.id),
    trigger: r.trigger as ScanTrigger,
    status: r.status as ToProcessScanRun['status'],
    startedAt: iso(r.started_at)!,
    finishedAt: iso(r.finished_at),
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    accounts: Number(r.accounts),
    created: Number(r.created),
    updated: Number(r.updated),
    closed: Number(r.closed),
    promoted: Number(r.promoted),
    demoted: Number(r.demoted),
    errors: Number(r.errors),
    errorSample: (r.error_sample as string | null) ?? null,
    nextCursor: r.next_cursor === null ? null : Number(r.next_cursor),
  }));
}
