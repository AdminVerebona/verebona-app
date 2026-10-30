/**
 * POST /api/billing/stop-renewal — « Résilier mon abonnement » (fin de
 * période), lot 100D (décision PO A9 : la résiliation reste un droit de
 * l'utilisateur dans l'application ; aucun achat, aucun tarif, aucun portail
 * de paiement). Utilisée par Mon compte › Mon abonnement dans l'app ; le Web
 * garde le portail Verebona (lot 70B). N'est PAS une opération commerciale
 * au sens de `lib/native/commerce` : elle n'achète rien et n'ouvre aucun
 * paiement.
 *
 * Titulaire de l'espace seulement. Effet : `cancel_at_period_end` chez
 * Stripe (reflet local immédiat, le webhook fait foi et envoie la
 * confirmation). Journal : SUBSCRIPTION_RENEWAL_STOPPED.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, accountSubscriptions } from '@/db/schema';
import { getSession } from '@/lib/auth-guards';
import { resolveOwnedSessionAccount } from '@/services/account/membership.service';
import { stopSubscriptionRenewal } from '@/services/billing/stop-renewal.service';
import { getStripeServer } from '@/lib/stripe-client';
import { logUserActivity } from '@/lib/audit-logger';
import { SessionService } from '@/lib/session-service';

export async function POST(request: NextRequest) {
  try {
    return await stopRenewal(request);
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}

async function stopRenewal(request: NextRequest): Promise<NextResponse> {
  const session = await getSession(request);
  if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const owned = await resolveOwnedSessionAccount(session);
  if (!owned.ok) return owned.response;

  const [account] = await db
    .select({ id: accounts.id, stripeSubscriptionId: accounts.stripeSubscriptionId })
    .from(accounts)
    .where(eq(accounts.id, owned.accountId))
    .limit(1);
  const outcome = await stopSubscriptionRenewal(account?.stripeSubscriptionId, getStripeServer);
  if (!outcome.ok) {
    const status = outcome.code === 'BILLING_UNAVAILABLE' ? 503 : outcome.code === 'NO_SUBSCRIPTION' ? 400 : 409;
    return NextResponse.json({ error: outcome.code, code: outcome.code, message: outcome.message }, { status });
  }
  if (!outcome.alreadyScheduled) {
    // Reflet local immédiat ; le webhook Stripe reste la source de vérité.
    await db.update(accountSubscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(accountSubscriptions.stripeSubscriptionId, outcome.subscriptionId))
      .catch(() => undefined);
    void logUserActivity({
      activityType: 'SUBSCRIPTION_RENEWAL_STOPPED',
      userId: session.userId,
      userEmail: session.email,
      details: { accountId: owned.accountId, endsAt: outcome.endsAt, via: 'app' },
      request,
    });
  }
  return NextResponse.json({ success: true, alreadyScheduled: outcome.alreadyScheduled, endsAt: outcome.endsAt });
}
