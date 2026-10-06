/**
 * Rattrapages de données lancés depuis le BO « Exploitation » — exécution EN
 * TÂCHE DE FOND dans le serveur (lot 25, chantier B).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * EXCLUSIVITÉ : UN SEUL RATTRAPAGE À LA FOIS SUR TOUTE LA PLATEFORME
 *
 * Verrou consultatif de SESSION `verebona:ops-backfill`, pris par
 * `pg_try_advisory_lock` sur une connexion RÉSERVÉE et tenu jusqu'à la fin de
 * l'exécution, quel que soit le conteneur qui l'exécute :
 *   · un second lancement (même conteneur ou autre) est refusé aussitôt
 *     (`BackfillBusyError` → 409), sans attente ;
 *   · conteneur arrêté en cours de route : PostgreSQL libère le verrou avec la
 *     session ; la ligne restée `running` est alors une exécution orpheline,
 *     marquée `interrupted` au lancement suivant (ou à la lecture de l'état).
 * Filet : index UNIQUE partiel (migration 0253) — au plus une ligne `running`.
 * La ligne passe à son état final AVANT la libération du verrou.
 *
 * Les verrous propres aux services (fusion des pièces, CDC 15 : `--apply` /
 * `--restore`) restent en place : un lancement CLI concurrent est refusé par
 * le service (ConcurrentRunError, rapporté en échec).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONNEXIONS : un client PostgreSQL DÉDIÉ (4 connexions au plus, nom
 * `verebona-ops-backfill` dans pg_stat_activity), ouvert pour l'exécution et
 * fermé à la fin. Le pool web (DB_POOL_MAX) n'est pas consommé par les
 * transactions longues d'un rattrapage — comme pour un script lancé à part
 * (budget : docs/exploitation/migrations-et-sondes.md §3).
 *
 * SUIVI : progression et dernier signe de vie écrits au plus toutes les 3 s ;
 * synthèse lisible et rapport JSON (borné) écrits à la fin ; journal d'audit
 * admin au lancement (ou au refus) et à la fin (auteur, action, motif,
 * identifiants d'exécution).
 * ══════════════════════════════════════════════════════════════════════════
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { pgClient } from '@/db';
import { logAdminAction, type AdminActionEntry, type AdminActionType } from '@/lib/admin-audit';
import { redactString } from '../redact';
import {
  backfillDefinition, type BackfillAction, type BackfillRequest, type BackfillScript, type BackfillStatus,
} from './definitions';
import { executeBackfill, type ExecutionHooks } from './executors';
import {
  boundReport, summarizeBackfill, type BackfillSummary, type RawBackfillOutput,
} from './report-format';

export const OPS_BACKFILL_LOCK_KEY = 'verebona:ops-backfill';
const OWNER = `${(process.env.CONTAINER || hostname()).slice(0, 60)}:${process.pid}`;
const FLUSH_MS = 3_000;
const HEARTBEAT_MS = 30_000;
const LOG_TAIL = 20;

export class BackfillBusyError extends Error {
  readonly code = 'BACKFILL_BUSY';
  constructor(readonly active: BackfillRunView | null) {
    super(active
      ? `Un rattrapage est déjà en cours (${backfillDefinition(active.script)?.label ?? active.script}, ${active.action}, lancé par ${active.adminEmail ?? 'inconnu'}) : un seul à la fois sur la plateforme.`
      : 'Un rattrapage est déjà en cours sur la plateforme (un seul à la fois).');
    this.name = 'BackfillBusyError';
  }
}

export class BackfillUnavailableError extends Error {
  readonly code = 'BACKFILL_UNAVAILABLE';
  constructor(message: string) { super(message); this.name = 'BackfillUnavailableError'; }
}

export interface BackfillProgress {
  lastMessage?: string;
  lastAt?: string;
  data?: Record<string, unknown>;
  log?: string[];
}

export interface BackfillRunView {
  id: string;
  script: BackfillScript;
  action: BackfillAction;
  step: string | null;
  params: Record<string, unknown>;
  status: BackfillStatus;
  reason: string | null;
  adminUserId: number | null;
  adminEmail: string | null;
  scriptRunId: string | null;
  progress: BackfillProgress;
  summary: BackfillSummary | null;
  error: string | null;
  owner: string | null;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

interface Row {
  id: string; script: string; action: string; step: string | null; params: Record<string, unknown> | null;
  status: string; reason: string | null; admin_user_id: number | null; admin_email: string | null;
  script_run_id: string | null; progress: BackfillProgress | null; summary?: BackfillSummary | null; error: string | null;
  owner: string | null; started_at: Date | string; heartbeat_at: Date | string; finished_at: Date | string | null;
}

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

export function toView(r: Row): BackfillRunView {
  const debut = new Date(r.started_at).getTime();
  const fin = r.finished_at ? new Date(r.finished_at).getTime() : null;
  return {
    id: r.id, script: r.script as BackfillScript, action: r.action as BackfillAction, step: r.step, params: r.params ?? {},
    status: r.status as BackfillStatus, reason: r.reason, adminUserId: r.admin_user_id, adminEmail: r.admin_email,
    scriptRunId: r.script_run_id, progress: r.progress ?? {}, summary: r.summary ?? null, error: r.error, owner: r.owner,
    startedAt: iso(r.started_at)!, heartbeatAt: iso(r.heartbeat_at)!, finishedAt: iso(r.finished_at),
    durationMs: fin != null ? fin - debut : null,
  };
}

const COLONNES = `id::text AS id, script, action, step, params, status, reason, admin_user_id, admin_email, script_run_id,
  progress, error, owner, started_at, heartbeat_at, finished_at`;

/* ── Dépendances (injectables pour les tests) ────────────────────────────── */

