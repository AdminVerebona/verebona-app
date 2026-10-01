/**
 * Libellés des notifications de quota d'analyses (ANALYSIS_QUOTA_90 / _100).
 *
 * Le quota d'analyses n'est PAS mensuel : `account_analysis_counters` porte un
 * compteur par période d'essai (`trial`) ou par période annuelle (`annual`),
 * dimensionné par `plan_limits.trial_analysis_quota` / `yearly_analysis_quota`
 * (cf. `services/commercial-model.service.ts`). L'ancien texte « ce mois-ci »
 * annonçait donc une remise à zéro qui n'existe pas.
 *
 * Source unique pour la cloche (`NotificationBell`) et le catalogue (push,
 * e-mail) : les deux affichaient le même texte en dur et divergeaient au
 * moindre changement.
 *
 * `periodType` est absent des notifications émises avant ce correctif : on
 * retombe alors sur une formulation neutre, vraie dans les deux cas.
 */

export type QuotaThreshold = 90 | 100;

function periodSuffix(periodType: unknown): string {
  return periodType === 'trial' ? 'pour votre période d\'essai' : 'dans votre offre';
}

/** Titre court (cloche, push). */
export function quotaNotificationTitle(threshold: QuotaThreshold): string {
  return threshold === 100 ? 'Quota d\'analyses atteint' : 'Quota d\'analyses à 90 %';
}

/** Phrase principale, sans point final. */
export function quotaNotificationText(threshold: QuotaThreshold, periodType?: unknown): string {
  const suffixe = periodSuffix(periodType);
  return threshold === 100
    ? `Vous avez utilisé toutes les analyses incluses ${suffixe}`
    : `Vous avez utilisé 90 % des analyses incluses ${suffixe}`;
}
