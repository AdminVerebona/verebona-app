/**
 * Lot 102A — cycle de vie des comptes : ÉTAT RESTREINT, conservation, purge.
 *
 * Module PUR (aucun import serveur) : partagé par les services, le BO, les
 * écrans (bandeau « Lecture seule jusqu'au … ») et les tests. C'est le SEUL
 * endroit où vivent les durées du cycle de vie (aucune règle métier en dur
 * ailleurs).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISIONS PO (ticket « Conformité légale », 31/10/2026)
 *
 *   Motif                 Entrée                          Suppression programmée
 *   FIN_ESSAI             fin des 7 jours sans souscription   entrée + 90 jours
 *   FIN_ABONNEMENT        fin effective de la période payée   entrée + 90 jours
 *   RETRACTATION          rétractation traitée                entrée + 90 jours
 *   SUPPRESSION_DEMANDEE  demande explicite de l'utilisateur  au plus tôt (délai
 *                                                             court, plafond
 *                                                             technique 30 jours)
 *
 * Pendant l'état restreint : lecture et export autorisés ; aucune écriture
 * métier ; aucun traitement IA (règle unique des droits, `entitlements` et
 * `processing-eligibility`). Une (re)souscription avant l'échéance ANNULE la
 * purge (trois premiers motifs). La suppression volontaire s'annule depuis
 * l'écran « Compte en cours de suppression ».
 *
 * Le motif est porté par le compte à rebours de suppression existant
 * (`scheduled_account_deletions`, moteur unique de purge) : la date d'entrée
 * est `confirmed_at`, la date de suppression `scheduled_at` (figée, jamais
 * recalculée). Correspondance des codes : `DELETION_REASON_OF`.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const RESTRICTED_REASONS = ['FIN_ESSAI', 'FIN_ABONNEMENT', 'RETRACTATION', 'SUPPRESSION_DEMANDEE'] as const;
export type RestrictedReason = (typeof RESTRICTED_REASONS)[number];

/** Motif technique du compte à rebours (`scheduled_account_deletions.reason`). */
export type LifecycleDeletionReason = 'TRIAL_ABANDONED' | 'SUBSCRIPTION_ENDED' | 'WITHDRAWAL' | 'VOLUNTARY';

export const DELETION_REASON_OF: Readonly<Record<RestrictedReason, LifecycleDeletionReason>> = {
  FIN_ESSAI: 'TRIAL_ABANDONED',
  FIN_ABONNEMENT: 'SUBSCRIPTION_ENDED',
  RETRACTATION: 'WITHDRAWAL',
  SUPPRESSION_DEMANDEE: 'VOLUNTARY',
};

export function restrictedReasonOf(deletionReason: string | null | undefined): RestrictedReason | null {
  const hit = (Object.entries(DELETION_REASON_OF) as Array<[RestrictedReason, string]>).find(([, d]) => d === deletionReason);
  return hit ? hit[0] : null;
}

/**
 * Durées du cycle de vie — LES SEULES valeurs du dépôt (constantes
 * documentées, docs/exploitation/cycle-de-vie-comptes.md). Une évolution
 * passe par une décision PO et une livraison : la durée de conservation est
 * annoncée dans les textes publics (CGUV, Confidentialité).
 */
