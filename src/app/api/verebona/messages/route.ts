/**
 * POST /api/verebona/messages — CDC §27.1.
 *
 * Point d'entrée de l'assistant. Applique : session serveur (accountId de confiance),
 * rate limit (§6.6), idempotence (§31.9), puis délègue à l'orchestrateur. Ne fait AUCUN
 * appel Gemini directement — tout passe par le pipeline retrieval-first (§13).
 *
 * Conventions du repo : `SessionService.getSession` / `handleSessionError`,
 * `ensureMigrations`, `rateLimiter.check`, `getClientIp`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { rateLimiter, getClientIp } from '@/lib/rate-limiter';
import { ensureMigrations } from '@/db';
import { getEntitlements } from '@/services/entitlements.service';
import { refuserSiPasDIA } from '@/lib/write-access-guard';
import {
  runAssistant,
  getAssistantConfig,
  type AssistantRequestInput,
} from '@/services/verebona-assistant';
import { buildOrchestratorPorts } from '@/services/verebona-assistant/core/ports';
import {
  ConversationNotFoundError,
  findReplayedAnswer,
  resolveConversation,
} from '@/services/verebona-assistant/core/conversation.service';
import type { AssistantApiResponse, ResponseMode } from '@/services/verebona-assistant/types/contracts';
import type { VerebonaIntent } from '@/services/verebona-assistant/types/intents';
import { toApiPayload } from '@/services/verebona-assistant/core/api-payload';
import { resoudreClarification } from '@/services/verebona-assistant/core/clarification.service';
import { executerIssueClarification } from '@/services/verebona-assistant/core/clarification-flow';

export async function POST(req: NextRequest) {
  // 1. Session serveur (accountId de confiance — §27.1).
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const accountId = session.currentAccountId;
  if (!accountId) {
    return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  }

  const cfg = getAssistantConfig();
  if (!cfg.enabled) {
    return NextResponse.json({ error: 'ASSISTANT_DISABLED' }, { status: 503 });
  }

  // 2. Rate limit (§6.6) : 10 messages/min/user par défaut.
  const rl = rateLimiter.check(`verebona:${session.userId}:${getClientIp(req.headers)}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: 'Trop de messages, réessayez dans un instant.', recoverable: true } },
      { status: 429 },
    );
  }

  await ensureMigrations();

  // 3. Validation d'entrée (§7.5 : champ ≤ 2 000 caractères).
  const body = await req.json().catch(() => ({}));
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const clientRequestId = typeof body.clientRequestId === 'string' ? body.clientRequestId : '';
  if (!message) return NextResponse.json({ error: 'EMPTY_MESSAGE' }, { status: 400 });
  if (message.length > 2000) return NextResponse.json({ error: 'MESSAGE_TOO_LONG' }, { status: 400 });
  if (!clientRequestId) return NextResponse.json({ error: 'MISSING_CLIENT_REQUEST_ID' }, { status: 400 });
  // Fil choisi par l'utilisateur (optionnel). Absent : fil le plus récent.
  const requestedConversation =
    body.conversationId == null || body.conversationId === '' ? null : Number(body.conversationId);
  if (requestedConversation !== null && !Number.isInteger(requestedConversation)) {
    return NextResponse.json({ error: 'CONVERSATION_NOT_FOUND' }, { status: 404 });
  }

  // 4. Éligibilité IA via l'existant (source de vérité serveur — §15.1).
  const entitlements = await getEntitlements(accountId);

  // Essai terminé ou abonnement absent : l'assistant appelle un modèle, il
  // est refusé comme les autres traitements IA. Même réponse que les routes
  // d'écriture — le client l'affiche dans la fenêtre de fin d'essai.
  if (!entitlements.canWrite) {
    const refus = await refuserSiPasDIA(accountId);
    if (refus) return refus;
  }

  // Idempotence (§31.9), bornée à l'UTILISATEUR : une demande rejouée (réseau
  // instable, double clic) rend la réponse déjà produite sans relancer le
  // pipeline. Le même clientRequestId présenté par un autre membre du compte
  // ne retrouve rien — il n'accède jamais à la réponse d'un autre.
  const deja = await findReplayedAnswer(accountId, session.userId, clientRequestId);
  if (deja) {
    const replay: AssistantApiResponse = {
      requestId: deja.requestId,
      messageId: String(deja.messageId),
      conversationId: deja.conversationId,
      status: 'ready',
      intent: (deja.intent ?? 'UNKNOWN') as VerebonaIntent,
      mode: (deja.mode ?? 'fallback') as ResponseMode,
      answer: deja.content,
      sourcesAvailable: false,
      sourceCount: 0,
      actions: [],
      clarification: null,
    };
    return NextResponse.json({ ...replay, replayed: true });
  }

  // Le fil doit appartenir à l'utilisateur : un identifiant d'un autre fil
  // (ou d'un autre membre du Duo) est refusé, jamais remplacé en silence.
  let conversationId: number;
  try {
    conversationId = await resolveConversation(accountId, session.userId, cfg.locale, requestedConversation);
  } catch (e) {
    if (e instanceof ConversationNotFoundError) {
      return NextResponse.json(
        { error: { code: 'CONVERSATION_EXPIRED', message: 'Cette conversation n’existe plus. Démarrez-en une nouvelle.', recoverable: true } },
        { status: 404 },
      );
    }
    throw e;
  }

  const input: AssistantRequestInput = {
    accountId,
    userId: session.userId,
    planType: entitlements.premiumFeatures ? session.planType : 'STANDARD',
    message,
    pageContext: body.pageContext ?? undefined,
    clientRequestId,
    locale: cfg.locale,
    // Fil de l'utilisateur, résolu côté serveur : la persistance et les
    // copies en cache du modèle y sont rattachées (purge à l'effacement).
    conversationId,
  };

  // 5. Orchestration.
  try {
    const ports = buildOrchestratorPorts();

    // Réponse TAPÉE à une clarification en attente dans CE fil : elle est
    // interprétée comme un choix (« la première », « Lyon »…). Une question
    // complète abandonne la clarification et suit le parcours normal.
    if (await ports.hasPendingClarification(accountId, session.userId, conversationId)) {
      const issue = await resoudreClarification({
        accountId, userId: session.userId, conversationId, typedText: message,
      });
      const suite = await executerIssueClarification(issue, {
        accountId, userId: session.userId, planType: input.planType, locale: input.locale, typedText: message,
      }, { runAssistant, ports });
      if (suite.kind === 'result') return NextResponse.json(toApiPayload(suite.result, conversationId));
      if (suite.kind === 'rejected') {
        return NextResponse.json(
          { error: { code: suite.code, message: suite.message, recoverable: true } },
          { status: 409 },
        );
      }
    }

    const result = await runAssistant(input, ports);

    const payload: AssistantApiResponse = toApiPayload(result, conversationId);
    return NextResponse.json(payload);
  } catch (e) {
    console.error('[POST /api/verebona/messages]', e);
    return NextResponse.json(
      { error: { code: 'ASSISTANT_UNAVAILABLE', message: 'Assistant momentanément indisponible.', recoverable: true } },
      { status: 500 },
    );
  }
}
