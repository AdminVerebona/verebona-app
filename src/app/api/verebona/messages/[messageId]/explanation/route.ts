/**
 * GET /api/verebona/messages/[messageId]/explanation — « Pourquoi ? » (CDC §19.7 / §27.7).
 * Renvoie le mapping affirmation → sources.
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
  const rows = await pgClient.unsafe(
    `SELECT c.claim_text, c.derivation,
            coalesce(json_agg(s.title_snapshot) FILTER (WHERE s.id IS NOT NULL), '[]') AS sources
       FROM verebona_message_claims c
       JOIN verebona_messages m ON m.id = c.message_id
       LEFT JOIN verebona_claim_sources cs ON cs.claim_id = c.id
       LEFT JOIN verebona_message_sources s ON s.id = cs.message_source_id
      WHERE c.message_id = $1 AND m.account_id = $2
      GROUP BY c.id, c.claim_text, c.derivation`,
    [messageId, accountId],
  );
  return NextResponse.json({ explanation: rows });
}