export const LIFECYCLE_DURATIONS = Object.freeze({
  /** Conservation en lecture seule (fin d'essai, fin d'abonnement, rétractation). */
  restrictedRetentionDays: 90,
  /**
   * Suppression volontaire : délai court avant la suppression active (le
   * temps d'annuler une erreur et de télécharger ses données). Ce n'est PAS
   * une durée de conservation : la suppression part au premier passage du
   * balayage après ce délai.
   */
  voluntaryDeletionDelayHours: 24,
  /** Plafond technique de la suppression volontaire (reprises d'échec comprises). */
  voluntaryDeletionMaxDays: 30,
  /** Rappel e-mail avant la purge d'un essai (J+80 = 90 − 10). */
  trialPurgeReminderDaysBefore: 10,
  /**
   * Comptes DÉJÀ en lecture seule avant la livraison de la purge (rattrapage) :
   * jamais de suppression sans un préavis minimal à compter de la
   * programmation (aucun titulaire n'avait été prévenu d'une date).
   */
  backfillMinNoticeDays: 30,
  /**
   * Rappel J−7 de la suppression volontaire : envoyé seulement si le délai
   * annoncé le permet (délai ≥ 7 jours — anciennes demandes à J+30).
   */
  voluntaryReminderMinDelayDays: 7,
  /**
   * Registre des suppressions exécutées (rejeu après restauration) : conservé
   * le temps de rotation des sauvegardes + marge, puis purgé.
   */
  deletionRegistryMarginDays: 7,
  /** Purge en retard au-delà de ce délai après l'échéance : anomalie de Supervision. */
  overdueToleranceHours: 24,
});

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Échéance du rappel J+80 (jours après la fin d'essai), dérivée de la conservation. */
export function trialPurgeReminderOffsetDays(): number {
  return LIFECYCLE_DURATIONS.restrictedRetentionDays - LIFECYCLE_DURATIONS.trialPurgeReminderDaysBefore;
}

/** Délai de la suppression volontaire, borné par le plafond technique. */
export function voluntaryDeletionDelayMs(): number {
  const ms = Math.max(0, LIFECYCLE_DURATIONS.voluntaryDeletionDelayHours) * HOUR_MS;
  return Math.min(ms, LIFECYCLE_DURATIONS.voluntaryDeletionMaxDays * DAY_MS);
}

/**
 * Date de suppression programmée pour une entrée en état restreint.
 *
 * `minNoticeFrom` (rattrapage) : la date n'est jamais antérieure à
 * `minNoticeFrom + backfillMinNoticeDays` — un compte déjà restreint avant la
 * livraison n'est jamais purgé sans préavis.
 */
export function purgeDateFor(reason: RestrictedReason, enteredAt: Date, opts: { minNoticeFrom?: Date } = {}): Date {
  const base = reason === 'SUPPRESSION_DEMANDEE'
    ? enteredAt.getTime() + voluntaryDeletionDelayMs()
    : enteredAt.getTime() + LIFECYCLE_DURATIONS.restrictedRetentionDays * DAY_MS;
  if (!opts.minNoticeFrom || reason === 'SUPPRESSION_DEMANDEE') return new Date(base);
  return new Date(Math.max(base, opts.minNoticeFrom.getTime() + LIFECYCLE_DURATIONS.backfillMinNoticeDays * DAY_MS));
}

/** La purge de ce motif est-elle annulée par une (re)souscription ? */
export function cancelledBySubscription(reason: RestrictedReason): boolean {
  return reason !== 'SUPPRESSION_DEMANDEE';
}

/** Jours restants avant la suppression (arrondi supérieur, jamais négatif). */
export function daysUntilPurge(purgeAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((purgeAt.getTime() - now.getTime()) / DAY_MS));
}

/** Le rappel J−7 d'une suppression volontaire a-t-il un sens pour ce délai ? */
export function voluntaryReminderApplies(confirmedAt: Date, scheduledAt: Date): boolean {
  return scheduledAt.getTime() - confirmedAt.getTime() >= LIFECYCLE_DURATIONS.voluntaryReminderMinDelayDays * DAY_MS;
}

/** Une suppression volontaire dépasse-t-elle le plafond technique (anomalie) ? */
export function voluntaryCeilingExceeded(confirmedAt: Date, now: Date): boolean {
  return now.getTime() - confirmedAt.getTime() > LIFECYCLE_DURATIONS.voluntaryDeletionMaxDays * DAY_MS;
}

/** Libellés d'interface (factuels, sans formulation juridique). */
export const RESTRICTED_REASON_LABELS: Readonly<Record<RestrictedReason, string>> = {
  FIN_ESSAI: 'Fin de l’essai gratuit',
  FIN_ABONNEMENT: 'Fin de l’abonnement',
  RETRACTATION: 'Rétractation',
  SUPPRESSION_DEMANDEE: 'Suppression demandée',
};

/** Phrase courte du bandeau « Mon compte » pour chaque motif. */
export const RESTRICTED_REASON_BANNER: Readonly<Record<Exclude<RestrictedReason, 'SUPPRESSION_DEMANDEE'>, string>> = {
  FIN_ESSAI: 'Votre essai gratuit est terminé.',
  FIN_ABONNEMENT: 'Votre abonnement est terminé.',
  RETRACTATION: 'Votre rétractation a été prise en compte : l’abonnement est annulé et remboursé.',
};

/** Date courte à Paris (« 29 janvier 2027 »). */
export function formatParisLongDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' }).format(date);
}

/** Délai de la suppression volontaire en mots simples (« sous 24 heures »). */
export function voluntaryDelayLabel(): string {
  const h = voluntaryDeletionDelayMs() / HOUR_MS;
  if (h <= 0) return 'dès le prochain traitement';
  if (h < 48) return `sous ${Math.round(h)} heures`;
  return `sous ${Math.round(h / 24)} jours`;
}
