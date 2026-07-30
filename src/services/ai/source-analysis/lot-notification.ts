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

export interface LotNotificationInput {
  accountId: number;
  userId?: number;
  lotId: number;
  analysedCount: number;
  failedCount: number;
}

/**
 * Type de notification correspondant à l'issue du lot.
 *
 * Pure et exportée : c'est la seule règle de ce module, et elle décide de ce
 * que l'utilisateur lit.
 */
export function resolveLotNotificationType(
  analysedCount: number,
  failedCount: number,
): 'DOCUMENT_BATCH_COMPLETED' | 'DOCUMENT_BATCH_PARTIALLY_FAILED' | 'DOCUMENT_BATCH_FAILED' {
  if (analysedCount === 0) return 'DOCUMENT_BATCH_FAILED';
  if (failedCount > 0) return 'DOCUMENT_BATCH_PARTIALLY_FAILED';
  return 'DOCUMENT_BATCH_COMPLETED';
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

  // Un lot vide n'a rien produit à annoncer.
  if (input.analysedCount === 0 && input.failedCount === 0) return;

  try {
    await emit({
      type: resolveLotNotificationType(input.analysedCount, input.failedCount),
      recipientUserIds: [input.userId],
      accountId: input.accountId,
      entityType: 'document_lot',
      entityId: input.lotId,
      payload: {
        lotId: input.lotId,
        analysedCount: input.analysedCount,
        failedCount: input.failedCount,
      },
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
