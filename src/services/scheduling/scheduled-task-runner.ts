/**
 * Moteur des tâches planifiées internes — lot 25, chantier A.
 *
 * Démarré par `instrumentation-node.ts`, à côté des tâches quotidiennes
 * (`daily-maintenance-scheduler.ts`) et de la sauvegarde, dont il reprend les
 * principes : tour périodique dans chaque instance, coordination par la base
 * (jamais par la mémoire d'un processus), heures de Paris.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN TOUR DE 30 s ET UNE LIGNE PAR TÂCHE
 *
 * Le planificateur quotidien tourne toutes les 30 min avec des fenêtres à
 * l'heure près et un bail-cadenceur de 20 h : il ne sait ni envoyer les
 * notifications chaque minute, ni viser 8 h 30, ni dire quand une tâche a
 * tourné pour la dernière fois. Ici, chaque tâche a sa ligne
 * (`scheduled_task_state`) qui porte son échéance, son bail d'exécution et sa
 * dernière exécution ; le tour (30 s) ne fait qu'une lecture indexée.
 *
 * GARANTIES
 *   · une seule exécution à la fois par tâche, toutes instances confondues,
 *     y compris pendant le recouvrement d'un déploiement : prise atomique de
 *     la ligne (`scheduled-task-state.ts`), exécution manuelle comprise ;
 *   · bail COURT (90 s) renouvelé toutes les 30 s pendant l'exécution, au plus
 *     2 × le délai après le début : un conteneur tué (déploiement, crash)
 *     bloque sa tâche au plus 90 s ; à l'arrêt propre (SIGTERM/SIGINT,
 *     beforeExit) les baux des exécutions en cours sont ramenés à 10 s ;
 *   · délai borné (`timeoutMs`) : au-delà, l'exécution est déclarée en échec
 *     et le tour continue ; le bail reste renouvelé tant que le travail n'a
 *     pas rendu la main (plafond 2 × délai), pour qu'aucune autre instance ne
 *     le double ;
 *   · charge bornée par instance : une tâche à la fois (hors envoi des
 *     notifications, qui a son propre créneau ; SCHEDULED_TASKS_MAX_PARALLEL,
 *     1 à 4) et aucun lancement quand le pool de connexions a des requêtes en
 *     attente (`pool-metrics.ts`) ;
 *   · isolement : chaque tâche s'exécute dans sa propre promesse, une erreur
 *     ou une lenteur n'affecte ni le tour ni les autres tâches ;
 *   · pas de rattrapage en rafale : l'échéance suivante est calculée après
 *     l'exécution, un créneau périmé est sauté (`task-calendar.ts`) ;
 *   · alerte de Supervision (domaine « Autres traitements techniques ») pour
 *     les tâches critiques : N échecs consécutifs
 *     (SCHEDULED_TASK_ALERT_AFTER_FAILURES, défaut 3) ou plus d'exécution
 *     réussie depuis `staleAfterMs` ; résolue automatiquement au succès.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import {
  computeFirstRun, computeNextRun, describeSchedule, isSlotStillValid, scheduleSignature,
} from './task-calendar';
import {
  findTask, isTaskEnabled, schedulerDisabled, SCHEDULED_TASKS, type ScheduledTaskDef, type TaskEnv, type TaskRunResult,
} from './scheduled-tasks.catalog';
import type { TaskStateRow, TaskStateStore, TaskTrigger } from './scheduled-task-state';

const TICK_MS = 30_000;
const FIRST_TICK_MS = 45_000;
const WATCHDOG_EVERY_MS = 5 * 60_000;
/** Délai de mise en route d'une tâche à intervalle sans `startupDelayMs`. */
const DEFAULT_STARTUP_DELAY_MS = 2 * 60_000;
/** Bail d'exécution, renouvelé pendant l'exécution (revue I1). */
export const LEASE_MS = 90_000;
const RENEW_EVERY_MS = 30_000;
/** Bail restant laissé aux exécutions en cours quand le processus s'arrête. */
export const SHUTDOWN_LEASE_MS = 10_000;
/** Instant de démarrage du moteur dans ce processus (chien de garde, M2). */
const PROCESS_STARTED_AT = new Date();

