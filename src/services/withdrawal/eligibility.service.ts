/**
 * Éligibilité à la rétractation — CDC 6 §5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 32 — DÉCISIONS PO DU 07/10/2026 (Q1, Q2)
 *
 *   · le délai court à partir du PAIEMENT (premier paiement réussi de
 *     l'abonnement payant en cours, `withdrawalWindowStart`), plus de la
 *     conclusion technique de l'abonnement ;
 *   · la rétractation est traitée IMMÉDIATEMENT et supprime le compte : plus
 *     d'examen manuel. Ce module répond toujours `eligible`, `ineligible` ou
 *     `undetermined` ; `undetermined` ne vient plus que d'une panne de
 *     lecture (base indisponible, compte introuvable). L'appelant REFUSE
 *     alors temporairement (503, « réessayez ») au lieu d'enregistrer une
 *     demande en examen : une suppression de compte ne se décide pas sur un
 *     doute. Aucune date de paiement : aucun contrat payant (§5.4).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { accountSubscriptions, accounts, withdrawalRequests } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { computeWithdrawalDeadline } from '@/services/legal/french-calendar';
import { isWithdrawalWindowOpen, withdrawalWindowStart } from './withdrawal-window';

export type EligibilityVerdict = 'eligible' | 'ineligible' | 'undetermined';

/**
 * Motifs de non-éligibilité.
 *
 * Volontairement génériques côté API (§12.1 : « raison générique si non
 * éligible ») : détailler pourquoi un contrat n'est pas rétractable renseigne
 * un tiers sur l'existence et l'état d'un compte qui n'est pas le sien.
 */
export type IneligibilityReason =
  | 'NO_PAID_CONTRACT'
  | 'DEADLINE_PASSED'
  | 'ALREADY_WITHDRAWN'
  | 'NOT_ACCOUNT_OWNER';

export interface ContractSummary {
  accountId: number;
  subscriptionIdInternal: number | null;
  stripeSubscriptionId: string | null;
  planCode: string | null;
  billingPeriod: string | null;
  /** Conclusion de l'abonnement (`contract_concluded_at`) ; à défaut, le paiement. */
  contractConcludedAt: Date;
  /** Départ du délai : premier paiement de l'abonnement payant (lot 32, PO-Q1). */
  paidAt: Date;
  withdrawalDeadlineAt: Date;
  deadlineDeferred: boolean;
  deadlineDeferralReason?: string;
}

export interface EligibilityResult {
  verdict: EligibilityVerdict;
  reason?: IneligibilityReason;
  contract?: ContractSummary;
  /** Demande déjà enregistrée pour ce contrat, le cas échéant (§12.1). */
  existingRequest?: { publicReference: string; status: string; requestedAt: Date };
  /** Détail technique, journalisé mais jamais renvoyé au demandeur. */
  diagnostic?: string;
}

/** Statuts d'une demande considérée comme encore en cours. */
export const ACTIVE_WITHDRAWAL_STATUSES = ['received', 'manual_review', 'processing'] as const;

/**
 * Évalue l'éligibilité d'un compte à la rétractation.
 *
 * @param userId demandeur. Le §5.1 exige qu'il soit « l'utilisateur principal
 *   titulaire du contrat » : un membre invité d'un compte Duo ne peut pas
 *   rétracter l'abonnement d'un autre (§3.5).
 */
