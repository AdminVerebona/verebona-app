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
 * Appelé :
 *   1. Par le scheduler interne (instrumentation.ts) toutes les INTERVAL_MS
 *   2. Par GET /api/cron/retry-analysis (cron externe ou appel manuel)
 *   3. Par /api/analysis/check-pending (appelé au chargement de l'app côté client)
 *
 * Concurrence : batchs de BATCH_SIZE, avec BATCH_DELAY_MS entre chaque batch.
 */

import { db } from '@/db';
import { assetFiles, accounts } from '@/db/schema';
import { eq, inArray, isNull, and, lt, or } from 'drizzle-orm';
import { canConsumeAnalysis } from '@/services/commercial-model.service';
import { analyzeFileSources } from '@/services/ai/source-analysis/entrypoint';
import { withJobLock } from '@/lib/job-lock';

const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 3_000;
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
          ),
        ),
      )
      .limit(50);

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

    // 6. Traiter par batchs de BATCH_SIZE
    const allDocs = candidates.filter(d => d.accountId != null);
    for (let i = 0; i < allDocs.length; i += BATCH_SIZE) {
      const batch = allDocs.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (doc) => {
          if (!doc.accountId) return;
          try {
            analyzeFileSources([doc.id], doc.accountId, {
              billable: false,
              origin: 'analysis-recovery',
            }).catch((err: Error) => {
              console.error(`[analysis-recovery] File ${doc.id} failed:`, err.message);
            });
            result.retried++;
          } catch (err) {
            console.error(`[analysis-recovery] Erreur relance file ${doc.id}:`, (err as Error).message);
            result.errors++;
          }
        }),
      );

      if (i + BATCH_SIZE < allDocs.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    console.info(`[analysis-recovery] Terminé — ${result.retried} relancé(s), ${result.errors} erreur(s).`);
  } catch (err) {
    console.error('[analysis-recovery] Erreur globale:', (err as Error).message);
  }
  // Le bail est rendu par `withJobLock`, y compris en cas d'exception.

  return result;
}
