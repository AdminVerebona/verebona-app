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
import { claimNext, completeJob, failJob, type QueuedJob } from './job-queue.repository';

/** Exécutant d'un traitement. Rend normalement, ou lève : l'issue est écrite ici. */
export type JobHandler = (job: QueuedJob) => Promise<void>;

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

  const job = await claimNext(treatment);
  if (!job) return false;

  try {
    await handler(job);
    await completeJob(job.id);
  } catch (e) {
    // Une erreur d'exécutant n'interrompt jamais la boucle : le travail suivant
    // n'a pas à payer l'échec du précédent.
    const { permanent } = await failJob(job.id, (e as Error).message ?? 'erreur inconnue');
    console.error(
      `[queue] ${treatment} job ${job.id} en échec${permanent ? ' définitif' : ''} :`,
      (e as Error).message,
    );
  }
  return true;
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
