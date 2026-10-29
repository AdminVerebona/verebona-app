/**
 * GET /api/users/me/security — vue consolidée de Mon compte › Sécurité
 * (lot 92, CDC 18 §27, §29). Aucune IP, aucun secret.
 *
 *   · `reauth` : la session courante a-t-elle une preuve fraîche (et jusqu'à
 *     quand), méthodes de confirmation utilisables (mot de passe ; Google /
 *     Apple quand le sous-lot 93 les enregistre) ;
 *   · `loginMethods.password` : mot de passe local configuré ;
 *   · `biometrics` : non disponible côté serveur (biométrie locale de
 *     l'application, lot mobile).
 * Lot 96B (décisions PO Q2-Q4) : aucune double authentification en V1 — le
 * champ `twoFactor` est retiré (aucun écran ne l'annonce).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { getReauthState, listReauthMethodsFor } from '@/lib/auth/reauth';
// Lot 93 : enregistre Google / Apple comme méthodes de confirmation (à redirection).
import '@/lib/auth/oauth/reauth-bridge';

export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const [state, methods] = await Promise.all([
      getReauthState(session.userId, session.sid),
      listReauthMethodsFor(session.userId),
    ]);
    return NextResponse.json({
      email: session.email,
      loginMethods: { password: { configured: methods.some((m) => m.id === 'password') } },
      biometrics: { available: false },
      reauth: {
        fresh: state.state === 'fresh',
        freshUntil: state.state === 'fresh' ? state.proof.expiresAt.toISOString() : null,
        methods,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