/** Identité de l'instance — journalisée et affichée, jamais utilisée pour décider. */
export const INSTANCE_ID = `${(process.env.CONTAINER ?? '').trim() || hostname()}:${process.pid}`;

// ─── Alertes ────────────────────────────────────────────────────────────────

export interface TaskAlerts {
  report(def: ScheduledTaskDef, title: string, detail: Record<string, unknown>): Promise<void>;
  resolve(def: ScheduledTaskDef): Promise<void>;
  isOpen(def: ScheduledTaskDef): Promise<boolean>;
}

export function taskAlertFingerprint(code: string): string {
  return `other:scheduled-task:${code}`;
}

const supervisionAlerts: TaskAlerts = {
  async report(def, title, detail) {
    const { reportAnomaly } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({ domain: 'other', fingerprint: taskAlertFingerprint(def.code), title, detail });
  },
  async resolve(def) {
    const { autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
    await autoResolveAnomaly(taskAlertFingerprint(def.code), { origin: 'scheduled_task_succeeded' });
  },
  async isOpen(def) {
    const { pgClient } = await import('@/db');
    const rows = await pgClient.unsafe(
      `SELECT 1 FROM admin_anomalies WHERE fingerprint = $1 AND status = 'open' LIMIT 1`,
      [taskAlertFingerprint(def.code)] as never[],
    );
    return rows.length > 0;
  },
};

/** Seuil d'échecs consécutifs avant alerte (défaut 3, borné 1–100). */
export function alertThreshold(env: TaskEnv = process.env): number {
  const n = Number((env.SCHEDULED_TASK_ALERT_AFTER_FAILURES ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 3;
}

/** Exécutions simultanées par instance, hors `ownSlot` (défaut 1, borné 1–4). */
export function maxParallel(env: TaskEnv = process.env): number {
  const n = Number((env.SCHEDULED_TASKS_MAX_PARALLEL ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 1;
}

/** Signaler à ce nombre d'échecs ? Au seuil, puis tous les `seuil` échecs (pas un par minute). */
export function shouldAlertOnFailures(consecutive: number, threshold: number): boolean {
  return consecutive >= threshold && (consecutive - threshold) % threshold === 0;
}

// ─── Messages ───────────────────────────────────────────────────────────────

/**
 * Message court, sans donnée sensible : première ligne, adresses e-mail,
 * identifiants de connexion d'URL, jetons longs et clés Stripe masqués ;
 * 300 caractères au plus.
 */
export function shortErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'erreur inconnue';
  const first = (raw.split(/\r?\n/)[0] ?? '').trim() || 'erreur inconnue';
  const clean = first
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[e-mail]')
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[identifiants]@')
    .replace(/\b(?:sk|rk|pk|whsec)_(?:live|test)?_?[A-Za-z0-9]{8,}\b/g, '[clé]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [jeton]')
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, '[jeton]');
  return clean.length > 300 ? `${clean.slice(0, 299)}…` : clean;
}

// ─── Exécution ──────────────────────────────────────────────────────────────

export interface RunnerDeps {
  store: TaskStateStore;
  tasks: readonly ScheduledTaskDef[];
  env: TaskEnv;
  alerts: TaskAlerts;
  owner: string;
  now: () => Date;
  /** Verrou du chien de garde (une instance à la fois) ; `null` = pris ailleurs. */
  watchdogLock: () => Promise<{ release: () => Promise<void> } | null>;
  /** Pool de connexions saturé (requêtes en attente) : ne rien lancer. */
  poolBusy?: () => Promise<boolean>;
  /** Démarrage du moteur dans ce processus (défaut : chargement du module). */
  startedAt?: Date;
  /** Période de renouvellement du bail (tests). */
  renewEveryMs?: number;
}

export function defaultDeps(): RunnerDeps {
  return {
    store: lazyPgStore,
    tasks: SCHEDULED_TASKS,
    env: process.env,
    alerts: supervisionAlerts,
    owner: INSTANCE_ID,
    now: () => new Date(),
    watchdogLock: async () => {
      const { acquireJobLock } = await import('@/lib/job-lock');
      // Bail non rendu : il cadence le chien de garde entre instances.
      const h = await acquireJobLock('scheduled-tasks-watchdog', WATCHDOG_EVERY_MS - 30_000);
      return h ? { release: async () => undefined } : null;
    },
    poolBusy: async () => {
      const { getPoolMetrics } = await import('@/db/pool-metrics');
      return getPoolMetrics().waiting > 0;
    },
  };
}

/** Import différé : le module reste chargeable sans base (tests unitaires). */
const lazyPgStore: TaskStateStore = {
  ensure: async (...a) => (await import('./scheduled-task-state')).pgTaskStateStore.ensure(...a),
  due: async () => (await import('./scheduled-task-state')).pgTaskStateStore.due(),
  claim: async (...a) => (await import('./scheduled-task-state')).pgTaskStateStore.claim(...a),
  reschedule: async (...a) => (await import('./scheduled-task-state')).pgTaskStateStore.reschedule(...a),
  finish: async (...a) => (await import('./scheduled-task-state')).pgTaskStateStore.finish(...a),
  release: async (...a) => (await import('./scheduled-task-state')).pgTaskStateStore.release(...a),
  renew: async (...a) => (await import('./scheduled-task-state')).pgTaskStateStore.renew(...a),
  list: async () => (await import('./scheduled-task-state')).pgTaskStateStore.list(),
};

export interface RunOutcome {
  status: 'ok' | 'error';
  error: string | null;
  note: string | null;
  durationMs: number;
  timedOut: boolean;
  /** Passage ignoré (verrou interne détenu ailleurs). */
  skipped: boolean;
}

class TaskTimeout extends Error {}

/** Exécutions planifiées en cours DANS cette instance (le bail en base fait foi entre instances). */
const inFlight = new Map<string, { promise: Promise<RunOutcome>; ownSlot: boolean }>();

/** Baux détenus par ce processus (planifiés et manuels) : libérés à l'arrêt. */
const activeLeases = new Map<string, { code: string; store: TaskStateStore }>();

/**
 * Arrêt du processus : les baux des exécutions en cours sont ramenés à
 * `SHUTDOWN_LEASE_MS`, pour qu'un autre conteneur reprenne la tâche aussitôt
 * au lieu d'attendre l'expiration. Rend le nombre de baux traités.
 */
export async function releaseActiveLeases(leaseMs = SHUTDOWN_LEASE_MS): Promise<number> {
  const all = [...activeLeases.entries()];
  await Promise.allSettled(all.map(([runId, l]) => l.store.renew(l.code, runId, leaseMs)));
  return all.length;
}

/**
 * Exécute une tâche dont la prise a réussi : délai borné, résultat consigné,
 * alertes. Ne lève jamais.
 */
export async function executeClaimed(
  def: ScheduledTaskDef,
  runId: string,
  trigger: TaskTrigger,
  deps: RunnerDeps,
): Promise<RunOutcome> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: TaskRunResult | void = undefined;
  let failure: unknown = null;
  let timedOut = false;

  activeLeases.set(runId, { code: def.code, store: deps.store });
  const work = Promise.resolve().then(() => def.run({ deadline: started + def.timeoutMs, trigger }));
  // Renouvellement du bail tant que le travail n'a pas rendu la main, au plus
  // 2 × le délai après le début (un travail figé finit par libérer la tâche).
  let settled = false;
  const renewer = setInterval(() => {
    if (settled || Date.now() - started >= 2 * def.timeoutMs) { clearInterval(renewer); return; }
    void deps.store.renew(def.code, runId, LEASE_MS).catch(() => undefined);
  }, deps.renewEveryMs ?? RENEW_EVERY_MS);
  renewer.unref?.();
  const endWork = () => { settled = true; clearInterval(renewer); activeLeases.delete(runId); };
  void work.then(endWork, endWork);
  try {
    result = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TaskTimeout(`délai dépassé (${Math.round(def.timeoutMs / 1000)} s)`)), def.timeoutMs);
      }),
    ]);
  } catch (e) {
    failure = e;
    timedOut = e instanceof TaskTimeout;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const durationMs = Date.now() - started;
  const error = failure !== null ? shortErrorMessage(failure) : result?.error ? shortErrorMessage(result.error) : null;
  const status: 'ok' | 'error' = error ? 'error' : 'ok';
  const skipped = status === 'ok' && Boolean(result?.skipped);
  const note = result?.note ? String(result.note).slice(0, 500) : null;

  let nextRunAt: Date | null | 'keep';
  if (trigger === 'manual') nextRunAt = 'keep';
  else nextRunAt = computeNextRun(def.schedule, deps.now(), { again: Boolean(result?.again) || status === 'error' });

  let consecutive = 0;
  try {
    const fin = await deps.store.finish(def.code, runId, { status, error, durationMs, nextRunAt, release: !timedOut, skipped });
    if (!fin) console.warn(`[scheduled-tasks] ${def.code} : exécution ${runId} reprise par une autre instance, état non écrit.`);
    consecutive = fin?.consecutiveFailures ?? 0;
  } catch (e) {
    console.error(`[scheduled-tasks] ${def.code} : état non enregistré :`, shortErrorMessage(e));
  }

  if (timedOut) {
    // Le travail continue peut-être : le bail reste posé jusqu'à ce qu'il
    // rende la main (ou expire), jamais de seconde exécution en parallèle.
    void work.catch(() => undefined).finally(() => deps.store.release(def.code, runId).catch(() => undefined));
  }

  if (status === 'error') {
    console.error(`[scheduled-tasks] ${def.code} en échec (${trigger}, ${durationMs} ms) : ${error}`);
  } else if (note) {
    console.info(`[scheduled-tasks] ${def.code} (${trigger}, ${durationMs} ms) : ${note}`);
  }

  if (def.critical) {
    try {
      if (status === 'ok' && !skipped) await deps.alerts.resolve(def);
      else if (shouldAlertOnFailures(consecutive, alertThreshold(deps.env))) {
        await deps.alerts.report(def, `Tâche planifiée « ${def.label} » : ${consecutive} échecs consécutifs`, {
          code: def.code, consecutiveFailures: consecutive, lastError: error, instance: deps.owner,
        });
      }
    } catch (e) {
      console.error(`[scheduled-tasks] ${def.code} : alerte non émise :`, shortErrorMessage(e));
    }
  }

  return { status, error, note, durationMs, timedOut, skipped };
}

