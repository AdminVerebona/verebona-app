/**
 * analysis-recovery.service.ts
 * Relance automatiquement l'analyse IA sur les documents en attente ou bloqués.
 *
 * Cas traités :
 *   - analysisState IS NULL   → jamais analysé (quota épuisé au moment de l'upload ou plan standard)
 *   - ANALYSIS_FAILED < 10    → relancer
 *   - ANALYZING bloqué > 10m  → crash serveur / timeout → relancer
 *
 * Dans tous les cas, le compte doit avoir du crédit disponible (canConsumeAnalysis).
 *
 *   - UPLOADED bloqué > 10m   → mis en file puis perdu (redémarrage de la
 *                               file mémoire) — autrefois repris par
 *                               `/api/analysis/check-pending`, appelé par le
 *                               navigateur (E-06) : la reprise est désormais
 *                               exclusivement serveur.
 *
 * Dans tous les cas, le compte doit avoir du crédit disponible (canConsumeAnalysis).
 *
 * Appelé :
 *   1. Par le scheduler interne (instrumentation.ts) toutes les INTERVAL_MS
 *   2. Par GET /api/cron/retry-analysis (cron externe ou appel manuel)
 *   3. Par le passage planifié T1 de la file durable (t1-handler)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * JAMAIS DEUX ANALYSES DU MÊME FICHIER (§10.4 — lot 3, bascule durable)
 *
 * La reprise appelait `analyzeFileSources` DIRECTEMENT, à côté de la file.
 * Avec `AI_DURABLE_QUEUE=enabled`, un fichier dont le job T1 attendait son
 * backoff (état ANALYSIS_FAILED ou UPLOADED) ou s'exécutait depuis plus de
 * dix minutes (ANALYZING, délai global de 15 min) était relancé une seconde
 * fois, hors file — et sous garde, le pipeline ne filtre plus les ANALYZING.
 *
 * Désormais :
 *   · tout fichier ayant un job T1 VIVANT (PENDING ou RUNNING) est écarté,
 *     et son état n'est jamais réinitialisé ;
 *   · en file mémoire (`legacy`), un fichier encore connu de la file de ce
 *     processus est écarté de même ;
 *   · la relance passe par `enqueueFileAnalyses` — la file active, avec sa
 *     déduplication (WF-10 en durable, ensemble `connus` en mémoire) et sa
 *     concurrence bornée — au lieu d'un appel direct.
 */

import { db } from '@/db';
import { assetFiles, accounts } from '@/db/schema';
import { eq, inArray, isNull, and, lt, or } from 'drizzle-orm';
import { canConsumeAnalysis } from '@/services/commercial-model.service';
import { withJobLock } from '@/lib/job-lock';
/** Un document en ANALYZING depuis plus de 10 min est considéré bloqué */
const STUCK_THRESHOLD_MS = 10 * 60 * 1_000;

/**
 * Nom du bail et durée maximale d'un tour.
 *
 * ⚠️ Le verrou en mémoire ne protégeait qu'un processus. Deux instances
 * derrière un répartiteur relançaient les mêmes documents et consommaient
 * deux fois le crédit d'analyse. Le bail est désormais en base (`job_locks`).
 *
 * 15 minutes : un tour traite au plus 50 documents par lots de 3 espacés de
 * 3 secondes, l'analyse elle-même étant lancée sans attendre. La marge est
 * volontairement large — un bail trop court serait repris par une autre
 * instance pendant que le travail continue.
 */
const LOCK_NAME = 'analysis-recovery';
const LOCK_TTL_MS = 15 * 60 * 1_000;

export interface RecoveryResult {
  found: number;
  retried: number;
  errors: number;
}

/**
 * runAnalysisRecovery — point d'entrée principal.
 * Idempotent : si déjà en cours, retourne immédiatement.
 *
 * @param targetAccountId — si fourni, ne traiter que ce compte (ex: après upgrade plan)
 */
export async function runAnalysisRecovery(targetAccountId?: number): Promise<RecoveryResult> {
  const issue = await withJobLock(LOCK_NAME, LOCK_TTL_MS, () => runInterne(targetAccountId));
  if (issue === null) {
    console.info('[analysis-recovery] Un autre tour est en cours ailleurs, skip.');
    return { found: 0, retried: 0, errors: 0 };
  }
  return issue;
}

