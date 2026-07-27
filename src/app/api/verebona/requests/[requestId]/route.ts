/**
 * GET /api/verebona/requests/[requestId]    — statut d'une demande (polling/annulation UI, §27.5).
 * DELETE /api/verebona/requests/[requestId]  — annule une demande en cours (§7.8, §30.5).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations, pgClient } from '@/db';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  const { requestId } = await params;
  const rows = await pgClient.unsafe(
    `SELECT request_id, status, mode, error_code, created_at
       FROM verebona_request_runs
      WHERE request_id = $1 AND account_id = $2 LIMIT 1`,
    [requestId, accountId],
  );
  const list = rows as unknown[];
  if (!list.length) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  return NextResponse.json(list[0]);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  if (!session.currentAccountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  const { requestId } = await params;
  // TODO(CDC §30.5) : marquer la demande CANCELLED (l'exécution serveur honore l'AbortController).
  return NextResponse.json({ ok: true, requestId, status: 'cancelled' });
}
