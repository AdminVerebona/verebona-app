/**
 * Récapitulatif contractuel affiché avant confirmation — CDC 6 §7.2, §7.3.
 *
 * Un seul constructeur, partagé par le parcours authentifié et le parcours
 * public : les deux doivent montrer exactement la même chose, faute de quoi
 * l'instantané figé à la confirmation dépendrait du chemin emprunté.
 */
import { db } from '@/db';
import { accountSubscriptions, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { PRICE_CATALOG } from '@/lib/stripe-prices';
import type { EligibilityResult } from './eligibility.service';
import { DATA_RECOVERY_DAYS } from './withdrawal.service';

export interface WithdrawalSummary {
  firstName: string;
  lastName: string;
  email: string;
  offerLabel: string;
  billingPeriodLabel: string;
  contractConcludedAt: string | null;
  withdrawalDeadlineAt: string | null;
  deadlineDeferred: boolean;
  deadlineDeferralReason: string | null;
  /** Estimation en centimes (§7.2). */
  amountExpected: number | null;
  amountLabel: string;
  dataDeletionAt: string;
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
 * Le montant définitif ne sera connu qu'après interrogation des paiements
 * Stripe réussis et non déjà remboursés — c'est le travail du lot suivant.
 *
 * En attendant, la valeur retenue est le tarif catalogue de l'offre et de la
 * périodicité souscrites : c'est ce qui a été facturé au premier paiement,
 * hors changement d'offre en cours de délai. Prendre une valeur plus élevée
 * exposerait à annoncer un remboursement qu'on ne pourrait pas honorer.
 */
function estimateRefund(planCode: string | null, billingPeriod: string | null): number | null {
  if (!planCode || !billingPeriod) return null;
  const plan = (PRICE_CATALOG as Record<string, Record<string, { amountCents: number }>>)[planCode];
  return plan?.[billingPeriod]?.amountCents ?? null;
}

export async function buildSummary(
  eligibility: EligibilityResult,
  identity: { userId: number | null; firstName?: string | null; lastName?: string | null; email?: string | null },
  now: Date = new Date(),
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

  if (!planCode && contract?.subscriptionIdInternal) {
    const [sub] = await db
      .select({ planCode: accountSubscriptions.planCode, billingPeriod: accountSubscriptions.billingPeriod })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.id, contract.subscriptionIdInternal))
      .limit(1);
    planCode = sub?.planCode ?? null;
    billingPeriod = sub?.billingPeriod ?? null;
  }

  const amountExpected = estimateRefund(planCode, billingPeriod);

  return {
    firstName,
    lastName,
    email,
    offerLabel: OFFER_LABELS[planCode ?? ''] ?? 'Verebona',
    billingPeriodLabel: billingPeriod === 'yearly' ? 'annuelle' : billingPeriod === 'monthly' ? 'mensuelle' : '—',
    contractConcludedAt: contract?.contractConcludedAt.toISOString() ?? null,
    withdrawalDeadlineAt: contract?.withdrawalDeadlineAt.toISOString() ?? null,
    deadlineDeferred: contract?.deadlineDeferred ?? false,
    deadlineDeferralReason: contract?.deadlineDeferralReason ?? null,
    amountExpected,
    amountLabel: formatAmount(amountExpected),
    dataDeletionAt: new Date(now.getTime() + DATA_RECOVERY_DAYS * 24 * 3600 * 1000).toISOString(),
    stripeSubscriptionId: contract?.stripeSubscriptionId ?? null,
  };
}
