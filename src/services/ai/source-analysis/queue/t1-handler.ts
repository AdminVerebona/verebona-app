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
import { registerJobHandler } from '../../queue/queue-worker';
import { enqueue } from '../../queue/job-queue.repository';

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
 * raisons vérifiées dans le code, à lever avant la bascule :
 *   · débit : la file mémoire analyse 2 fichiers en parallèle dès le dépôt ;
 *     le boucleur sert T1 séquentiellement (5 par tour, tour toutes les
 *     15 s après un premier tour différé de 30 s) — un dépôt de 20 fichiers
 *     serait nettement plus lent ;
 *   · état du fichier : la file mémoire remet à « non analysé » un fichier
 *     resté `UPLOADED` après son tour (`remettreEnAttenteSiIntact`), la file
 *     durable non — un fichier refusé pour quota resterait « En file
 *     d'attente » à l'écran ;
 *   · le bail du boucleur (`withJobLock`, 30 s) est plus court qu'une analyse
 *     T1 : deux tours peuvent se chevaucher (sans doublon grâce à SKIP LOCKED,
 *     mais avec deux analyses T1 simultanées).
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
  options: { userId?: number; origin: string },
): Promise<number[]> {
  const acceptes: number[] = [];

  for (const fileId of [...new Set(fileIds)]) {
    if (!Number.isInteger(fileId)) continue;
    try {
      const { decision } = await enqueue({
        treatment: 'T1',
        scope: { accountId, targetType: TARGET_TYPE, targetId: fileId },
        triggerCode: options.origin,
        payload: { fileId, userId: options.userId ?? null, origin: options.origin },
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
    await analyzeFileSources([fileId], job.accountId, {
      userId: payload.userId ?? undefined,
      origin: payload.origin ?? 'queue',
      guard,
      // WF-11 / T1-021 : une réanalyse manuelle ne consomme pas les crédits
      // de l'utilisateur et n'est pas refusée faute de crédit (manual-launch).
      ...(payload.billable === false ? { billable: false } : {}),
    });
  });

  console.info('[t1-queue] Exécutant T1 enregistré auprès du boucleur.');
}
