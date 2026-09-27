/**
 * File d'attente des analyses de documents.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN DÉPÔT DE N FICHIERS = N DOCUMENTS, ANALYSÉS L'UN APRÈS L'AUTRE
 *
 * Le dépôt multiple envoyait tous les fichiers dans UNE analyse. Le pipeline
 * commençait par un regroupement IA (« ces fichiers sont-ils les pages d'un
 * même document ? »), puis supprimait les fichiers jugés secondaires. Deux
 * factures distinctes pouvaient ainsi devenir un seul document — c'est le
 * « seul le premier document est analysé et enregistré » constaté en recette.
 *
 * Désormais chaque fichier est une analyse à part, exactement comme s'il
 * avait été déposé seul. Le regroupement ne s'applique plus au dépôt.
 *
 * ── POURQUOI UNE FILE ET PAS N APPELS SIMULTANÉS ──────────────────────────
 *
 * Dix analyses lancées ensemble, ce sont dix appels modèle et dix fichiers en
 * mémoire sur un conteneur déjà tombé pour dépassement mémoire. La file borne
 * le parallélisme (`ANALYSIS_QUEUE_CONCURRENCY`, 2 par défaut).
 *
 * En attente, le fichier porte l'état `UPLOADED` (« En file d'attente »). Si
 * le processus redémarre avant son tour, la reprise serveur (`analysis-recovery`)
 * le remet en file après dix minutes (E-06 : plus de reprise déclenchée par le
 * navigateur).
 *
 * ⚠️ File EN MÉMOIRE, propre au processus. Elle suffit pour un conteneur
 * unique ; plusieurs instances se partageraient la charge sans coordination,
 * ce que la déduplication du pipeline (`ANALYZING` ignoré) rend sans danger.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { analyzeFileSources } from './entrypoint';

export interface QueuedAnalysis {
  fileId: number;
  accountId: number;
  userId?: number;
  origin: string;
  /** Reprise serveur : non facturée au compte (comme `analysis-recovery`). */
  billable?: boolean;
}

const CONCURRENCE = Math.max(1, Number(process.env.ANALYSIS_QUEUE_CONCURRENCY) || 2);

/**
 * Marque les fichiers « en file d'attente ».
 *
 * Commun aux deux files : c'est cet état que la reprise serveur recherche
 * (`analysis-recovery`, UPLOADED bloqué), et le perdre priverait la file du
 * rattrapage qui protège la file en mémoire. Une ceinture de plus ne coûte rien.
 */
