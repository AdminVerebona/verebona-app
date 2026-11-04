/**
 * Faits lus pour décider de la notification de RÉUSSITE d'un lot — lot 108I
 * (décision pure : `lib/notifications/document-notification-policy.ts`).
 *
 *   firstSuccess     aucune exécution T1 réussie (`document_analysis_runs`
 *                    `completed`) du document créée AVANT l'ouverture du lot :
 *                    une réanalyse, une reprise ou une relance par la
 *                    cohérence (108B : relance T1 d'un justificatif sans
 *                    montant) d'un document déjà analysé n'est pas un premier
 *                    succès. La reprise d'un échec rattachée au lot d'origine
 *                    (`absorbed`) crée son exécution APRÈS ce lot : le lot
 *                    d'origine reste un premier succès ;
 *   userVisible      visibilité du traitement (lot 50, non-déclassement d'un
 *                    document jamais analysé) ; colonne absente : USER ;
 *   followedRecently suivi visible du demandeur plus récent que la fenêtre,
 *                    horloge de la base.
 * Illisible (migration absente, panne) : `null` — l'appelant garde le
 * comportement antérieur (notifier), jamais l'inverse.
 */
import { ANALYSIS_FOLLOW_FRESHNESS_SECONDS, type SuccessCandidate } from '@/lib/notifications/document-notification-policy';
import { analysisVisibilityColumnReady, userVisibleAnalysisSql } from '../processing-status/processing-visibility';

export interface LotSuccessFacts {
  followedRecently: boolean;
  byFile: Map<number, Pick<SuccessCandidate, 'firstSuccess' | 'userVisible'>>;
}

export async function readLotSuccessFacts(lotId: number, fileIds: number[]): Promise<LotSuccessFacts | null> {
  try {
    const { pgClient } = await import('@/db');
    const visible = userVisibleAnalysisSql('af', await analysisVisibilityColumnReady());
    const [lot] = await pgClient.unsafe<Array<{ followed: boolean }>>(
      `SELECT (followed_at IS NOT NULL AND followed_at > now() - make_interval(secs => $2)) AS followed
         FROM document_lots WHERE id = $1`,
      [lotId, ANALYSIS_FOLLOW_FRESHNESS_SECONDS] as never[]);
    const rows = fileIds.length === 0 ? [] : await pgClient.unsafe<Array<{ id: number; first_success: boolean; user_visible: boolean }>>(
      `SELECT af.id,
              NOT EXISTS (SELECT 1 FROM document_analysis_runs r
                           WHERE r.asset_file_id = af.id AND r.status = 'completed'
                             AND r.created_at < l.created_at) AS first_success,
              ${visible} AS user_visible
         FROM asset_files af
         JOIN document_lots l ON l.id = $1
        WHERE af.id = ANY($2::int[]) AND af.account_id = l.account_id`,
      [lotId, fileIds] as never[]);
    const byFile = new Map<number, Pick<SuccessCandidate, 'firstSuccess' | 'userVisible'>>();
    for (const r of rows) byFile.set(Number(r.id), { firstSuccess: Boolean(r.first_success), userVisible: Boolean(r.user_visible) });
    return { followedRecently: Boolean(lot?.followed), byFile };
  } catch (e) {
    console.warn(`[source-analysis] faits de notification du lot ${lotId} illisibles — comportement antérieur :`, (e as Error).message);
    return null;
  }
}

/** Trace le motif d'un résultat non notifié. Ne lève jamais. */
export async function traceLotSkipReason(lotId: number, reason: string): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(`UPDATE document_lots SET notification_skip_reason = $2 WHERE id = $1`, [lotId, reason] as never[]);
  } catch (e) {
    console.warn(`[source-analysis] motif du lot ${lotId} non tracé :`, (e as Error).message);
  }
}
