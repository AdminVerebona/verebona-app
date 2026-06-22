import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accounts, accountMemberships } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';

/**
 * POST /api/billing/create-customer-portal-session
 * Crée une session Stripe Customer Portal pour gérer l'abonnement
 * IMPORTANT: Accessible uniquement aux Owners
 */
export async function POST(request: NextRequest) {
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
        { code: 'NO_ACCOUNT', message: 'User has no account' },
        { status: 404 }
      );
    }

    // Vérifier que l'utilisateur est Owner
    if (membership.role !== 'owner') {
      return NextResponse.json(
        {
          code: 'FORBIDDEN',
          message: 'Seul le propriétaire du compte peut accéder à la facturation.',
        },
        { status: 403 }
      );
    }

    // Récupérer le compte
    const [account] = await db
      .select({
        stripeCustomerId: accounts.stripeCustomerId,
      })
      .from(accounts)
      .where(eq(accounts.id, membership.accountId))
      .limit(1);

    if (!account) {
      return NextResponse.json(
        { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' },
        { status: 404 }
      );
    }

    if (!account.stripeCustomerId) {
      return NextResponse.json(
        {
          code: 'NO_STRIPE_CUSTOMER',
          message: 'Aucun compte de facturation n\'est associé à ce compte.',
        },
        { status: 404 }
      );
    }

    const stripe = getStripeServer();

    // Créer la session Customer Portal
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/mon-compte`,
      locale: 'fr',
    });

    return NextResponse.json({
      portal_url: portalSession.url,
    });
  } catch (error) {
    console.error('[Customer Portal Error]', error);
    
    if (error instanceof Error && error.message.includes('AUTH_REQUIRED')) {
      return SessionService.handleSessionError(error);
    }

    return NextResponse.json(
      {
        code: 'PORTAL_SESSION_FAILED',
        message: 'Failed to create customer portal session',
      },
      { status: 500 }
    );
  }
}