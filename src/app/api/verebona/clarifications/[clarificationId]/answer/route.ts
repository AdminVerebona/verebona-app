/**
 * POST /api/verebona/clarifications/[clarificationId]/answer — CDC §20.4, §20.5.
 *
 * Reprend la demande initiale avec le candidat choisi.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA ROUTE NE VÉRIFIAIT RIEN
 *
 * Elle recevait un identifiant de clarification et le traitait, sans contrôler
 * à qui il appartenait. Un identifiant deviné aurait suffi à répondre à la
 * place d'un autre compte.
 *
 * Les quatre contrôles vivent dans `clarification.service`, où ils sont
 * testables sans base : une règle de sécurité éprouvée seulement de bout en
 * bout n'est éprouvée qu'aux endroits où quelqu'un y a pensé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { runAssistant } from '@/services/verebona-assistant/core/assistant-orchestrator.service';
import { buildOrchestratorPorts } from '@/services/verebona-assistant/core/ports';
import {
  chargerClarification,
  verifierClarification,
  consommerClarification,
  incrementerTentative,
  messageEchec,
} from '@/services/verebona-assistant/core/clarification.service';

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

  // Le bornage au compte est dans la requête : un état appartenant à un autre
  // compte n'est jamais chargé, donc jamais comparé.
  const { etat, conversationId } = await chargerClarification(accountId);
  const verdict = verifierClarification(etat, clarificationId, choiceId);

  if (!verdict.ok) {
    // Un choix invalide laisse la clarification ouverte — l'utilisateur peut
    // corriger. Une clarification expirée ou épuisée est effacée : la laisser
    // ferait croire indéfiniment qu'une question attend une réponse.
    if (conversationId && etat) {
      if (verdict.motif === 'CHOIX_INVALIDE') await incrementerTentative(conversationId, etat);
      else if (verdict.motif !== 'INTROUVABLE') await consommerClarification(conversationId);
    }
    return NextResponse.json(
      {
        status: 'error',
        error: {
          code: 'CLARIFICATION_REJECTED',
          message: messageEchec(verdict.motif),
          recoverable: verdict.motif !== 'TROP_DE_TENTATIVES',
        },
      },
      // 409 et non 403 : distinguer « n'existe pas » de « ne vous appartient
      // pas » renseignerait sur l'existence de clarifications tierces.
      { status: 409 },
    );
  }

  // La clarification est consommée AVANT la reprise : si l'analyse échoue,
  // l'utilisateur reformule plutôt que de rejouer un choix déjà fait.
  if (conversationId) await consommerClarification(conversationId);

  const resultat = await runAssistant(
    {
      accountId,
      userId: session.userId,
      planType: session.planType ?? 'STANDARD',
      // Le libellé du candidat, non son identifiant : c'est ce que
      // l'utilisateur a désigné, et ce que le routage sait interpréter.
      message: `${etat!.question} ${verdict.choix.label}`,
      clientRequestId: `clarif:${clarificationId}:${verdict.choix.id}`,
      // La session ne porte pas de langue : le français est la seule servie.
      locale: 'fr-FR',
    },
    buildOrchestratorPorts(),
  );

  return NextResponse.json({ status: 'ok', clarificationId, result: resultat });
}
