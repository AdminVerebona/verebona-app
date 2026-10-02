/**
 * File T1 et exécutant T1 — CDC BO IA GEN-004, GEN-005, NFR-003.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA FILE DURABLE EST LA SEULE FILE T1 (lot 16b)
 *
 * L'ancienne file EN MÉMOIRE (`analysis-queue.ts`, « file propre au
 * processus ») et son drapeau de bascule `AI_DURABLE_QUEUE` sont retirés :
 * un job ne peut pas être perdu après un redémarrage applicatif (NFR-003).
 * Toute mise en file T1 passe par `ai_job_queue` :
 *   · exécution par le boucleur (`queue-worker`), démarré dans le processus
 *     web (`instrumentation-node`, étape 6), sur CHAQUE instance — la file
 *     est protégée par `SKIP LOCKED`, chaque exécution par son propre bail
 *     renouvelé (`AI_QUEUE_LEASE_SECONDS`) ;
 *   · reprise après redémarrage : une exécution dont le bail expire est
 *     reprise (`recoverAbandonedJobs`), un job PENDING attend simplement le
 *     prochain tour ;
 *   · concurrence bornée par instance (`AI_QUEUE_CONCURRENCY`) ;
 *   · déduplication WF-10 : un fichier déjà en attente ou en cours n'est
 *     jamais mis en file deux fois (§10.4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE TRAVAIL NE PORTE PAS LES DONNÉES, IL PORTE DE QUOI LES RETROUVER
 *
 * Seuls l'identifiant du fichier, le compte, l'utilisateur et l'origine sont
 * mis en file. Le pipeline relit l'état du fichier au moment de s'exécuter :
 * un document supprimé entre la mise en file et l'exécution doit être ignoré,
 * pas analysé à partir d'un instantané périmé.
 *
 * Un dépôt de N fichiers = N travaux, un par fichier, exactement comme si
 * chacun avait été déposé seul (aucun regroupement au dépôt).
 */
import { registerJobHandler, nudgeQueueWorker, type JobOutcome } from '../../queue/queue-worker';
import { enqueue, type QueuedJob } from '../../queue/job-queue.repository';
import { JobDeferredError } from '../../queue/queue-policy';

/** Type de cible, pour la clé de déduplication. */
const TARGET_TYPE = 'asset_file';

/** Origine des dépôts (route `files/confirm`) — déclencheur `source_uploaded`. */
export const UPLOAD_ORIGIN = 'files/confirm';

async function t1TriggerActive(code: string): Promise<boolean> {
  try {
    const { isTriggerActive } = await import('../../queue/triggers');
    return await isTriggerActive('T1', code);
  } catch {
    return true;
  }
}

/**
 * Marque les fichiers « en file d'attente » (`UPLOADED`), sauf s'ils sont en
 * cours d'analyse. C'est cet état que la reprise serveur recherche
 * (`analysis-recovery`, UPLOADED bloqué) et que le bandeau lit
 * (`/api/analysis/queue-status`, `/api/documents/[id]/analysis-status`).
 */
