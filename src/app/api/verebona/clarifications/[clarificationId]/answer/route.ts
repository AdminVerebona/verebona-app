/**
 * POST /api/verebona/clarifications/[clarificationId]/answer — CDC §20.4, §20.5.
 *
 * Reprend la demande INITIALE avec le candidat choisi.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REPRISE STRUCTURÉE, PAS CONCATÉNATION
 *
 * La route reconstruisait un message « question de clarification + libellé
 * choisi » et relançait tout le raisonnement. Rien ne garantissait de
 * retrouver l'intention ni le contexte de la demande d'origine.
 *
 * Désormais : l'état complet enregistré à la création (demande, intention,
 * contexte, candidats) est rechargé ; le choix est contrôlé (propriété,
 * expiration, tentatives, appartenance aux candidats, existence en base) puis
 * injecté comme paramètre (`resume.assetId`) dans la demande initiale, qui
 * garde son intention.
 *
 * Les contrôles vivent dans `clarification.service`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { runAssistant } from '@/services/verebona-assistant/core/assistant-orchestrator.service';
import { buildOrchestratorPorts } from '@/services/verebona-assistant/core/ports';
import { getAssistantConfig } from '@/services/verebona-assistant/config/assistant-config';
import { getEntitlements } from '@/services/entitlements.service';
import { refuserSiPasDIA } from '@/lib/write-access-guard';
import { toApiPayload } from '@/services/verebona-assistant/core/api-payload';
import { executerIssueClarification } from '@/services/verebona-assistant/core/clarification-flow';
import { resoudreClarification } from '@/services/verebona-assistant/core/clarification.service';
import { assistantPlanFromEntitlements } from '@/services/verebona-assistant/core/plan-eligibility';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clarificationId: string }> },
) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }

  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  const { clarificationId } = await params;
  const body = await req.json().catch(() => ({}));
  const choiceId = typeof body.choiceId === 'string' ? body.choiceId : '';
  if (!choiceId) return NextResponse.json({ error: 'MISSING_CHOICE' }, { status: 400 });

  // La reprise relance le pipeline (éventuellement un appel modèle) : mêmes
  // droits que l'envoi d'une question.
  const entitlements = await getEntitlements(accountId);
  if (!entitlements.canWrite) {
    const refus = await refuserSiPasDIA(accountId);
    if (refus) return refus;
  }

  // Bornage compte + utilisateur (+ fil) dans la requête de chargement : la
  // clarification de l'autre membre d'un Duo, ou d'un autre fil, n'est
  // jamais chargée.
  const issue = await resoudreClarification({
    accountId,
    userId: session.userId,
    clarificationId,
    conversationId: Number(body.conversationId) || undefined,
    choiceId,
  });

  const cfg = getAssistantConfig();
  const out = await executerIssueClarification(issue, {
    accountId,
    userId: session.userId,
    // Même dérivation que l'envoi d'un message : essai = Premium (§6.5).
    planType: assistantPlanFromEntitlements(entitlements, session.planType),
    locale: cfg.locale,
  }, { runAssistant, ports: buildOrchestratorPorts() });

  if (out.kind === 'rejected') {
    return NextResponse.json(
      {
        status: 'error',
        error: { code: out.code, message: out.message, recoverable: true },
      },
      // 409 et non 403 : distinguer « n'existe pas » de « ne vous appartient
      // pas » renseignerait sur l'existence de clarifications tierces.
      { status: 409 },
    );
  }
  if (out.kind === 'abandoned') {
    // Impossible pour un choix cliqué ; par prudence, rien n'est repris.
    return NextResponse.json({ status: 'error', error: { code: 'CLARIFICATION_REJECTED', message: 'Reformulez votre demande.', recoverable: true } }, { status: 409 });
  }
  return NextResponse.json({ ...toApiPayload(out.result), clarificationId });
}
