/**
 * POST /api/verebona/commands/[planId]/cancel — annulation, par l'utilisateur,
 * d'une commande proposée par l'assistant et pas encore confirmée.
 *
 * Aucune écriture métier n'a lieu : le plan passe à CANCELLED (ou EXPIRED si
 * sa validité est dépassée), l'issue est tracée et enregistrée dans le fil.
 * Idempotente : rejouée, elle rend le même résultat (200).
 *
 *   200 { planId, status: 'CANCELLED' | 'EXPIRED', message, alreadyHandled }
 *   404 PLAN_NOT_FOUND        plan inexistant, d'un autre compte ou d'un autre utilisateur
 *   409 PLAN_ALREADY_HANDLED  plan déjà confirmé (plus annulable ici)
 *
 * Interrupteur VEREBONA_ASSISTANT_WRITE_COMMANDS coupé : l'annulation reste
 * possible. Elle n'écrit rien dans les données du compte, et elle permet de
 * clore une proposition affichée avant la bascule (la confirmation, elle,
 * est refusée).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { httpRequestId, mutationRateLimited, withRequestId } from '@/lib/verebona/api-guard';
import { PlanParamsSchema } from '@/lib/verebona/api-schemas';
import { cancelCommandPlan } from '@/services/verebona-assistant/commands/plan.service';

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

  await ensureMigrations();
  // §27 : identifiant validé par schéma ; un identifiant mal formé est
  // traité comme inexistant (rien n'est révélé).
  const parsed = PlanParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'PLAN_NOT_FOUND', message: 'Cette action n’existe pas ou ne vous appartient pas.', recoverable: false } }, { status: 404 });
  }
  const { planId } = parsed.data;
  const r = await cancelCommandPlan({ planId, accountId, userId: session.userId });
  if (!r.ok) {
    return NextResponse.json(
      { error: { code: r.code, message: r.message, recoverable: false }, status: r.status ?? null },
      { status: r.code === 'PLAN_NOT_FOUND' ? 404 : 409 },
    );
  }
  return NextResponse.json({ planId, status: r.status, message: r.message, alreadyHandled: r.alreadyHandled });
}
