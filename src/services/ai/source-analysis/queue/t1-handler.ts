/**
 * Exécutant T1 — CDC BO IA GEN-004, GEN-005, NFR-003.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE REMPLACE
 *
 * `analysis-queue.ts` tient la file des analyses EN MÉMOIRE — son propre
 * en-tête le reconnaît : « file propre au processus », « si le processus
 * redémarre avant son tour, `analysis/check-pending` le reprend ».
 *
 * C'est précisément ce que le NFR-003 refuse : « un job ne peut pas être perdu
 * après un redémarrage applicatif ». Trois redéploiements ont eu lieu le
 * 18/09/2026 ; chacun a vidé cette file, et seule une route de rattrapage
 * appelée par le client permettait de s'en apercevoir.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA BASCULE EST RÉVERSIBLE, ET C'EST DÉLIBÉRÉ
 *
 * Le dépôt de documents est un chemin critique : si la file durable se trompe,
 * plus aucune analyse ne part. Le drapeau `AI_DURABLE_QUEUE` permet de revenir
 * à la file en mémoire sans redéploiement, comme chaque bascule de ce projet.
 *
 * Les deux files ne tournent JAMAIS ensemble. Le §10.4 interdit qu'un même
 * document soit traité deux fois, et c'est le défaut qui nous a occupés le
 * matin même : `emitSourceAnalyzed` déclenchait tous les abonnés dès qu'un seul
 * drapeau était actif.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE TRAVAIL NE PORTE PAS LES DONNÉES, IL PORTE DE QUOI LES RETROUVER
 *
 * Seuls l'identifiant du fichier, le compte, l'utilisateur et l'origine sont
 * mis en file. Le pipeline relit l'état du fichier au moment de s'exécuter :
 * un document supprimé entre la mise en file et l'exécution doit être ignoré,
 * pas analysé à partir d'un instantané périmé.
 */
import { registerJobHandler, nudgeQueueWorker, type JobOutcome } from '../../queue/queue-worker';
import { enqueue, type QueuedJob } from '../../queue/job-queue.repository';
import { JobDeferredError } from '../../queue/queue-policy';

/** Type de cible, pour la clé de déduplication. */
const TARGET_TYPE = 'asset_file';

/**
 * Bascule entre file en mémoire et file durable.
 *
 * Variable propre, et non membre d'`AI_FLAGS` : cette liste signifie « un
 * drapeau par usage IA », et deux tests en dépendent — la bijection usage ⇄
 * drapeau, et l'interprétation du rapport d'inventaire. Les y mélanger ferait
 * compter une bascule technique comme un usage.
 *
 * Deux valeurs seulement. Un mode observation n'aurait pas de sens : deux files
 * analyseraient le même document deux fois, ce que le §10.4 interdit.
 *
 * ── DÉCISION LOT IA 2 (OPS-001, T1-024) : LE DÉFAUT RESTE `legacy` POUR T1 ──
 * T3 et T4 sont passés en file durable sans drapeau. T1 non, pour trois
 * freins constatés au lot 2. Le lot 3 les lève ; le défaut reste `legacy`
 * jusqu'à la recette, la bascule se fait par variable d'environnement :
 *   · débit — LEVÉ : le boucleur tient `AI_QUEUE_CONCURRENCY` exécutions
 *     simultanées par instance (3 par défaut), et une mise en file T1 le
 *     réveille immédiatement (`nudgeQueueWorker`) ;
 *   · état du fichier — LEVÉ : les suites T1 (`onT1JobSettled`) alignent
 *     l'état du fichier sur l'issue du job. Un refus de quota REPORTE le job
 *     (backoff, puis échec définitif motivé) et le fichier repasse « non
 *     analysé » : jamais « En file d'attente » sans job vivant ;
 *   · bail — LEVÉ : le bail du tour ne couvre plus que l'entretien ; chaque
 *     exécution tient son propre bail (`AI_QUEUE_LEASE_SECONDS`, 300 s),
 *     renouvelé toutes les 100 s tant qu'elle travaille, et le délai global
 *     GEN-012 (15 min pour T1) borne l'exécution.
 * Le boucleur est bien démarré en production (`instrumentation.ts`, étape 6) ;
 * la bascule reste un simple `AI_DURABLE_QUEUE=enabled`, réversible.
 */
export function isDurableQueueEnabled(): boolean {
  const raw = (process.env.AI_DURABLE_QUEUE ?? 'legacy').toLowerCase();
  return raw === 'enabled' || raw === 'true' || raw === '1';
}

/**
 * Met une analyse de fichier dans la file durable.
 *
 * Rend les identifiants réellement acceptés — même contrat que la file en
 * mémoire, pour que les trois appelants n'aient pas à changer. Un fichier déjà
 * en attente ou en cours est écarté par la déduplication du WF-10, exactement
 * comme le faisait l'ensemble `connus`.
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
        triggerCode: options.origin,
        payload: {
          fileId, userId: options.userId ?? null, origin: options.origin,
          ...(options.billable === false ? { billable: false } : {}),
        },
      });
      // `skip` : un travail équivalent attend déjà. Ce n'est pas un refus, mais
      // le fichier n'a pas à être compté deux fois comme nouvellement accepté.
      if (decision === 'create') acceptes.push(fileId);
    } catch (e) {
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
 * Appelé au démarrage. Sans cet enregistrement, les travaux T1 resteraient en
 * file — visibles à l'écran « File IA », jamais exécutés. C'est le comportement
 * voulu tant que la bascule n'est pas faite : mieux vaut un travail visiblement
 * bloqué qu'un travail marqué traité alors que personne ne l'a pris.
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
