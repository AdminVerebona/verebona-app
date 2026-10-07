import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  accounts,
  accountSubscriptions,
  planLimits,
  accountAnalysisCounters,
  accountAnalysisCredits,
  referralEvents,
} from '@/db/schema';
import { NOTIFICATION_TYPES } from '@/types/notifications';
import { emit } from '@/lib/notifications';

export type CommercialPlanCode = 'standard' | 'premium' | 'premium_duo' | 'premium_pro';
export type AnalysisPeriodType = 'trial' | 'annual';

const DEFAULT_LIMITS: Record<CommercialPlanCode, { trial: number; annual: number }> = {
  standard: { trial: 10, annual: 50 },
  premium: { trial: 30, annual: 200 },
  premium_duo: { trial: 50, annual: 300 },
  premium_pro: { trial: 100, annual: 1200 },
};

export function mapLegacyPlanTypeToCommercialCode(planType: string | null | undefined): CommercialPlanCode {
  switch ((planType || '').toUpperCase()) {
    case 'STANDARD':
      return 'standard';
    case 'PREMIUM':
      return 'premium';
    case 'PREMIUM_DUO':
      return 'premium_duo';
    case 'PREMIUM_PRO':
      return 'premium_pro';
    default:
      return 'standard';
  }
}

async function resolvePlanLimits(planCode: CommercialPlanCode): Promise<{ trial: number; annual: number }> {
  const [row] = await db
    .select({ trial: planLimits.trialAnalysisQuota, annual: planLimits.yearlyAnalysisQuota })
    .from(planLimits)
    .where(eq(planLimits.planCode, planCode))
    .limit(1);

  if (!row) return DEFAULT_LIMITS[planCode];
  return { trial: row.trial, annual: row.annual };
}

export async function getCommercialPlanForAccount(accountId: number): Promise<CommercialPlanCode> {
  const [sub] = await db
    .select({ planCode: accountSubscriptions.planCode })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);

  if (sub?.planCode) {
    if (sub.planCode === 'standard' || sub.planCode === 'premium' || sub.planCode === 'premium_duo' || sub.planCode === 'premium_pro') {
      return sub.planCode;
    }
  }

  const [account] = await db
    .select({ planType: accounts.planType })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  return mapLegacyPlanTypeToCommercialCode(account?.planType);
}

async function getPeriodType(accountId: number): Promise<AnalysisPeriodType> {
  const [sub] = await db
    .select({ status: accountSubscriptions.status })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);

  if (sub?.status === 'trialing') return 'trial';

  const [account] = await db
    .select({ status: accounts.subscriptionStatus })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  return account?.status === 'TRIALING' ? 'trial' : 'annual';
}

async function getOrCreateActiveCounter(accountId: number, planCode: CommercialPlanCode, periodType: AnalysisPeriodType) {
  const [existing] = await db
    .select()
    .from(accountAnalysisCounters)
    .where(
      and(
        eq(accountAnalysisCounters.accountId, accountId),
        eq(accountAnalysisCounters.periodType, periodType),
        isNull(accountAnalysisCounters.periodEndAt),
      ),
    )
    .limit(1);

  if (existing) return existing;

  const limits = await resolvePlanLimits(planCode);
  const [created] = await db
    .insert(accountAnalysisCounters)
    .values({
      accountId,
      periodType,
      includedQuota: periodType === 'trial' ? limits.trial : limits.annual,
      includedConsumed: 0,
      periodStartAt: new Date(),
      updatedAt: new Date(),
      createdAt: new Date(),
    })
    .returning();

  return created;
}

