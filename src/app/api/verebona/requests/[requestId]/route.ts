/**
 * GET /api/verebona/requests/[requestId]    — statut d'une demande (polling/annulation UI, §27.5).
 * DELETE /api/verebona/requests/[requestId]  — annule une demande en cours (§7.8, §30.5).
 *
 * `[requestId]` accepte l'identifiant serveur OU le `clientRequestId` généré
 * par le client : celui-ci peut ainsi annuler une demande dont il n'a pas
 * encore reçu la réponse (la réservation `pending` est écrite au début du
 * traitement — `request-lifecycle.service.ts`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations, pgClient } from '@/db';
import { httpRequestId, mutationRateLimited, parseWith, readRateLimited, withRequestId } from '@/lib/verebona/api-guard';
import { RequestParamsSchema } from '@/lib/verebona/api-schemas';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ requestId: string }> },
) {
  // §27 : requestId journalisé et renvoyé (x-request-id) sur toute réponse.
  const httpId = httpRequestId(req);
  return withRequestId(await lire(req, ctx, httpId), httpId);
}

async function lire(
  req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
  httpId: string,
): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  // §27 : lectures limitées elles aussi (le client interroge l'état en boucle).
  const limite = await readRateLimited(session.userId, accountId, httpId, req);
  if (limite) return limite;

  await ensureMigrations();
  // §27 : identifiant validé par schéma avant toute requête.
  const p = parseWith(RequestParamsSchema, await params, httpId);
  if (!p.ok) return p.response;
  const { requestId } = p.data;
  const rows = await pgClient.unsafe(
    `SELECT request_id, status, mode, error_code, created_at
       FROM verebona_request_runs
      WHERE (request_id = $1 OR client_request_id = $1) AND account_id = $2 AND user_id = $3
      ORDER BY id DESC LIMIT 1`,
    [requestId, accountId, session.userId],
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
  const accountId = session.currentAccountId;
  // §31.10 : l'annulation est une écriture — limiteur dédié ; §27 : schéma.
  const httpId = httpRequestId(req);
  const limite = await mutationRateLimited(session.userId, accountId, 'cancel', httpId, req);
  if (limite) return limite;
  const p = parseWith(RequestParamsSchema, await params, httpId);
  if (!p.ok) return p.response;
  const { requestId } = p.data;

  // ══════════════════════════════════════════════════════════════════════
  // ANNULER, PAS SEULEMENT LE DIRE
  //
  // La route répondait « cancelled » sans rien écrire. L'utilisateur voyait
  // sa demande annulée, la trace restait « ok », et le message continuait
  // d'apparaître dans l'historique — deux vérités contradictoires.
  //
  // Le bornage au compte est dans la clause WHERE : une demande d'un autre
  // compte n'est jamais atteinte, donc jamais annulée par un identifiant
  // deviné.
  //
  // Seule une demande EN COURS peut être annulée. Une demande terminée l'est
  // déjà : la marquer annulée réécrirait un fait accompli, et fausserait
  // l'évaluation de qualité du §35, qui compte les échecs.
  // ══════════════════════════════════════════════════════════════════════
  const annulees = await pgClient`
    UPDATE verebona_request_runs
       SET status = 'cancelled'
     WHERE (request_id = ${requestId} OR client_request_id = ${requestId})
       AND account_id = ${accountId}
       AND user_id = ${session.userId}
       AND status NOT IN ('ok', 'error', 'cancelled')
    RETURNING id, request_id
  `;

  if (annulees.length === 0) {
    // Existe-t-elle, et dans quel état ?
    const [existante] = await pgClient<{ status: string }[]>`
      SELECT status FROM verebona_request_runs
       WHERE (request_id = ${requestId} OR client_request_id = ${requestId}) AND account_id = ${accountId}
         AND user_id = ${session.userId}
       LIMIT 1
    `;
    if (!existante) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    // Déjà terminée : ce n'est pas une erreur, mais le dire évite de laisser
    // croire que l'annulation a interrompu quelque chose.
    return NextResponse.json(
      { ok: false, requestId, status: existante.status, motif: 'DEJA_TERMINEE' },
      { status: 409 },
    );
  }

  // Le message correspondant cesse d'attendre : sans cela, l'historique
  // montrerait une réponse « en cours » qui n'arrivera jamais.
  await pgClient`
    UPDATE verebona_messages
       SET status = 'cancelled'
     WHERE request_id = ${String((annulees[0] as { request_id: string }).request_id)}
       AND account_id = ${accountId}
       AND conversation_id IN (SELECT id FROM verebona_conversations
                                WHERE account_id = ${accountId} AND user_id = ${session.userId})
       AND status = 'pending'
  `;

  return NextResponse.json({ ok: true, requestId: (annulees[0] as { request_id: string }).request_id, status: 'cancelled' });
}
