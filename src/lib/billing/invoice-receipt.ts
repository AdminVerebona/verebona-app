/**
 * Lot 79C — le reçu de paiement Stripe couvre-t-il un renouvellement ?
 *
 * `receipt_number` n'est attribué à une facture que lorsque Stripe émet un
 * reçu de paiement (réglage Stripe « e-mails de paiement réussi »). Présent :
 * l'e-mail générique « Abonnement renouvelé » de Verebona ferait doublon.
 * Absent : l'e-mail générique reste envoyé (variante prudente).
 */
export function invoiceReceiptCovered(invoice: { receipt_number?: string | null } | null | undefined): boolean {
  const n = invoice?.receipt_number;
  return typeof n === 'string' && n.trim() !== '';
}
