/**
 * GET /api/verebona/messages/[messageId]/explanation — « Pourquoi ? » (CDC §19.7 / §27.7).
 * Renvoie le mapping affirmation → sources.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations, pgClient } from '@/db';
import { MESSAGE_OWNED_BY_USER } from '@/services/verebona-assistant/core/conversation.service';
import { httpRequestId, parseWith, readRateLimited, withRequestId } from '@/lib/verebona/api-guard';
import { MessageParamsSchema } from '@/lib/verebona/api-schemas';
import { explanationDetails, type ExplanationTrace } from '@/services/verebona-assistant/core/explanation';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ messageId: string }> },
) {
  // §27 : requestId journalisé et renvoyé (x-request-id) sur toute réponse.
  const httpId = httpRequestId(req);
  return withRequestId(await lire(req, ctx, httpId), httpId);
}

async function lire(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
  httpId: string,
): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  // §27 : lectures limitées elles aussi (limiteur dédié de l'assistant).
  const limite = await readRateLimited(session.userId, accountId, httpId, req);
  if (limite) return limite;

  await ensureMigrations();
  // §27 : identifiant validé par schéma (entier positif) avant toute requête.
  const p = parseWith(MessageParamsSchema, await params, httpId);
  if (!p.ok) return p.response;
  const { messageId } = p.data;
  const rows = await pgClient.unsafe(
    `SELECT c.claim_text, c.derivation,
            coalesce(json_agg(s.title_snapshot) FILTER (WHERE s.id IS NOT NULL), '[]') AS sources
       FROM verebona_message_claims c
       JOIN verebona_messages m ON m.id = c.message_id
       LEFT JOIN verebona_claim_sources cs ON cs.claim_id = c.id
       LEFT JOIN verebona_message_sources s ON s.id = cs.message_source_id
      WHERE c.message_id = $1 AND m.account_id = $2
        AND ${MESSAGE_OWNED_BY_USER('m', '$2', '$3')}
      GROUP BY c.id, c.claim_text, c.derivation`,
    [messageId, accountId, session.userId],
  );
  // §19.8 : règle ou calcul appliqué, et limites — lus dans la trace de la
  // cascade de CE message (même propriétaire), traduits en phrases courtes.
  const meta = (await pgClient.unsafe(
    `SELECT m.support_level, r.retrieval_methods_json AS trace
       FROM verebona_messages m
       LEFT JOIN verebona_request_runs r ON r.request_id = m.request_id AND r.account_id = m.account_id
      WHERE m.id = $1 AND m.account_id = $2
        AND ${MESSAGE_OWNED_BY_USER('m', '$2', '$3')}
      LIMIT 1`,
    [messageId, accountId, session.userId],
  ).catch(() => [])) as unknown as Array<{ support_level: string | null; trace: ExplanationTrace | null }>;
  const { rule, limits } = explanationDetails(meta[0]?.trace ?? null, meta[0]?.support_level ?? null);
  return NextResponse.json({ explanation: rows, rule, limits });
}
