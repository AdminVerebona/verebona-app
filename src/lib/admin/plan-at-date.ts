/**
 * Rattachement d'un paiement à son offre — CDC Back-Office V1 SUB-009.
 *
 * La table `invoices` ne porte pas l'offre facturée. Elle est déduite de
 * l'historique des changements d'offre (`subscription_history`).
 */
/**
 * Offre en vigueur à une date, d'après l'historique des changements d'offre
 * (trié par date croissante). Sert à rattacher un paiement à son offre
 * (CDC BO SUB-009) : la table `invoices` ne porte pas l'offre.
 */
export function planAtDate(
  history: Array<{ createdAt: Date; oldTier: string | null; newTier: string }>,
  at: Date,
  currentPlan: string,
): string {
  let plan: string | null = null;
  for (const h of history) {
    if (h.createdAt.getTime() <= at.getTime()) plan = h.newTier;
    else {
      // Premier changement postérieur : l'offre d'avant est celle d'alors.
      if (plan === null) plan = h.oldTier ?? null;
      break;
    }
  }
  return plan ?? currentPlan;
}
