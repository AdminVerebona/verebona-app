/**
 * COM-008 — pertinence des contextes « Paiement » et « Rétractation » dans la
 * prévisualisation des communications. Module pur, partagé par le service et
 * l'écran (aucun accès base).
 */

/**
 * Contextes facultatifs proposés selon le modèle : le sélecteur « Paiement »
 * n'a de sens que pour les communications de facturation (abonnement,
 * paiement, essai, rétractation), « Rétractation » que pour la rétractation.
 * Pur.
 */
export function relevantPreviewContexts(eventCode: string, emailTemplateCode?: string | null): {
  payment: boolean;
  withdrawal: boolean;
} {
  const codes = [eventCode, emailTemplateCode ?? ''].map((c) => c.toUpperCase());
  const withdrawal = codes.some((c) => c.includes('WITHDRAWAL'));
  const payment =
    withdrawal ||
    codes.some((c) => /PAYMENT|INVOICE|SUBSCRIPTION|PREMIUM_CONFIRMATION|TRIAL|DOWNGRADE|ACCOUNT_READ_ONLY/.test(c));
  return { payment, withdrawal };
}