/**
 * Enregistre les tâches (lignes manquantes, calendrier modifié) ; `boot` :
 * démarrage de l'instance, les tâches de démarrage sont ramenées à échéance.
 */
export async function registerTasks(deps: RunnerDeps, opts: { boot?: boolean } = { boot: true }): Promise<void> {
  const now = deps.now();
  await deps.store.ensure(deps.tasks.map((t) => ({
    code: t.code,
    signature: scheduleSignature(t.schedule),
    firstRunAt: computeFirstRun(t.schedule, now, t.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS),
    bootRunAt: opts.boot && t.schedule.kind === 'startup' ? new Date(now.getTime() + t.schedule.delayMs) : null,
  })));
}

/**
 * Un tour : chaque tâche active dont l'échéance est atteinte et le bail libre
 * est prise puis lancée SANS être attendue (isolement). Rend les codes lancés.
 */
export async function tick(deps: RunnerDeps): Promise<string[]> {
  if (schedulerDisabled(deps.env)) return [];
  const launched: string[] = [];
  const due = await deps.store.due();
  if (due.length === 0) return launched;
  // Pool saturé : aucune tâche lancée ce tour-ci (elles restent échues).
  if (deps.poolBusy && await deps.poolBusy().catch(() => false)) return launched;
  const limit = maxParallel(deps.env);
  for (const row of due) {
    const def = findTask(row.code, deps.tasks);
    if (!def || !isTaskEnabled(def.code, deps.env) || inFlight.has(def.code)) continue;
    if (!def.ownSlot && [...inFlight.values()].filter((f) => !f.ownSlot).length >= limit) continue;
    try {
      const now = deps.now();
      if (!isSlotStillValid(def.schedule, row.nextRunAt, now)) {
        // Créneau périmé (redémarrage, fenêtre close) : sauté, pas rattrapé.
        await deps.store.reschedule(def.code, row.nextRunAt, computeNextRun(def.schedule, now));
        continue;
      }
      const runId = randomUUID();
      const trigger: TaskTrigger = def.schedule.kind === 'startup' ? 'startup' : 'schedule';
      if (!(await deps.store.claim(def.code, runId, deps.owner, LEASE_MS, trigger, true))) continue;
      launched.push(def.code);
      const p = executeClaimed(def, runId, trigger, deps).finally(() => inFlight.delete(def.code));
      inFlight.set(def.code, { promise: p, ownSlot: Boolean(def.ownSlot) });
    } catch (e) {
      console.error(`[scheduled-tasks] ${def.code} : prise impossible :`, shortErrorMessage(e));
    }
  }
  return launched;
}

