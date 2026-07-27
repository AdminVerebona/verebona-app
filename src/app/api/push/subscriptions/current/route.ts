import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { pushSubscriptions } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * DELETE /api/push/subscriptions/current  (CDC §13.2 / §10.2)
 * Désassocie l'abonnement de l'appareil courant (identifié par son endpoint)
 * du compte connecté. Appelé à la déconnexion pour qu'un appareil partagé ne
 * reçoive plus les notifications de l'ancien compte. La souscription navigateur
 * peut rester locale et être rattachée à un futur utilisateur après consentement.
 *
 * Body: { endpoint }
 */
export async function DELETE(request: NextRequest) {
  let session;
  try { session = await getSession(request); }
  catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }

  const body = await request.json().catch(() => null);
  const endpoint: string | undefined = body?.endpoint;
  if (!endpoint) {
    return NextResponse.json({ error: 'MISSING_ENDPOINT' }, { status: 400 });
  }

  await db.update(pushSubscriptions)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(and(
      eq(pushSubscriptions.endpoint, endpoint),
      eq(pushSubscriptions.userId, session.userId),
    ));

  return NextResponse.json({ ok: true });
}
