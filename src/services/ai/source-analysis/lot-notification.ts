/**
 * Notification de fin de lot — CDC notifications §7.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE NOTIFICATION PAR LOT, JAMAIS PAR DOCUMENT
 *
 * C'est la règle du §7.2, et elle a une raison concrète : un utilisateur qui
 * dépose vingt documents ne doit pas recevoir vingt notifications. Le lot 0
 * a d'ailleurs supprimé la route `notify-analyzed` pour cette raison — elle
 * en créait une par fichier.
 *
 * L'ancien pipeline émettait cette notification de lot. Le nouveau l'avait
 * perdue : basculer sans ce module aurait rendu l'analyse muette, sans que
 * rien ne le signale.
 *
 * ── LA CLÉ DE DÉDUPLICATION EST STABLE ────────────────────────────────────
 *
 * Elle porte l'identifiant du lot, pas un horodatage. C'est ce qui distingue
 * une notification de la route supprimée au lot 0, dont la clé valait
 * `Date.now()` : deux exécutions du même lot — reprise, rejeu — produisaient
 * deux notifications.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { emit } from '@/lib/notifications';
import { LOT_DOCUMENTS_MAX, lotNotificationPayload, type LotDocument } from './lot-notification-text';

export { lotNotificationPayload, lotNotificationText, type LotDocument } from './lot-notification-text';

export interface LotNotificationInput {
  accountId: number;
  userId?: number;
  lotId: number;
  analysedCount: number;
  failedCount: number;
  /** Documents analysés ; relus en base s'ils ne sont pas fournis. */
  documents?: LotDocument[];
}

/**
 * Documents analysés d'un lot, avec leur titre retenu. Ne lève jamais :
 * sans titres, la notification reste émise, simplement moins précise.
 */
export async function loadLotDocuments(lotId: number): Promise<LotDocument[]> {
  try {
    const { db } = await import('@/db');
    const rows = await db.$client<{ assetFileId: number; title: string | null }[]>`
      SELECT li.asset_file_id AS "assetFileId",
             COALESCE(NULLIF(af.retained_title, ''), NULLIF(af.original_filename, ''), af.filename) AS title
      FROM document_lot_items li
      JOIN asset_files af ON af.id = li.asset_file_id
      WHERE li.lot_id = ${lotId} AND li.analysis_status = 'completed' AND af.deleted_at IS NULL
      ORDER BY li.position ASC
      LIMIT ${LOT_DOCUMENTS_MAX + 1}
    `;
    return rows.filter((r) => r.title).map((r) => ({ assetFileId: r.assetFileId, title: r.title as string }));
  } catch (e) {
    console.warn(`[source-analysis] titres du lot ${lotId} non lus :`, (e as Error).message);
    return [];
  }
}

/**
 * Type de notification correspondant à l'issue du lot.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PLUS DE NOTIFICATION « ANALYSE IMPOSSIBLE »
 *
 * Elle était émise à tort dans deux cas fréquents :
 *   · un doublon détecté — il n'est pas compté comme analysé, et le lot
 *     passait pour un échec ;
 *   · un regroupement de fichiers — les fichiers secondaires manquaient au
 *     décompte et comptaient comme échecs.
 *
 * Et quand l'échec était réel, elle n'apportait rien d'actionnable : le
 * document affiche son état et peut être relancé depuis son tiroir. L'échec
 * reste journalisé côté serveur.
 *
 * Seule la réussite est donc annoncée. `null` : rien à émettre.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function resolveLotNotificationType(
  analysedCount: number,
  _failedCount: number,
): 'DOCUMENT_BATCH_COMPLETED' | null {
  return analysedCount > 0 ? 'DOCUMENT_BATCH_COMPLETED' : null;
}

/**
 * Émet la notification de fin de lot.
 *
 * NE LÈVE JAMAIS. L'analyse est terminée et les résultats sont écrits quand
 * cette fonction s'exécute : une notification perdue est un désagrément, une
 * analyse perdue une régression.
 */
export async function notifyLotCompleted(input: LotNotificationInput): Promise<void> {
  // Sans destinataire, il n'y a personne à prévenir — cas d'une analyse
  // déclenchée par une tâche planifiée.
  if (!input.userId) return;

  const type = resolveLotNotificationType(input.analysedCount, input.failedCount);
  if (!type) {
    if (input.failedCount > 0) {
      console.warn(
        `[source-analysis] lot ${input.lotId} : ${input.failedCount} échec(s), aucune notification émise.`,
      );
    }
    return;
  }

  try {
    await emit({
      type,
      recipientUserIds: [input.userId],
      accountId: input.accountId,
      entityType: 'document_lot',
      entityId: input.lotId,
      // Les échecs ne sont plus annoncés à l'utilisateur (failedCount: 0).
      payload: lotNotificationPayload(
        input.lotId,
        input.analysedCount,
        input.documents ?? await loadLotDocuments(input.lotId),
      ),
      // Stable : un rejeu du même lot ne produit pas une seconde
      // notification (§7.2, et défaut de la route supprimée au lot 0).
      dedupeKey: `document:lot-completed:${input.lotId}`,
    });
  } catch (e) {
    console.error(
      `[source-analysis] notification du lot ${input.lotId} non émise :`,
      (e as Error).message,
    );
  }
}
