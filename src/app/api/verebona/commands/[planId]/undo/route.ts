/**
 * POST /api/verebona/commands/[planId]/undo — « Annuler » une action DÉJÀ
 * EXÉCUTÉE depuis l'assistant (CDC BO IA T2-038 / T2-039).
 *
 * Décision produit : proposé 15 minutes après l'exécution, pour les plans
 * dont toutes les étapes réussies sont réversibles. Règles détaillées dans
 * `commands/undo.service.ts`. Le corps ne porte aucun paramètre.
 *
 *   200 { planId, status: 'UNDONE', message, alreadyHandled, entities }
 *   403 WRITE_COMMANDS_DISABLED  interrupteur VEREBONA_ASSISTANT_WRITE_COMMANDS coupé
 *   403 WRITE_REFUSED            compte en lecture seule (offre, impayé)
 *   404 PLAN_NOT_FOUND           plan inexistant, d'un autre compte ou d'un autre utilisateur
 *   409 IRREVERSIBLE | UNDO_EXPIRED | UNDO_CONFLICT | NOT_UNDOABLE
 *
 * Interrupteur coupé : contrairement à l'annulation d'une PROPOSITION (qui
 * n'écrit rien), défaire une action exécutée ÉCRIT dans les données du
 * compte (suppression de l'échéance créée, valeur rétablie…). Elle est donc
 * refusée comme une confirmation : 403, message français, rien n'est
 * modifié — la correction reste possible depuis l'écran concerné.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { httpRequestId, mutationRateLimited, withRequestId } from '@/lib/verebona/api-guard';
import { PlanParamsSchema } from '@/lib/verebona/api-schemas';
import { areWriteCommandsEnabled, WRITE_COMMANDS_DISABLED_MESSAGE } from '@/services/verebona-assistant/config/assistant-config';
import { undoCommandPlan } from '@/services/verebona-assistant/commands/undo.service';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ planId: string }> },
) {
  const httpId = httpRequestId(req);
  return withRequestId(await traiter(req, ctx, httpId), httpId);
}

async function traiter(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
  httpId: string,
): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  // §31.10 : limiteur des routes qui écrivent.
  const limite = await mutationRateLimited(session.userId, accountId, 'command', httpId, req);
  if (limite) return limite;

  // Défaire écrit : même interrupteur que la confirmation.
  if (!areWriteCommandsEnabled()) {
    return NextResponse.json(
      { error: { code: 'WRITE_COMMANDS_DISABLED', message: WRITE_COMMANDS_DISABLED_MESSAGE, recoverable: false } },
      { status: 403 },
    );
  }

  await ensureMigrations();
  const parsed = PlanParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'PLAN_NOT_FOUND', message: 'Cette action n’existe pas ou ne vous appartient pas.', recoverable: false } }, { status: 404 });
  }
  const { planId } = parsed.data;
  const r = await undoCommandPlan({ planId, accountId, userId: session.userId });
  if (!r.ok) {
    const status = r.code === 'PLAN_NOT_FOUND' ? 404 : r.code === 'WRITE_REFUSED' ? 403 : 409;
    return NextResponse.json(
      { error: { code: r.code, message: r.message, recoverable: false }, status: r.status ?? null },
      { status },
    );
  }
  return NextResponse.json({ planId, status: r.status, message: r.message, alreadyHandled: r.alreadyHandled, entities: r.entities });
}
