/**
 * POST /api/verebona/commands/[planId]/confirm — confirmation explicite d'une
 * commande préparée par l'assistant, puis exécution.
 *
 * Le corps ne porte AUCUN paramètre : seule l'action préparée, figée et
 * présentée à l'utilisateur est exécutée. Les contrôles (propriétaire,
 * expiration, empreinte, droits d'écriture à l'instant de la confirmation)
 * vivent dans `plan.service`. L'exécution passe par les services métier de
 * l'interface classique.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { httpRequestId, mutationRateLimited, withRequestId } from '@/lib/verebona/api-guard';
import { PlanParamsSchema } from '@/lib/verebona/api-schemas';
import { areWriteCommandsEnabled, WRITE_COMMANDS_DISABLED_MESSAGE } from '@/services/verebona-assistant/config/assistant-config';
import { confirmCommandPlan, outcomeText } from '@/services/verebona-assistant/commands/plan.service';

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

  // Écart assumé au CDC §4.8 / §22.5 : commandes d'écriture conservées sur
  // décision produit, derrière VEREBONA_ASSISTANT_WRITE_COMMANDS. Coupées,
  // un plan préparé avant la bascule ne s'exécute plus : refus propre, en
  // français, sans aucune écriture.
  if (!areWriteCommandsEnabled()) {
    return NextResponse.json(
      { error: { code: 'WRITE_COMMANDS_DISABLED', message: WRITE_COMMANDS_DISABLED_MESSAGE, recoverable: false } },
      { status: 403 },
    );
  }

  await ensureMigrations();
  // §27 : identifiant validé par schéma ; un identifiant mal formé est
  // traité comme inexistant (rien n'est révélé).
  const parsed = PlanParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'PLAN_NOT_FOUND', message: 'Cette action n’existe pas ou ne vous appartient pas.', recoverable: false } }, { status: 404 });
  }
  const { planId } = parsed.data;
  const r = await confirmCommandPlan({ planId, accountId, userId: session.userId });
  if (!r.ok) {
    const status = r.code === 'PLAN_NOT_FOUND' ? 404 : r.code === 'WRITE_REFUSED' ? 403 : 409;
    return NextResponse.json({ error: { code: r.code, message: r.message, recoverable: r.code !== 'WRITE_REFUSED' }, status: r.status ?? null }, { status });
  }
  // `message` : texte de l'issue, tel qu'enregistré dans le fil.
  // `undoUntil` : fin de la fenêtre « Annuler » (null : plan irréversible).
  return NextResponse.json({
    planId, status: r.status, summary: r.summary, results: r.results, message: outcomeText(r.summary, r.results),
    undoUntil: r.undoUntil ?? null,
  });
}
