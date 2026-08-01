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
  const accountId = session.currentAccountId;
  const { requestId } = await params;

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
     WHERE request_id = ${requestId}
       AND account_id = ${accountId}
       AND status NOT IN ('ok', 'error', 'cancelled')
    RETURNING id
  `;

  if (annulees.length === 0) {
    // Existe-t-elle, et dans quel état ?
    const [existante] = await pgClient<{ status: string }[]>`
      SELECT status FROM verebona_request_runs
       WHERE request_id = ${requestId} AND account_id = ${accountId}
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
     WHERE request_id = ${requestId}
       AND account_id = ${accountId}
       AND status = 'pending'
  `;

  return NextResponse.json({ ok: true, requestId, status: 'cancelled' });
}
