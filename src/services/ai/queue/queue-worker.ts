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
 * Le bail de `job_locks` (migration 0127) ne couvre que l'ENTRETIEN du tour
 * (reprise des abandonnés, sondes, planifications) : une seule instance à la
 * fois. Il ne protège pas la file, qui se protège seule par
 * `FOR UPDATE SKIP LOCKED`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONCURRENCE BORNÉE, HORS DU BAIL (lot 3 — bascule T1 en file durable)
 *
 * Le boucleur servait les jobs SÉQUENTIELLEMENT, sous le bail du tour (30 s),
 * plus court qu'une analyse T1 : deux tours pouvaient se chevaucher, et un
 * dépôt de 20 fichiers était nettement plus lent qu'avec la file mémoire.
 *
 * Désormais chaque instance tient au plus `AI_QUEUE_CONCURRENCY` exécutions
 * simultanées (3 par défaut), prélevées HORS du bail d'entretien. Plusieurs
 * instances se partagent la file sans coordination : `claimNext` est atomique
 * (`SKIP LOCKED`) et chaque exécution tient son propre bail, renouvelé tant
 * qu'elle travaille — une analyse longue n'est jamais reprise ailleurs. Un
 * traitement ne peut occuper toutes les places : une T3 de trente minutes ne
 * bloque pas les dépôts T1.
 *
 * La mise en file T1 « réveille » le boucleur (`nudgeQueueWorker`) : un dépôt
 * n'attend pas le tour suivant.
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
  claimNext, completeJob, failJob, deferJob, deferJobUntil, renewLease, recoverAbandonedJobs, isExecutionActive, LEASE_SECONDS,
  releaseInterruptedJob, type QueuedJob,
} from './job-queue.repository';
import { isCostCapReached, costCapResumeAt } from '../gateway/errors';
import { isJobDeferred } from './queue-policy';
import {
  createExecutionGuard, registerLocalExecution, unregisterLocalExecution,
  isExecutionCancelled, ExecutionCancelledError, waitForSettlement, type ExecutionGuard,
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

/**
 * Issue d'une exécution, telle qu'ÉCRITE en base par le boucleur.
 *
 *  · `done`        — clôturé DONE ;
 *  · `failed`      — échec : `permanent` = FAILED, sinon retour en file avec
 *                    backoff (MOD-005) ; `timedOut` = délai global (GEN-012) ;
 *  · `interrupted` — rollback, arrêt d'urgence, désactivation, bail perdu :
 *                    remis en tête, sans tentative consommée ;
 *  · `deferred`    — report (quota) : retour en file différé, ou FAILED
 *                    au-delà du plafond de reports.
 */
export type JobOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; permanent: boolean; timedOut: boolean; error: string }
  | { kind: 'interrupted'; reason: string }
  | {
    kind: 'deferred'; permanent: boolean; reason: string;
    /** Lot 22 : report jusqu'à cette date (plafond de coût du compte), ISO. */
    until?: string;
  };

/**
 * Suites d'une exécution, propres au traitement — l'état métier que le
 * boucleur ne connaît pas. T1 s'en sert pour que l'état du fichier affiché à
 * l'utilisateur suive l'état du job (jamais « En file » sans job vivant,
 * jamais « Analyse en cours » après un échec). Appelées APRÈS l'écriture de
 * l'issue ; une erreur y est journalisée, jamais propagée.
 */
export interface JobHandlerHooks {
  onSettled?: (job: QueuedJob, outcome: JobOutcome) => Promise<void>;
}

const handlers = new Map<Treatment, JobHandler>();
const hooks = new Map<Treatment, JobHandlerHooks>();

/**
 * Enregistre l'exécutant d'un traitement, au démarrage.
 *
 * Sans exécutant, les travaux du traitement restent en file au lieu d'être
 * perdus — et le SCR-08 permettra de voir qu'ils n'avancent pas. C'est
 * préférable à un échec permanent qui les marquerait comme traités alors que
 * personne n'a rien fait.
 */
export function registerJobHandler(treatment: Treatment, handler: JobHandler, handlerHooks?: JobHandlerHooks): void {
  handlers.set(treatment, handler);
  if (handlerHooks) hooks.set(treatment, handlerHooks);
  else hooks.delete(treatment);
}

export function clearJobHandlers(): void {
  handlers.clear();
  hooks.clear();
}