async function marquerEnFile(fileIds: number[], accountId: number): Promise<void> {
  const ids = [...new Set(fileIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0 || !accountId) return;
  try {
    const [{ db }, { assetFiles }, { and, eq, inArray, isNull, or }] = await Promise.all([
      import('@/db'), import('@/db/schema'), import('drizzle-orm'),
    ]);
    await db
      .update(assetFiles)
      .set({ analysisState: 'UPLOADED', updatedAt: new Date() })
      .where(and(
        inArray(assetFiles.id, ids),
        eq(assetFiles.accountId, accountId),
        or(isNull(assetFiles.analysisState), eq(assetFiles.analysisState, 'UPLOADED'), eq(assetFiles.analysisState, 'ANALYSIS_FAILED')),
      ));
  } catch (e) {
    console.error('[t1-queue] marquage « en file » impossible :', (e as Error).message);
  }
}

/**
 * Met des fichiers en file T1, un travail par fichier — point d'entrée unique
 * des appelants (dépôt, analyse par lot, reprise serveur).
 *
 * T1-UI-08 (lot IA 2) : le dépôt n'enclenche l'analyse que si le
 * déclencheur `source_uploaded` est actif dans la version effective (liste
 * vide = défauts du code, donc actif). Les autres origines — reprise,
 * relance demandée par l'utilisateur — ne sont pas des déclencheurs
 * automatiques du catalogue et ne sont pas filtrées.
 *
 * Rend les identifiants réellement acceptés. Ne lève pas pour un fichier
 * refusé : l'échec d'une mise en file ne doit pas faire échouer un dépôt.
 */
export async function enqueueFileAnalyses(
  fileIds: number[],
  accountId: number,
  options: { userId?: number; origin: string; billable?: boolean },
): Promise<number[]> {
  if (options.origin === UPLOAD_ORIGIN && !(await t1TriggerActive('source_uploaded'))) {
    console.info(`[t1-queue] déclencheur « source_uploaded » inactif : ${fileIds.length} fichier(s) non mis en file.`);
    return [];
  }
  await marquerEnFile(fileIds, accountId);
  return enqueueDurableFileAnalyses(fileIds, accountId, options);
}

/**
 * Met une analyse de fichier dans la file durable, sans contrôle de
 * déclencheur ni marquage (voir `enqueueFileAnalyses`).
 *
 * Rend les identifiants réellement acceptés. Un fichier déjà en attente ou
 * en cours est écarté par la déduplication du WF-10.
 */
export async function enqueueDurableFileAnalyses(
  fileIds: number[],
  accountId: number,
  options: {
    userId?: number; origin: string;
    /** Reprise serveur ou réanalyse d'exploitation : non facturée au compte. */
    billable?: boolean;
  },
): Promise<number[]> {
  const acceptes: number[] = [];

  for (const fileId of [...new Set(fileIds)]) {
    if (!Number.isInteger(fileId)) continue;
    try {
      const { decision } = await enqueue({
        treatment: 'T1',
        scope: { accountId, targetType: TARGET_TYPE, targetId: fileId },
        // CDC 15 OBS-CFG : un dépôt est le déclencheur `source_uploaded` du
        // catalogue (repris dans les traces via le contexte d'exécution).
        triggerCode: options.origin === UPLOAD_ORIGIN ? 'source_uploaded' : options.origin,
        payload: {
          fileId, userId: options.userId ?? null, origin: options.origin,
          ...(options.billable === false ? { billable: false } : {}),
        },
      });
      // `skip` : un travail équivalent attend déjà. Ce n'est pas un refus, mais
      // le fichier n'a pas à être compté deux fois comme nouvellement accepté.
      if (decision === 'create') acceptes.push(fileId);
    } catch (e) {
      // Mise en file concurrente du même fichier (deux dépôts, dépôt + reprise) :
      // l'index unique des jobs vivants a refusé le doublon — le fichier EST en
      // file, ce n'est pas une panne. Non compté comme nouvellement accepté.
      if ((e as { code?: string })?.code === '23505') {
        console.info(`[t1-queue] fichier ${fileId} déjà en file (mise en file concurrente).`);
        continue;
      }
      // Le SCR-08 interdit d'acquitter une mise en file non persistée : on ne
      // compte pas ce fichier, et l'appelant peut le constater.
      console.error(`[t1-queue] mise en file impossible pour le fichier ${fileId} :`, (e as Error).message);
    }
  }

  // Un dépôt n'attend pas le tour suivant du boucleur (15 s) : réveil immédiat.
  if (acceptes.length > 0) nudgeQueueWorker();
  return acceptes;
}

/**
 * Enregistre l'exécutant T1 auprès du boucleur.
 *
 * Appelé au démarrage (`instrumentation-node`), AVANT le boucleur. Sans cet
 * enregistrement, les travaux T1 resteraient en file — visibles à l'écran
 * « File IA », jamais exécutés : mieux vaut un travail visiblement bloqué
 * qu'un travail marqué traité alors que personne ne l'a pris.
 */
export function registerSourceAnalysisHandler(): void {
  registerJobHandler('T1', async (job, guard) => {
    // Passage planifié (déclencheur `schedule_*` de la version effective,
    // §15.1) : périmètre = sources jamais analysées, en échec récupérable ou
    // bloquées — exactement ce que sait reprendre `analysis-recovery`, qui
    // vérifie aussi le quota de chaque compte. Réutilisé plutôt que dupliqué.
    if (job.accountId == null && job.targetType == null) {
      await guard.assertActive('reprise planifiée');
      const { runAnalysisRecovery } = await import('@/services/document-ai/analysis-recovery.service');
      const r = await runAnalysisRecovery();
      console.info(`[t1-queue] passage planifié ${job.triggerCode ?? ''} : ${r.retried}/${r.found} source(s) relancée(s).`);
      return;
    }

    const payload = (job.payload ?? {}) as {
      fileId?: number; userId?: number | null; origin?: string;
      /** Réanalyse lancée par l'administration (WF-11) : non facturée au compte. */
      billable?: boolean;
    };
    const fileId = payload.fileId ?? (job.targetId ? Number(job.targetId) : NaN);

    if (!Number.isInteger(fileId) || !job.accountId) {
      // Travail malformé : lever le ferait reprendre cinq fois avant l'échec
      // définitif, pour un contexte qui ne s'améliorera jamais.
      console.error(`[t1-queue] travail ${job.id} sans fichier exploitable — ignoré.`);
      return;
    }

    // §5.7, §10.4 : jamais deux analyses du même fichier. Sous garde, le
    // pipeline ne filtre plus les ANALYZING (titulaire exclusif du job) ; la
    // file mémoire retirée le faisait juste avant l'exécution — la file
    // durable le fait ici.
    if (await analyseConcurrenteEnCours(fileId, job)) {
      console.info(`[t1-queue] travail ${job.id} : fichier ${fileId} déjà en cours d'analyse hors de ce job — non relancé.`);
      return;
    }

    const { analyzeFileSources } = await import('../entrypoint');
    // La garde suit l'exécution jusque dans le pipeline : après un rollback,
    // un arrêt d'urgence ou une désactivation, aucun résultat de cette
    // exécution n'est écrit (contrôle avant chaque écriture significative).
    const outcome = await analyzeFileSources([fileId], job.accountId, {
      userId: payload.userId ?? undefined,
      origin: payload.origin ?? 'queue',
      guard,
      // WF-11 / T1-021 : une réanalyse manuelle ne consomme pas les crédits
      // de l'utilisateur et n'est pas refusée faute de crédit (manual-launch).
      ...(payload.billable === false ? { billable: false } : {}),
    });

    // Quota épuisé : le pipeline n'a rien fait. Clore DONE mentirait au SCR-08
    // et laisserait le fichier « En file d'attente » ; le job est REPORTÉ
    // (backoff, sans tentative consommée), puis abandonné avec un motif clair.
    if (outcome?.skippedReason === 'quota') {
      throw new JobDeferredError('quota d’analyse du compte épuisé');
    }
  }, { onSettled: onT1JobSettled });

  console.info('[t1-queue] Exécutant T1 enregistré auprès du boucleur.');
}

/**
 * Le fichier est-il en cours d'analyse par une AUTRE exécution (analyse
 * directe : `/api/documents/[id]/analyze`, changement de bien, montée de
 * référentiel…) ? Même règle que la reprise serveur (`analysis-recovery`) :
 *
 *   · `ANALYZING` récent (moins de `STUCK_THRESHOLD_MS`, 10 min) : une
 *     analyse vit — le job s'arrête PROPREMENT (issue `done`, qui ne touche
 *     pas un fichier ANALYZING) ; l'analyse en cours le mènera à son terme,
 *     et si elle meurt, la reprise serveur le relancera après 10 min ;
 *   · `ANALYZING` plus ancien : bloqué (processus mort) — le job le reprend ;
 *   · job REPRIS après abandon (`recoveredCount > 0`, bail expiré) : l'état
 *     ANALYZING est très probablement le sien — il le reprend (titulaire).
 *
 * Un report (`JobDeferredError`) serait moins sûr : ses suites remettent un
 * fichier ANALYZING à « non analysé » pendant que l'autre analyse tourne.
 * Lecture illisible : on laisse le pipeline faire (comportement antérieur).
 */
export async function analyseConcurrenteEnCours(
  fileId: number, job: Pick<QueuedJob, 'recoveredCount'>, now: number = Date.now(),
): Promise<boolean> {
  if ((job.recoveredCount ?? 0) > 0) return false;
  try {
    const [{ db }, { assetFiles }, { eq }, { STUCK_THRESHOLD_MS }] = await Promise.all([
      import('@/db'), import('@/db/schema'), import('drizzle-orm'),
      import('@/services/document-ai/analysis-recovery.service'),
    ]);
    const [f] = await db.select({ state: assetFiles.analysisState, updatedAt: assetFiles.updatedAt })
      .from(assetFiles).where(eq(assetFiles.id, fileId)).limit(1);
    if (f?.state !== 'ANALYZING') return false;
    const depuis = f.updatedAt ? new Date(f.updatedAt).getTime() : 0;
    return now - depuis < STUCK_THRESHOLD_MS;
  } catch {
    return false;
  }
}

/**
 * Suites d'un job T1 : l'état du fichier, visible par l'utilisateur, suit
 * l'état du job — audit final BO IA ligne 1 (« fichier laissé En file sur
 * refus quota »), SCR-08.
 *
 *   issue                              fichier
 *   ─────────────────────────────────  ───────────────────────────────────────
 *   done                               resté `UPLOADED` (rien fait) → non analysé
 *   deferred (quota), ou définitif     `UPLOADED`/`ANALYZING` → non analysé ;
 *                                      la reprise serveur le remet en file dès
 *                                      que le compte a du crédit
 *   failed, nouvelle tentative prévue  `ANALYZING` → `UPLOADED` (« En file » :
 *                                      c'est vrai, un job l'attend)
 *   failed définitif (dont timeout)    `UPLOADED`/`ANALYZING` → `ANALYSIS_FAILED`
 *                                      avec le motif
 *   interrupted (rollback, arrêt…)     `ANALYZING` → `UPLOADED` (remis en tête)
 *
 * Seuls les états transitoires sont touchés : un fichier déjà ANALYZED (ou
 * supprimé) n'est jamais réécrit.
 */
export async function onT1JobSettled(job: QueuedJob, outcome: JobOutcome): Promise<void> {
  if (job.targetType !== TARGET_TYPE || job.accountId == null) return;
  const payloadFileId = (job.payload as { fileId?: unknown } | null)?.fileId;
  const fileId = Number(payloadFileId ?? job.targetId);
  if (!Number.isInteger(fileId)) return;

  switch (outcome.kind) {
    case 'done':
      await setFileState(fileId, job.accountId, ['UPLOADED'], { analysisState: null });
      return;
    case 'deferred':
      await setFileState(fileId, job.accountId, ['UPLOADED', 'ANALYZING'], { analysisState: null });
      return;
    case 'interrupted':
      await setFileState(fileId, job.accountId, ['ANALYZING'], { analysisState: 'UPLOADED' });
      return;
    case 'failed':
      if (!outcome.permanent) {
        await setFileState(fileId, job.accountId, ['ANALYZING'], { analysisState: 'UPLOADED' });
      } else {
        await setFileState(fileId, job.accountId, ['UPLOADED', 'ANALYZING'], {
          analysisState: 'ANALYSIS_FAILED',
          analysisFailReason: outcome.timedOut
            ? 'Analyse interrompue : délai maximal dépassé.'
            : 'Analyse impossible après plusieurs tentatives.',
          incrementRetry: true,
        });
      }
      return;
  }
}

async function setFileState(
  fileId: number,
  accountId: number,
  from: string[],
  patch: { analysisState: string | null; analysisFailReason?: string; incrementRetry?: boolean },
): Promise<void> {
  const [{ db }, { assetFiles }, { and, eq, inArray, sql }] = await Promise.all([
    import('@/db'), import('@/db/schema'), import('drizzle-orm'),
  ]);
  await db.update(assetFiles)
    .set({
      analysisState: patch.analysisState,
      ...(patch.analysisFailReason ? { analysisFailReason: patch.analysisFailReason } : {}),
      ...(patch.incrementRetry ? { analysisRetryCount: sql`${assetFiles.analysisRetryCount} + 1` } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(assetFiles.id, fileId),
      eq(assetFiles.accountId, accountId),
      inArray(assetFiles.analysisState, from),
    ));
}
