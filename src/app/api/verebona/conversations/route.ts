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
import { httpRequestId, mutationRateLimited, parseWith, readJson, withRequestId } from '@/lib/verebona/api-guard';
import { CreateConversationSchema } from '@/lib/verebona/api-schemas';

export async function GET(req: NextRequest) {
  const httpId = httpRequestId(req);
  return withRequestId(await lister(req), httpId);
}

async function lister(req: NextRequest): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  return NextResponse.json({ conversations: await listConversations(accountId, session.userId) });
}

export async function POST(req: NextRequest) {
  const httpId = httpRequestId(req);
  return withRequestId(await creer(req, httpId), httpId);
}

async function creer(req: NextRequest, httpId: string): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  // §31.10 : créer un fil est une écriture — limiteur dédié.
  const limite = await mutationRateLimited(session.userId, accountId, 'conversation', httpId, req);
  if (limite) return limite;
  // Corps facultatif, validé (§27) : aucun paramètre n'est lu.
  const b = parseWith(CreateConversationSchema, (await readJson(req)) ?? {}, httpId);
  if (!b.ok) return b.response;

  await ensureMigrations();
  const conversationId = await createConversation(accountId, session.userId, getAssistantConfig().locale);
  return NextResponse.json({ conversationId }, { status: 201 });
}
