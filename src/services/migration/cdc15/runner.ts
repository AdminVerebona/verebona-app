/**
 * Rattrapages de données du CDC 15 §14 (MIG-01 à MIG-09) — orchestration
 * (plan lot 17, volet B ; décisions D-10, D-16).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE MIGRATION (CDC 15 §14, MIG-09)
 * « Aucune migration automatique ne doit écraser une valeur USER/ADMIN ni
 * trancher un conflit non résolu. Les cas ambigus vont dans un rapport de
 * migration ou À traiter. »
 *   · une valeur humaine n'est jamais remplacée : SKIPPED_USER ;
 *   · un conflit n'est jamais tranché : AMBIGUOUS, au rapport 0225, et en
 *     carte À traiter MIG-REVIEW quand l'utilisateur peut choisir (idempotente) ;
 *   · sans `apply` : AUCUNE écriture de données ni de carte — seules les
 *     tables de rapport 0225 sont écrites (et rien du tout avec
 *     `dbReport: false`) ;
 *   · jamais `ensureMigrations` : un prérequis absent est signalé, rien ne
 *     s'exécute.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Par lots bornés, avec pause, limite et reprise (`resumeRunId` : les étapes
 * terminées sont sautées, l'étape interrompue reprend à son curseur).
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { createRun, finishRun, loadRun, ReportSink, saveCursor } from './report';
import { REPORT_REQUIREMENTS, STEP_REQUIREMENTS, formatMissing, missingRequirements } from './schema-check';
import { planKcAliases, runMig01 } from './steps/mig01-aliases';
import { runMig02 } from './steps/mig02-amounts';
import { planOrigins, runMig03 } from './steps/mig03-origins';
import { loadHistory } from './history';
import { restoreBackups, type RestoreResult } from './backup';
import { ALL_MIRROR_COLUMNS, type AssetRowJson } from '@/services/canonical/asset-state';
import { runMig04 } from './steps/mig04-supersede';
import { runMig07 } from './steps/mig07-mirrors';
import { runMig05, runMig06, runMig08 } from './steps/orchestrated';
import {
  ALL_ORDER, MIG_STEPS, type Decision, type MigStep, type ReportEntry, type ReviewCardRequest, type StepContext, type StepResult,
} from './types';

export class MissingRequirementsError extends Error {
  constructor(message: string) { super(message); this.name = 'MissingRequirementsError'; }
}

export interface BackfillOptions {
  sql: postgres.Sql;
  steps: MigStep[] | 'all';
  accountId?: number | null;
  apply?: boolean;
  batchSize?: number;
  pauseMs?: number;
  limit?: number | null;
  /** Reprise d'une exécution interrompue. */
  resumeRunId?: string | null;
  /** Rapport en base (0225) ; faux : rapport en mémoire seulement. */
  dbReport?: boolean;
  log?: (msg: string) => void;
}

export interface BackfillRunResult {
  runId: string;
  mode: 'dry_run' | 'apply';
  results: StepResult[];
  /** Entrées du rapport gardées en mémoire (bornées). */
  entries: ReportEntry[];
  /** Avertissements (simulation partielle, exécution orpheline…). */
  warnings: string[];
}

const RUNNERS: Record<MigStep, (ctx: StepContext) => Promise<StepResult>> = {
  'MIG-01': runMig01, 'MIG-02': runMig02, 'MIG-03': runMig03, 'MIG-04': runMig04,
  'MIG-05': runMig05, 'MIG-06': runMig06, 'MIG-07': runMig07, 'MIG-08': runMig08,
};

/** Étapes demandées, dans l'ordre d'exécution (pur, testé). */
export function orderSteps(steps: MigStep[] | 'all'): MigStep[] {
  if (steps === 'all') return [...ALL_ORDER];
  for (const s of steps) if (!(MIG_STEPS as readonly string[]).includes(s)) throw new Error(`Étape inconnue : ${s}`);
  return ALL_ORDER.filter((s) => steps.includes(s));
}

/** Verrou consultatif GLOBAL des rattrapages (une seule application à la fois). */
export const BACKFILL_LOCK_KEY = 'cdc15_backfill';

type Verrou = { liberer: () => Promise<void> };

/**
 * Verrou de SESSION sur une connexion réservée (tenue jusqu'à la fin) :
 * deux `--apply` (ou `--restore`) simultanés sont refusés, jamais entrelacés.
 */
