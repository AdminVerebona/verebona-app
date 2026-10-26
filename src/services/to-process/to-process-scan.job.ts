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
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { accounts } from '@/db/schema';
import { withJobLockOrSkip } from '@/lib/job-lock';
import { innerLockTtlMs, TO_PROCESS_SCAN_TIMEOUT_MS } from '@/services/scheduling/task-timeouts';
import {
  closeActionsForDeletedTargets, closeInapplicableAssetFieldActions, produceAccountActions, type ScanErrorDetail,
} from './producers.service';
import { promoteDueActions } from './priority-scheduler.service';

const TO_PROCESS_SCAN_LOCK = 'to-process-scan';
/** Couvre la durée maximale d'une exécution planifiée (2 × délai + marge). */
const TO_PROCESS_SCAN_LOCK_TTL_MS = innerLockTtlMs(TO_PROCESS_SCAN_TIMEOUT_MS);

/** Comptes au plus par passage (le suivant reprend au curseur). */
const TO_PROCESS_SCAN_DEFAULT_LIMIT = 5000;
/** Lignes de trace conservées. */
const TRACE_RETENTION = 500;

type ScanTrigger = 'schedule' | 'manual' | 'startup' | 'route';

interface ToProcessScanResult {
  accounts: number;
  created: number;
  updated: number;
  closed: number;
  promoted: number;
  demoted: number;
  refused: number;
  /** Comptes portant au moins une erreur sur ce passage (famille, règle, écriture non confirmée, trace). */
  errors: number;
  /** Lot 75I (B) : comptes en échec SANS résultat exploitable (exception, toutes les familles en échec). */
  failedAccounts: number;
  /** Passage interrompu (délai, limite) : le suivant reprend au curseur. */
  partial: boolean;
  /** Lot 75I (B) : statut fidèle du passage (ok / partial / error). */
  status: 'ok' | 'partial' | 'error';
  /** Lot 75I (B) : erreurs détaillées (≤ 50) — compte, document, règle, étape, nature, cause. */
  errorDetails: ScanErrorDetail[];
  /** Lot 75I (B) : bilan — documents réévalués, issues, refus normaux (valeur protégée), erreurs par nature. */
  summary: ScanSummary;
  /** Ligne de trace (`to_process_scan_runs`), null si la table manque. */
  runId: number | null;
}

/** Bilan d'un passage (lot 75I, B). */
interface ScanSummary {
  documents: number;
  outcomes: Record<string, number>;
  /** Refus NORMAUX : écriture automatique refusée car la valeur de l'utilisateur est protégée (jamais une erreur). */
  protectedRefusals: number;
  /** Erreurs par nature (PERSISTENCE_FAILED, READ_FAILED, TRACE_FAILED, FAMILY_FAILED…). */
  errorsByKind: Record<string, number>;
}

/** Erreurs détaillées conservées par passage. */
const SCAN_ERROR_DETAILS_MAX = 50;

/**
 * Lot 75I (B) — statut d'un passage (pure) :
 *   · ok      : traitement terminé, aucune erreur ;
 *   · partial : une partie a réussi et une autre a échoué (règle, famille,
 *               compte), ou passage incomplet (délai, limite) ;
 *   · error   : aucun résultat exploitable (tous les comptes en échec, ou
 *               échec avant tout traitement).
 * L'ancien calcul rendait « ok » dès qu'au moins un compte réussissait.
 */
export function scanRunStatus(r: { accounts: number; failedAccounts: number; accountsWithErrors: number; partial: boolean; fatal?: boolean }): 'ok' | 'partial' | 'error' {
  if (r.fatal) return 'error';
  if (r.accounts > 0 && r.failedAccounts >= r.accounts) return 'error';
  if (r.failedAccounts > 0 || r.accountsWithErrors > 0 || r.partial) return 'partial';
  return 'ok';
}