async function marquerEnFile(fileIds: number[], accountId: number): Promise<void> {
  const ids = [...new Set(fileIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0 || !accountId) return;
  try {
    await db
      .update(assetFiles)
      .set({ analysisState: 'UPLOADED', updatedAt: new Date() })
      .where(and(
        inArray(assetFiles.id, ids),
        eq(assetFiles.accountId, accountId),
        or(isNull(assetFiles.analysisState), eq(assetFiles.analysisState, 'UPLOADED'), eq(assetFiles.analysisState, 'ANALYSIS_FAILED')),
      ));
  } catch (e) {
    console.error('[analysis-queue] marquage « en file » impossible :', (e as Error).message);
  }
}

const file: QueuedAnalysis[] = [];
/** Fichiers en attente ou en cours — évite qu'un même fichier passe deux fois. */
const connus = new Set<number>();
let actifs = 0;
/** Incrémenté par la remise à zéro des tests : un travail d'une génération passée ne touche plus aux compteurs. */
let generation = 0;

/**
 * Le fichier est-il en attente ou en cours dans la file mémoire de CE
 * processus ? Sert la reprise serveur, qui ne doit pas relancer un fichier
 * que la file mémoire va traiter (double analyse, §10.4).
 */
export function isFileQueuedInMemory(fileId: number): boolean {
  return connus.has(fileId);
}

/** État de la file, pour le diagnostic et les tests. */
export function getAnalysisQueueState(): { pending: number; running: number; concurrency: number } {
  return { pending: file.length, running: actifs, concurrency: CONCURRENCE };
}

/**
 * Met des fichiers en file, un travail par fichier.
 *
 * Marque les fichiers `UPLOADED` (« En file d'attente ») sauf s'ils sont
 * déjà en cours d'analyse. Ne lève jamais : l'appelant a déjà répondu, ou va
 * le faire, et l'échec d'une mise en file ne doit pas faire échouer un dépôt.
 */
export async function enqueueFileAnalyses(
  fileIds: number[],
  accountId: number,
  options: { userId?: number; origin: string; billable?: boolean },
): Promise<number[]> {
  // ══════════════════════════════════════════════════════════════════════
  // AIGUILLAGE VERS LA FILE DURABLE (CDC BO IA GEN-004, NFR-003)
  //
  // Un seul point de bascule, ici, plutôt qu'un test de drapeau chez chacun
  // des trois appelants — même raisonnement que `source-analysis/entrypoint`,
  // où l'audit avait manqué cinq appelants sur huit.
  //
  // Les deux files ne tournent jamais ensemble : le mode `shadow` est refusé
  // au démarrage, car deux files analyseraient le même document deux fois.
  // ══════════════════════════════════════════════════════════════════════
  const { isDurableQueueEnabled, enqueueDurableFileAnalyses } =
    await import('./queue/t1-handler');

  // T1-UI-08 (lot IA 2) : le dépôt n'enclenche l'analyse que si le
  // déclencheur `source_uploaded` est actif dans la version effective (liste
  // vide = défauts du code, donc actif). Les autres origines — reprise,
  // relance demandée par l'utilisateur — ne sont pas des déclencheurs
  // automatiques du catalogue et ne sont pas filtrées.
  if (options.origin === UPLOAD_ORIGIN && !(await t1TriggerActive('source_uploaded'))) {
    console.info(`[analysis-queue] déclencheur « source_uploaded » inactif : ${fileIds.length} fichier(s) non mis en file.`);
    return [];
  }

  if (isDurableQueueEnabled()) {
    await marquerEnFile(fileIds, accountId);
    return enqueueDurableFileAnalyses(fileIds, accountId, options);
  }

  const nouveaux = [...new Set(fileIds)].filter((id) => Number.isInteger(id) && !connus.has(id));
  if (nouveaux.length === 0 || !accountId) return [];

  await marquerEnFile(nouveaux, accountId);

  for (const fileId of nouveaux) {
    connus.add(fileId);
    file.push({
      fileId, accountId, userId: options.userId, origin: options.origin,
      ...(options.billable === false ? { billable: false } : {}),
    });
  }
  pomper();
  return nouveaux;
}

/** Origine des dépôts (route `files/confirm`) — déclencheur `source_uploaded`. */
const UPLOAD_ORIGIN = 'files/confirm';

async function t1TriggerActive(code: string): Promise<boolean> {
  try {
    const { isTriggerActive } = await import('../queue/triggers');
    return await isTriggerActive('T1', code);
  } catch {
    return true;
  }
}

/**
 * Délai avant de revérifier l'état de T1 quand il est bloqué. Court : la
 * reprise après relâchement d'un arrêt d'urgence doit se voir vite ; la
 * vérification ne coûte qu'une lecture.
 */
const RELANCE_SI_BLOQUE_MS = 30_000;
let verificationEnCours = false;
let relance: ReturnType<typeof setTimeout> | null = null;

/**
 * T1 peut-il démarrer une analyse ? (CDC BO IA OPS-008, OPS-011, WF-07, WF-08)
 *
 * La file durable le vérifie dans `claimNext` ; la file mémoire — mode par
 * défaut — ne le faisait pas : désactiver T1 ou engager l'arrêt d'urgence
 * n'empêchait aucun démarrage. Base illisible : on laisse passer (la garde de
 * la gateway reste là en second rideau).
 */
async function t1PeutDemarrer(): Promise<boolean> {
  try {
    const { canStart } = await import('../queue/job-queue.repository');
    return await canStart('T1');
  } catch (e) {
    console.warn('[analysis-queue] état T1 illisible, démarrage autorisé :', (e as Error).message);
    return true;
  }
}

/**
 * Lance les travaux en attente dans la limite de la concurrence.
 *
 * Bloqué (T1 désactivé, suspendu ou arrêt d'urgence) : les travaux RESTENT en
 * file, sans démarrer — WF-07 étapes 40-41 : « conserver les jobs, accepter les
 * nouvelles demandes, aucun nouveau démarrage » — et l'état est revérifié
 * périodiquement pour reprendre seul à la réactivation. Les fichiers gardent
 * l'état `UPLOADED`, que `analysis-recovery` sait aussi reprendre après un
 * redémarrage du processus.
 */
function pomper(): void {
  if (verificationEnCours || actifs >= CONCURRENCE || file.length === 0) return;
  verificationEnCours = true;
  const gen = generation;
  void t1PeutDemarrer().then((ok) => {
    if (gen !== generation) return;
    verificationEnCours = false;
    if (!ok) {
      if (!relance) {
        relance = setTimeout(() => { relance = null; pomper(); }, RELANCE_SI_BLOQUE_MS);
        relance.unref?.();
      }
      return;
    }
    demarrer();
  });
}

function demarrer(): void {
  while (actifs < CONCURRENCE && file.length > 0) {
    const travail = file.shift()!;
    const gen = generation;
    actifs++;
    void executer(travail).then(({ remisEnFile, toujoursActive }) => {
      if (gen !== generation) return;
      actifs--;
      // Remis en file après interruption : il reste « connu », sinon un
      // nouveau dépôt du même fichier le mettrait une seconde fois en file.
      //
      // Délai global dépassé et exécution toujours active (moteur historique,
      // qui ignore la garde) : la place est rendue, mais le fichier reste
      // « connu » jusqu'à la fin RÉELLE de l'exécution — ni la file ni la
      // reprise serveur (`isFileQueuedInMemory`) ne peuvent lancer une
      // seconde analyse pendant que la première écrit encore.
      if (toujoursActive) {
        void toujoursActive.finally(() => { if (gen === generation) connus.delete(travail.fileId); });
      } else if (!remisEnFile) {
        connus.delete(travail.fileId);
      }
      pomper();
    });
  }
}

/**
 * Exécute une analyse. `remisEnFile` : le travail a été REMIS en file parce
 * qu'il a été interrompu (et non parce qu'il a échoué). `toujoursActive` :
 * délai global dépassé, exécution sous-jacente pas encore terminée — le
 * fichier reste réservé jusqu'à sa fin (voir `demarrer`).
 *
 * ── CONTEXTE D'EXÉCUTION (VER-015, VER-016, MOD-011) ────────────────────────
 * Comme la file durable, la file mémoire ouvre un contexte d'exécution :
 *   · version de configuration figée au démarrage — une activation en cours
 *     d'analyse ne change plus de modèle ni de préambule en route ;
 *   · instant de démarrage — sous disjoncteur, l'analyse déjà lancée termine
 *     (exemption de la garde de la passerelle, runnable-guard).
 *
 * ── INTERRUPTION ≠ ÉCHEC (revue indépendante lot IA 2) ──────────────────────
 * Un refus `AI_BLOCKED` (arrêt d'urgence, désactivation) marquait la source
 * ANALYSIS_FAILED et incrémentait son compteur d'échecs, alors que rien
 * n'avait échoué : l'exploitation avait coupé l'IA. Le pipeline laisse
 * désormais remonter l'interruption (execution-control) ; ici, la source
 * repasse « En file d'attente » et le travail reprend sa place en TÊTE de
 * file — `pomper` attend la réactivation (WF-07 étapes 40-41, WF-08).
 */
async function executer(t: QueuedAnalysis): Promise<{ remisEnFile: boolean; toujoursActive: Promise<unknown> | null }> {
  let remisEnFile = false;
  let toujoursActive: Promise<unknown> | null = null;
  let desinscrire: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let execution: Promise<unknown> | null = null;
  let limit: number | null = null;
  try {
    const [{ runInJobContext, executionTimeoutMs }, control, configVersionId] = await Promise.all([
      import('../queue/job-context'),
      import('../queue/execution-control'),
      versionEffective(),
    ]);

    // Déduplication (§5.7) : la garde transmise au pipeline le rend
    // « titulaire exclusif » et il ne filtre plus lui-même les sources en
    // cours ; le contrôle qu'il faisait est donc fait ici, à l'identique.
    if (await dejaEnCours(t.fileId)) return { remisEnFile: false, toujoursActive: null };

    // ── ROLLBACK ET ARRÊT D'URGENCE ATTEIGNENT AUSSI LA FILE MÉMOIRE ────────
    // (VER-017, WF-06 — audit final BO IA ligne 1.) L'exécution s'enregistre
    // auprès du contrôle d'exécution : `requeueRunning('T1')` l'interrompt
    // comme une exécution durable locale. La garde (sans jeton en base) est
    // contrôlée par le pipeline avant chaque écriture : l'analyse interrompue
    // n'écrit plus rien, et le travail reprend en tête avec la nouvelle
    // configuration.
    const controller = new AbortController();
    desinscrire = control.registerMemoryExecution('T1', controller);
    const guard = control.createExecutionGuard({ id: 0, executionId: null }, controller, async () => true);

    // ── GEN-012 : DÉLAI GLOBAL D'EXÉCUTION, ICI AUSSI ────────────────────────
    // Même borne que la file durable (`executionTimeoutMs('T1')`). Au
    // dépassement, l'exécution est coupée (signal, garde) ; le fichier ne
    // passe en échec qu'une fois l'exécution RÉELLEMENT terminée (revue
    // lot 3 : le moteur historique ignore la garde et continuait d'écrire
    // pendant que la reprise relançait le fichier). Ce n'est pas une
    // interruption d'exploitation : il ne repart pas en tête (il bouclerait
    // sans fin) ; la reprise serveur le relancera ensuite.
    limit = executionTimeoutMs('T1');
    const borne = limit;
    const deadline = borne
      ? new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const err = new control.ExecutionCancelledError(`délai global d'exécution dépassé (${Math.round(borne / 1000)} s)`);
          controller.abort(err);
          reject(err);
        }, borne);
        (timer as { unref?: () => void }).unref?.();
      })
      : null;

    // Un seul fichier : aucun regroupement, aucune suppression de source.
    execution = runInJobContext(
      { jobId: null, treatment: 'T1', configVersionId, startedAt: Date.now(), signal: controller.signal },
      () => analyzeFileSources([t.fileId], t.accountId, {
        userId: t.userId,
        origin: `${t.origin} (file)`,
        guard,
        ...(t.billable === false ? { billable: false } : {}),
      }),
    );
    await (deadline ? Promise.race([execution, deadline]) : execution);
  } catch (e) {
    const [{ isExecutionCancelled }, { isAiBlocked }] = await Promise.all([
      import('../queue/execution-control'),
      import('../queue/runnable-guard'),
    ]);
    if (timedOut) {
      const raison = (e as Error).message;
      console.error(`[analysis-queue] analyse du fichier ${t.fileId} : ${raison} — attente de la fin réelle de l'exécution.`);
      const { waitForSettlement } = await import('../queue/execution-control');
      const enCours = execution ?? Promise.resolve();
      // La place reste occupée pendant une seconde durée de délai au plus.
      if (await waitForSettlement(enCours, limit ?? 0)) {
        await marquerEchecDelai(t.fileId, raison);
      } else {
        console.error(`[analysis-queue] fichier ${t.fileId} : exécution toujours active après le délai de grâce — place rendue, fichier réservé jusqu'à sa fin.`);
        toujoursActive = enCours
          .catch(() => {})
          .then(() => marquerEchecDelai(t.fileId, raison))
          .then(() => remettreEnAttenteSiIntact(t.fileId));
      }
    } else if (isExecutionCancelled(e) || isAiBlocked(e)) {
      remisEnFile = await remettreEnFileApresInterruption(t, (e as Error).message);
    } else {
      // `analyzeFileSources` ne lève pas en principe ; filet de sécurité.
      console.error(`[analysis-queue] analyse du fichier ${t.fileId} impossible :`, (e as Error).message);
    }
  } finally {
    if (timer) clearTimeout(timer);
    desinscrire?.();
    if (!remisEnFile && !toujoursActive) await remettreEnAttenteSiIntact(t.fileId);
  }
  return { remisEnFile, toujoursActive };
}

