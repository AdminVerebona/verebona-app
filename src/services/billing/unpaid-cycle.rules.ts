/**
 * Cycle d'impayé de 90 jours — règles pures (Centre d'aide GAP-06, articles
 * AID-BILL-008 « Que se passe-t-il après un échec de paiement ? » et
 * AID-TRANSFER-006 « Récupérer ses données quand le compte est restreint »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE CIBLE VALIDÉE (texte de AID-BILL-008)
 *
 *   J0          Échec de paiement : suspension immédiate des fonctions
 *               normales et payantes ; accès au compte conservé.
 *   J0 → J+90   Régularisation possible. Consultation, export/récupération
 *               et transmission des biens restent accessibles.
 *   Régularisation : les droits normaux reprennent après confirmation du
 *               paiement.
 *   J+90        Sans régularisation : accès retiré et suppression des
 *               données métier/utilisateur (hors données à conserver
 *               légalement ; sauvegardes selon leur rotation normale).
 *
 * Ne pas confondre avec les 30 jours d'export après une rétractation.
 *
 * LECTURES RETENUES LÀ OÙ LE TEXTE NE TRANCHE PAS (lecture prudente)
 *
 *   · Relances : le texte exige des notifications sans en fixer le
 *     calendrier. Retenu : J0 (incident de paiement, avec l'échéance), puis
 *     J-7 et J-1 avant la suppression — le calendrier des rappels déjà en
 *     vigueur pour les suppressions programmées (CDC rétractation §13.3).
 *   · J0 = premier échec de paiement non régularisé. Les nouvelles
 *     tentatives Stripe du même cycle ne repoussent PAS l'échéance.
 *   · À J+90, la suppression n'est engagée qu'après revérification chez
 *     Stripe : un paiement encaissé mais non synchronisé annule la
 *     suppression (resynchronisation) au lieu de détruire les données d'un
 *     client à jour. Stripe injoignable : report au passage suivant.
 *   · Un compte faisant déjà l'objet d'une suppression programmée pour un
 *     autre motif (rétractation, demande volontaire) ou rétracté n'est pas
 *     supprimé par ce cycle : la procédure déjà annoncée s'applique.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Durée du cycle, en jours (AID-BILL-008). */
export const UNPAID_CYCLE_DAYS = 90;

/** Rappels avant suppression, en jours restants. */
export const UNPAID_REMINDER_DAYS_BEFORE = [7, 1] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type UnpaidReminderStage = 'J-7' | 'J-1';

export type UnpaidStep =
  | { kind: 'none' }
  | { kind: 'reminder'; stage: UnpaidReminderStage }
  | { kind: 'expired' };

export interface UnpaidCycleState {
  startedAt: Date;
  deadlineAt: Date;
  /** Jours restants avant l'échéance, arrondis au jour supérieur (0 si échue). */
  daysLeft: number;
  step: UnpaidStep;
}

/** Échéance J+90 d'un cycle commencé à `startedAt`. */
export function unpaidDeadline(startedAt: Date): Date {
  return new Date(startedAt.getTime() + UNPAID_CYCLE_DAYS * DAY_MS);
}

/**
 * Étape du cycle à la date `now`. Pure.
 *
 *   - échéance atteinte              → `expired` (suppression à engager) ;
 *   - 1 jour ou moins avant          → rappel J-1 ;
 *   - 7 jours ou moins avant         → rappel J-7 ;
 *   - sinon                          → rien (J0 notifié par le webhook).
 *
 * Un rappel manqué (cron interrompu) n'est pas rattrapé si une étape plus
 * proche est due : on n'envoie pas « J-7 » la veille de la suppression.
 */
export function computeUnpaidCycle(
  startedAt: Date,
  now: Date,
  /** Échéance enregistrée (migration 0182 : report des cycles antérieurs). */
  storedDeadlineAt?: Date | null,
): UnpaidCycleState {
  const deadlineAt = storedDeadlineAt ?? unpaidDeadline(startedAt);
  const remainingMs = deadlineAt.getTime() - now.getTime();
  const daysLeft = remainingMs <= 0 ? 0 : Math.ceil(remainingMs / DAY_MS);

  let step: UnpaidStep = { kind: 'none' };
  if (remainingMs <= 0) step = { kind: 'expired' };
  else if (daysLeft <= 1) step = { kind: 'reminder', stage: 'J-1' };
  else if (daysLeft <= 7) step = { kind: 'reminder', stage: 'J-7' };

  return { startedAt, deadlineAt, daysLeft, step };
}

/** Statuts d'abonnement Stripe qui prouvent une régularisation. */
const REGULARIZED_STRIPE_STATUSES = new Set(['active', 'trialing']);
/** Statuts Stripe encore facturables : à résilier avant de supprimer. */
const STILL_BILLING_STRIPE_STATUSES = new Set(['past_due', 'unpaid', 'incomplete']);

/**
 * Décision à l'échéance d'après les abonnements Stripe du client. Pure.
 *   - un abonnement actif ou en essai → `regularized` (resynchroniser) ;
 *   - sinon → `delete`, en résiliant d'abord ceux qui facturent encore
 *     (un client supprimé ne doit plus être prélevé).
 */
export function decideAtDeadline(stripeSubscriptions: Array<{ id: string; status: string }>):
  | { action: 'regularized'; subscriptionId: string }
  | { action: 'delete'; cancelFirst: string[] } {
  const paid = stripeSubscriptions.find((s) => REGULARIZED_STRIPE_STATUSES.has(s.status));
  if (paid) return { action: 'regularized', subscriptionId: paid.id };
  return {
    action: 'delete',
    cancelFirst: stripeSubscriptions.filter((s) => STILL_BILLING_STRIPE_STATUSES.has(s.status)).map((s) => s.id),
  };
}

/** Date lisible (fuseau Paris) pour les messages. */
export function formatUnpaidDeadline(deadlineAt: Date | string): string {
  const d = typeof deadlineAt === 'string' ? new Date(deadlineAt) : deadlineAt;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
}

/** Message de refus d'écriture pendant le cycle (403 SUBSCRIPTION_REQUIRED). */
export function unpaidRestrictionMessage(deadlineAt: Date | null): string {
  const date = deadlineAt ? formatUnpaidDeadline(deadlineAt) : '';
  return (
    'Un paiement a échoué : les fonctions de votre compte sont suspendues. ' +
    'Vos biens et documents restent consultables, exportables et transmissibles. ' +
    (date
      ? `Régularisez votre paiement avant le ${date} pour retrouver l'usage normal ; sans régularisation, vos données seront supprimées à cette date.`
      : "Régularisez votre paiement pour retrouver l'usage normal.")
  );
}