/** Attend la fin des exécutions lancées par cette instance (tests, arrêt). */
export async function drainInFlight(): Promise<void> {
  await Promise.allSettled([...inFlight.values()].map((f) => f.promise));
}

/**
 * Chien de garde : tâche critique active sans exécution réussie depuis
 * `staleAfterMs` → anomalie (une seule tant qu'elle est ouverte).
 */
export async function checkStaleCriticalTasks(deps: RunnerDeps, rows?: TaskStateRow[]): Promise<string[]> {
  const list = rows ?? await deps.store.list();
  const now = deps.now().getTime();
  const stale: string[] = [];
  for (const def of deps.tasks) {
    if (!def.critical || !isTaskEnabled(def.code, deps.env)) continue;
    const row = list.find((r) => r.code === def.code);
    // Référence : dernier succès, sinon création de la ligne (tâche jamais
    // réussie), et jamais avant le démarrage du moteur dans ce processus — une
    // tâche réactivée (variable retirée = redémarrage) a le temps d'atteindre
    // sa première échéance avant toute alerte (revue M2).
    const base = row?.lastSuccessAt ?? row?.createdAt ?? null;
    const startedAt = deps.startedAt ?? PROCESS_STARTED_AT;
    const ref = base && base.getTime() > startedAt.getTime() ? base : base ? startedAt : null;
    if (!ref || now - ref.getTime() <= def.critical.staleAfterMs) continue;
    stale.push(def.code);
    try {
      if (await deps.alerts.isOpen(def)) continue;
      await deps.alerts.report(def, `Tâche planifiée « ${def.label} » : aucune exécution réussie récente`, {
        code: def.code,
        lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
        lastStatus: row?.lastStatus ?? null,
        staleAfterMinutes: Math.round(def.critical.staleAfterMs / 60_000),
      });
    } catch (e) {
      console.error(`[scheduled-tasks] ${def.code} : alerte d'arrêt non émise :`, shortErrorMessage(e));
    }
  }
  return stale;
}