async function settle(treatment: Treatment, job: QueuedJob, outcome: JobOutcome): Promise<void> {
  const h = hooks.get(treatment)?.onSettled;
  if (!h) return;
  try {
    await h(job, outcome);
  } catch (e) {
    console.error(`[queue] ${treatment} job ${job.id} : suite « ${outcome.kind} » en échec (non bloquant) :`, (e as Error).message);
  }
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
export async function runOne(treatment: Treatment, onClaimed?: () => void): Promise<boolean> {
  const handler = handlers.get(treatment);
  if (!handler) return false;

  // VER-016 : la version effective est lue AU DÉMARRAGE et figée sur le job ;
  // VER-015 : l'exécution la garde jusqu'au bout (contexte ci-dessous).
  const configVersionId = await pinnableVersionId();
  const job = await claimNext(treatment, WORKER_ID, LEASE_SECONDS, configVersionId);
  if (!job) return false;
  // Pool : un job pris signale qu'il y a du travail — une autre place peut
  // s'ouvrir sans attendre le tour suivant.
  try { onClaimed?.(); } catch { /* jamais bloquant */ }

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
  //
  // Base injoignable pendant toute la durée du bail : le job va être repris
  // par une autre instance (`recoverAbandonedJobs`). L'exécution locale
  // s'arrête d'elle-même à l'échéance, sans attendre de pouvoir constater la
  // dépossession — jamais deux analyses du même job qui se croient titulaires.
  let bailJusqua = Date.now() + LEASE_SECONDS * 1000;
  const heartbeat = job.executionId
    ? setInterval(() => {
        void renewLease(job.id, job.executionId!).then((ok) => {
          if (ok) bailJusqua = Date.now() + LEASE_SECONDS * 1000;
          else if (!controller.signal.aborted) controller.abort(new ExecutionCancelledError('bail perdu'));
        }).catch(() => {
          // Réseau : on réessaie au prochain battement, tant que le bail court.
          if (Date.now() >= bailJusqua && !controller.signal.aborted) {
            controller.abort(new ExecutionCancelledError('bail expiré sans renouvellement'));
          }
        });
      }, HEARTBEAT_MS)
    : null;
  heartbeat?.unref?.();

  // L'issue écrite, transmise ensuite aux suites du traitement.
  let outcome: JobOutcome | null = null;
  let execution: Promise<void> | null = null;

  try {
    // Contexte d'exécution : version figée et job parent, lus par la
    // passerelle (config-resolver) et la trace (§9.1 : job_id, version).
    execution = runInJobContext(
      {
        jobId: job.id, treatment, configVersionId: job.configVersionId ?? configVersionId,
        // CDC 15 OBS-CFG : déclencheur effectif, tracé avec chaque appel.
        triggerCode: job.triggerCode ?? null,
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
    } else {
      outcome = { kind: 'done' };
    }
  } catch (e) {
    if (timedOut) {
      // Échec, pas interruption : le travail n'a pas abouti pour une raison
      // qui lui est propre. Le jeton est révoqué par `failJob` : l'exécution
      // qui continuerait en mémoire ne peut plus rien écrire.
      //
      // Revue lot 3 : AVANT de libérer le job, on attend que l'exécution
      // interrompue se termine vraiment — bail toujours renouvelé, job
      // toujours RUNNING. Un exécutant qui ignore la garde (moteur historique
      // T1) ne peut ainsi jamais tourner en même temps qu'une reprise du même
      // job. Borné à une seconde durée de délai global.
      if (execution && limit) {
        const fini = await waitForSettlement(execution, limit);
        if (!fini) {
          console.error(`[queue] ${treatment} job ${job.id} : exécution toujours active après le délai de grâce — libérée quand même.`);
        }
      }
      const { permanent, stale } = await failJob(job.id, (e as Error).message, job.executionId);
      if (!stale) outcome = { kind: 'failed', permanent, timedOut: true, error: (e as Error).message };
      console.error(`[queue] ${treatment} job ${job.id} : ${(e as Error).message}${permanent ? ' — échec définitif' : ''}.`);
    } else if (treatment === 'T1' && isCostCapReached(e) && !controller.signal.aborted) {
      // Lot 22 : plafond mensuel de coût IA du compte atteint (refus de la
      // passerelle, avant tout appel). T1 SEULEMENT (T3/T4 appliquent leur
      // repli déterministe et ne lèvent pas ce refus). Ni échec ni
      // interruption : le job est reporté UNE fois au début de la période
      // suivante (aucune tentative consommée, aucune boucle de relance). Rien
      // n'a été écrit par l'analyse : la reprise rejoue tout. Date inconnue
      // (ne devrait pas arriver) : 1 h.
      const until = costCapResumeAt(e) ?? new Date(Date.now() + 3_600_000);
      const { costCapAnalysisReason } = await import('../gateway/account-cost-cap');
      const reason = costCapAnalysisReason(until);
      const r = await deferJobUntil(job.id, reason, until, job.executionId);
      if (!r.stale) outcome = { kind: 'deferred', permanent: false, reason, until: until.toISOString() };
      console.warn(`[queue] ${treatment} job ${job.id} reporté au ${until.toISOString()} — plafond IA du compte ${job.accountId ?? '?'} atteint.`);
    } else if (isJobDeferred(e) && !controller.signal.aborted) {
      // Report (quota épuisé…) : ni échec, ni succès — voir `JobDeferredError`.
      const r = await deferJob(job.id, (e as Error).message, job.executionId);
      if (!r.stale) outcome = { kind: 'deferred', permanent: r.permanent, reason: (e as Error).message };
      console.warn(
        `[queue] ${treatment} job ${job.id} reporté — ${(e as Error).message}`
        + `${r.permanent ? ' (plafond de reports atteint : échec définitif)' : ''}`,
      );
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
      // Suites seulement si CETTE exécution a remis le job en file : sinon
      // (déjà remis par l'administration, ou repris par une autre instance
      // qui a peut-être déjà relancé l'analyse), l'état métier n'est plus le
      // sien et ne doit pas être réécrit.
      if (released) outcome = { kind: 'interrupted', reason: (e as Error).message ?? 'interruption' };
      console.warn(
        `[queue] ${treatment} job ${job.id} interrompu — ${(e as Error).message}`
        + `${released ? ' (remis en tête, sans tentative consommée)' : ''}`,
      );
    } else {
      // Une erreur d'exécutant n'interrompt jamais la boucle : le travail
      // suivant n'a pas à payer l'échec du précédent.
      const { permanent, stale } = await failJob(job.id, (e as Error).message ?? 'erreur inconnue', job.executionId);
      if (!stale) outcome = { kind: 'failed', permanent, timedOut: false, error: (e as Error).message ?? 'erreur inconnue' };
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
  if (outcome) await settle(treatment, job, outcome);
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
  // CDC Assistant §31.3, §15.13 : taux d'escalade, dérive des jetons, écart
  // modèle résolu / attendu, dépréciation annoncée d'un modèle actif.
  await run('assistant_alerts', 3_600, async () =>
    (await import('@/services/verebona-assistant/observability/assistant-alerts')).evaluateAssistantAlerts());
}

// ── Pool d'exécution borné ─────────────────────────────────────────────────

/**
 * Nombre maximal d'exécutions simultanées PAR INSTANCE (`AI_QUEUE_CONCURRENCY`,
 * 3 par défaut, borné à [1, 20]). Le parallélisme total vaut ce nombre fois le
 * nombre d'instances : c'est lui qu'il faut dimensionner contre la mémoire du
 * conteneur et le débit autorisé chez le fournisseur.
 */
export function queueConcurrency(): number {
  const n = Math.floor(Number(process.env.AI_QUEUE_CONCURRENCY));
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(n, 20);
}

/**
 * Places qu'un même traitement peut occuper : toutes sauf une (dès qu'il y en
 * a deux). Une T3 de trente minutes ne doit pas priver les dépôts T1.
 */
export function perTreatmentCap(concurrency: number = queueConcurrency()): number {
  return concurrency > 1 ? concurrency - 1 : 1;
}

/**
 * État du pool, porté par `globalThis` : Next.js peut charger ce module deux
 * fois (instrumentation, routes). Le réveil déclenché par une route doit
 * atteindre le pool démarré par l'instrumentation, pas un pool fantôme.
 */
interface PoolState {
  started: boolean;
  active: number;
  running: Map<Treatment, number>;
  cursor: number;
  fill: (() => void) | null;
}
const POOL_KEY = Symbol.for('verebona.ai.queue-worker.pool');
function pool(): PoolState {
  const g = globalThis as unknown as Record<symbol, PoolState | undefined>;
  return (g[POOL_KEY] ??= { started: false, active: 0, running: new Map(), cursor: 0, fill: null });
}

/**
 * Prend et exécute UN job, en servant les traitements à tour de rôle (le
 * point de départ tourne à chaque appel). Rend `false` si aucun traitement
 * n'a de travail disponible — ou si tous ceux qui en ont sont à leur plafond.
 */
async function runNextAvailable(onClaimed: () => void): Promise<boolean> {
  const p = pool();
  const treatments = listBatchTreatments();
  const cap = perTreatmentCap();
  const start = p.cursor++ % Math.max(1, treatments.length);
  for (let k = 0; k < treatments.length; k++) {
    const t = treatments[(start + k) % treatments.length];
    if (!handlers.has(t)) continue;
    if ((p.running.get(t) ?? 0) >= cap) continue;
    // La place est réservée AVANT le prélèvement : deux emplacements ne
    // peuvent pas dépasser ensemble le plafond du traitement.
    p.running.set(t, (p.running.get(t) ?? 0) + 1);
    try {
      if (await runOne(t, onClaimed)) return true;
    } finally {
      p.running.set(t, Math.max(0, (p.running.get(t) ?? 1) - 1));
    }
  }
  return false;
}

/**
 * Remplit le pool : ouvre UNE place si la borne le permet. Chaque place
 * enchaîne les jobs tant qu'il y en a ; chaque job pris ouvre la place
 * suivante. File vide : une seule place interroge la base, puis se referme —
 * aucun sondage multiplié par la concurrence.
 */
export function fillSlots(): void {
  const p = pool();
  if (p.active >= queueConcurrency()) return;
  p.active++;
  void (async () => {
    try {
      for (;;) {
        const pris = await runNextAvailable(() => fillSlots());
        if (!pris) return;
      }
    } catch (e) {
      console.error('[queue] place d’exécution en échec (non bloquant) :', (e as Error).message);
    } finally {
      p.active--;
    }
  })();
}

/**
 * Réveille le boucleur de ce processus (mise en file T1, lancement manuel) :
 * un dépôt n'attend pas le tour suivant. Sans effet si le boucleur n'est pas
 * démarré ici (tests, script) — le tour périodique d'une autre instance le
 * prendra.
 */
export function nudgeQueueWorker(): void {
  const p = pool();
  if (p.started && p.fill) p.fill();
}

/** État du pool, pour le diagnostic et les tests. */
export function getPoolState(): { active: number; concurrency: number; running: Partial<Record<Treatment, number>> } {
  const p = pool();
  return { active: p.active, concurrency: queueConcurrency(), running: Object.fromEntries(p.running) };
}

/** Réservé aux tests. */
export function __resetPoolForTests(): void {
  const g = globalThis as unknown as Record<symbol, PoolState | undefined>;
  delete g[POOL_KEY];
}

const INTERVAL_MS = Number(process.env.AI_QUEUE_INTERVAL_MS ?? 15_000);
const LOCK_NAME = 'ai-job-queue';
/**
 * Bail de l'ENTRETIEN seulement (reprise, sondes, planifications) : les
 * exécutions n'y sont plus. Une minute au moins — une sonde fournisseur peut
 * prendre quelques dizaines de secondes.
 */
const HOUSEKEEPING_LOCK_MS = Math.max(60_000, INTERVAL_MS * 2);

/**
 * Démarre le boucleur. Appelé une fois au démarrage, depuis `instrumentation`.
 *
 * Le premier tour est différé : au démarrage, migrations, référentiel et
 * tarifs se mettent en place, et prélever un travail avant qu'ils ne soient
 * prêts le ferait échouer pour une raison sans rapport avec lui.
 */
export function startQueueWorker(): void {
  const p = pool();
  if (p.started) return;
  p.started = true;

  const tick = async () => {
    try {
      const { withJobLock } = await import('@/lib/job-lock');
      await withJobLock(LOCK_NAME, HOUSEKEEPING_LOCK_MS, async () => {
        // Reprise des exécutions abandonnées (arrêt brutal d'un processus),
        // avant de prélever : au redémarrage, elles repassent en tête.
        const repris = await recoverAbandonedJobs();
        if (repris.length > 0) {
          console.warn(`[queue] ${repris.length} exécution(s) abandonnée(s) reprise(s) :`, repris.map((r) => `${r.id}→${r.status}`).join(', '));
        }
        // Sondes du circuit breaker (WF-09, MOD-013, MOD-014) : AVANT le
        // prélèvement, pour qu'un traitement réactivé soit servi dès ce tour.
        // Isolées : une sonde en échec ne doit pas priver la file de son tour.
        // Sous le même bail que l'entretien : une seule instance sonde à la
        // fois, le fournisseur n'est pas sollicité N fois par sonde.
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
      });
    } catch (e) {
      // Un tour en échec ne doit pas arrêter la boucle : la panne est souvent
      // passagère, et s'arrêter demanderait un redéploiement pour repartir.
      console.error('[queue] tour en échec (non bloquant) :', (e as Error).message);
    }
    // Prélèvement HORS du bail d'entretien, sur CHAQUE instance : le pool est
    // borné localement, la file protégée par `SKIP LOCKED`, chaque exécution
    // par son propre bail renouvelé.
    fillSlots();
  };

  p.fill = () => fillSlots();

  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, INTERVAL_MS);

  console.info(
    `[queue] Boucleur démarré — premier tour dans 30 s, puis toutes les ${INTERVAL_MS / 1000} s ; `
    + `${queueConcurrency()} exécution(s) simultanée(s) par instance, bail ${LEASE_SECONDS} s renouvelé toutes les ${HEARTBEAT_MS / 1000} s.`,
  );
}
