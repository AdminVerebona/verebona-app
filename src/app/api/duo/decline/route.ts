import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { SessionService } from '@/lib/session-service';
import {
  declineDuoInvitationByToken,
  declineDuoInvitationsForEmail,
  isWellFormedInviteToken,
} from '@/services/duo/duo-invitation-decline.service';

/**
 * POST /api/duo/decline — « Refuser l'invitation » Premium Duo (lot 73B).
 *
 * Corps :
 *   · `{ token }` : lien d'invitation (page `/duo/join/[token]`). PUBLIC :
 *     l'invité non inscrit refuse sans créer de compte ; la session, si elle
 *     existe, n'est lue que pour la trace (auteur du refus) ;
 *   · `{ invitedEmail: true }` : écran « sans espace » — invitations en
 *     attente adressées à l'adresse VÉRIFIÉE de la session (session exigée).
 *
 * ANTI-ÉNUMÉRATION : une requête bien formée reçoit TOUJOURS la même réponse
 * (`200 { success: true }`), que le jeton soit inconnu, expiré, déjà accepté,
 * déjà refusé ou refusé à l'instant, et que l'adresse ait un compte ou non.
 * Aucune donnée (adresse, titulaire, Duo) n'est renvoyée. Effets et
 * idempotence : `services/duo/duo-invitation-decline.service.ts`.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const token = body?.token;
  const byEmail = body?.invitedEmail === true;

  try {
    if (token !== undefined) {
      if (!isWellFormedInviteToken(token)) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
      const session = await SessionService.tryGetSession(request);
      await declineDuoInvitationByToken(token, { byUserId: session?.userId ?? null, via: 'link' });
    } else if (byEmail) {
      const session = await SessionService.tryGetSession(request);
      if (!session) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
      // Adresse ACTUELLE relue en base (jamais une adresse fournie par le client).
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, session.userId)).limit(1);
      if (u?.email) await declineDuoInvitationsForEmail(u.email, { byUserId: session.userId });
    } else {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
  } catch (error) {
    console.error('[duo/decline] refus non enregistré :', (error as Error)?.message ?? error);
    return NextResponse.json({ error: 'DECLINE_FAILED' }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
