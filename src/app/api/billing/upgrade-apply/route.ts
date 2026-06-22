import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { getStripeServer, STRIPE_PRODUCTS } from '@/lib/stripe';
import { db } from '@/db';
import { accounts, accountMemberships } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * POST /api/billing/upgrade-apply
 *
 * Applique l'upgrade Premium → Premium Duo sur la subscription Stripe existante.
 *
 * - Remplace le price Premium par le price Premium Duo sur le subscription item existant
 * - proration_behavior=always_invoice → facturation immédiate du différentiel
 * - payment_behavior=pending_if_incomplete → l'upgrade n'est activé que si le paiement réussit
 * - La date de renouvellement reste inchangée (pas de billing_cycle_anchor reset)
 *
 * L'état local est mis à jour de façon optimiste si la subscription passe active.
 * Les webhooks Stripe (customer.subscription.updated, invoice.paid/payment_failed)
 * confirment et corrigent l'état final.
 *
 * Body: { target_offer: "premium_duo" }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const body = await request.json();

    if (body.target_offer !== 'premium_duo') {
      return NextResponse.json({ error: 'Seul le passage vers premium_duo est supporté' }, { status: 400 });
    }

    // Récupérer le compte de l'utilisateur
    const [membership] = await db
      .select({ accountId: accountMemberships.accountId, role: accountMemberships.role })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, session.userId))
      .limit(1);

    if (!membership) {
      return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });
    }

    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, membership.accountId))
      .limit(1);

    if (!account) {
      return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });
    }

    // Vérifications préalables
    if (account.planType !== 'PREMIUM') {
      return NextResponse.json(
        { error: 'Seul un abonnement Premium actif peut être upgradé vers Premium Duo' },
        { status: 422 }
      );
    }

    if ((account.planType as string) === 'PREMIUM_DUO') {
      return NextResponse.json({ error: 'Vous êtes déjà abonné Premium Duo' }, { status: 422 });
    }

    if (!account.stripeCustomerId || !account.stripeSubscriptionId) {
      return NextResponse.json({ error: 'Aucune souscription Stripe active' }, { status: 422 });
    }

    const stripe = getStripeServer();

    // Récupérer la subscription Stripe active
    const subscription = await stripe.subscriptions.retrieve(account.stripeSubscriptionId);

    if (!['active', 'trialing'].includes(subscription.status)) {
      return NextResponse.json(
        { error: `La souscription Stripe est en statut "${subscription.status}" et ne peut pas être upgradée` },
        { status: 422 }
      );
    }

    const subscriptionItem = subscription.items.data[0];
    if (!subscriptionItem) {
      return NextResponse.json({ error: 'Subscription item introuvable' }, { status: 422 });
    }

    const duoPriceId = STRIPE_PRODUCTS.PREMIUM_DUO.priceId;
    if (!duoPriceId) {
      return NextResponse.json({ error: 'Price ID Premium Duo non configuré' }, { status: 500 });
    }

    // Mise à jour de la subscription :
    //   - items[0][id]    = subscription item existant (remplace le price au lieu d'en ajouter un)
    //   - items[0][price] = price Premium Duo
    //   - proration_behavior=always_invoice → facture immédiate du différentiel
    //   - payment_behavior=pending_if_incomplete → l'upgrade ne s'applique que si le paiement réussit
    //   - billing_cycle_anchor non forcé → date de renouvellement inchangée
    const updatedSubscription = await stripe.subscriptions.update(
      account.stripeSubscriptionId,
      {
        items: [
          {
            id: subscriptionItem.id,
            price: duoPriceId,
          },
        ],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
      }
    );

    const currentPeriodEnd = (updatedSubscription as any).current_period_end as number;
    const nextRenewalDate = new Date(currentPeriodEnd * 1000).toISOString().split('T')[0];

    // Vérifier si des pending updates sont en attente (paiement non encore confirmé)
    const hasPendingUpdates = !!(updatedSubscription as any).pending_update;

    if (hasPendingUpdates) {
      // Le plan changera seulement après succès du paiement — les webhooks confirmeront
      return NextResponse.json({
        status: 'pending_payment',
        message: "L'upgrade est en attente de confirmation du paiement. Votre plan sera mis à jour dès que la facture sera réglée.",
        next_renewal_date: nextRenewalDate,
      });
    }

    // Si pas de pending updates (paiement réussi immédiatement), mettre à jour localement
    if (['active', 'trialing'].includes(updatedSubscription.status)) {
      await db
        .update(accounts)
        .set({
          planType: 'PREMIUM_DUO',
          subscriptionTier: 'pro',
          subscriptionStatus: 'ACTIVE',
          maxMembers: 2,
          premiumUntil: currentPeriodEnd * 1000,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, account.id));
    }

    return NextResponse.json({
      status: 'upgraded',
      message: 'Votre abonnement a été mis à jour vers Premium Duo.',
      next_renewal_date: nextRenewalDate,
    });
  } catch (error) {
    if (error instanceof Error && ['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED'].includes(error.message)) {
      return SessionService.handleSessionError(error);
    }
    console.error('[upgrade-apply] Error:', error);
    return NextResponse.json({ error: "Erreur lors de l'application de l'upgrade" }, { status: 500 });
  }
}
