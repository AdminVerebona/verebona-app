/**
 * Statuts d'abonnement — modèle sans période de grâce (APP-FUNC-31).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS NOTIONS À NE PAS CONFONDRE
 *
 *   · compte ACCESSIBLE  : on peut s'y connecter, renouveler sa session,
 *     consulter et exporter (SessionService, login, refresh) ;
 *   · abonnement ACTIF   : une offre est en cours et facturée sans incident
 *     (statut ci-dessous) ;
 *   · droits d'ÉCRITURE  : décidés UNIQUEMENT par `entitlements.service`
 *     (`account_subscriptions.status`), contrôlés côté serveur.
 *
 * Un compte en impayé reste accessible mais n'a ni abonnement actif ni droit
 * d'écriture. Aucun délai ne maintient les droits normaux après un échec de
 * paiement : le délai de régularisation/conservation (J+90,
 * `accounts.unpaid_recovery_ends_at`) n'ouvre aucun droit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * accounts.subscription_status (contrainte `accounts_subscription_status_check`)
 *
 *   NONE       Aucun abonnement ni essai.                     → TRIALING, ACTIVE
 *              Droits : aucun (lecture seule).
 *   TRIALING   Essai Verebona (local, sans Stripe).           → ACTIVE, EXPIRED
 *              Droits : ceux de l'essai tant qu'il court.
 *   ACTIVE     Abonnement payé à jour.                        → PAST_DUE, CANCELED,
 *              Droits : ceux de l'offre.                        EXPIRED, WITHDRAWN
 *   CANCELED   Résiliation programmée en fin de période : l'offre reste
 *              acquise jusqu'à la fin de la période payée.    → ACTIVE, EXPIRED, PAST_DUE
 *   PAST_DUE   IMPAYÉ. Attribué dès le premier échec de paiement (webhook
 *              `invoice.payment_failed`, ou abonnement Stripe `past_due`).
 *              Droits : mode restreint immédiat (consultation, export,
 *              transmission) ; cycle J0 → J+90 (`unpaid_started_at`,
 *              `unpaid_recovery_ends_at`).               → ACTIVE (régularisation),
 *                                                          EXPIRED (fin Stripe),
 *                                                          suppression à J+90 (balayage)
 *   EXPIRED    Abonnement terminé (Stripe canceled / unpaid / incomplete_expired).
 *              Droits : lecture seule.                        → ACTIVE (nouvelle souscription)
 *   WITHDRAWN  Rétractation exercée : lecture et export 30 jours.
 *              Droits : lecture seule ; aucun webhook ne les rend.
 *
 * Retirés par la migration 0250 : PAST_DUE_GRACE (ancienne grâce de 15 j,
 * droits maintenus — contraire à la règle) et UNPAID_RECOVERY sur le compte
 * (recopie du statut Duo), tous deux devenus PAST_DUE.
 *
 * duo_accounts.subscription_status : ACTIVE | UNPAID_RECOVERY | CANCELED
 *   UNPAID_RECOVERY  Impayé Duo, dès le premier échec : mêmes restrictions
 *                    (droits du compte payeur, `past_due`), mais le membre
 *                    reste membre pour RÉCUPÉRER ses biens (déplacement,
 *                    copie, sortie) jusqu'à `unpaid_recovery_ends_at`.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Statuts de compte d'un abonnement en cours, sans incident de paiement. */
const ACTIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'TRIALING']);

/**
 * L'abonnement du compte est-il actif (offre en cours, aucun impayé) ?
 * Ne dit RIEN de l'accès au compte (un impayé reste accessible) ni des droits
 * d'écriture (entitlements). Sert aux indications de session et d'affichage.
 */
export function hasActiveSubscriptionStatus(status: string | null | undefined): boolean {
  return ACTIVE_SUBSCRIPTION_STATUSES.has((status ?? '').toUpperCase());
}

/** Le compte est-il en impayé (cycle de régularisation en cours) ? */
export function isUnpaidAccountStatus(status: string | null | undefined): boolean {
  return (status ?? '').toUpperCase() === 'PAST_DUE';
}

/**
 * Statuts qui interdisent d'ouvrir une NOUVELLE souscription Checkout : un
 * abonnement est déjà en cours, ou un impayé doit être régularisé (portail
 * de facturation) plutôt que doublé par un second abonnement.
 */
export function blocksNewCheckout(status: string | null | undefined): boolean {
  const s = (status ?? '').toUpperCase();
  return ACTIVE_SUBSCRIPTION_STATUSES.has(s) || s === 'PAST_DUE';
}

/** Impayé Duo : restreint, récupération des biens ouverte au membre. */
export function isDuoUnpaidStatus(status: string | null | undefined): boolean {
  return (status ?? '').toUpperCase() === 'UNPAID_RECOVERY';
}

/**
 * Un Duo peut-il accueillir un second utilisateur ? Seulement s'il est à
 * jour : rejoindre un espace est une écriture, refusée pendant un impayé.
 */
export function isDuoJoinable(status: string | null | undefined): boolean {
  return (status ?? '').toUpperCase() === 'ACTIVE';
}
