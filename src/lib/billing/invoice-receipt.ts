/**
 * Communication d'un RENOUVELLEMENT d'abonnement — lot 79C, règle refondue
 * au lot 81E.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `receipt_number` N'EST PAS UNE PREUVE DE LIVRAISON
 *
 * Le lot 79C supprimait l'e-mail « Abonnement renouvelé » dès que la facture
 * Stripe portait un `receipt_number`. Ce numéro dit seulement qu'un reçu a été
 * NUMÉROTÉ : ni qu'il a été envoyé (le réglage « e-mails de paiement réussi »
 * de Stripe n'est pas lisible par l'API), ni qu'il a été reçu. Il n'est plus
 * utilisé pour décider d'une communication.
 *
 * RÈGLE EXPLICITE, PAR TYPE DE RENOUVELLEMENT (variante prudente)
 *
 *   · premier paiement (`subscription_create`) : pas de « renouvellement » —
 *     l'activation a sa propre communication (confirmation contractuelle
 *     durable, `subscription-communications.service`) ;
 *   · renouvellement mensuel ou annuel (`subscription_cycle`) : notification
 *     « Abonnement renouvelé » dans la cloche ; e-mail selon la préférence
 *     « Compte et abonnement » ; JAMAIS de push (lot 79C). Le message porte
 *     l'offre, la formule, la prochaine échéance et l'accès aux justificatifs
 *     (Mon compte › Offres) : il n'est pas l'équivalent d'un reçu de paiement ;
 *   · renouvellement annuel : le rappel J−7 (file durable, lot 68C / 72F) et
 *     les informations de changement tarifaire (revalorisation) sont
 *     inchangés.
 *
 * Responsabilités : Stripe émet ses reçus de paiement selon SON réglage
 * (tableau de bord Stripe) ; Verebona ne présume jamais de leur envoi. Si le
 * PO constate que les reçus Stripe sont actifs et veut éviter deux e-mails
 * mensuels, la décision est explicite et tracée : BO › Communications,
 * désactiver le canal e-mail de « Abonnement renouvelé » — jamais une
 * déduction automatique.
 * ══════════════════════════════════════════════════════════════════════════
 */

interface RenewalInvoice {
  id?: string | null;
  billing_reason?: string | null;
  lines?: { data?: Array<{ period?: { end?: number | null } | null } | null> } | null;
  period_end?: number | null;
}

/** Fin de la période ouverte par ce renouvellement (prochaine échéance). */
function renewalNextDate(invoice: RenewalInvoice | null | undefined): Date | null {
  const ends = (invoice?.lines?.data ?? [])
    .map((l) => l?.period?.end)
    .filter((v): v is number => typeof v === 'number' && v > 0);
  const end = ends.length ? Math.max(...ends) : null;
  return end ? new Date(end * 1000) : null;
}

/** Charge utile de la notification « Abonnement renouvelé » (pure). */
export function renewalNotificationPayload(
  invoice: RenewalInvoice | null | undefined,
  p: { planCode: string; billingPeriod?: 'monthly' | 'yearly' | null },
): { planCode: string; billingPeriod?: 'monthly' | 'yearly'; nextRenewalAt?: string; invoiceId?: string } {
  const next = renewalNextDate(invoice);
  return {
    planCode: p.planCode,
    ...(p.billingPeriod ? { billingPeriod: p.billingPeriod } : {}),
    ...(next ? { nextRenewalAt: next.toISOString() } : {}),
    ...(invoice?.id ? { invoiceId: invoice.id } : {}),
  };
}