export async function evaluateEligibility(
  userId: number,
  accountId: number,
  now: Date = new Date(),
): Promise<EligibilityResult> {
  try {
    const [account] = await db
      .select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) {
      return { verdict: 'undetermined', diagnostic: `Compte ${accountId} introuvable.` };
    }

    if (account.ownerUserId !== userId) {
      return { verdict: 'ineligible', reason: 'NOT_ACCOUNT_OWNER' };
    }

    const [subscription] = await db
      .select({
        id: accountSubscriptions.id,
        planCode: accountSubscriptions.planCode,
        billingPeriod: accountSubscriptions.billingPeriod,
        status: accountSubscriptions.status,
        contractConcludedAt: accountSubscriptions.contractConcludedAt,
        firstBilledAt: accountSubscriptions.firstBilledAt,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, accountId))
      .limit(1);

    const [accountRow] = await db
      .select({ stripeSubscriptionId: accounts.stripeSubscriptionId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    // §5.4 : l'essai gratuit n'ouvre aucun droit de rétractation — il n'y a
    // pas de contrat payant, donc rien à rembourser.
    if (!subscription || subscription.status === 'trialing') {
      return { verdict: 'ineligible', reason: 'NO_PAID_CONTRACT' };
    }

    // Lot 32 (PO-Q1) : le délai court à partir du PAIEMENT. Aucun paiement
    // constaté : aucun contrat payant à rétracter, rien à rembourser.
    const windowStart = withdrawalWindowStart({
      firstBilledAt: subscription.firstBilledAt,
      contractConcludedAt: subscription.contractConcludedAt,
    });
    if (!windowStart) {
      return { verdict: 'ineligible', reason: 'NO_PAID_CONTRACT', diagnostic: `Abonnement ${subscription.id} sans paiement constaté.` };
    }

    const deadline = computeWithdrawalDeadline(windowStart);

    const existing = await db
      .select({
        publicReference: withdrawalRequests.publicReference,
        status: withdrawalRequests.status,
        requestedAt: withdrawalRequests.requestedAt,
      })
      .from(withdrawalRequests)
      .where(
        and(
          eq(withdrawalRequests.accountId, accountId),
          inArray(withdrawalRequests.status, [...ACTIVE_WITHDRAWAL_STATUSES, 'completed']),
        ),
      )
      .limit(1);

    const contract: ContractSummary = {
      accountId,
      subscriptionIdInternal: subscription.id,
      stripeSubscriptionId: accountRow?.stripeSubscriptionId ?? null,
      planCode: subscription.planCode,
      billingPeriod: subscription.billingPeriod,
      contractConcludedAt: subscription.contractConcludedAt ?? windowStart,
      paidAt: windowStart,
      withdrawalDeadlineAt: deadline.deadlineAt,
      deadlineDeferred: deadline.deferred,
      deadlineDeferralReason: deadline.deferralReason,
    };

    // §5.1 condition 5 : un contrat déjà rétracté ne l'est pas deux fois.
    if (existing.length > 0) {
      return {
        verdict: 'ineligible',
        reason: 'ALREADY_WITHDRAWN',
        contract,
        existingRequest: existing[0],
      };
    }

    // §5.1 condition 4 : la demande doit précéder l'expiration du délai.
    // Même fonction que l'affichage (lot 26) : ce qui est proposé est ce qui
    // est accepté, à la seconde près.
    if (!isWithdrawalWindowOpen(windowStart, now)) {
      return { verdict: 'ineligible', reason: 'DEADLINE_PASSED', contract };
    }

    return { verdict: 'eligible', contract };
  } catch (e) {
    // Une panne ne produit ni refus définitif ni suppression : l'appelant
    // répond « réessayez » (lot 32 — plus d'examen manuel).
    return { verdict: 'undetermined', diagnostic: (e as Error).message };
  }
}

/**
 * Message affiché au demandeur pour un motif de non-éligibilité.
 *
 * Générique par construction (§12.1) : chaque libellé doit rester vrai qu'un
 * compte existe ou non derrière la demande.
 */
export function ineligibilityMessage(reason: IneligibilityReason): string {
  switch (reason) {
    case 'NO_PAID_CONTRACT':
      return "Aucun abonnement payant en cours n'est associé à ce compte. " +
        "Le droit de rétractation porte sur un contrat payant : l'essai gratuit " +
        'peut simplement être laissé expirer.';
    case 'DEADLINE_PASSED':
      return 'Le délai légal de quatorze jours est écoulé pour ce contrat. ' +
        'Vous pouvez néanmoins résilier votre abonnement ou nous contacter.';
    case 'ALREADY_WITHDRAWN':
      return 'Une demande de rétractation a déjà été enregistrée pour ce contrat.';
    case 'NOT_ACCOUNT_OWNER':
      return "Seul le titulaire de l'abonnement peut exercer le droit de rétractation.";
  }
}
