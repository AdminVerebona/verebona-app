import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accounts, accountMemberships, assets, assetFiles, users, accountSubscriptions } from '@/db/schema';
import { eq, and, isNull, count, inArray } from 'drizzle-orm';
import { getAnalysisQuotaState, mapLegacyPlanTypeToCommercialCode } from '@/services/commercial-model.service';
import { getStripeServer, STRIPE_PRODUCTS } from '@/lib/stripe';

/**
 * GET /api/billing/me
 * Récupère les informations d'abonnement de l'utilisateur connecté
 * SPECS V1: Retourne planType, subscriptionStatus depuis le compte
 */
export async function GET(request: NextRequest) {
  try {
    const       session = await SessionService.getSession(request);

    // Récupérer le membership de l'utilisateur
    const [membership] = await db
      .select({
        accountId: accountMemberships.accountId,
        role: accountMemberships.role,
      })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, session.userId))
      .limit(1);

    if (!membership) {
      return NextResponse.json(
        { error: 'User has no account' },
        { status: 404 }
      );
    }

    // Récupérer les infos d'abonnement depuis le compte
    const [account] = await db
      .select({
        id: accounts.id,
        ownerUserId: accounts.ownerUserId,
        planType: accounts.planType,
        subscriptionStatus: accounts.subscriptionStatus,
        stripeCustomerId: accounts.stripeCustomerId,
        stripeSubscriptionId: accounts.stripeSubscriptionId,
        premiumUntil: accounts.premiumUntil,
      })
      .from(accounts)
      .where(eq(accounts.id, membership.accountId))
      .limit(1);

    if (!account) {
      return NextResponse.json(
        { error: 'Account not found' },
        { status: 404 }
      );
    }

    const { searchParams } = new URL(request.url);
    const stripeSessionId = searchParams.get('session_id');

    if (stripeSessionId && (account.subscriptionStatus === 'NONE' || !account.subscriptionStatus || account.subscriptionStatus === 'PENDING')) {
      try {
        const stripe = getStripeServer();
        const checkoutSession = await stripe.checkout.sessions.retrieve(stripeSessionId);

        if (checkoutSession && checkoutSession.status === 'complete' && (checkoutSession.payment_status === 'paid' || checkoutSession.payment_status === 'no_payment_required')) {
          const subscriptionId = checkoutSession.subscription as string;
          const customerId = checkoutSession.customer as string;

          if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const status = subscription.status;
            const priceId = subscription.items.data[0]?.price.id;

            // Resolve plan details
            let resolvedPlanType = 'STANDARD';
            if (priceId === STRIPE_PRODUCTS.PREMIUM_DUO.priceId) {
              resolvedPlanType = 'PREMIUM_DUO';
            } else if (priceId === STRIPE_PRODUCTS.PREMIUM.priceId) {
              resolvedPlanType = 'PREMIUM';
            }

            const subscriptionTier = resolvedPlanType === 'PREMIUM_DUO' ? 'pro' : (resolvedPlanType === 'PREMIUM' || resolvedPlanType === 'STANDARD') ? 'premium' : 'free';
            const isPaidPlan = resolvedPlanType === 'PREMIUM' || resolvedPlanType === 'PREMIUM_DUO' || resolvedPlanType === 'STANDARD';

            const currentPeriodEnd = ((subscription.items.data[0] as any).current_period_end ?? (subscription as any).current_period_end) as number;
            const trialStartUnix = (subscription as any).trial_start as number | null | undefined;
            const trialEndUnix = (subscription as any).trial_end as number | null | undefined;
            const trialEndsAtDate = trialEndUnix ? new Date(trialEndUnix * 1000) : null;
            const newSubStatus = subscription.cancel_at_period_end ? 'CANCELED' : (status === 'trialing' ? 'TRIALING' : 'ACTIVE');

            // Sync database on-the-fly!
            await db
              .update(accounts)
              .set({
                planType: resolvedPlanType,
                subscriptionTier,
                subscriptionStatus: newSubStatus,
                stripeSubscriptionId: subscriptionId,
                stripeCustomerId: customerId,
                premiumUntil: isPaidPlan ? currentPeriodEnd : null,
                trialEndsAt: trialEndsAtDate,
                updatedAt: new Date(),
              })
              .where(eq(accounts.id, account.id));

            await db.insert(accountSubscriptions).values({
              accountId: account.id,
              planCode: mapLegacyPlanTypeToCommercialCode(resolvedPlanType),
              status: status,
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscriptionId,
              currentPeriodEndAt: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
              ...(trialStartUnix ? { trialStartedAt: new Date(trialStartUnix * 1000) } : {}),
              ...(trialEndUnix ? { trialEndsAt: new Date(trialEndUnix * 1000) } : {}),
              updatedAt: new Date(),
              createdAt: new Date(),
            }).onConflictDoUpdate({
              target: accountSubscriptions.accountId,
              set: {
                planCode: mapLegacyPlanTypeToCommercialCode(resolvedPlanType),
                status: status,
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscriptionId,
                currentPeriodEndAt: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
                ...(trialStartUnix ? { trialStartedAt: new Date(trialStartUnix * 1000) } : {}),
                ...(trialEndUnix ? { trialEndsAt: new Date(trialEndUnix * 1000) } : {}),
                updatedAt: new Date(),
              },
            });

            if (resolvedPlanType !== account.planType) {
              await db
                .update(users)
                .set({ planType: resolvedPlanType, updatedAt: new Date() })
                .where(eq(users.id, account.ownerUserId));
            }

            // Update local memory-bound variables for immediate response
            account.subscriptionStatus = newSubStatus;
            account.planType = resolvedPlanType;
            account.stripeSubscriptionId = subscriptionId;
            account.premiumUntil = isPaidPlan ? currentPeriodEnd : null;
          }
        }
      } catch (err) {
        console.error('[me-api] Failed to sync Stripe checkout session on-the-fly:', err);
      }
    }

      const [quotaState, assetCountResult, analyzedCountResult] = await Promise.all([
        getAnalysisQuotaState(membership.accountId).catch(() => null),
        db.select({ count: count() }).from(assets).where(
          and(eq(assets.accountId, membership.accountId), isNull(assets.deletedAt))
        ),
        db.select({ count: count() }).from(assetFiles).where(
          and(
            eq(assetFiles.accountId, membership.accountId),
            isNull(assetFiles.deletedAt),
            inArray(assetFiles.analysisState, ['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED']),
          )
        ),
      ]);

      const assetCount = assetCountResult[0]?.count ?? 0;
      const analyzedCount = analyzedCountResult[0]?.count ?? 0;

      // Normalise les anciens plans vers le nouveau modèle commercial
      const normalizePlan = (p: string | null) => {
        if (!p) return 'STANDARD';
        return p.toUpperCase();
      };

      return NextResponse.json({
        plan_type: normalizePlan(account.planType),
        subscription_status: account.subscriptionStatus?.toUpperCase() || 'NONE',
        premium_until: account.premiumUntil,
        has_stripe_subscription: !!account.stripeSubscriptionId || !!account.stripeCustomerId,
        role: membership.role,
        currentAccountId: membership.accountId,
        asset_count: assetCount,
        analysis_quota: quotaState ? {
          plan_code: quotaState.planCode,
          period_type: quotaState.periodType,
          included_quota: quotaState.includedQuota,
          // On prend le max entre le compteur quota et le nombre réel de fichiers analysés
          // (les comptes existants ont des analyses antérieures au compteur)
          included_consumed: Math.max(quotaState.includedConsumed, analyzedCount),
          included_remaining: quotaState.includedRemaining,
          referral_remaining: quotaState.referralRemaining,
          pack_remaining: quotaState.packRemaining,
          total_remaining: quotaState.totalRemaining,
        } : null,
      });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
