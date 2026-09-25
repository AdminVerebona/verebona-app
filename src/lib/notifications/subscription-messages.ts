/**
 * Libellés des notifications d'abonnement — source unique, partagée par le
 * catalogue serveur (contenu stocké, push, email) et par la cloche (qui
 * recalcule le texte depuis le payload, y compris pour les lignes déjà en
 * base).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « NOUVELLE NOTIFICATION » → CE QUI A CHANGÉ
 *
 * La cloche n'avait aucun libellé pour SUBSCRIPTION_ACTIVATED / CHANGED /
 * RENEWED : elle affichait « Nouvelle notification » et renvoyait vers les
 * offres. Le texte dit désormais ce qui s'est passé et quelle est l'offre
 * obtenue, par exemple :
 *
 *   « Votre offre a été modifiée. Nouvelle offre : Premium »
 *
 * et s'adapte à l'événement (activation, changement, renouvellement,
 * changement programmé, résiliation) et à la formule (mensuelle/annuelle).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Types traités ici. Aucune de ces notifications n'est cliquable dans la cloche. */
export const SUBSCRIPTION_NOTIFICATION_TYPES = [
  'SUBSCRIPTION_ACTIVATED',
  'SUBSCRIPTION_CHANGED',
  'SUBSCRIPTION_CHANGE_SCHEDULED',
  'SUBSCRIPTION_RENEWED',
  'SUBSCRIPTION_CANCELLATION_SCHEDULED',
  'SUBSCRIPTION_CANCELLED',
] as const;

export function isSubscriptionNotification(type: string): boolean {
  return (SUBSCRIPTION_NOTIFICATION_TYPES as readonly string[]).includes(type);
}

const PLAN_LABELS: Record<string, string> = {
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  PREMIUM_DUO: 'Premium Duo',
  PREMIUM_PRO: 'Premium Pro',
};

export interface SubscriptionNotificationPayload {
  planCode?: string;
  planLabel?: string;
  billingPeriod?: string | null;
  previousPlanCode?: string;
  previousPlanLabel?: string;
  direction?: string;
  effectiveAt?: string;
}

/** Libellé d'offre : celui du payload, sinon déduit du code (`premium_duo` → « Premium Duo »). */
export function planLabelOf(p: SubscriptionNotificationPayload): string | null {
  if (p.planLabel) return p.planLabel;
  if (!p.planCode) return null;
  return PLAN_LABELS[p.planCode.toUpperCase()] ?? p.planCode;
}

function formule(billingPeriod: string | null | undefined): string {
  if (billingPeriod === 'monthly') return ' (formule mensuelle)';
  if (billingPeriod === 'yearly') return ' (formule annuelle)';
  return '';
}

function dateLongue(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris',
  });
}

/**
 * Texte de la notification, ou `null` si le type n'est pas un type
 * d'abonnement (l'appelant applique alors son propre libellé).
 */
export function subscriptionNotificationText(
  type: string,
  payload: SubscriptionNotificationPayload | null | undefined,
): string | null {
  const p = payload ?? {};
  const offre = planLabelOf(p);

  switch (type) {
    case 'SUBSCRIPTION_ACTIVATED':
      return offre
        ? `Votre offre a été activée. Nouvelle offre : ${offre}${formule(p.billingPeriod)}`
        : 'Votre offre a été activée.';
    case 'SUBSCRIPTION_CHANGED':
      return offre
        ? `Votre offre a été modifiée. Nouvelle offre : ${offre}${formule(p.billingPeriod)}`
        : 'Votre offre a été modifiée.';
    case 'SUBSCRIPTION_CHANGE_SCHEDULED': {
      const date = dateLongue(p.effectiveAt);
      const quand = date ? ` Prise d’effet le ${date}.` : ' Prise d’effet à votre prochaine échéance.';
      return offre
        ? `Changement d’offre programmé. Nouvelle offre : ${offre}${formule(p.billingPeriod)}.${quand}`
        : `Changement d’offre programmé.${quand}`;
    }
    case 'SUBSCRIPTION_RENEWED':
      return offre
        ? `Votre abonnement a été renouvelé. Offre : ${offre}`
        : 'Votre abonnement a été renouvelé.';
    case 'SUBSCRIPTION_CANCELLATION_SCHEDULED': {
      const date = dateLongue(p.effectiveAt);
      return date
        ? `La résiliation de votre abonnement est programmée au ${date}.`
        : 'La résiliation de votre abonnement est programmée.';
    }
    case 'SUBSCRIPTION_CANCELLED':
      return 'Votre abonnement a été résilié.';
    default:
      return null;
  }
}