export async function acquireBackfillLock(sql: postgres.Sql): Promise<Verrou> {
  const cnx = await sql.reserve();
  const [{ ok }] = await cnx<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${BACKFILL_LOCK_KEY})) AS ok`;
  if (!ok) {
    cnx.release();
    throw new ConcurrentRunError('Une autre exécution --apply (ou --restore) des rattrapages CDC 15 est en cours : rien n’a été fait.');
  }
  return {
    liberer: async () => {
      try { await cnx`SELECT pg_advisory_unlock(hashtext(${BACKFILL_LOCK_KEY}))`; } finally { cnx.release(); }
    },
  };
}

export class ConcurrentRunError extends Error {
  constructor(message: string) { super(message); this.name = 'ConcurrentRunError'; }
}

/**
 * Simulation : lignes telles que MIG-01 et MIG-03 (si elles font partie de
 * l'exécution et la précèdent) les laisseraient — calcul en mémoire, rien
 * n'est écrit.
 */
function previewFor(sql: postgres.Sql, steps: MigStep[], step: MigStep) {
  const avant = steps.slice(0, steps.indexOf(step));
  const alias = avant.includes('MIG-01');
  const origines = avant.includes('MIG-03');
  if (!alias && !origines) return undefined;
  return async <R extends AssetRowJson & { id: number }>(rows: R[]): Promise<R[]> => {
    let out = rows;
    if (alias) {
      out = out.map((r) => {
        const p = planKcAliases(r);
        return p.kc ? { ...r, key_characteristics: JSON.stringify(p.kc) } : r;
      });
    }
    if (origines) {
      const h = await loadHistory(sql, out.map((r) => r.id));
      out = out.map((r) => {
        const p = planOrigins(r, h.get(r.id));
        return p.kc ? { ...r, key_characteristics: JSON.stringify(p.kc) } : r;
      });
    }
    return out;
  };
}

export async function runCdc15Backfill(o: BackfillOptions): Promise<BackfillRunResult> {
  const log = o.log ?? (() => {});
  const dbReport = o.dbReport !== false;
  let steps = orderSteps(o.steps);
  let apply = !!o.apply;
  let accountId = o.accountId ?? null;
  let cursors: Record<string, number> = {};
  let done = new Set<MigStep>();
  let runId = o.resumeRunId ?? randomUUID();
  const warnings: string[] = [];

  const reqs = [...(dbReport || o.resumeRunId ? REPORT_REQUIREMENTS : []), ...steps.flatMap((s) => STEP_REQUIREMENTS[s])];
  const uniques = reqs.filter((r, i) => reqs.findIndex((x) => x.kind === r.kind && x.name === r.name) === i);
  const missing = await missingRequirements(o.sql, uniques);
  if (missing.length) throw new MissingRequirementsError(formatMissing(missing));

  let resumed: Awaited<ReturnType<typeof loadRun>> = null;
  if (o.resumeRunId) {
    resumed = await loadRun(o.sql, o.resumeRunId);
    if (!resumed) throw new Error(`Exécution ${o.resumeRunId} introuvable.`);
    if (resumed.status === 'DONE') throw new Error(`Exécution ${o.resumeRunId} déjà terminée.`);
    steps = resumed.steps; apply = resumed.runMode === 'apply'; accountId = resumed.accountId; cursors = resumed.cursors as Record<string, number>;
    done = new Set(Object.keys(resumed.counts ?? {}) as MigStep[]);
    runId = resumed.runId;
  }

  // Une seule application à la fois (verrou tenu jusqu'à la fin).
  const verrou = apply ? await acquireBackfillLock(o.sql) : null;
  try {
    if (resumed?.status === 'RUNNING') {
      // Verrou obtenu : aucune exécution active — celle-ci a été interrompue sans fin propre.
      const w = `Exécution ${resumed.runId} trouvée RUNNING : interrompue sans fin propre (processus arrêté). Reprise à ses curseurs.`;
      warnings.push(w);
      log(w);
    }
    if (apply && !resumed && dbReport) {
      const orphelins = await o.sql<{ run_id: string }[]>`SELECT run_id FROM cdc15_migration_runs WHERE status = 'RUNNING' AND run_mode = 'apply'`;
      for (const x of orphelins) {
        const w = `Exécution ${x.run_id} RUNNING orpheline (interrompue) : reprenez-la par --resume ${x.run_id}.`;
        warnings.push(w);
        log(w);
      }
    }
    if (!apply && (steps.includes('MIG-02') || steps.includes('MIG-07')) && !steps.includes('MIG-03')) {
      const w = 'Simulation sans MIG-03 : les origines ne sont pas reconstituées en mémoire — le rapport de MIG-02 / MIG-07 '
        + 'peut différer d’une application complète (--step all).';
      warnings.push(w);
      log(w);
    }
    if (!apply && steps.includes('MIG-02') && steps.includes('MIG-07')) {
      const w = 'Simulation : les corrections de MIG-02 ne sont pas reportées en mémoire sur MIG-07 — un montant corrigé '
        + 'peut y apparaître avec son ancienne colonne miroir (MIRROR_FILLED / MIRROR_ALIGNED_ON_KC) qui disparaîtra à l’application.';
      warnings.push(w);
      log(w);
    }
    if (!resumed && dbReport) {
      await createRun(o.sql, {
        runId, runMode: apply ? 'apply' : 'dry_run', steps, accountId,
        options: { batchSize: o.batchSize ?? 200, pauseMs: o.pauseMs ?? 0, limit: o.limit ?? null, warnings },
      });
    }
    const mode = apply ? 'apply' as const : 'dry_run' as const;
    const sink = new ReportSink(dbReport ? o.sql : null, runId, mode);
    const counts: Partial<Record<MigStep, Record<Decision, number>>> = {};
    const results: StepResult[] = [];
    let partielle = false;

    const card = async (c: ReviewCardRequest): Promise<'CREATED' | 'UPDATED' | 'SKIPPED'> => {
      if (!apply) return 'SKIPPED'; // simulation : aucune carte
      const { upsertMigrationReviewCard } = await import('@/services/to-process/migration-review-cards');
      return upsertMigrationReviewCard(c);
    };

    try {
      for (const step of steps) {
        if (done.has(step)) { log(`${step} : déjà terminée (reprise), ignorée.`); continue; }
        const ctx: StepContext = {
          sql: o.sql, runId, apply, accountId,
          batchSize: Math.max(1, Math.min(o.batchSize ?? 200, 5000)),
          pauseMs: Math.max(0, o.pauseMs ?? 0),
          limit: o.limit ?? null,
          fromCursor: cursors[step] ?? 0,
          cursorOf: (part) => cursors[part] ?? 0,
          report: (e) => sink.add(e),
          card,
          checkpoint: async (c, part) => { if (dbReport) await saveCursor(o.sql, runId, part ?? step, c); },
          preview: apply || !['MIG-02', 'MIG-03', 'MIG-07'].includes(step) ? undefined : previewFor(o.sql, steps, step),
          log: (m) => log(m),
        };
        log(`${step} : ${apply ? 'application' : 'simulation'}…`);
        const r = await RUNNERS[step](ctx);
        await sink.flush();
        results.push(r);
        // Étape complète (aucune partie arrêtée par --limit) : terminée pour la reprise.
        if (r.complete) counts[step] = r.counts;
        else partielle = true;
        log(`${step} : ${r.skipped ? `ignorée (${r.skipped})` : `${r.scanned} parcouru(s)${r.complete ? '' : ' (limite atteinte)'}`} — `
          + `${Object.entries(r.counts).map(([d, n]) => `${d} ${n}`).join(', ')}${r.cards ? `, ${r.cards} carte(s)` : ''}`);
      }
      if (dbReport) await finishRun(o.sql, runId, partielle ? 'PARTIAL' : 'DONE', counts);
    } catch (e) {
      await sink.flush().catch(() => {});
      if (dbReport) await finishRun(o.sql, runId, 'FAILED', counts).catch(() => {});
      throw e;
    }
    return { runId, mode, results, entries: sink.entries, warnings };
  } finally {
    await verrou?.liberer();
  }
}

/**
 * `--restore <runId>` : remet TOUT ce que l'exécution a écrit (colonnes,
 * clés de fiche et leurs métadonnées, preuves, faits — `backup.ts`), dans
 * l'ordre inverse ; une valeur modifiée depuis l'exécution n'est pas
 * restaurée (`conflicts`). Idempotente. Sous le verrou global.
 */
export async function restoreCdc15Run(sql: postgres.Sql, runId: string): Promise<RestoreResult> {
  const missing = await missingRequirements(sql, [{ kind: 'table', name: 'cdc15_migration_backups', migration: '0225_cdc15_migration_report_backups' }]);
  if (missing.length) throw new MissingRequirementsError(formatMissing(missing));
  const verrou = await acquireBackfillLock(sql);
  try {
    return await restoreBackups(sql, runId, ALL_MIRROR_COLUMNS);
  } finally {
    await verrou.liberer();
  }
}