async function runInterne(targetAccountId?: number): Promise<RecoveryResult> {
  const result: RecoveryResult = { found: 0, retried: 0, errors: 0 };

  try {
    const stuckThreshold = new Date(Date.now() - STUCK_THRESHOLD_MS);

    // 1. Récupérer les comptes à vérifier
    const allAccounts = targetAccountId
      ? await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, targetAccountId))
      : await db.select({ id: accounts.id }).from(accounts);

    if (allAccounts.length === 0) return result;

    // 2. Pour chaque compte, vérifier le quota avant d'inclure ses docs
    const eligibleAccountIds: number[] = [];
    await Promise.all(allAccounts.map(async (acc) => {
      try {
        const gate = await canConsumeAnalysis(acc.id, 1);
        if (gate.allowed) eligibleAccountIds.push(acc.id);
      } catch { /* ignorer les erreurs par compte */ }
    }));

    if (eligibleAccountIds.length === 0) {
      console.info('[analysis-recovery] Aucun compte avec crédit disponible.');
      return result;
    }

    // 3. Trouver les documents éligibles pour ces comptes :
    //    - analysisState IS NULL → jamais analysé (quota était épuisé ou plan standard avant)
    //    - ANALYSIS_FAILED < 10  → relancer
    //    - ANALYZING bloqué      → crash / timeout
    const candidates = await db
      .select({
        id: assetFiles.id,
        accountId: assetFiles.accountId,
        analysisState: assetFiles.analysisState,
        updatedAt: assetFiles.updatedAt,
      })
      .from(assetFiles)
      .where(
        and(
          isNull(assetFiles.deletedAt),
          eq(assetFiles.uploadStatus, 'COMPLETED'),
          inArray(assetFiles.accountId as any, eligibleAccountIds),
          or(
            // Jamais analysé (null = quota épuisé lors de l'upload, ou doc ancien)
            isNull(assetFiles.analysisState),
            // Échec récupérable
            and(
              eq(assetFiles.analysisState, 'ANALYSIS_FAILED'),
              lt(assetFiles.analysisRetryCount, 10),
            ),
            // Bloqué en ANALYZING (crash serveur)
            and(
              eq(assetFiles.analysisState, 'ANALYZING'),
              lt(assetFiles.updatedAt, stuckThreshold),
            ),
            // Mis en file puis perdu (redémarrage de la file mémoire) — E-06.
            and(
              eq(assetFiles.analysisState, 'UPLOADED'),
              lt(assetFiles.updatedAt, stuckThreshold),
            ),
          ),
        ),
      )
      .limit(50);

    // §10.4 : écarter ce que la file traite déjà (voir l'en-tête).
    const vivants = await fichiersEnFile(candidates.map((c) => c.id));
    const ecartes = candidates.filter((c) => vivants.has(c.id)).length;
    if (ecartes > 0) {
      console.info(`[analysis-recovery] ${ecartes} document(s) déjà en file — non relancé(s).`);
    }
    const aRelancer = candidates.filter((c) => !vivants.has(c.id));
    candidates.length = 0;
    candidates.push(...aRelancer);

    result.found = candidates.length;

    if (candidates.length === 0) {
      console.info('[analysis-recovery] Aucun document à relancer.');
      return result;
    }

    console.info(`[analysis-recovery] ${candidates.length} document(s) à relancer pour ${eligibleAccountIds.length} compte(s).`);

    // 4. Regrouper par compte pour limiter les appels quota
    const byAccount = new Map<number, number[]>();
    for (const doc of candidates) {
      if (!doc.accountId) continue;
      if (!byAccount.has(doc.accountId)) byAccount.set(doc.accountId, []);
      byAccount.get(doc.accountId)!.push(doc.id);
    }

    // 5. Réinitialiser les docs bloqués en ANALYZING (le pipeline les ignore sinon)
    const stuckAnalyzingIds = candidates
      .filter(d => d.analysisState === 'ANALYZING')
      .map(d => d.id);
    if (stuckAnalyzingIds.length > 0) {
      await db.update(assetFiles)
        .set({ analysisState: null as any, updatedAt: new Date() })
        .where(inArray(assetFiles.id, stuckAnalyzingIds));
    }

    // 6. Remettre en file, compte par compte. La file active (durable ou
    //    mémoire) borne la concurrence et déduplique ; non facturé, comme
    //    avant (la reprise n'est pas une nouvelle demande de l'utilisateur).
    const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/analysis-queue');
    for (const [accountId, ids] of byAccount) {
      try {
        const acceptes = await enqueueFileAnalyses(ids, accountId, {
          origin: 'analysis-recovery',
          billable: false,
        });
        result.retried += acceptes.length;
      } catch (err) {
        console.error(`[analysis-recovery] Remise en file impossible (compte ${accountId}) :`, (err as Error).message);
        result.errors += ids.length;
      }
    }

    console.info(`[analysis-recovery] Terminé — ${result.retried} relancé(s), ${result.errors} erreur(s).`);
  } catch (err) {
    console.error('[analysis-recovery] Erreur globale:', (err as Error).message);
  }
  // Le bail est rendu par `withJobLock`, y compris en cas d'exception.

  return result;
}

/**
 * Fichiers déjà pris en charge par une file : job T1 vivant dans la file
 * durable (quel que soit le mode : le lancement manuel T1 y passe toujours),
 * ou, en mode `legacy`, fichier connu de la file mémoire de ce processus.
 *
 * File durable illisible : on écarte TOUT — mieux vaut une reprise différée de
 * cinq minutes qu'une double analyse facturée deux fois au fournisseur.
 */
async function fichiersEnFile(ids: number[]): Promise<Set<number>> {
  const vivants = new Set<number>();
  if (ids.length === 0) return vivants;
  try {
    const { listLiveTargets } = await import('@/services/ai/queue/job-queue.repository');
    for (const t of await listLiveTargets('T1', 'asset_file', ids)) vivants.add(Number(t));
  } catch (e) {
    console.warn('[analysis-recovery] file durable illisible, reprise différée :', (e as Error).message);
    return new Set(ids);
  }
  try {
    const { isDurableQueueEnabled } = await import('@/services/ai/source-analysis/queue/t1-handler');
    if (!isDurableQueueEnabled()) {
      const { isFileQueuedInMemory } = await import('@/services/ai/source-analysis/analysis-queue');
      for (const id of ids) if (isFileQueuedInMemory(id)) vivants.add(id);
    }
  } catch { /* file mémoire indisponible : rien de plus à écarter */ }
  return vivants;
}
