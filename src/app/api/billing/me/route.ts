import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accounts, accountMemberships, assets, assetFiles, accountSubscriptions } from '@/db/schema';
import { eq, and, isNull, count, inArray } from 'drizzle-orm';
import { getAnalysisQuotaState } from '@/services/commercial-model.service';
import { syncFromCheckoutSession } from '@/services/billing/subscription-sync.service';

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
    const { searchParams } = new URL(request.url);
    const stripeSessionId = searchParams.get('session_id');

    // ══════════════════════════════════════════════════════════════════
    // RETOUR DE STRIPE CHECKOUT
    //
    // Le compte est synchronisé ici sans attendre le webhook, par le même
    // service que celui-ci : offre, statut, périodicité, identifiants,
    // dates de souscription et de renouvellement, fin de l'essai.
    //
    // L'ancien traitement ne tournait que pour un statut NONE/PENDING, ne
    // reconnaissait pas les prix V2 (tout paiement devenait STANDARD) et
    // acceptait n'importe quelle session : elle doit désormais appartenir
    // au compte appelant.
    // ══════════════════════════════════════════════════════════════════
    let checkoutSync: string | null = null;
    if (stripeSessionId) {
      try {
        const outcome = await syncFromCheckoutSession({
          sessionId: stripeSessionId,
          accountId: membership.accountId,
        });
        checkoutSync = outcome.status === 'synced' ? 'synced' : outcome.reason;
      } catch (err) {
        checkoutSync = 'ERROR';
        console.error('[me-api] synchronisation du retour de paiement impossible :', err);
      }
    }

    // Récupérer les infos d'abonnement depuis le compte (après synchronisation)
    const [account] = await db
      .select({
        id: accounts.id,
        planType: accounts.planType,
        subscriptionStatus: accounts.subscriptionStatus,
        stripeCustomerId: accounts.stripeCustomerId,
        stripeSubscriptionId: accounts.stripeSubscriptionId,
        premiumUntil: accounts.premiumUntil,
        subscriptionStartedAt: accounts.subscriptionStartedAt,
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

    const [subscriptionRow] = await db
      .select({
        billingPeriod: accountSubscriptions.billingPeriod,
        currentPeriodEndAt: accountSubscriptions.currentPeriodEndAt,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, account.id))
      .limit(1);

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
        billing_period: subscriptionRow?.billingPeriod ?? null,
        subscription_started_at: account.subscriptionStartedAt?.toISOString() ?? null,
        renewal_at: subscriptionRow?.currentPeriodEndAt?.toISOString() ?? null,
        ...(checkoutSync ? { checkout_sync: checkoutSync } : {}),
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
