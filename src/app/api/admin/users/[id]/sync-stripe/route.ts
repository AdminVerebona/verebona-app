import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { StripeConfigError } from '@/lib/stripe';
import { syncAccountFromStripeCustomer } from '@/services/billing/subscription-sync.service';
import { isStripeResourceMissing } from '@/lib/stripe-customer';

/**
 * POST /api/admin/users/[id]/sync-stripe
 * Resynchronise le compte de l'utilisateur depuis Stripe.
 *
 * ⚠️ L'ancienne version ne reconnaissait que STRIPE_PRICE_PREMIUM (tout le
 * reste devenait STANDARD), stockait le statut Stripe en minuscules — refusé
 * par la contrainte `accounts_subscription_status_check` — et ne touchait pas
 * `account_subscriptions`, source des droits. Elle passe désormais par le
 * service de synchronisation commun au webhook et au retour de paiement.
 *
 * AUD-001 : l'action peut modifier l'offre et le statut d'abonnement du
 * compte ; elle est journalisée (`ACCOUNT_STRIPE_RESYNC`, cible ACCOUNT) avec
 * l'offre et le statut avant / après, y compris en cas d'échec une fois le
 * compte identifié.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let adminId: number | null = null;
  // Compte ciblé et état avant la synchronisation, connus une fois le compte lu.
  let audited: {
    accountId: number;
    userId: number;
    before: { planType: string; subscriptionStatus: string };
  } | null = null;
  const logFailure = async (result: 'FAILURE' | 'DENIED', error: string) => {
    if (adminId === null || !audited) return;
    await logAdminAction({
      adminId,
      action: 'ACCOUNT_STRIPE_RESYNC',
      targetType: 'ACCOUNT',
      targetId: audited.accountId,
      result,
      before: audited.before,
      details: { userId: audited.userId, error },
    });
  };

  try {
    adminId = await requireAdmin(request);

    const { id } = await params;
    const userId = parseInt(id);
    if (isNaN(userId)) {
      return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
    }

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const [account] = await db
      .select({
        id: accounts.id,
        planType: accounts.planType,
        subscriptionStatus: accounts.subscriptionStatus,
        stripeCustomerId: accounts.stripeCustomerId,
      })
      .from(accounts)
      .where(eq(accounts.ownerUserId, userId))
      .limit(1);

    if (!account) {
      return NextResponse.json({ error: 'User has no account' }, { status: 404 });
    }
    audited = {
      accountId: account.id,
      userId,
      before: { planType: account.planType, subscriptionStatus: account.subscriptionStatus },
    };
    if (!account.stripeCustomerId) {
      await logFailure('DENIED', 'NO_STRIPE_CUSTOMER');
      return NextResponse.json({ error: 'Aucun client Stripe rattaché à ce compte' }, { status: 400 });
    }

    const { result, subscriptionCount } = await syncAccountFromStripeCustomer({
      accountId: account.id,
      customerId: account.stripeCustomerId,
    });

    if (!result) {
      await logFailure('FAILURE', subscriptionCount === 0 ? 'NO_STRIPE_SUBSCRIPTION' : 'SUBSCRIPTION_NOT_SYNCABLE');
      return NextResponse.json(
        {
          error: subscriptionCount === 0
            ? 'Aucun abonnement Stripe pour ce client'
            : 'Abonnement Stripe non synchronisable (prix inconnu ou compte introuvable)',
        },
        { status: 409 },
      );
    }

    const changed = result.oldPlanType !== result.newPlanType || result.oldStatus !== result.newStatus;

    await logAdminAction({
      adminId,
      action: 'ACCOUNT_STRIPE_RESYNC',
      targetType: 'ACCOUNT',
      targetId: account.id,
      result: 'SUCCESS',
      before: { planType: result.oldPlanType, subscriptionStatus: result.oldStatus },
      after: { planType: result.newPlanType, subscriptionStatus: result.newStatus },
      details: {
        userId,
        changed,
        skipped: result.skipped ?? null,
        stripeStatus: result.stripeStatus,
        billingPeriod: result.billingPeriod,
      },
    });

    return NextResponse.json({
      success: true,
      skipped: result.skipped ?? null,
      changes: {
        // Deux jeux de clés : la page utilisateur lit tier*, l'ancienne réponse planType*.
        tierChanged: changed,
        oldTier: `${result.oldPlanType} / ${result.oldStatus}`,
        newTier: `${result.newPlanType} / ${result.newStatus}`,
        planTypeChanged: result.oldPlanType !== result.newPlanType,
        oldPlanType: result.oldPlanType,
        newPlanType: result.newPlanType,
        billingPeriod: result.billingPeriod,
      },
      stripeData: {
        customerId: account.stripeCustomerId,
        subscriptionId: result.subscriptionId,
        status: result.stripeStatus,
      },
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('[Sync Stripe] Error:', error);
    await logFailure('FAILURE', error instanceof Error ? error.message : 'Unknown error');

    if (error instanceof StripeConfigError) {
      return NextResponse.json({ error: `Configuration Stripe : ${error.message}` }, { status: 503 });
    }
    if (isStripeResourceMissing(error)) {
      return NextResponse.json(
        { error: 'Client Stripe introuvable dans le mode courant (test/live)' },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        error: 'Failed to sync with Stripe',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
