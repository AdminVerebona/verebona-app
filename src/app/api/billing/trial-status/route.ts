import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accountMemberships, assets, assetFiles, accountSubscriptions } from '@/db/schema';
import { eq, and, isNull, count } from 'drizzle-orm';
import { getTrialState, hasUsedTrial } from '@/services/trial.service';
import { getEntitlements, quotaUsage } from '@/services/entitlements.service';
import { getScheduledChange } from '@/services/plan-change.service';

/**
 * GET /api/billing/trial-status
 *
 * Etat de l'essai, droits effectifs et consommation des quotas.
 * Alimente le bandeau d'essai, les compteurs « x sur y » et l'ecran
 * de fin d'essai (CDC §9).
 *
 * Toutes les valeurs sont calculees cote serveur : le client se contente
 * de les afficher.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);

    const [membership] = await db
      .select({ accountId: accountMemberships.accountId })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, session.userId))
      .limit(1);

    if (!membership) {
      return NextResponse.json({ error: 'User has no account' }, { status: 404 });
    }

    const accountId = membership.accountId;

    const [trial, entitlements, scheduled] = await Promise.all([
      getTrialState(accountId),
      getEntitlements(accountId),
      getScheduledChange(accountId),
    ]);

    // Details d'abonnement pour l'ecran « Mon abonnement » (CDC §9.1)
    const [sub] = await db
      .select({
        planCode: accountSubscriptions.planCode,
        billingPeriod: accountSubscriptions.billingPeriod,
        currentPeriodEndAt: accountSubscriptions.currentPeriodEndAt,
        cancelAtPeriodEnd: accountSubscriptions.cancelAtPeriodEnd,
        stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, accountId))
      .limit(1);

    // Consommation reelle (biens et documents non supprimes)
    const [assetRow] = await db
      .select({ value: count() })
      .from(assets)
      .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt)));

    const [docRow] = await db
      .select({ value: count() })
      .from(assetFiles)
      .where(and(eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)));

    const assetsUsed = assetRow?.value ?? 0;
    const documentsUsed = docRow?.value ?? 0;

    // ══════════════════════════════════════════════════════════════════
    // « PAS D'ESSAI » A DEUX CAUSES TRÈS DIFFÉRENTES
    //
    // Soit l'attribution a échoué — anomalie technique.
    // Soit l'adresse a DÉJÀ consommé son essai (§3.4) — comportement
    // attendu, notamment lorsqu'un compte est recréé.
    //
    // L'écran annonçait « n'a pas pu être activé » dans les deux cas, ce qui
    // laisse croire à une panne là où la règle s'applique normalement.
    // ══════════════════════════════════════════════════════════════════
    const dejaConsomme =
      trial.status === 'none' && (await hasUsedTrial(session.email ?? ''));

    return NextResponse.json({
      trial: {
        status: trial.status,
        dejaConsomme,
        daysRemaining: trial.status === 'active' ? trial.daysRemaining : 0,
        endsAt: 'endsAt' in trial ? trial.endsAt.toISOString() : null,
        // A J-2 et J-1, le bandeau doit devenir plus visible (CDC §9.2)
        isUrgent: trial.status === 'active' && trial.daysRemaining <= 2,
      },
      plan: entitlements.plan,
      status: entitlements.status,
      subscription: {
        planCode: sub?.planCode ?? null,
        billingPeriod: sub?.billingPeriod ?? null,
        currentPeriodEndAt: sub?.currentPeriodEndAt?.toISOString() ?? null,
        cancelAtPeriodEnd: Boolean(sub?.cancelAtPeriodEnd),
        scheduledChange: scheduled
          ? {
              planCode: scheduled.planCode,
              billingPeriod: scheduled.billingPeriod,
              effectiveAt: scheduled.effectiveAt?.toISOString() ?? null,
            }
          : null,
        hasStripeSubscription: Boolean(sub?.stripeSubscriptionId),
      },
      premiumFeatures: entitlements.premiumFeatures,
      canWrite: entitlements.canWrite,
      isRestricted: entitlements.isRestricted,
      quotas: {
        assets: quotaUsage(assetsUsed, entitlements.quotas.maxAssets),
        documents: quotaUsage(documentsUsed, entitlements.quotas.maxDocuments),
        users: { limit: entitlements.quotas.maxUsers },
      },
    });
  } catch (error) {
    console.error('[trial-status] erreur:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
