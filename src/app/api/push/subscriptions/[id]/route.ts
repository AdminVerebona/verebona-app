import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { pushSubscriptions } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * DELETE /api/push/subscriptions/{id}  (CDC §13.2 / §10.3)
 * Révoque un appareil appartenant à l'utilisateur (bouton « Retirer »).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try { session = await getSession(request); }
  catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'MISSING_ID' }, { status: 400 });
  }

  // Ne révoque que si l'abonnement appartient bien à l'utilisateur (ownership).
  const revoked = await db.update(pushSubscriptions)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(and(
      eq(pushSubscriptions.id, id),
      eq(pushSubscriptions.userId, session.userId),
    ))
    .returning({ id: pushSubscriptions.id });

  if (revoked.length === 0) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
