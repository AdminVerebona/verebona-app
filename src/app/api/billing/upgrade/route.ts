import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accountMemberships } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getAppBaseUrl } from '@/lib/app-url';
import { startImmediateUpgrade } from '@/services/billing/plan-upgrade.service';
import { CATALOG_ERROR_HTTP, CATALOG_ERROR_MESSAGES, type BillingCatalogErrorCode } from '@/services/billing/catalog-types';

/**
 * POST /api/billing/upgrade — montée en gamme immédiate d'un compte abonné.
 *
 * Body : { plan_code: 'premium' | 'premium_duo', billing_period: 'monthly' | 'yearly',
 *          displayed_price_revision: 'pr_…' }  // révision du prix affiché (CDC lookup_key LK-34)
 * Réponse : { url } — page Stripe (portail, flux `subscription_update_confirm`)
 * où l'utilisateur confirme et règle le prorata. Au retour :
 * `/mon-compte/offres?changement=confirme`, qui déclenche
 * `POST /api/billing/sync-subscription`.
 *
 * Réservé au propriétaire du compte, comme le reste de la facturation.
 * Le client ne transmet jamais de Price ID (CDC §5.6).
 */
const MESSAGES: Record<string, string> = {
  INVALID_TARGET: "L'offre ou la périodicité demandée est invalide.",
  NO_SUBSCRIPTION: "Aucun abonnement n'est associé à ce compte.",
  NOT_AN_UPGRADE: "Cette offre n'est pas une montée en gamme : son changement est programmé à l'échéance.",
  SUBSCRIPTION_NOT_ACTIVE: "Votre abonnement n'est pas actif : il ne peut pas être modifié pour le moment.",
  NO_STRIPE_CUSTOMER: "Aucun compte de facturation n'est associé à ce compte.",
  SCHEDULE_RELEASE_FAILED: "Un changement d'offre programmé n'a pas pu être annulé. Réessayez dans un instant ou annulez-le depuis Mon compte.",
  UNRECOGNIZED_SUBSCRIPTION_ITEM: "Votre abonnement n'a pas pu être vérifié. Aucun changement n'a été fait. Contactez le support si le problème persiste.",
  MUTATION_IN_PROGRESS: "Une modification de votre abonnement est déjà en cours. Patientez quelques minutes avant de réessayer.",
  PORTAL_UNAVAILABLE: "La page de paiement est momentanément indisponible. Aucun changement n'a été fait.",
};

export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const [membership] = await db
      .select({ accountId: accountMemberships.accountId, role: accountMemberships.role })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, session.userId))
      .limit(1);

    if (!membership) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 404 });
    if (membership.role !== 'owner') {
      return NextResponse.json(
        { error: 'FORBIDDEN_BILLING_ACTION', code: 'FORBIDDEN_BILLING_ACTION', message: CATALOG_ERROR_MESSAGES.FORBIDDEN_BILLING_ACTION },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const result = await startImmediateUpgrade({
      accountId: membership.accountId,
      planCode: typeof body.plan_code === 'string' ? body.plan_code.toLowerCase() : '',
      billingPeriod: typeof body.billing_period === 'string' ? body.billing_period : '',
      appBaseUrl: getAppBaseUrl(request),
      displayedPriceRevision: body.displayed_price_revision,
      userId: session.userId,
    });

    if (!result.ok) {
      const catalogCode = result.reason in CATALOG_ERROR_HTTP ? (result.reason as BillingCatalogErrorCode) : null;
      return NextResponse.json(
        {
          error: result.reason,
          code: result.reason,
          message: catalogCode ? CATALOG_ERROR_MESSAGES[catalogCode] : MESSAGES[result.reason],
          ...(result.offer ? { offer: result.offer, details: { offer: result.offer } } : {}),
        },
        { status: catalogCode ? CATALOG_ERROR_HTTP[catalogCode] : result.reason === 'MUTATION_IN_PROGRESS' ? 409 : result.reason === 'PORTAL_UNAVAILABLE' ? 503 : 400 },
      );
    }
    return NextResponse.json({ url: result.url, offer: result.offer, scheduled_change_released: result.scheduledChangeReleased });
  } catch (error) {
    if (error instanceof Error && ['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED'].includes(error.message)) {
      return SessionService.handleSessionError(error);
    }
    console.error('[billing/upgrade] erreur :', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Impossible d’ouvrir la page de paiement.' },
      { status: 500 },
    );
  }
}