export interface RunnerDeps {
  /** Client PostgreSQL dédié à UNE exécution (fermé à la fin). */
  openClient: () => postgres.Sql;
  execute: (sql: postgres.Sql, req: BackfillRequest, hooks: ExecutionHooks) => Promise<RawBackfillOutput>;
  audit: (entry: AdminActionEntry) => Promise<void>;
}

export function openOpsClient(): postgres.Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new BackfillUnavailableError('DATABASE_URL absente : rattrapage impossible.');
  const client = postgres(url, {
    max: 4,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => undefined,
    connection: { application_name: 'verebona-ops-backfill' },
  });
  // MÊME configuration de types que `pgClient` (src/db/index.ts) : `drizzle()`
  // rend transparents les sérialiseurs JSON / JSONB (114, 3802) et les
  // parseurs / sérialiseurs de dates (1184, 1114, 1082, 1083…). Les services
  // de rattrapage sont écrits pour ce client-là : sans cela, une chaîne
  // `JSON.stringify(…)` passée à `$n::jsonb` devient un scalaire JSON
  // (« cannot call populate_composite on a scalar »), et les dates des
  // lignes lues deviennent des `Date` au lieu de chaînes.
  drizzle(client);
  return client;
}

const defaultDeps = (): RunnerDeps => ({ openClient: openOpsClient, execute: executeBackfill, audit: logAdminAction });

const AUDIT_ACTION: Record<BackfillAction, AdminActionType> = {
  simulate: 'OPS_BACKFILL_SIMULATE',
  apply: 'OPS_BACKFILL_APPLY',
  restore: 'OPS_BACKFILL_RESTORE',
};

/* ── Exécutions en cours dans CE processus (tests, arrêt propre) ─────────── */

const EN_COURS = Symbol.for('verebona.ops.backfill.running');
function enCours(): Map<string, Promise<void>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
  return (g[EN_COURS] ??= new Map());
}

/** Attend la fin d'une exécution lancée par ce processus (tests). */
export async function waitForBackfill(id: string): Promise<void> {
  await enCours().get(id);
}

/* ── Lancement ───────────────────────────────────────────────────────────── */

