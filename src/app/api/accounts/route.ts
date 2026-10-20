import { NextRequest, NextResponse } from "next/server";
import { SessionService } from "@/lib/session-service";
import { listUserSpaces, noSpaceOptions } from "@/services/account/membership.service";

/**
 * GET /api/accounts — espaces de l'utilisateur (lot 72D, sélecteur d'espace).
 *
 * Adhésions ACTIVES seulement, avec rôle et offre ; un compte archivé
 * (rattrapage duo-shared-account) n'est listé que s'il est l'espace ouvert.
 * Réponse volontairement réduite : ni identifiants Stripe ni adresses des
 * autres membres (l'ancienne réponse les exposait à tout membre).
 */
export async function GET(req: NextRequest) {
  try {
    const session = await SessionService.getSession(req);
    const accounts = await listUserSpaces(session.userId, session.currentAccountId ?? null);
    // Identité sans espace (décision PO Q8) : ce que l'écran peut proposer.
    const options = accounts.length === 0 ? await noSpaceOptions(session.email) : null;
    return NextResponse.json({ accounts, currentAccountId: session.currentAccountId ?? null, options });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
