import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db } from '@/db';
import { accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { resolveOwnedSessionAccount } from '@/services/account/membership.service';

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

    // Lot 72D : le compte est celui de la SESSION, et la résiliation est
    // réservée à son titulaire (avant : « premier compte possédé », au hasard
    // pour un utilisateur à plusieurs espaces ; aucun contrôle de rôle).
    const owned = await resolveOwnedSessionAccount(session);
    if (!owned.ok) return owned.response;

    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, owned.accountId))
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
