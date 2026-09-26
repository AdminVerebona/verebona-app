/**
 * Boucleur de la file — CDC BO IA GEN-004, NFR-003, MOD-005, MOD-011.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE BOUCLEUR NE SAIT PAS CE QU'IL EXÉCUTE
 *
 * T1, T3 et T4 enregistrent leur exécutant ; le boucleur prélève, appelle,
 * et écrit l'issue. Il ne connaît ni l'analyse de source, ni la réconciliation,
 * ni l'agenda.
 *
 * Cette ignorance est le point : le GEN-005 veut que l'orchestration reste
 * définie dans le code de chaque traitement, et un boucleur qui saurait
 * enchaîner T1 puis T3 recréerait une orchestration centrale — exactement ce
 * que la V1 exclut.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IL SURVIT AUX REDÉMARRAGES PARCE QU'IL NE PORTE AUCUN ÉTAT
 *
 * Tout est en base : ce qui reste à faire, ce qui a échoué, quand reprendre.
 * Le boucleur n'est qu'un déclencheur périodique. Un redéploiement — il y en a
 * eu plusieurs ce matin — le tue sans rien perdre, là où l'actuel
 * `analysis-recovery-scheduler` repart de zéro.
 *
 * Le bail de `job_locks` (migration 0127) évite que deux instances bouclent en
 * parallèle. Il ne protège pas la file, qui se protège seule par
 * `FOR UPDATE SKIP LOCKED` ; il évite simplement de multiplier les tours à vide.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MOD-011 : SOUS DISJONCTEUR, CE QUI TOURNE TERMINE
 *
 * `claimNext` rend `null` quand le traitement est coupé : aucun nouveau
 * démarrage. Les exécutions en cours ne sont pas touchées — elles se terminent,
 * et c'est volontaire. Les interrompre ferait perdre le travail déjà fait pour
 * un incident qui ne les concerne peut-être pas.
 */