/** La source est-elle déjà en cours d'analyse (même règle que le pipeline) ? */
async function dejaEnCours(fileId: number): Promise<boolean> {
  try {
    const rows = await db.select({ state: assetFiles.analysisState })
      .from(assetFiles).where(eq(assetFiles.id, fileId)).limit(1);
    return rows[0]?.state === 'ANALYZING';
  } catch {
    // Illisible : on laisse le pipeline décider (il relira l'état).
    return false;
  }
}

/** Délai global dépassé : la source passe en échec récupérable, avec le motif. */
async function marquerEchecDelai(fileId: number, raison: string): Promise<void> {
  try {
    await db
      .update(assetFiles)
      .set({
        analysisState: 'ANALYSIS_FAILED',
        analysisFailReason: `Analyse interrompue : ${raison}.`,
        analysisRetryCount: sql`${assetFiles.analysisRetryCount} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(assetFiles.id, fileId), or(eq(assetFiles.analysisState, 'ANALYZING'), eq(assetFiles.analysisState, 'UPLOADED'))));
  } catch {
    /* la reprise serveur traitera l'ANALYZING bloqué après dix minutes */
  }
}

/** Version effective à figer ; jamais bloquant (repli : configuration du code). */
async function versionEffective(): Promise<number | null> {
  try {
    const { resolveEffectiveVersionId } = await import('../config/config-resolver');
    return await resolveEffectiveVersionId();
  } catch {
    return null;
  }
}

/**
 * Remet en tête de file un travail interrompu. La source, laissée
 * `ANALYZING` par le pipeline, repasse `UPLOADED` : sinon la reprise
 * l'ignorerait (`excludeInProgress`) et l'écran afficherait « en cours »
 * indéfiniment.
 */
async function remettreEnFileApresInterruption(t: QueuedAnalysis, raison: string): Promise<boolean> {
  try {
    await db
      .update(assetFiles)
      .set({ analysisState: 'UPLOADED', updatedAt: new Date() })
      .where(and(eq(assetFiles.id, t.fileId), eq(assetFiles.analysisState, 'ANALYZING')));
  } catch {
    /* la reprise serveur reprendra la source ; la remise en file suffit */
  }
  file.unshift(t);
  console.warn(`[analysis-queue] analyse du fichier ${t.fileId} interrompue (${raison}) — remise en tête de file.`);
  return true;
}

/**
 * Un fichier encore `UPLOADED` après son tour n'a pas été analysé (quota
 * épuisé, par exemple) : il repasse à « non analysé » pour que la reprise
 * serveur (`analysis-recovery`) le traite quand du crédit sera disponible, au lieu
 * d'afficher « En file d'attente » indéfiniment.
 */
async function remettreEnAttenteSiIntact(fileId: number): Promise<void> {
  try {
    await db
      .update(assetFiles)
      .set({ analysisState: null, updatedAt: new Date() })
      .where(and(eq(assetFiles.id, fileId), eq(assetFiles.analysisState, 'UPLOADED')));
  } catch {
    /* sans conséquence : analysis-recovery reprend aussi l'UPLOADED bloqué */
  }
}

/** Réservé aux tests. */
export function __resetAnalysisQueueForTests(): void {
  file.length = 0;
  connus.clear();
  actifs = 0;
  verificationEnCours = false;
  if (relance) { clearTimeout(relance); relance = null; }
  generation++;
}
