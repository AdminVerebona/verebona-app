/**
 * GET /api/verebona/conversation?conversationId=… — historique d'UN fil (§24, §27.3).
 *   Sans identifiant : le fil le plus récent de l'utilisateur (rien n'est créé).
 * DELETE /api/verebona/conversation?conversationId=… — efface ce fil (§24.5).
 *   Sans identifiant : efface tout l'historique de l'utilisateur.
 *
 * En Duo, chaque membre n'accède qu'à ses propres fils : la propriété est
 * contrôlée en base sur l'identifiant de session ; un identifiant de fil
 * appartenant à un autre utilisateur est traité comme inexistant (404).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import {
  clearUserHistory,
  findLatestConversation,
  findOwnedConversation,
  listActiveMessages,
} from '@/services/verebona-assistant/core/conversation.service';
import { chargerClarification } from '@/services/verebona-assistant/core/clarification.service';
import { isExpired } from '@/services/verebona-assistant/core/clarification-builder';

/** `undefined` : absent ; `null` : présent mais invalide. */
function parseConversationId(req: NextRequest): number | null | undefined {
  const raw = req.nextUrl.searchParams.get('conversationId');
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const notFound = () => NextResponse.json({ error: 'CONVERSATION_NOT_FOUND' }, { status: 404 });

export async function GET(req: NextRequest) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  const requested = parseConversationId(req);
  if (requested === null) return notFound();

  const conversationId = requested === undefined
    ? await findLatestConversation(accountId, session.userId)
    : await findOwnedConversation(accountId, session.userId, requested);
  if (requested !== undefined && !conversationId) return notFound();
  if (!conversationId) return NextResponse.json({ conversationId: null, messages: [] });

  const messages = await listActiveMessages(accountId, session.userId, conversationId);

  // Clarification encore en attente dans ce fil : rendue pour que l'utilisateur
  // puisse y répondre après un rechargement ou une reconnexion. Seuls la
  // question et les choix sortent — l'état interne reste côté serveur.
  const { etat } = await chargerClarification(accountId, session.userId, undefined, conversationId);
  const clarification = etat && etat.originalMessage && (!etat.status || etat.status === 'PENDING') && !isExpired(etat)
    ? {
        clarificationId: etat.clarificationId,
        question: etat.question,
        expiresAt: etat.expiresAt,
        choices: etat.candidates.map((c) => ({ choiceId: c.id, label: c.label, secondaryLabel: c.secondaryLabel })),
      }
    : null;
  return NextResponse.json({ conversationId, messages, clarification });
}

export async function DELETE(req: NextRequest) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  const requested = parseConversationId(req);
  if (requested === null) return notFound();

  const purge = await clearUserHistory(accountId, session.userId, requested);
  if (requested !== undefined && purge.conversations === 0) return notFound();
  return NextResponse.json({ ok: true, deleted: purge.conversations });
}
