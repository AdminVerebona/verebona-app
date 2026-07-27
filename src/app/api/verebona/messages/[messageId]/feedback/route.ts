/**
 * POST /api/verebona/messages/[messageId]/feedback — CDC §27.10.
 * Enregistre un avis (utile / pas utile + motif). Dernière valeur par (message, user).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations, pgClient } from '@/db';

const VALUES = new Set(['helpful', 'not_helpful']);
const REASONS = new Set(['incorrect_answer', 'missing_information', 'wrong_source', 'wrong_action', 'too_long', 'other']);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  const { messageId } = await params;
  const body = await req.json().catch(() => ({}));
  const value = String(body.value ?? '');
  const reason = body.reason ? String(body.reason) : null;
  if (!VALUES.has(value)) return NextResponse.json({ error: 'INVALID_VALUE' }, { status: 400 });
  if (reason && !REASONS.has(reason)) return NextResponse.json({ error: 'INVALID_REASON' }, { status: 400 });

  // Propriété compte + upsert (dernière valeur remplace — §27.10).
  await pgClient.unsafe(
    `INSERT INTO verebona_feedback (message_id, account_id, user_id, value, reason)
       SELECT $1, $2, $3, $4, $5
        WHERE EXISTS (SELECT 1 FROM verebona_messages WHERE id = $1 AND account_id = $2)
     ON CONFLICT (message_id, user_id) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, created_at = now()`,
    [messageId, accountId, session.userId, value, reason],
  );
  return NextResponse.json({ ok: true });
}
