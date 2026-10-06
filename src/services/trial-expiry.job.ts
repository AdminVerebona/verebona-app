/**
 * Fin des essais de 7 jours arrivés à échéance sans souscription (CDC §3.5).
 *
 * Traitement partagé par GET /api/cron/expire-trials et la tâche planifiée
 * interne `expire-trials` (lot 25).
 *
 * Aucun paiement n'est déclenché, aucun compte n'est supprimé : seul le statut
 * d'abonnement passe en lecture seule. Sûr en double exécution : la bascule
 * est un seul `UPDATE … WHERE status = 'trialing' RETURNING`, donc deux
 * passages simultanés se partagent des comptes DISJOINTS, et la notification
 * de fin d'essai est dédupliquée par compte (`dedupeKey`).
 */
import { expireOverdueTrials } from '@/services/trial.service';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';
import { emit } from '@/lib/notifications';

export async function runTrialExpiry(now: Date = new Date()): Promise<{ expired: number }> {
  const { expired, accountIds } = await expireOverdueTrials(now);

  for (const accountId of accountIds) {
    void trackFunnelEvent({ event: 'expired_without_conversion', accountId });
    // Fin d'essai (configurable, cloche + email par défaut, CDC §7.6).
    void emit({
      type: 'TRIAL_ENDED',
      accountId,
      entityType: 'account',
      entityId: accountId,
      payload: {},
      dedupeKey: `account:trial-ended:${accountId}`,
    }).catch((err) => console.error('[expire-trials] emit TRIAL_ENDED échoué:', err));
  }

  if (expired > 0) {
    console.info(`[expire-trials] ${expired} essai(s) basculé(s) en mode restreint`);
  }
  return { expired };
}
