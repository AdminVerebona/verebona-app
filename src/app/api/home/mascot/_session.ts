import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';

/**
 * Session et compte courant — toutes les routes de la mascotte vérifient le
 * compte de la session (SEC-006) : aucun identifiant reçu n'est cru sur parole.
 */
export async function mascotSession(req: NextRequest): Promise<
  { ok: true; accountId: number; userId: number } | { ok: false; response: NextResponse }
> {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return { ok: false, response: SessionService.handleSessionError(e) as NextResponse };
  }
  if (!session.currentAccountId) {
    return { ok: false, response: NextResponse.json({ error: 'No account selected' }, { status: 400 }) };
  }
  return { ok: true, accountId: session.currentAccountId, userId: session.userId };
}
