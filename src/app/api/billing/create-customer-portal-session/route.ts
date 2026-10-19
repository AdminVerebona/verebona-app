import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { getAppBaseUrl } from '@/lib/app-url';
import { PortalConfigurationUnavailableError, createCustomerPortalSession, resolveBillingPortalAccess } from '@/services/billing/customer-portal.service';

/**
 * POST /api/billing/create-customer-portal-session
 * Crée une session Stripe Customer Portal pour gérer l'abonnement.
 * IMPORTANT : accessible uniquement au TITULAIRE du compte facturé.
 *
 * Lot 68C : logique factorisée (`services/billing/customer-portal.service.ts`),
 * partagée avec le lien permanent des e-mails (`/mon-compte/abonnement/gerer`,
 * rappel J−7 avant renouvellement annuel). L'invité d'un Premium Duo reçoit un
 * refus explicite (`DUO_GUEST`), sans aucune donnée du titulaire.
 * Réponse inchangée : `{ portal_url }`, ou `{ code, message }` en erreur.
 *
 * Lot 70B : la session utilise la configuration Verebona du portail
 * (résiliation à la fin de la période). Configuration indisponible et
 * configuration par défaut non conforme : 503 `PORTAL_SESSION_FAILED`
 * (« Réessayer » proposé ; anomalie BO signalée par le service).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const access = await resolveBillingPortalAccess(session.userId, session.currentAccountId);
    if (!access.ok) {
      return NextResponse.json({ code: access.code, message: access.message }, { status: access.status });
    }
    const portalUrl = await createCustomerPortalSession({
      customerId: access.customerId,
      returnUrl: `${getAppBaseUrl(request)}/mon-compte`,
    });
    return NextResponse.json({ portal_url: portalUrl });
  } catch (error) {
    if (error instanceof Error && /AUTH_REQUIRED|INVALID_TOKEN|ACCOUNT_SUSPENDED|SESSION_UNAVAILABLE|ACCOUNT_PENDING_DELETION/.test(error.message)) {
      return SessionService.handleSessionError(error);
    }
    if (error instanceof PortalConfigurationUnavailableError) {
      console.error('[Customer Portal Error]', error.message);
      return NextResponse.json(
        { code: 'PORTAL_SESSION_FAILED', message: 'L’espace de gestion Stripe est momentanément indisponible. Réessayez dans quelques instants.' },
        { status: 503 },
      );
    }
    console.error('[Customer Portal Error]', error instanceof Error ? error.message : error);
    return NextResponse.json(
      { code: 'PORTAL_SESSION_FAILED', message: 'Failed to create customer portal session' },
      { status: 500 },
    );
  }
}
