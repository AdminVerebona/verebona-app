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
import { assistantPlanFromEntitlements, assistantPlanLimit } from '@/services/verebona-assistant/core/plan-eligibility';
import { checkAssistantRateLimit } from '@/lib/verebona/rate-limit';
import { httpRequestId, parseWith, readJson, withRequestId } from '@/lib/verebona/api-guard';
import { ClarificationAnswerSchema, ClarificationParamsSchema } from '@/lib/verebona/api-schemas';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ clarificationId: string }> },
) {
  const httpId = httpRequestId(req);
  return withRequestId(await traiter(req, ctx, httpId), httpId);
}

async function traiter(
  req: NextRequest,
  { params }: { params: Promise<{ clarificationId: string }> },
  httpId: string,
): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }

  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  // La reprise relance le pipeline : même quota que l'envoi d'une question
  // (§6.6, §31.10).
  const rl = checkAssistantRateLimit(session.userId, accountId, getAssistantConfig().rateLimitPerMinute);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: 'Vous avez posé beaucoup de questions en peu de temps. Réessayez dans un instant.', recoverable: true } },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  await ensureMigrations();
  // Entrées validées par schéma (§27.3) : identifiant de clarification et
  // choix proposé ; jamais un identifiant d'objet arbitraire.
  const p = parseWith(ClarificationParamsSchema, await params, httpId);
  if (!p.ok) return p.response;
  const { clarificationId } = p.data;
  const b = parseWith(ClarificationAnswerSchema, await readJson(req), httpId);
  if (!b.ok) return b.response;
  const { choiceId } = b.data;

  // La reprise relance le pipeline (éventuellement un appel modèle) : mêmes
  // droits que l'envoi d'une question.
  // Fin d'essai (§6.5) : la reprise reste possible SANS IA (offre Standard
  // effective) ; refus seulement si le compte n'est plus consultable.
  const entitlements = await getEntitlements(accountId);
  if (assistantPlanLimit(entitlements) === 'NO_ACCESS') {
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
    conversationId: b.data.conversationId ?? undefined,
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
