/**
 * GET /api/users/me/sessions — « Appareils connectés » (lot 92, CDC 18
 * §20.3, §27.4 ; SESS-06, SESS-09). Sessions ACTIVES de l'utilisateur
 * connecté uniquement (isolation stricte : filtrées par l'identité de la
 * session, jamais par un paramètre). Appareil, navigateur ou application,
 * dernière activité, badge « Cet appareil ». Ni IP, ni localisation, ni `sid`
 * (identifiant public dérivé).
 *
 * Une session ouverte avant le déploiement du registre apparaît à son
 * prochain renouvellement (dans les 15 minutes d'utilisation — Q5).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { listUserSessions } from '@/lib/auth/session-registry';

export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const sessions = await listUserSessions(session.userId, session.sid);
    return NextResponse.json({ sessions, currentListed: sessions.some((s) => s.current) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