export async function getAnalysisQuotaState(accountId: number): Promise<{
  planCode: CommercialPlanCode;
  periodType: AnalysisPeriodType;
  includedQuota: number;
  includedConsumed: number;
  includedRemaining: number;
  referralRemaining: number;
  packRemaining: number;
  totalRemaining: number;
}> {
  const planCode = await getCommercialPlanForAccount(accountId);
  const periodType = await getPeriodType(accountId);
  const counter = await getOrCreateActiveCounter(accountId, planCode, periodType);

  const credits = await db
    .select({ source: accountAnalysisCredits.source, total: sql<number>`coalesce(sum(${accountAnalysisCredits.amountRemaining}), 0)` })
    .from(accountAnalysisCredits)
    .where(and(eq(accountAnalysisCredits.accountId, accountId), gt(accountAnalysisCredits.amountRemaining, 0)))
    .groupBy(accountAnalysisCredits.source);

  const referralRemaining = credits.find(c => c.source === 'referral')?.total ?? 0;
  const packRemaining = credits.find(c => c.source === 'pack')?.total ?? 0;
  const includedRemaining = Math.max(0, counter.includedQuota - counter.includedConsumed);

  return {
    planCode,
    periodType,
    includedQuota: counter.includedQuota,
    includedConsumed: counter.includedConsumed,
    includedRemaining,
    referralRemaining,
    packRemaining,
    totalRemaining: includedRemaining + referralRemaining + packRemaining,
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ LE COMPTEUR D'ANALYSES NE BLOQUE PLUS L'ANALYSE (lot 26)
 *
 * Le quota commercial est un quota de DOCUMENTS (CDC tarification V2 :
 * 30 / 150 / 225, `entitlements.canAddDocument`, contrôlé au dépôt). Le
 * compteur `account_analysis_counters` (modèle 0066 : 10/50, 30/200,
 * 50/300…) est un autre compteur : il compte chaque passage d'analyse
 * (réanalyses, documents multiples d'un même PDF) et peut rester sur la
 * période d'essai (repli sur `accounts.subscription_status`). Il atteignait
 * donc son plafond alors que le compte était loin de sa limite de documents
 * (59 / 150 en préproduction) : l'e-mail « Votre quota d'analyses » partait
 * à tort, et surtout la confirmation de dépôt, la réanalyse, le pipeline et
 * la reprise serveur refusaient d'analyser les nouveaux documents.
 *
 * L'analyse d'un document accepté n'est donc plus refusée par ce compteur ;
 * le coût IA reste borné par le plafond mensuel du compte (lot 22). Le
 * compteur continue d'être alimenté (statistiques BO).
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function canConsumeAnalysis(accountId: number, amount = 1): Promise<{ allowed: boolean; reason?: string }> {
  const planCode = await getCommercialPlanForAccount(accountId);

  if (planCode === 'premium_pro') {
    return { allowed: false, reason: 'PLAN_NOT_SUBSCRIBABLE' };
  }

  void amount;
  return { allowed: true };
}

export async function consumeAnalysisCredits(accountId: number, amount = 1): Promise<void> {
  if (amount <= 0) return;

  const state = await getAnalysisQuotaState(accountId);

  let toConsume = amount;
  const counter = await getOrCreateActiveCounter(accountId, state.planCode, state.periodType);

  const includedRemaining = Math.max(0, counter.includedQuota - counter.includedConsumed);
  const consumeIncluded = Math.min(includedRemaining, toConsume);

  let newIncludedConsumed = counter.includedConsumed;
  if (consumeIncluded > 0) {
    newIncludedConsumed += consumeIncluded;
    await db
      .update(accountAnalysisCounters)
      .set({ includedConsumed: newIncludedConsumed, updatedAt: new Date() })
      .where(eq(accountAnalysisCounters.id, counter.id));
    toConsume -= consumeIncluded;
  }

  if (toConsume > 0) {
    const referralCredits = await db
      .select({ id: accountAnalysisCredits.id, amountRemaining: accountAnalysisCredits.amountRemaining })
      .from(accountAnalysisCredits)
      .where(
        and(
          eq(accountAnalysisCredits.accountId, accountId),
          eq(accountAnalysisCredits.source, 'referral'),
          gt(accountAnalysisCredits.amountRemaining, 0),
        ),
      )
      .orderBy(asc(accountAnalysisCredits.createdAt));

    for (const credit of referralCredits) {
      if (toConsume <= 0) break;
      const used = Math.min(credit.amountRemaining, toConsume);
      await db
        .update(accountAnalysisCredits)
        .set({ amountRemaining: credit.amountRemaining - used, updatedAt: new Date() })
        .where(eq(accountAnalysisCredits.id, credit.id));
      toConsume -= used;
    }
  }

  if (toConsume > 0) {
    const packCredits = await db
      .select({ id: accountAnalysisCredits.id, amountRemaining: accountAnalysisCredits.amountRemaining })
      .from(accountAnalysisCredits)
      .where(
        and(
          eq(accountAnalysisCredits.accountId, accountId),
          eq(accountAnalysisCredits.source, 'pack'),
          gt(accountAnalysisCredits.amountRemaining, 0),
        ),
      )
      .orderBy(asc(accountAnalysisCredits.createdAt));

    for (const credit of packCredits) {
      if (toConsume <= 0) break;
      const used = Math.min(credit.amountRemaining, toConsume);
      await db
        .update(accountAnalysisCredits)
        .set({ amountRemaining: credit.amountRemaining - used, updatedAt: new Date() })
        .where(eq(accountAnalysisCredits.id, credit.id));
      toConsume -= used;
    }
  }

  // Au-delà des analyses incluses et des crédits : la consommation est
  // enregistrée (statistiques), sans refus ni notification (lot 26 — le
  // quota commercial est celui des documents).
  if (toConsume > 0) {
    await db
      .update(accountAnalysisCounters)
      .set({ includedConsumed: newIncludedConsumed + toConsume, updatedAt: new Date() })
      .where(eq(accountAnalysisCounters.id, counter.id));
  }
}

export async function grantReferralRewardForFirstBilling(
  referredAccountId: number,
  stripeInvoiceId?: string,
): Promise<boolean> {
  const [event] = await db
    .select()
    .from(referralEvents)
    .where(eq(referralEvents.referredAccountId, referredAccountId))
    .limit(1);

  if (!event) return false;
  if (event.status === 'first_billed' || event.status === 'reward_granted') return false;

  // Idempotence : si l'invoice a déjà été traitée, on skip
  if (stripeInvoiceId && event.stripeInvoiceId === stripeInvoiceId) return false;

  // CDC tarification §13 : la recompense n'est plus un lot de credits d'analyse
  // mais UN MOIS D'ABONNEMENT OFFERT, attribue apres le delai de retractation
  // par la tache /api/cron/referral-rewards.
  //
  // Cette fonction se limite desormais a marquer la premiere facturation :
  // c'est ce marquage qui rend l'evenement eligible a l'attribution.
  await db
    .update(referralEvents)
    .set({
      status: 'first_billed',
      firstBilledAt: new Date(),
      ...(stripeInvoiceId ? { stripeInvoiceId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(referralEvents.id, event.id));

  // Notification interne au parrain
  try {
    const [referrerAccount] = await db
      .select({ ownerUserId: accounts.ownerUserId })
      .from(accounts)
      .where(eq(accounts.id, event.referrerAccountId))
      .limit(1);

    if (referrerAccount?.ownerUserId) {
      await emit({
        type: NOTIFICATION_TYPES.REFERRAL_REWARD_GRANTED,
        recipientUserIds: [referrerAccount.ownerUserId],
        entityType: 'referral_event',
        entityId: event.id,
        payload: {
          referralEventId: event.id,
          referredAccountId,
        },
        dedupeKey: `account:referral-reward-granted:${event.id}`,
      });
    }
  } catch (err) {
    // Ne pas bloquer le reward si la notif échoue
    console.error('[grantReferralReward] notification error:', err);
  }

  return true;
}
