import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { db } from '@/db';
import { notificationOutbox } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { processOutboxIds } from '@/lib/notifications';

/**
 * POST /api/admin/notifications/[outboxId]/resend  (CDC §20.3)
 * Réémet un événement : le remet en file puis relance le dispatcher. La cloche
 * reste dédupliquée (pas de doublon) ; push et email sont renvoyés.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ outboxId: string }> },
) {
  try {
    await requireAdmin(request);
  } catch {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }

  const { outboxId } = await params;

  const [row] = await db.select({ id: notificationOutbox.id })
    .from(notificationOutbox).where(eq(notificationOutbox.id, outboxId)).limit(1);
  if (!row) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  await db.update(notificationOutbox)
    .set({ status: 'pending', processedAt: null, attemptCount: 0, lastError: null })
    .where(eq(notificationOutbox.id, outboxId));

  const summary = await processOutboxIds([outboxId]);
  return NextResponse.json({ ok: true, summary });
}
