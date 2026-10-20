import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accountSubscriptions } from '@/db/schema';
import { resolveOwnedSessionAccount } from '@/services/account/membership.service';
import { eq } from 'drizzle-orm';
import { syncSubscriptionById } from '@/services/billing/subscription-sync.service';

/**
 * POST /api/billing/sync-subscription — relit l'abonnement chez Stripe et
 * met à jour l'offre du compte, sans attendre le webhook.
 *
 * Appelé au retour du portail Stripe après une montée en gamme
 * (`/mon-compte/offres?changement=confirme`). Idempotent : si le webhook est
 * déjà passé, la synchronisation ne change rien (et ne renotifie pas, cf.
 * les clés de déduplication de `subscription-sync`).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    // Lot 72D : compte de la session, titulaire seulement (retour du portail).
    const owned = await resolveOwnedSessionAccount(session);
    if (!owned.ok) return owned.response;
    const membership = { accountId: owned.accountId };

    const [sub] = await db
      .select({ stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, membership.accountId))
      .limit(1);
    if (!sub?.stripeSubscriptionId) return NextResponse.json({ error: 'NO_SUBSCRIPTION' }, { status: 404 });

    const result = await syncSubscriptionById(sub.stripeSubscriptionId, {
      source: 'portal-return',
      accountIdHint: membership.accountId,
    });

    return NextResponse.json({
      ok: true,
      planType: result?.newPlanType ?? null,
      billingPeriod: result?.billingPeriod ?? null,
    });
  } catch (error) {
    if (error instanceof Error && ['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED'].includes(error.message)) {
      return SessionService.handleSessionError(error);
    }
    console.error('[billing/sync-subscription] erreur :', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