// ─── Exécution manuelle (BO) ────────────────────────────────────────────────

export type ManualRunResult =
  | { status: 'not_found' }
  | { status: 'disabled' }
  | { status: 'busy' }
  | { status: 'finished'; runId: string; outcome: RunOutcome }
  | { status: 'running'; runId: string };

/**
 * Exécution immédiate, soumise à la même exclusivité que le planificateur :
 * refusée (`busy`) si une exécution est en cours ailleurs. Attend au plus
 * `waitMs` ; au-delà, l'exécution continue en arrière-plan (`running`).
 * L'échéance planifiée n'est pas modifiée.
 */
export async function runTaskNow(code: string, opts: { waitMs?: number } = {}, deps: RunnerDeps = defaultDeps()): Promise<ManualRunResult> {
  const def = findTask(code, deps.tasks);
  if (!def) return { status: 'not_found' };
  if (!isTaskEnabled(def.code, deps.env)) return { status: 'disabled' };
  // Ligne absente (première exécution avant tout tour) : créée d'abord.
  await registerTasks({ ...deps, tasks: [def] }, { boot: false });
  const runId = randomUUID();
  if (!(await deps.store.claim(def.code, runId, deps.owner, LEASE_MS, 'manual', false))) return { status: 'busy' };
  const p = executeClaimed(def, runId, 'manual', deps);
  const waitMs = opts.waitMs ?? 20_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  const outcome = await Promise.race([p, timeout]);
  if (timer) clearTimeout(timer);
  return outcome ? { status: 'finished', runId, outcome } : { status: 'running', runId };
}

// ─── Lecture (BO) ───────────────────────────────────────────────────────────

export interface ScheduledTaskView {
  code: string;
  label: string;
  frequency: string;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | 'running' | null;
  lastDurationMs: number | null;
  lastError: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  enabled: boolean;
  /** Compléments (non exigés par l'écran) : instance, déclencheur, dernier succès. */
  lastInstance: string | null;
  lastTrigger: TaskTrigger | null;
  lastSuccessAt: string | null;
  critical: boolean;
}

