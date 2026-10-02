/**
 * POST /api/verebona/messages/[messageId]/feedback — CDC §27.10.
 * Enregistre un avis (utile / pas utile + motif). Dernière valeur par (message, user).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations, pgClient } from '@/db';
import { MESSAGE_OWNED_BY_USER } from '@/services/verebona-assistant/core/conversation.service';
import { httpRequestId, mutationRateLimited, parseWith, readJson } from '@/lib/verebona/api-guard';
import { FeedbackSchema, MessageParamsSchema } from '@/lib/verebona/api-schemas';

// Valeurs et motifs autorisés (§27.10) : `FeedbackSchema` (lib/verebona/api-schemas).

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
  // §27 : identifiant et corps validés par schéma ; §31.10 : limiteur des
  // routes qui écrivent.
  const httpId = httpRequestId(req);
  const limite = await mutationRateLimited(session.userId, accountId, 'feedback', httpId, req);
  if (limite) return limite;
  const p = parseWith(MessageParamsSchema, await params, httpId);
  if (!p.ok) return p.response;
  const { messageId } = p.data;
  const b = parseWith(FeedbackSchema, await readJson(req), httpId);
  if (!b.ok) return b.response;
  const value = b.data.value;
  const reason = b.data.reason ?? null;

  // Propriété : message d'une conversation de L'UTILISATEUR (les fils sont
  // privés en Duo) + upsert (dernière valeur remplace — §27.10).
  await pgClient.unsafe(
    `INSERT INTO verebona_feedback (message_id, account_id, user_id, value, reason)
       SELECT $1, $2, $3, $4, $5
        WHERE EXISTS (SELECT 1 FROM verebona_messages m
                       WHERE m.id = $1 AND m.account_id = $2
                         AND ${MESSAGE_OWNED_BY_USER('m', '$2', '$3')})
     ON CONFLICT (message_id, user_id) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, created_at = now()`,
    [messageId, accountId, session.userId, value, reason],
  );
  return NextResponse.json({ ok: true });
}
