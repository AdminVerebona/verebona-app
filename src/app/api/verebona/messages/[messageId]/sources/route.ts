/**
 * GET /api/verebona/messages/[messageId]/sources — CDC §19 / §27.6.
 * Renvoie les sources résolues d'un message (≤ 5 affichées), avec disponibilité.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations, pgClient } from '@/db';

export async function GET(
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
  // Propriété : le message doit appartenir au compte (§29.1).
  const sources = await pgClient.unsafe(
    `SELECT s.source_type, s.source_id, s.title_snapshot, s.excerpt_snapshot, s.is_available, s.rank
       FROM verebona_message_sources s
       JOIN verebona_messages m ON m.id = s.message_id
      WHERE s.message_id = $1 AND m.account_id = $2
      ORDER BY s.rank ASC NULLS LAST
      LIMIT 5`,
    [messageId, accountId],
  );
  return NextResponse.json({ sources });
}
