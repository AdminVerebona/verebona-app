/**
 * GET /api/verebona/conversation   — récupère la conversation active + historique 7 j (§24, §27.3).
 * DELETE /api/verebona/conversation — efface l'historique du compte (§24.5).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations, pgClient } from '@/db';
import { clearAccountHistory } from '@/services/verebona-assistant/core/conversation.service';

export async function GET(req: NextRequest) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  const messages = await pgClient.unsafe(
    `SELECT id, role, content, intent, mode, created_at
       FROM verebona_messages
      WHERE account_id = $1 AND expires_at > now()
      ORDER BY created_at ASC
      LIMIT 200`,
    [accountId],
  );
  return NextResponse.json({ messages });
}

export async function DELETE(req: NextRequest) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  await clearAccountHistory(accountId);
  return NextResponse.json({ ok: true });
}
