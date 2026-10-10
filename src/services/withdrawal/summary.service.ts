/**
 * Récapitulatif contractuel affiché avant confirmation — CDC 6 §7.2, §7.3.
 *
 * Un seul constructeur, partagé par le parcours authentifié et le parcours
 * public : les deux doivent montrer exactement la même chose, faute de quoi
 * l'instantané figé à la confirmation dépendrait du chemin emprunté.
 */
import { db } from '@/db';
import { accountSubscriptions, invoices, users } from '@/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import type { EligibilityResult } from './eligibility.service';

export interface WithdrawalSummary {
  firstName: string;
  lastName: string;
  email: string;
  offerLabel: string;
  billingPeriodLabel: string;
  contractConcludedAt: string | null;
  /** Départ du délai : premier paiement (lot 32, PO-Q1). */
  paidAt: string | null;
  withdrawalDeadlineAt: string | null;
  deadlineDeferred: boolean;
  deadlineDeferralReason: string | null;
  /** Estimation en centimes (§7.2). */
  amountExpected: number | null;
  amountLabel: string;
  /**
   * Lot 32 (PO-Q2) : le compte et ses données sont supprimés IMMÉDIATEMENT à
   * la confirmation (plus de délai d'export de 30 jours). Figé dans
   * l'instantané de la déclaration : c'est ce qui a été annoncé.
   */
  accountDeletion: 'immediate';
  stripeSubscriptionId: string | null;
}

const OFFER_LABELS: Record<string, string> = {
  standard: 'Verebona Standard',
  premium: 'Verebona Premium',
  premium_duo: 'Verebona Premium Duo',
  premium_pro: 'Verebona Premium Pro',
};

function formatAmount(cents: number | null, currency = 'eur'): string {
  if (cents === null) return 'à déterminer';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/**
 * Estimation du montant remboursable.
 *
 * ⚠️ ESTIMATION, ET LE MOT COMPTE. Le §7.2 précise que « le système doit
 * éviter d'afficher un montant supérieur aux sommes réellement encaissées ».
 * Le montant définitif est calculé au traitement, depuis les paiements
 * Stripe réussis et non remboursés (`refund-calculator.ts`, lot 32).
 *
 * CDC lookup_key V4 (LK-21, LK-76, TC-56) : l'estimation part du PRIX
 * CONTRACTUEL de l'abonnement (écrit depuis l'objet Stripe), jamais du
 * catalogue de vente courant — après une hausse, un ancien abonné ne doit
 * pas se voir annoncer le nouveau tarif. Prix contractuel inconnu → aucune
 * estimation affichée (jamais une valeur devinée).
 */
export function estimateRefund(contractUnitAmountCents: number | null | undefined): number | null {
  return typeof contractUnitAmountCents === 'number' && contractUnitAmountCents > 0 ? contractUnitAmountCents : null;
}

export async function buildSummary(
  eligibility: EligibilityResult,
  identity: { userId: number | null; firstName?: string | null; lastName?: string | null; email?: string | null },
): Promise<WithdrawalSummary> {
  const contract = eligibility.contract;

  let firstName = identity.firstName ?? '';
  let lastName = identity.lastName ?? '';
  let email = identity.email ?? '';

  if (identity.userId) {
    const [user] = await db
      .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(users)
      .where(eq(users.id, identity.userId))
      .limit(1);
    if (user) {
      firstName = firstName || (user.firstName ?? '');
      lastName = lastName || (user.lastName ?? '');
      email = email || user.email;
    }
  }

  let planCode = contract?.planCode ?? null;
  let billingPeriod = contract?.billingPeriod ?? null;
  let contractAmount: number | null = null;

  if (contract?.subscriptionIdInternal) {
    const [sub] = await db
      .select({
        planCode: accountSubscriptions.planCode,
        billingPeriod: accountSubscriptions.billingPeriod,
        contractUnitAmountCents: accountSubscriptions.contractUnitAmountCents,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.id, contract.subscriptionIdInternal))
      .limit(1);
    planCode = planCode ?? sub?.planCode ?? null;
    billingPeriod = billingPeriod ?? sub?.billingPeriod ?? null;
    contractAmount = sub?.contractUnitAmountCents ?? null;
  }

  // À défaut de prix contractuel connu : dernier paiement réellement encaissé
  // sur cet abonnement (fondé sur les paiements concernés, LK-76).
  if (contractAmount === null && contract?.stripeSubscriptionId) {
    const [inv] = await db
      .select({ amount: invoices.amount })
      .from(invoices)
      .where(and(eq(invoices.stripeSubscriptionId, contract.stripeSubscriptionId), eq(invoices.status, 'paid')))
      .orderBy(desc(invoices.paidAt))
      .limit(1)
      .catch(() => []);
    contractAmount = inv?.amount ?? null;
  }

  const amountExpected = estimateRefund(contractAmount);

  return {
    firstName,
    lastName,
    email,
    offerLabel: OFFER_LABELS[planCode ?? ''] ?? 'Verebona',
    billingPeriodLabel: billingPeriod === 'yearly' ? 'annuelle' : billingPeriod === 'monthly' ? 'mensuelle' : '—',
    contractConcludedAt: contract?.contractConcludedAt.toISOString() ?? null,
    paidAt: contract?.paidAt.toISOString() ?? null,
    withdrawalDeadlineAt: contract?.withdrawalDeadlineAt.toISOString() ?? null,
    deadlineDeferred: contract?.deadlineDeferred ?? false,
    deadlineDeferralReason: contract?.deadlineDeferralReason ?? null,
    amountExpected,
    amountLabel: formatAmount(amountExpected),
    accountDeletion: 'immediate',
    stripeSubscriptionId: contract?.stripeSubscriptionId ?? null,
  };
}
