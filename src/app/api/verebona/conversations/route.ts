/**
 * GET  /api/verebona/conversations — fils de conversation de L'UTILISATEUR.
 * POST /api/verebona/conversations — crée explicitement un nouveau fil.
 *
 * Un nouveau fil démarre sans aucune mémoire des autres : seules les données
 * métier du compte restent consultables par l'assistant. Les fils sont
 * privés à l'utilisateur, y compris en Duo (compte + utilisateur de session).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { getAssistantConfig } from '@/services/verebona-assistant';
import { createConversation, listConversations } from '@/services/verebona-assistant/core/conversation.service';

export async function GET(req: NextRequest) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  return NextResponse.json({ conversations: await listConversations(accountId, session.userId) });
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  const conversationId = await createConversation(accountId, session.userId, getAssistantConfig().locale);
  return NextResponse.json({ conversationId }, { status: 201 });
}