export function toView(def: ScheduledTaskDef, row: TaskStateRow | undefined, env: TaskEnv): ScheduledTaskView {
  const enabled = isTaskEnabled(def.code, env);
  return {
    code: def.code,
    label: def.label,
    frequency: describeSchedule(def.schedule),
    lastRunAt: row?.lastStartedAt?.toISOString() ?? null,
    lastStatus: row?.running ? 'running' : row?.lastStatus ?? null,
    lastDurationMs: row?.lastDurationMs ?? null,
    lastError: row?.lastStatus === 'error' ? row.lastError : null,
    nextRunAt: enabled ? row?.nextRunAt?.toISOString() ?? null : null,
    consecutiveFailures: row?.consecutiveFailures ?? 0,
    enabled,
    lastInstance: row?.lastInstance ?? null,
    lastTrigger: row?.lastTrigger ?? null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
    critical: Boolean(def.critical),
  };
}

export async function listScheduledTasks(deps: RunnerDeps = defaultDeps()): Promise<ScheduledTaskView[]> {
  const rows = await deps.store.list().catch((e) => {
    // Table absente (migration 0252 pas encore passée) : la liste reste
    // affichable, sans état.
    console.error('[scheduled-tasks] lecture de l’état impossible :', shortErrorMessage(e));
    return [] as TaskStateRow[];
  });
  return deps.tasks.map((def) => toView(def, rows.find((r) => r.code === def.code), deps.env));
}

// ─── Démarrage ──────────────────────────────────────────────────────────────

let arretInstalle = false;

/**
 * SIGTERM/SIGINT (arrêt d'un conteneur au déploiement) et `beforeExit` :
 * baux en cours ramenés à 10 s. N'empêche jamais l'arrêt : si personne
 * d'autre n'écoute le signal, il est réémis après la libération (≤ 3 s) pour
 * conserver le comportement par défaut de Node.
 */
function installShutdownRelease(): void {
  if (arretInstalle) return;
  arretInstalle = true;
  const onSignal = (signal: NodeJS.Signals) => {
    const borne = new Promise((r) => setTimeout(r, 3_000).unref?.());
    void Promise.race([releaseActiveLeases(), borne]).finally(() => {
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.once('beforeExit', () => { void releaseActiveLeases(); });
}

let demarre = false;

export function startScheduledTasks(deps: RunnerDeps = defaultDeps()): void {
  if (demarre) return;
  demarre = true;

  if (schedulerDisabled(deps.env)) {
    console.info('[scheduled-tasks] désactivé (SCHEDULED_TASKS_DISABLED=true).');
    return;
  }
  const off = deps.tasks.filter((t) => !isTaskEnabled(t.code, deps.env)).map((t) => t.code);
  console.info(
    `[scheduled-tasks] démarré (${deps.owner}) — ${deps.tasks.length - off.length} tâche(s) interne(s)`
    + (off.length ? `, arrêtée(s) : ${off.join(', ')}` : '') + '.',
  );

  installShutdownRelease();

  let registered = false;
  let lastWatchdog = 0;
  let lastErrorLog = 0;
  let running = false;

  const tour = async () => {
    if (running) return; // tour précédent pas terminé (base lente) : on passe
    running = true;
    try {
      if (!registered) {
        await registerTasks(deps);
        registered = true;
      }
      await tick(deps);
      if (Date.now() - lastWatchdog >= WATCHDOG_EVERY_MS) {
        lastWatchdog = Date.now();
        const lock = await deps.watchdogLock().catch(() => null);
        if (lock) await checkStaleCriticalTasks(deps);
      }
    } catch (e) {
      // Base indisponible, table absente (schéma en cours de mise à niveau) :
      // le tour suivant réessaie ; une trace toutes les 10 min au plus.
      if (Date.now() - lastErrorLog > 10 * 60_000) {
        lastErrorLog = Date.now();
        console.error('[scheduled-tasks] tour impossible :', shortErrorMessage(e));
      }
    } finally {
      running = false;
    }
  };

  const t = setTimeout(() => {
    void tour();
    const i = setInterval(() => void tour(), TICK_MS);
    i.unref?.();
  }, FIRST_TICK_MS);
  t.unref?.();
}