import type { Treatment } from '../config/treatments';
import { listBatchTreatments } from '../config/treatments';
import {
  claimNext, completeJob, failJob, renewLease, recoverAbandonedJobs, isExecutionActive, LEASE_SECONDS,
  releaseInterruptedJob, type QueuedJob,
} from './job-queue.repository';
import {
  createExecutionGuard, registerLocalExecution, unregisterLocalExecution,
  isExecutionCancelled, ExecutionCancelledError, type ExecutionGuard,
} from './execution-control';
import { runInJobContext, executionTimeoutMs } from './job-context';
import { isAiBlocked } from './runnable-guard';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Identité de ce processus, portée par les jobs qu'il prélève (supervision). */
export const WORKER_ID = `${(() => { try { return hostname(); } catch { return 'local'; } })()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Renouvellement du bail : trois fois par durée de bail. */
const HEARTBEAT_MS = Math.max(1_000, Math.floor((LEASE_SECONDS * 1000) / 3));

/**
 * Exécutant d'un traitement. Rend normalement, ou lève : l'issue est écrite ici.
 *
 * `guard` : signal d'annulation et contrôle avant écriture. Un exécutant
 * appelle `guard.assertActive()` avant chaque écriture significative ;
 * interrompu (rollback, arrêt d'urgence, désactivation), il n'écrit plus rien.
 */
export type JobHandler = (job: QueuedJob, guard: ExecutionGuard) => Promise<void>;

const handlers = new Map<Treatment, JobHandler>();

/**
 * Enregistre l'exécutant d'un traitement, au démarrage.
 *
 * Sans exécutant, les travaux du traitement restent en file au lieu d'être
 * perdus — et le SCR-08 permettra de voir qu'ils n'avancent pas. C'est
 * préférable à un échec permanent qui les marquerait comme traités alors que
 * personne n'a rien fait.
 */
export function registerJobHandler(treatment: Treatment, handler: JobHandler): void {
  handlers.set(treatment, handler);
}

export function clearJobHandlers(): void {
  handlers.clear();
}

export function hasHandler(treatment: Treatment): boolean {
  return handlers.has(treatment);
}

/**
 * Traite un travail d'un traitement, s'il y en a un de disponible.
 *
 * Rend `true` si un travail a été pris — la boucle peut alors enchaîner sans
 * attendre, tant qu'il y a du travail.
 */
export async function runOne(treatment: Treatment): Promise<boolean> {
  const handler = handlers.get(treatment);
  if (!handler) return false;

  // VER-016 : la version effective est lue AU DÉMARRAGE et figée sur le job ;
  // VER-015 : l'exécution la garde jusqu'au bout (contexte ci-dessous).
  const configVersionId = await pinnableVersionId();
  const job = await claimNext(treatment, WORKER_ID, LEASE_SECONDS, configVersionId);
  if (!job) return false;

  // Annulation : signal local, bail, jeton en base (execution-control).
  const controller = new AbortController();
  registerLocalExecution(job.id, controller);
  const guard = createExecutionGuard(job, controller, isExecutionActive);

  // GEN-012 : timeout GLOBAL d'exécution, distinct du timeout par appel. Le
  // chronomètre part au prélèvement : l'attente en file est exclue. Au
  // dépassement, l'exécution est interrompue (plus aucune écriture : garde)
  // et le job suit le chemin d'échec normal (backoff, puis échec définitif).
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = executionTimeoutMs(treatment);
  const deadline = limit
    ? new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const err = new ExecutionCancelledError(`délai global d'exécution dépassé (${Math.round(limit / 1000)} s)`);
        controller.abort(err);
        reject(err);
      }, limit);
      timer.unref?.();
    })
    : null;

  // Bail renouvelé tant que l'exécutant travaille : un processus arrêté
  // brutalement cesse de le renouveler, et le job est repris après expiration
  // (`recoverAbandonedJobs`) — jamais pendant qu'il tourne encore ici. Un
  // renouvellement refusé signifie que l'exécution a été dépossédée : elle
  // est interrompue.
  const heartbeat = job.executionId
    ? setInterval(() => {
        void renewLease(job.id, job.executionId!).then((ok) => {
          if (!ok && !controller.signal.aborted) controller.abort(new ExecutionCancelledError('bail perdu'));
        }).catch(() => { /* réseau : on réessaie au prochain battement */ });
      }, HEARTBEAT_MS)
    : null;
  heartbeat?.unref?.();

  try {
    // Contexte d'exécution : version figée et job parent, lus par la
    // passerelle (config-resolver) et la trace (§9.1 : job_id, version).
    const execution = runInJobContext(
      {
        jobId: job.id, treatment, configVersionId: job.configVersionId ?? configVersionId,
        signal: controller.signal,
        // MOD-011 : jeton de démarrage, comparé à l'ouverture du disjoncteur
        // par la garde de la passerelle (runnable-guard).
        startedAt: Date.now(),
      },
      () => handler(job, guard),
    );
    await (deadline ? Promise.race([execution, deadline]) : execution);
    // Dernier contrôle : une exécution interrompue ne clôt jamais le job
    // (la clôture est de toute façon conditionnée au jeton).
    await guard.assertActive('clôture');
    const done = await completeJob(job.id, job.executionId);
    if (done.stale) {
      console.warn(`[queue] ${treatment} job ${job.id} : exécution dépossédée, clôture ignorée.`);
    }
  } catch (e) {
    if (timedOut) {
      // Échec, pas interruption : le travail n'a pas abouti pour une raison
      // qui lui est propre. Le jeton est révoqué par `failJob` : l'exécution
      // qui continuerait en mémoire ne peut plus rien écrire.
      const { permanent } = await failJob(job.id, (e as Error).message, job.executionId);
      console.error(`[queue] ${treatment} job ${job.id} : ${(e as Error).message}${permanent ? ' — échec définitif' : ''}.`);
    } else if (isExecutionCancelled(e) || isAiBlocked(e) || controller.signal.aborted) {
      // Interrompu (administration, dépossession) ou refusé par la garde de
      // la passerelle (`AI_BLOCKED` : arrêt d'urgence, désactivation,
      // suspension). Ce n'est pas un échec : aucune tentative n'est
      // consommée (MOD-005). Dans le cas usuel, l'administration a déjà remis
      // le job en file et révoqué le jeton — `releaseInterruptedJob` est alors
      // sans effet ; sinon (garde en cache sur une autre instance, blocage
      // constaté par l'exécutant), c'est lui qui remet le job en tête.
      // Revue indépendante lot IA 2 : AI_BLOCKED passait par `failJob`.
      const released = await releaseInterruptedJob(job.id, job.executionId, (e as Error).message ?? 'interruption')
        .catch(() => false);
      console.warn(
        `[queue] ${treatment} job ${job.id} interrompu — ${(e as Error).message}`
        + `${released ? ' (remis en tête, sans tentative consommée)' : ''}`,
      );
    } else {
      // Une erreur d'exécutant n'interrompt jamais la boucle : le travail
      // suivant n'a pas à payer l'échec du précédent.
      const { permanent } = await failJob(job.id, (e as Error).message ?? 'erreur inconnue', job.executionId);
      console.error(
        `[queue] ${treatment} job ${job.id} en échec${permanent ? ' définitif' : ''} :`,
        (e as Error).message,
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    unregisterLocalExecution(job.id, controller);
  }
  return true;
}

/** Version effective à figer ; jamais bloquant (repli : configuration du code). */
async function pinnableVersionId(): Promise<number | null> {
  try {
    const { resolveEffectiveVersionId } = await import('../config/config-resolver');
    return await resolveEffectiveVersionId();
  } catch {
    return null;
  }
}

/**
 * Un tour de boucle sur tous les traitements batch.
 *
 * `maxPerTreatment` borne le travail d'un tour : sans borne, un traitement dont
 * la file est longue monopoliserait le tour et les deux autres n'avanceraient
 * jamais. Servir chacun à tour de rôle vaut mieux que vider le premier.
 */
export async function runOnce(maxPerTreatment = 5): Promise<number> {
  let traites = 0;
  for (const treatment of listBatchTreatments()) {
    for (let i = 0; i < maxPerTreatment; i++) {
      const pris = await runOne(treatment);
      if (!pris) break;
      traites++;
    }
  }
  return traites;
}

/**
 * Évaluateurs périodiques (garde-fous, budgets, anomalies). Chaque passage est
 * réservé en base (`claimEvaluatorRun`) : plusieurs instances n'évaluent
 * jamais la même fenêtre deux fois. Isolés les uns des autres.
 */
async function runEvaluators(): Promise<void> {
  const { claimEvaluatorRun } = await import('../alerts/alerts.repository').catch(() => ({ claimEvaluatorRun: null }));
  if (!claimEvaluatorRun) return;
  const run = async (name: string, everySeconds: number, fn: () => Promise<unknown>) => {
    try {
      if (await claimEvaluatorRun(name, everySeconds)) await fn();
    } catch (e) {
      console.error(`[queue] évaluateur ${name} en échec (non bloquant) :`, (e as Error).message);
    }
  };
  await run('guardrails', 300, async () => (await import('../alerts/guardrail-evaluator')).evaluateGuardrails());
  await run('budgets', 3_600, async () => (await import('../alerts/cost-evaluator')).evaluateBudgetAlerts());
  await run('cost_anomalies', 86_400 - 600, async () => (await import('../alerts/cost-evaluator')).evaluateAnomalyAlerts());
}

const INTERVAL_MS = Number(process.env.AI_QUEUE_INTERVAL_MS ?? 15_000);
const LOCK_NAME = 'ai-job-queue';

let started = false;

/**
 * Démarre le boucleur. Appelé une fois au démarrage, depuis `instrumentation`.
 *
 * Le premier tour est différé : au démarrage, migrations, référentiel et
 * tarifs se mettent en place, et prélever un travail avant qu'ils ne soient
 * prêts le ferait échouer pour une raison sans rapport avec lui.
 */
export function startQueueWorker(): void {
  if (started) return;
  started = true;

  const tick = async () => {
    try {
      const { withJobLock } = await import('@/lib/job-lock');
      await withJobLock(LOCK_NAME, INTERVAL_MS * 2, async () => {
        // Reprise des exécutions abandonnées (arrêt brutal d'un processus),
        // avant de prélever : au redémarrage, elles repassent en tête.
        const repris = await recoverAbandonedJobs();
        if (repris.length > 0) {
          console.warn(`[queue] ${repris.length} exécution(s) abandonnée(s) reprise(s) :`, repris.map((r) => `${r.id}→${r.status}`).join(', '));
        }
        // Sondes du circuit breaker (WF-09, MOD-013, MOD-014) : AVANT le
        // prélèvement, pour qu'un traitement réactivé soit servi dès ce tour.
        // Isolées : une sonde en échec ne doit pas priver la file de son tour.
        // Sous le même bail que la file : une seule instance sonde à la fois,
        // le fournisseur n'est pas sollicité N fois par sonde.
        try {
          const { runDueProbes } = await import('./circuit-breaker.repository');
          const sondes = await runDueProbes();
          for (const r of sondes) {
            console.info(`[queue] sonde ${r.treatment} : ${r.reactivated ? `réactivé (${r.recoveredWith})` : 'toujours indisponible'}.`);
          }
        } catch (e) {
          console.error('[queue] sondes en échec (non bloquant) :', (e as Error).message);
        }

        // Planifications versionnées (§15.1, T3-006, T3-UI-05) : un passage
        // global échu est mis en file AVANT le prélèvement.
        try {
          const { runDueSchedules } = await import('./triggers');
          for (const f of await runDueSchedules()) {
            console.info(`[queue] passage planifié ${f.treatment} (${f.triggerCode}) mis en file.`);
          }
        } catch (e) {
          console.error('[queue] planification en échec (non bloquant) :', (e as Error).message);
        }

        // Garde-fous (toutes les 5 min), budgets (toutes les heures) et
        // anomalies de coût (une fois par jour) — une seule instance, grâce
        // à la réservation en base. Jamais bloquant pour la file.
        void runEvaluators();

        const n = await runOnce();
        if (n > 0) console.info(`[queue] ${n} travail(aux) traité(s).`);
      });
    } catch (e) {
      // Un tour en échec ne doit pas arrêter la boucle : la panne est souvent
      // passagère, et s'arrêter demanderait un redéploiement pour repartir.
      console.error('[queue] tour en échec (non bloquant) :', (e as Error).message);
    }
  };

  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, INTERVAL_MS);

  console.info(
    `[queue] Boucleur démarré — premier tour dans 30 s, puis toutes les ${INTERVAL_MS / 1000} s.`,
  );
}
