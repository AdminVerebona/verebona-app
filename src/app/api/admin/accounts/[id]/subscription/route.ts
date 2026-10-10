import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import {
  accountSubscriptions,
  subscriptionPlans,
  planLimits,
  subscriptionHistory,
  referralEvents,
  stripeWebhookLogs,
  assets,
  assetFiles,
  accountMemberships,
  trialGrants,
} from '@/db/schema';
import { and, count, desc, eq, isNull, or } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

/**
 * GET /api/admin/accounts/[id]/subscription
 *
 * Vue d'administration d'un abonnement (CDC tarification §15).
 *
 * Rassemble en une reponse : etat et dates de l'essai, offre et periodicite,
 * identifiants Stripe, prochaine echeance, statut de paiement, quotas
 * consommes, changement programme, historique des changements, evenements
 * Stripe recents et avantages de parrainage.
 *
 * La resynchronisation manuelle est assuree par la route existante
 * /api/admin/users/[id]/sync-stripe.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Leve une exception si l'appelant n'est pas administrateur.
    await requireAdmin(request);

    const { id } = await params;
    const accountId = Number(id);
    if (!Number.isFinite(accountId)) {
      return NextResponse.json({ error: 'INVALID_ACCOUNT_ID' }, { status: 400 });
    }

    const [sub] = await db
      .select()
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, accountId))
      .limit(1);

    if (!sub) {
      return NextResponse.json({ error: 'NO_SUBSCRIPTION' }, { status: 404 });
    }

    // Tarif et quotas de l'offre courante
    const [plan] = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.code, sub.planCode))
      .limit(1);

    const [limits] = await db
      .select()
      .from(planLimits)
      .where(eq(planLimits.planCode, sub.planCode))
      .limit(1);

    // Consommation reelle
    const [assetRow] = await db
      .select({ value: count() })
      .from(assets)
      .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt)));

    const [docRow] = await db
      .select({ value: count() })
      .from(assetFiles)
      .where(and(eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)));

    const [memberRow] = await db
      .select({ value: count() })
      .from(accountMemberships)
      .where(eq(accountMemberships.accountId, accountId));

    // Historique des changements d'offre
    const history = await db
      .select()
      .from(subscriptionHistory)
      .where(eq(subscriptionHistory.accountId, accountId))
      .orderBy(desc(subscriptionHistory.createdAt))
      .limit(20);

    // Parrainages lies a ce compte, comme parrain ou comme filleul
    const referrals = await db
      .select({
        id: referralEvents.id,
        status: referralEvents.status,
        referrerAccountId: referralEvents.referrerAccountId,
        referredAccountId: referralEvents.referredAccountId,
        firstBilledAt: referralEvents.firstBilledAt,
        rewardedAt: referralEvents.rewardedAt,
      })
      .from(referralEvents)
      .where(
        or(
          eq(referralEvents.referrerAccountId, accountId),
          eq(referralEvents.referredAccountId, accountId),
        ),
      )
      .orderBy(desc(referralEvents.createdAt))
      .limit(20);

    // Trace d'unicite de l'essai (anti-fraude)
    const [grant] = await db
      .select({
        emailNormalized: trialGrants.emailNormalized,
        grantedAt: trialGrants.grantedAt,
        expiresAt: trialGrants.expiresAt,
        convertedAt: trialGrants.convertedAt,
      })
      .from(trialGrants)
      .where(eq(trialGrants.accountId, accountId))
      .limit(1);

    // Evenements Stripe recents, pour diagnostiquer une desynchronisation
    const webhooks = sub.stripeCustomerId
      ? await db
          .select({
            eventId: stripeWebhookLogs.eventId,
            eventType: stripeWebhookLogs.eventType,
            processed: stripeWebhookLogs.processed,
            errorMessage: stripeWebhookLogs.errorMessage,
            createdAt: stripeWebhookLogs.createdAt,
          })
          .from(stripeWebhookLogs)
          .orderBy(desc(stripeWebhookLogs.createdAt))
          .limit(15)
      : [];

    return NextResponse.json({
      accountId,

      trial: {
        startedAt: sub.trialStartedAt,
        endsAt: sub.trialEndsAt,
        consumed: sub.trialConsumed,
        grant: grant ?? null,
      },

      subscription: {
        planCode: sub.planCode,
        planLabel: plan?.label ?? null,
        billingPeriod: sub.billingPeriod,
        status: sub.status,
        currentPeriodStartAt: sub.currentPeriodStartAt,
        currentPeriodEndAt: sub.currentPeriodEndAt,
        firstBilledAt: sub.firstBilledAt,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      },

      scheduledChange: sub.scheduledPlanCode
        ? {
            planCode: sub.scheduledPlanCode,
            billingPeriod: sub.scheduledBillingPeriod,
            effectiveAt: sub.scheduledChangeAt,
            // Cible EXACTE acceptée (CDC lookup_key LK-20).
            stripePriceId: sub.scheduledStripePriceId,
            unitAmountCents: sub.scheduledUnitAmountCents,
            currency: sub.scheduledCurrency,
            scheduleId: sub.scheduledScheduleId,
            state: sub.scheduledChangeState,
          }
        : null,

      stripe: {
        customerId: sub.stripeCustomerId,
        subscriptionId: sub.stripeSubscriptionId,
        // Prix CONTRACTUEL de l'abonnement (LK-19, LK-64) — et non le prix
        // de vente courant, qui peut différer sans que l'abonnement soit
        // défectueux.
        priceId: sub.stripePriceId,
        productId: sub.stripeProductId,
        unitAmountCents: sub.contractUnitAmountCents,
        currency: sub.contractCurrency,
        quantity: sub.contractQuantity,
        interval: sub.contractInterval,
        verifiedAt: sub.contractVerifiedAt,
        // Miroirs transitoires du catalogue de vente (diagnostic seulement).
        catalogPriceIdMonthly: plan?.stripePriceIdMonthly ?? null,
        catalogPriceIdYearly: plan?.stripePriceIdYearly ?? null,
      },

      quotas: {
        assets: { used: assetRow?.value ?? 0, limit: limits?.maxAssets ?? 0 },
        documents: { used: docRow?.value ?? 0, limit: limits?.maxDocuments ?? 0 },
        users: { used: memberRow?.value ?? 0, limit: limits?.maxUsers ?? 1 },
      },

      history,
      referrals,
      recentWebhookEvents: webhooks,
    });
  } catch (error) {
    console.error('[admin/subscription] erreur:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
