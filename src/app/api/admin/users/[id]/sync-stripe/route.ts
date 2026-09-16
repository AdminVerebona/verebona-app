import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';
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
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(request);

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
        stripeCustomerId: accounts.stripeCustomerId,
      })
      .from(accounts)
      .where(eq(accounts.ownerUserId, userId))
      .limit(1);

    if (!account) {
      return NextResponse.json({ error: 'User has no account' }, { status: 404 });
    }
    if (!account.stripeCustomerId) {
      return NextResponse.json({ error: 'Aucun client Stripe rattaché à ce compte' }, { status: 400 });
    }

    const { result, subscriptionCount } = await syncAccountFromStripeCustomer({
      accountId: account.id,
      customerId: account.stripeCustomerId,
    });

    if (!result) {
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
