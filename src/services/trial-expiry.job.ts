/**
 * Fin des essais de 7 jours arrivés à échéance sans souscription (CDC §3.5).
 *
 * Traitement partagé par GET /api/cron/expire-trials et la tâche planifiée
 * interne `expire-trials` (lot 25).
 *
 * Aucun paiement n'est déclenché, aucun compte n'est supprimé : seul le statut
 * d'abonnement passe en lecture seule. Lot 102A : la purge est PROGRAMMÉE à
 * fin d'essai + 90 jours (état restreint FIN_ESSAI, `restricted-state`),
 * annulée par une souscription ; les comptes déjà en lecture seule avant la
 * livraison sont rattrapés au même passage (préavis minimal). Sûr en double exécution : la bascule
 * est un seul `UPDATE … WHERE status = 'trialing' RETURNING`, donc deux
 * passages simultanés se partagent des comptes DISJOINTS, et la notification
 * de fin d'essai est dédupliquée par compte (`dedupeKey`).
 */
import { expireOverdueTrials } from '@/services/trial.service';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';
import { emit } from '@/lib/notifications';

export async function runTrialExpiry(now: Date = new Date()): Promise<{ expired: number; purgesScheduled: number }> {
  const { expired, accountIds } = await expireOverdueTrials(now);

  // Lot 82A (C-Q10, §3.3) : fin des 7 jours d'essai sans souscription — plus
  // aucun traitement métier ; travaux en attente ou en cours neutralisés tout
  // de suite (la mise en file et l'exécution le vérifient de toute façon).
  const { syncAccountEligibilitySafe } = await import('@/services/account/processing-lifecycle');
  for (const accountId of accountIds) {
    await syncAccountEligibilitySafe(accountId, 'trial_expiry');
  }

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

  // Lot 102A : purge J+90 programmée (essais de ce passage et rattrapage).
  let purgesScheduled = 0;
  try {
    const { scheduleTrialPurges } = await import('@/services/account/restricted-state.service');
    purgesScheduled = (await scheduleTrialPurges({ now })).scheduled;
    if (purgesScheduled > 0) console.info(`[expire-trials] ${purgesScheduled} purge(s) de fin d'essai programmée(s)`);
  } catch (e) {
    console.error('[expire-trials] programmation des purges de fin d’essai impossible :', (e as Error).message);
  }
  return { expired, purgesScheduled };
}
