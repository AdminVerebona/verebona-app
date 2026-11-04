/**
 * Suivi de l'analyse dans l'application — lot 108I (voir
 * `lib/notifications/document-notification-policy.ts`).
 *
 * La relève VISIBLE du bandeau d'analyse date le suivi des lots en attente
 * qui contiennent le document. Bornes de sécurité :
 *   · compte de la session uniquement (`account_id`) ;
 *   · lots dont l'utilisateur de la session est le DESTINATAIRE
 *     (`notification_user_id`) : suivre le document d'un autre membre d'un
 *     espace partagé ne lui retire pas sa notification ;
 *   · lots encore en attente seulement (un résultat déjà réglé est figé) ;
 *   · aucune donnée renvoyée (ni existence, ni nombre de lots).
 * Ne lève jamais : le suivi ne doit pas faire échouer la relève.
 */
import { ANALYSIS_FOLLOW_WRITE_THROTTLE_SECONDS } from '@/lib/notifications/document-notification-policy';

/** SQL de l'écriture du suivi (pur, testé). */
export const MARK_ANALYSIS_FOLLOWED_SQL = `UPDATE document_lots l
    SET followed_at = now()
  WHERE l.account_id = $1
    AND l.notification_user_id = $2
    AND l.notification_state = 'awaiting'
    AND (l.followed_at IS NULL OR l.followed_at < now() - make_interval(secs => $4))
    AND EXISTS (SELECT 1 FROM document_lot_items li WHERE li.lot_id = l.id AND li.asset_file_id = $3)`;

export async function markAnalysisFollowed(input: { accountId: number; userId: number; assetFileId: number }): Promise<void> {
  const { accountId, userId, assetFileId } = input;
  if (![accountId, userId, assetFileId].every((n) => Number.isInteger(n) && n > 0)) return;
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(MARK_ANALYSIS_FOLLOWED_SQL, [accountId, userId, assetFileId, ANALYSIS_FOLLOW_WRITE_THROTTLE_SECONDS] as never[]);
  } catch (e) {
    // Migration 1080 absente ou base indisponible : la notification partira
    // (comportement antérieur), jamais l'inverse.
    console.warn('[analysis-follow] suivi non enregistré :', (e as Error).message);
  }
}