export interface Launcher { id: number; email?: string }

/**
 * Lance un rattrapage en tâche de fond. Rend la ligne créée dès que le verrou
 * est pris (l'exécution continue après la réponse HTTP).
 */
export async function startBackfill(req: BackfillRequest, admin: Launcher, deps: RunnerDeps = defaultDeps()): Promise<BackfillRunView> {
  const details = { script: req.script, action: req.action, step: req.step, accountId: req.accountId, restoreRunId: req.runId, reason: req.reason };
  const sql = deps.openClient();
  let cnx: postgres.ReservedSql | null = null;
  let verrou = false;
  let confie = false;
  try {
    cnx = await sql.reserve();
    const [{ ok }] = await cnx<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${OPS_BACKFILL_LOCK_KEY})) AS ok`;
    if (!ok) {
      const active = await readActive(cnx).catch(() => null);
      await deps.audit({
        adminId: admin.id, adminEmail: admin.email, action: AUDIT_ACTION[req.action], targetType: 'OPS_BACKFILL', targetId: null,
        result: 'DENIED', after: details, details: { code: 'BACKFILL_BUSY', activeRunId: active?.id ?? null },
      });
      throw new BackfillBusyError(active);
    }
    verrou = true;

    // Verrou obtenu : toute ligne encore `running` est orpheline (processus arrêté).
    await marquerOrphelines(cnx);

    if (!admin.email) {
      // Auteur affiché (« lancé par ») et journalisé : relu en base si la session ne le porte pas.
      const [u] = await cnx.unsafe<Array<{ email: string }>>(`SELECT email FROM users WHERE id = $1`, [admin.id] as never[]).catch(() => []);
      if (u?.email) admin = { ...admin, email: u.email };
    }
    const id = randomUUID();
    const params = { accountId: req.accountId, restoreRunId: req.runId };
    let rows: Row[];
    try {
      rows = await cnx.unsafe<Row[]>(
        `INSERT INTO ops_backfill_runs (id, script, action, step, params, status, reason, admin_user_id, admin_email, owner, progress)
         VALUES ($1::uuid, $2, $3, $4, $5::text::jsonb, 'running', $6, $7, $8, $9, $10::text::jsonb)
         RETURNING ${COLONNES}`,
        [id, req.script, req.action, req.step, JSON.stringify(params), req.reason, admin.id, admin.email ?? null, OWNER,
          JSON.stringify({ lastMessage: 'Lancement…', lastAt: new Date().toISOString() })] as never[],
      );
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') throw new BackfillBusyError(await readActive(cnx).catch(() => null));
      if (code === '42P01') throw new BackfillUnavailableError('Table ops_backfill_runs absente : migration 0253 non appliquée.');
      throw e;
    }
    const run = toView(rows[0]);
    await deps.audit({
      adminId: admin.id, adminEmail: admin.email, action: AUDIT_ACTION[req.action], targetType: 'OPS_BACKFILL', targetId: null,
      result: 'SUCCESS', after: { ...details, runId: id }, details: { phase: 'launched', runId: id },
    });

    const tenue = cnx;
    // La connexion, le verrou et le client passent à la tâche de fond.
    cnx = null;
    verrou = false;
    confie = true;
    const done = executerEnFond(sql, tenue, run, req, admin, deps).finally(() => enCours().delete(id));
    enCours().set(id, done);
    return run;
  } finally {
    if (cnx) {
      if (verrou) await cnx`SELECT pg_advisory_unlock(hashtext(${OPS_BACKFILL_LOCK_KEY}))`.catch(() => undefined);
      cnx.release();
    }
    // Échec avant la tâche de fond : le client dédié est fermé ici.
    if (!confie) await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function marquerOrphelines(q: postgres.Sql | postgres.ReservedSql): Promise<number> {
  const r = await q.unsafe(
    `UPDATE ops_backfill_runs
        SET status = 'interrupted', finished_at = now(),
            error = COALESCE(error, 'Exécution interrompue : le processus qui la portait s’est arrêté (redémarrage, déploiement).')
      WHERE status = 'running'
      RETURNING id`,
  );
  return r.length;
}

async function executerEnFond(
  sql: postgres.Sql, cnx: postgres.ReservedSql, run: BackfillRunView, req: BackfillRequest, admin: Launcher, deps: RunnerDeps,
): Promise<void> {
  const progression: BackfillProgress = { ...run.progress, log: [] };
  let sale = false;
  let ecriture: Promise<unknown> = Promise.resolve();
  const ecrire = () => {
    sale = false;
    const p = JSON.stringify(progression);
    ecriture = ecriture.then(() => cnx.unsafe(
      `UPDATE ops_backfill_runs SET progress = $2::text::jsonb, heartbeat_at = now() WHERE id = $1::uuid AND status = 'running'`,
      [run.id, p] as never[],
    )).catch((e) => console.error('[ops-backfill] progression non écrite :', (e as Error).message));
  };
  const minuterie = setInterval(() => { if (sale) ecrire(); }, FLUSH_MS);
  const battement = setInterval(() => ecrire(), HEARTBEAT_MS);
  minuterie.unref?.();
  battement.unref?.();

  const hooks: ExecutionHooks = {
    log: (m) => {
      const ligne = redactString(String(m)).slice(0, 500);
      progression.lastMessage = ligne;
      progression.lastAt = new Date().toISOString();
      progression.log = [...(progression.log ?? []), ligne].slice(-LOG_TAIL);
      sale = true;
    },
    progress: (p) => {
      progression.data = { ...(progression.data ?? {}), ...p };
      progression.lastAt = new Date().toISOString();
      sale = true;
    },
  };

  let status: BackfillStatus = 'succeeded';
  let summary: BackfillSummary | null = null;
  let report: unknown = null;
  let erreur: string | null = null;
  try {
    const out = await deps.execute(sql, req, hooks);
    summary = summarizeBackfill(req.script, req.action, req.step, out);
    report = boundReport({
      runId: run.id, script: req.script, action: req.action, step: req.step, params: run.params,
      startedAt: run.startedAt, finishedAt: new Date().toISOString(),
      summary, result: out.result, scriptSummary: out.scriptSummary ?? null, scriptReport: out.scriptText ?? null,
    });
    // Même règle que le script CLI : une pièce en échec = code de sortie 1.
    const echecs = req.script === 'merge-rooms' && req.action !== 'restore'
      ? Number((out.result as { counts?: Record<string, number> }).counts?.failed ?? 0) : 0;
    if (echecs > 0) {
      status = 'failed';
      erreur = `${echecs} pièce(s) en échec (voir les avertissements du rapport).`;
    }
    hooks.log(summary.headline);
  } catch (e) {
    status = 'failed';
    erreur = redactString((e as Error)?.message ?? String(e)).slice(0, 2000);
    hooks.log(`Échec : ${erreur}`);
    report = boundReport({
      runId: run.id, script: req.script, action: req.action, step: req.step, params: run.params,
      startedAt: run.startedAt, finishedAt: new Date().toISOString(), error: erreur, log: progression.log ?? [],
    });
    console.error(`[ops-backfill] ${req.script} ${req.action} (${run.id}) en échec :`, erreur);
  } finally {
    clearInterval(minuterie);
    clearInterval(battement);
    await ecriture;
  }

  try {
    await cnx.unsafe(
      `UPDATE ops_backfill_runs
          SET status = $2, summary = $3::text::jsonb, report = $4::text::jsonb, error = $5, script_run_id = $6,
              progress = $7::text::jsonb, finished_at = now(), heartbeat_at = now()
        WHERE id = $1::uuid`,
      [run.id, status, summary ? JSON.stringify(summary) : null, report ? JSON.stringify(report) : null, erreur,
        summary?.scriptRunId ?? null, JSON.stringify(progression)] as never[],
    );
  } catch (e) {
    console.error('[ops-backfill] état final non écrit (ligne marquée interrompue au prochain lancement) :', (e as Error).message);
  } finally {
    await cnx`SELECT pg_advisory_unlock(hashtext(${OPS_BACKFILL_LOCK_KEY}))`.catch(() => undefined);
    cnx.release();
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }

  await deps.audit({
    adminId: admin.id, adminEmail: admin.email, action: AUDIT_ACTION[req.action], targetType: 'OPS_BACKFILL', targetId: null,
    result: status === 'succeeded' ? 'SUCCESS' : 'FAILURE',
    after: { script: req.script, action: req.action, step: req.step, runId: run.id, scriptRunId: summary?.scriptRunId ?? null, reason: req.reason },
    details: { phase: 'finished', runId: run.id, status, ...(erreur ? { error: erreur.slice(0, 300) } : {}) },
  }).catch(() => undefined);
}

/* ── Lecture ─────────────────────────────────────────────────────────────── */

async function readActive(q: postgres.Sql | postgres.ReservedSql): Promise<BackfillRunView | null> {
  const [r] = await q.unsafe<Row[]>(`SELECT ${COLONNES} FROM ops_backfill_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`);
  return r ? toView(r) : null;
}

/**
 * Le verrou de la plateforme est-il tenu par une session ? Lecture de
 * `pg_locks` (aucune prise de verrou : une lecture ne doit jamais faire
 * refuser un lancement concurrent).
 */
export async function isPlatformLockHeld(q: postgres.Sql = pgClient): Promise<boolean> {
  const [r] = await q<{ held: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory' AND objsubid = 1 AND granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND ((classid::bigint << 32) | objid::bigint) = hashtext(${OPS_BACKFILL_LOCK_KEY})::bigint
    ) AS held`;
  return r?.held === true;
}

