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
 * le processus redémarre avant son tour, `analysis/check-pending` le reprend :
 * l'état `UPLOADED` fait partie de ce qu'il recherche.
 *
 * ⚠️ File EN MÉMOIRE, propre au processus. Elle suffit pour un conteneur
 * unique ; plusieurs instances se partageraient la charge sans coordination,
 * ce que la déduplication du pipeline (`ANALYZING` ignoré) rend sans danger.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { analyzeFileSources } from './entrypoint';

export interface QueuedAnalysis {
  fileId: number;
  accountId: number;
  userId?: number;
  origin: string;
}

const CONCURRENCE = Math.max(1, Number(process.env.ANALYSIS_QUEUE_CONCURRENCY) || 2);

/**
 * Marque les fichiers « en file d'attente ».
 *
 * Commun aux deux files : c'est cet état que `analysis/check-pending` recherche,
 * et le perdre priverait la file durable du rattrapage qui protège la file en
 * mémoire. Une ceinture de plus ne coûte rien.
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
  options: { userId?: number; origin: string },
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

  if (isDurableQueueEnabled()) {
    await marquerEnFile(fileIds, accountId);
    return enqueueDurableFileAnalyses(fileIds, accountId, options);
  }

  const nouveaux = [...new Set(fileIds)].filter((id) => Number.isInteger(id) && !connus.has(id));
  if (nouveaux.length === 0 || !accountId) return [];

  await marquerEnFile(nouveaux, accountId);

  for (const fileId of nouveaux) {
    connus.add(fileId);
    file.push({ fileId, accountId, userId: options.userId, origin: options.origin });
  }
  pomper();
  return nouveaux;
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
 * l'état `UPLOADED`, que `check-pending` sait aussi reprendre après un
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
    void executer(travail).finally(() => {
      if (gen !== generation) return;
      actifs--;
      connus.delete(travail.fileId);
      pomper();
    });
  }
}

async function executer(t: QueuedAnalysis): Promise<void> {
  try {
    // Un seul fichier : aucun regroupement, aucune suppression de source.
    await analyzeFileSources([t.fileId], t.accountId, {
      userId: t.userId,
      origin: `${t.origin} (file)`,
    });
  } catch (e) {
    // `analyzeFileSources` ne lève pas en principe ; filet de sécurité.
    console.error(`[analysis-queue] analyse du fichier ${t.fileId} impossible :`, (e as Error).message);
  } finally {
    await remettreEnAttenteSiIntact(t.fileId);
  }
}

/**
 * Un fichier encore `UPLOADED` après son tour n'a pas été analysé (quota
 * épuisé, par exemple) : il repasse à « non analysé » pour que la reprise
 * de `check-pending` le traite quand du crédit sera disponible, au lieu
 * d'afficher « En file d'attente » indéfiniment.
 */
async function remettreEnAttenteSiIntact(fileId: number): Promise<void> {
  try {
    await db
      .update(assetFiles)
      .set({ analysisState: null, updatedAt: new Date() })
      .where(and(eq(assetFiles.id, fileId), eq(assetFiles.analysisState, 'UPLOADED')));
  } catch {
    /* sans conséquence : check-pending reprend aussi l'état UPLOADED */
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
