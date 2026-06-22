import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';
import { getStripeServer } from '@/lib/stripe';

/**
 * POST /api/admin/users/[id]/sync-stripe
 * Synchronise les données d'abonnement depuis Stripe pour le compte de l'utilisateur
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(request);

    const resolvedParams = await params;
    const userId = parseInt(resolvedParams.id);

    if (isNaN(userId)) {
      return NextResponse.json(
        { error: 'Invalid user ID' },
        { status: 400 }
      );
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.ownerUserId, userId))
      .limit(1);

    if (!account) {
      return NextResponse.json(
        { error: 'User has no account' },
        { status: 404 }
      );
    }

    if (!account.stripeCustomerId) {
      return NextResponse.json(
        { error: 'Account has no Stripe customer ID' },
        { status: 400 }
      );
    }

    const stripe = getStripeServer();

    const customer = await stripe.customers.retrieve(account.stripeCustomerId);

    if (customer.deleted) {
      return NextResponse.json(
        { error: 'Stripe customer has been deleted' },
        { status: 400 }
      );
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: account.stripeCustomerId,
      status: 'all',
      limit: 10,
    });

    const activeSubscription = subscriptions.data.find(
      sub => sub.status === 'active' || sub.status === 'trialing'
    ) || subscriptions.data[0];

    let newPlanType: 'STANDARD' | 'PREMIUM' = 'STANDARD';
    let newPremiumUntil: number | null = null;
    let newSubscriptionId: string | null = null;
    let newStatus: string | undefined = undefined;

    if (activeSubscription && (activeSubscription.status === 'active' || activeSubscription.status === 'trialing')) {
      const priceId = activeSubscription.items.data[0]?.price.id;
      const currentPeriodEnd = (activeSubscription as any).current_period_end * 1000;

      newSubscriptionId = activeSubscription.id;
      newStatus = activeSubscription.status;

      if (priceId === process.env.STRIPE_PRICE_PREMIUM) {
        newPlanType = 'PREMIUM';
        newPremiumUntil = currentPeriodEnd;
      }
    }

    const oldPlanType = account.planType;
    const oldPremiumUntil = account.premiumUntil;

    await db
      .update(accounts)
      .set({
        planType: newPlanType,
        stripeSubscriptionId: newSubscriptionId,
        premiumUntil: newPremiumUntil,
        subscriptionStatus: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, account.id));

    return NextResponse.json({
      success: true,
      changes: {
        planTypeChanged: oldPlanType !== newPlanType,
        oldPlanType,
        newPlanType,
        premiumUntil: newPremiumUntil,
      },
      stripeData: {
        customerId: account.stripeCustomerId,
        subscriptionId: newSubscriptionId,
        status: activeSubscription?.status || 'none',
      },
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    console.error('[Sync Stripe] Error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to sync with Stripe',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