export interface BackfillState {
  active: BackfillRunView | null;
  history: BackfillRunView[];
  /** Exécutions orphelines constatées à cette lecture (marquées interrompues). */
  recoveredOrphans: number;
}

/** État et historique (sans les rapports JSON). Auto-réparation des orphelines. */
export async function getBackfillState(limit = 50, q: postgres.Sql = pgClient): Promise<BackfillState> {
  let recovered = 0;
  let active = await readActive(q);
  if (active && !(await isPlatformLockHeld(q))) {
    // Plus aucune session ne tient le verrou : le processus s'est arrêté.
    // (Une exécution qui se termine met sa ligne à jour AVANT de libérer le verrou.)
    recovered = await q.unsafe(
      `UPDATE ops_backfill_runs
          SET status = 'interrupted', finished_at = now(),
              error = COALESCE(error, 'Exécution interrompue : le processus qui la portait s’est arrêté (redémarrage, déploiement).')
        WHERE id = $1::uuid AND status = 'running'
        RETURNING id`, [active.id] as never[],
    ).then((r) => r.length);
    if (recovered) active = null;
  }
  const rows = await q.unsafe<Row[]>(
    `SELECT ${COLONNES}, summary FROM ops_backfill_runs ORDER BY started_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 200)] as never[],
  );
  return { active, history: rows.map(toView), recoveredOrphans: recovered };
}

export async function getBackfillRun(id: string, q: postgres.Sql = pgClient): Promise<BackfillRunView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await q.unsafe<Row[]>(`SELECT ${COLONNES}, summary FROM ops_backfill_runs WHERE id = $1::uuid`, [id] as never[]);
  return r ? toView(r) : null;
}

export async function getBackfillReport(id: string, q: postgres.Sql = pgClient): Promise<{ run: BackfillRunView; report: unknown } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await q.unsafe<Array<Row & { report: unknown }>>(
    `SELECT ${COLONNES}, summary, report FROM ops_backfill_runs WHERE id = $1::uuid`, [id] as never[],
  );
  return r ? { run: toView(r), report: r.report } : null;
}
