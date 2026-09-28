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
import { reverifierCartesDesMessages } from '@/services/verebona-assistant/core/source-availability.service';
import { listThreadCommandPlans } from '@/services/verebona-assistant/commands/plan.service';
import { httpRequestId, mutationRateLimited, parseWith, queryObject, readRateLimited, withRequestId } from '@/lib/verebona/api-guard';
import { ConversationQuerySchema } from '@/lib/verebona/api-schemas';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';

/** `undefined` : absent ; `null` : présent mais invalide. */
function parseConversationId(req: NextRequest): number | null | undefined {
  const raw = req.nextUrl.searchParams.get('conversationId');
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const notFound = () => NextResponse.json({ error: 'CONVERSATION_NOT_FOUND' }, { status: 404 });

export async function GET(req: NextRequest) {
  const httpId = httpRequestId(req);
  return withRequestId(await lire(req, httpId), httpId);
}

async function lire(req: NextRequest, httpId: string): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  // §27 : lectures limitées elles aussi (limiteur dédié de l'assistant).
  const limite = readRateLimited(session.userId, accountId, httpId);
  if (limite) return limite;

  await ensureMigrations();
  // §27.6 : `limit` (≤ 50), `cursor` / `before` validés par schéma.
  const q = parseWith(ConversationQuerySchema, queryObject(req), httpId);
  if (!q.ok) return q.response;
  const requested = parseConversationId(req);
  if (requested === null) return notFound();

  const conversationId = requested === undefined
    ? await findLatestConversation(accountId, session.userId)
    : await findOwnedConversation(accountId, session.userId, requested);
  if (requested !== undefined && !conversationId) return notFound();
  if (!conversationId) return NextResponse.json({ conversationId: null, messages: [] });

  // Page la plus récente, ou messages antérieurs au curseur (§27.6).
  const page = await listActiveMessages(accountId, session.userId, conversationId, {
    limit: q.data.limit, before: q.data.cursor ?? q.data.before ?? null,
  });
  // §19.10 : les cartes relues depuis l'historique sont REVÉRIFIÉES — un
  // objet supprimé ou devenu inaccessible depuis perd son lien.
  const messages = await reverifierCartesDesMessages(
    page.messages as unknown as Array<{ result_groups_json?: unknown }>,
    accountId,
  );

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
  // Commandes proposées dans ce fil, avec leur état réel (§9.6 : en attente,
  // annulée, expirée, exécutée) : une proposition encore en attente reste
  // annulable après un rechargement ; une proposition close n'offre plus de
  // bouton. Seuls les plans de l'utilisateur sortent.
  const commandPlans = await listThreadCommandPlans(accountId, session.userId, conversationId).catch((e) => {
    console.error('[verebona] plans du fil illisibles :', (e as Error).message);
    return [];
  });
  // `nextCursor` : à renvoyer en `cursor` pour charger les messages plus anciens.
  return NextResponse.json({ conversationId, messages, nextCursor: page.nextCursor, clarification, commandPlans });
}

export async function DELETE(req: NextRequest) {
  const httpId = httpRequestId(req);
  return withRequestId(await effacer(req, httpId), httpId);
}

async function effacer(req: NextRequest, httpId: string): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  // §31.10 : limiteur des routes qui écrivent.
  const limite = mutationRateLimited(session.userId, accountId, 'conversation', httpId);
  if (limite) return limite;
  const q = parseWith(ConversationQuerySchema, queryObject(req), httpId);
  if (!q.ok) return q.response;

  await ensureMigrations();
  const requested = parseConversationId(req);
  if (requested === null) return notFound();

  const purge = await clearUserHistory(accountId, session.userId, requested);
  if (requested !== undefined && purge.conversations === 0) return notFound();
  // §31.7 : l'effacement de la conversation invalide le cache de l'assistant
  // (toutes instances) — rien de ce qui a été calculé dans le fil n'est resservi.
  if (purge.conversations > 0) {
    await emitBusinessEvent({ type: 'CONVERSATION_CLEARED', accountId, entityId: requested ?? null });
  }
  return NextResponse.json({ ok: true, deleted: purge.conversations });
}