/** Ligne de trace, telle que le BO la lit. */
interface ToProcessScanRun {
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
  /** Lot 75I (B, 0560) : comptes en échec complet, erreurs détaillées, bilan (null : passage antérieur). */
  failedAccounts?: number | null;
  errorDetails?: ScanErrorDetail[] | null;
  summary?: ScanSummary | null;
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

let colonnes0560: { at: number; ok: boolean } | null = null;
/** Colonnes du lot 75I (0560) présentes ? (relu au plus toutes les 5 minutes) */
async function scanDetailColumnsReady(): Promise<boolean> {
  if (colonnes0560 && Date.now() - colonnes0560.at < 300_000) return colonnes0560.ok;
  try {
    const [r] = await q(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                                          AND table_name = 'to_process_scan_runs' AND column_name = 'error_details') AS ok`);
    colonnes0560 = { at: Date.now(), ok: r?.ok === true };
  } catch { colonnes0560 = { at: Date.now(), ok: false }; }
  return colonnes0560.ok;
}

async function traceFinish(runId: number | null, r: Omit<ToProcessScanResult, 'runId'>, startedAt: number, errorSample: string | null, nextCursor: number | null): Promise<void> {
  if (runId === null) return;
  try {
    const detail = await scanDetailColumnsReady();
    await q(
      `UPDATE to_process_scan_runs
          SET status = $2, finished_at = now(), duration_ms = $3, accounts = $4, created = $5, updated = $6,
              closed = $7, promoted = $8, demoted = $9, errors = $10, error_sample = $11, next_cursor = $12
              ${detail ? ', failed_accounts = $13, error_details = $14::jsonb, summary = $15::jsonb' : ''}
        WHERE id = $1`,
      [runId, r.status, Date.now() - startedAt, r.accounts, r.created, r.updated, r.closed, r.promoted, r.demoted,
        r.errors, errorSample ? errorSample.slice(0, 500) : null, nextCursor,
        ...(detail ? [r.failedAccounts, JSON.stringify(r.errorDetails.slice(0, SCAN_ERROR_DETAILS_MAX)), JSON.stringify(r.summary)] : [])],
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

    // Lot 82A (C-Q10, §3.3) : production « À traiter » des seuls comptes
    // éligibles (ni essai échu, ni suspendus, ni en lecture seule) ; le
    // curseur avance sur les comptes éligibles, la reprise rattrape les autres.
    const eligible = sql.raw(processingEligibleSql('"accounts"."id"'));
    const cibles = opts.accountId
      ? await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, opts.accountId), eligible))
      : await db.select({ id: accounts.id }).from(accounts)
        .where(and(gt(accounts.id, from), eligible)).orderBy(asc(accounts.id)).limit(limit + 1);

    // Une ligne de plus que la limite : elle dit s'il reste des comptes.
    const plusQueLaLimite = !opts.accountId && cibles.length > limit;
    const aTraiter = plusQueLaLimite ? cibles.slice(0, limit) : cibles;

    const totaux = { created: 0, updated: 0, closed: 0, promoted: 0, demoted: 0, refused: 0, errors: 0, failedAccounts: 0 };
    let parcourus = 0;
    let dernier: number | null = null;
    let interrompu = false;
    let errorSample: string | null = null;
    const errorDetails: ScanErrorDetail[] = [];
    const summary: ScanSummary = { documents: 0, outcomes: {}, protectedRefusals: 0, errorsByKind: {} };
    const noter = (d: ScanErrorDetail) => {
      summary.errorsByKind[d.kind] = (summary.errorsByKind[d.kind] ?? 0) + 1;
      if (errorDetails.length < SCAN_ERROR_DETAILS_MAX) errorDetails.push(d);
    };

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
        summary.documents += production.documents ?? 0;
        summary.protectedRefusals += production.protectedRefusals ?? 0;
        for (const [k, n] of Object.entries(production.outcomes ?? {})) summary.outcomes[k] = (summary.outcomes[k] ?? 0) + n;
        for (const d of production.errorDetails ?? []) noter(d);
        if (production.errors.length > 0) {
          totaux.errors += 1;
          errorSample ??= `compte ${compte.id} — ${production.errors[0]}`;
        }
        // Lot 75I (B) : toutes les familles en échec = aucun résultat exploitable pour ce compte.
        if (production.familiesFailed !== undefined && production.familiesTotal !== undefined && production.familiesFailed >= production.familiesTotal) {
          totaux.failedAccounts += 1;
        }
        totaux.closed += await closeActionsForDeletedTargets(compte.id);
        // Lot 32 (L32-1) : donnée de bien sans objet (immatriculation d'un vélo).
        totaux.closed += await closeInapplicableAssetFieldActions(compte.id);

        const promotion = await promoteDueActions(compte.id);
        totaux.promoted += promotion.promoted;
        totaux.demoted += promotion.demoted;
        totaux.refused += promotion.refused;
      } catch (e) {
        // Un compte en échec ne doit pas arrêter le balayage des autres : le
        // passage suivant le rattrapera. L'échec est compté et tracé ; les
        // cartes restent en place (aucune résolution artificielle).
        totaux.errors += 1;
        totaux.failedAccounts += 1;
        const cause = String((e as Error).message).slice(0, 300);
        errorSample ??= `compte ${compte.id} — ${cause}`;
        noter({ accountId: compte.id, fileId: null, ruleCode: '*', step: 'ACCOUNT', kind: 'ACCOUNT_FAILED', cause });
        console.error('[to-process-scan] compte', compte.id, cause);
      }
      parcourus += 1;
      dernier = compte.id;
    }

    const partial = interrompu || plusQueLaLimite;
    const status = scanRunStatus({ accounts: parcourus, failedAccounts: totaux.failedAccounts, accountsWithErrors: totaux.errors, partial });
    const result = { accounts: parcourus, ...totaux, partial, status, errorDetails, summary };
    const curseur = opts.accountId ? (from || null) : partial ? dernier : null;
    await traceFinish(runId, result, startedAt, errorSample, curseur);
    return { ...result, runId };
  });
}

/** Derniers passages, du plus récent au plus ancien (BO Exploitation). */
export async function listToProcessScanRuns(limit = 20): Promise<ToProcessScanRun[]> {
  const detail = await scanDetailColumnsReady();
  const rows = await q(
    `SELECT id, trigger, status, started_at, finished_at, duration_ms, accounts, created, updated, closed,
            promoted, demoted, errors, error_sample, next_cursor${detail ? ', failed_accounts, error_details, summary' : ''}
       FROM to_process_scan_runs ORDER BY id DESC LIMIT $1`,
    [Math.max(1, Math.min(100, Math.floor(limit)))],
  );
  const obj = <T>(v: unknown): T | null => (v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v) as T);
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
    failedAccounts: r.failed_accounts == null ? null : Number(r.failed_accounts),
    errorDetails: obj<ScanErrorDetail[]>(r.error_details),
    summary: obj<ScanSummary>(r.summary),
  }));
}
