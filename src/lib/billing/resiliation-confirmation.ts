/**
 * Texte de la fenêtre « Résilier votre abonnement ? » — lot 108F.
 *
 * Texte EXACT imposé par le ticket PO (03/11/2026). La fenêtre ne porte plus
 * ni la précision sur la conservation des biens et documents, ni la mention
 * sur la rétractation et le remboursement : la résiliation demandée est un
 * NON-RENOUVELLEMENT à l'échéance, pas une interruption immédiate. Les
 * informations contractuelles restent dans les CGUV, la carte « Droit de
 * rétractation » et la page Mon abonnement (inchangées).
 *
 * Sources de vérité (aucune valeur figée) :
 *   · offre   : `account_subscriptions.plan_code` (abonnement Stripe
 *               synchronisé), servi par `/api/billing/trial-status`
 *               (`subscription.planCode`) ; à défaut, l'offre des droits
 *               (`plan`) si c'est une offre payante ;
 *   · date    : `account_subscriptions.current_period_end_at`
 *               (`subscription.currentPeriodEndAt`), la même échéance que
 *               celle à laquelle `stop-renewal` programme la fin ;
 *   · format  : `formatParisLongDate` (fr-FR, Europe/Paris, « 18 septembre 2027 »).
 *
 * Replis (choix par défaut à valider par le PO) — on ne fabrique rien et on
 * ne bloque jamais la résiliation :
 *   · date inconnue  → « … restera active jusqu’à la fin de la période en cours. »
 *   · offre inconnue → « Votre offre restera active … » (nom omis).
 *
 * Module pur, utilisable côté client.
 */
import { PLAN_LABELS, isPlanCode } from '@/lib/billing/plan-catalog';
import { formatParisLongDate } from '@/lib/account-lifecycle/retention-policy';

export const RESILIATION_CONFIRMATION = {
  title: 'Résilier votre abonnement ?',
  cancel: 'Garder mon abonnement',
  confirm: 'Confirmer la résiliation',
  /** Repli quand la date de fin de période n'est pas connue. */
  unknownEnd: 'jusqu’à la fin de la période en cours',
  secondLine: 'À cette date, votre abonnement prendra fin et ne sera pas renouvelé.',
} as const;

/** Nom commercial de l'offre résiliée (Standard, Premium, Premium Duo), ou `null`. */
export function resiliationOfferName(planCode: string | null | undefined, plan?: string | null): string | null {
  for (const raw of [planCode, plan]) {
    const code = (raw ?? '').trim().toLowerCase();
    if (isPlanCode(code)) return PLAN_LABELS[code];
  }
  return null;
}

/** Date de fin lisible (« 18 septembre 2027 », Europe/Paris), ou `null` si absente / invalide. */
export function resiliationEndDate(periodEndAt: string | null | undefined): string | null {
  if (!periodEndAt || Number.isNaN(Date.parse(periodEndAt))) return null;
  return formatParisLongDate(periodEndAt);
}

/** Les deux phrases du corps de la fenêtre, dans l'ordre. */
export function resiliationConfirmationLines(input: {
  planCode: string | null | undefined;
  plan?: string | null;
  periodEndAt: string | null | undefined;
}): [string, string] {
  const offre = resiliationOfferName(input.planCode, input.plan);
  const fin = resiliationEndDate(input.periodEndAt);
  const sujet = offre ? `Votre offre ${offre}` : 'Votre offre';
  const echeance = fin ? `jusqu’au ${fin}` : RESILIATION_CONFIRMATION.unknownEnd;
  return [`${sujet} restera active ${echeance}.`, RESILIATION_CONFIRMATION.secondLine];
}
