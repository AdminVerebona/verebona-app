import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db } from '@/db';
import { accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';

// Initialize Stripe
const getStripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  return new Stripe(key, {
    apiVersion: '2025-08-27.basil',
  });
};

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session || !session.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = session.userId;


    // Récupérer le compte de l'utilisateur (on suppose un compte par utilisateur pour simplifier en V1)
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.ownerUserId, userId))
      .limit(1);

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    if (!account.stripeSubscriptionId) {
      return NextResponse.json({ error: 'No active subscription found' }, { status: 400 });
    }

    const stripe = getStripe();

    // Mettre à jour la subscription Stripe pour ne pas renouveler à la fin de la période
    await stripe.subscriptions.update(account.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    // Mettre à jour le statut dans la base de données
    await db
      .update(accounts)
      .set({
        subscriptionStatus: 'CANCELED',
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, account.id));

    return NextResponse.json({ success: true, message: 'La résiliation a été prise en compte.' });
  } catch (error: any) {
    console.error('[Cancel Subscription] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Une erreur est survenue lors de la résiliation.' },
      { status: 500 }
    );
  }
}
