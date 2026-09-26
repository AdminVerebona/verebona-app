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
import { checkAssistantRateLimit } from '@/lib/verebona/rate-limit';
import { ensureMigrations } from '@/db';
import { getEntitlements } from '@/services/entitlements.service';
import { refuserSiPasDIA } from '@/lib/write-access-guard';
import {
  runAssistant,
  getAssistantConfig,
  ensureAssistantStartupChecked,
  type AssistantRequestInput,
} from '@/services/verebona-assistant';
import { closePendingRequest, requestStatus, reserveRequest } from '@/services/verebona-assistant/core/request-lifecycle.service';
import { sanitizePageContext } from '@/services/verebona-assistant/core/page-context';
import { AccountScopeError, assertNoClientAccountOverride } from '@/services/verebona-assistant/security/account-scope';
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
import { assistantPlanFromEntitlements } from '@/services/verebona-assistant/core/plan-eligibility';

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
  // Contrôle de démarrage §15.14 (une fois par processus) : hors des limites
  // V1 (web, Pro, « latest », > 2 appels…), l'assistant refuse de tourner.
  const demarrage = ensureAssistantStartupChecked();
  if (!demarrage.ok) {
    return NextResponse.json(
      { error: { code: 'ASSISTANT_UNAVAILABLE', message: 'Assistant momentanément indisponible.', recoverable: false } },
      { status: 503 },
    );
  }

  // 2. Rate limit (§6.6) : `VEREBONA_ASSISTANT_RATE_LIMIT_PER_MINUTE` par
  //    utilisateur (10 par défaut) et 3× par compte — limiteur DÉDIÉ, qui ne
  //    partage plus son quota avec le téléversement de fichiers.
  const rl = checkAssistantRateLimit(session.userId, accountId, cfg.rateLimitPerMinute);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: 'Vous avez posé beaucoup de questions en peu de temps. Réessayez dans un instant.', recoverable: true } },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  await ensureMigrations();

  // 3. Validation d'entrée (§7.5 : champ ≤ 2 000 caractères).
  const body = await req.json().catch(() => ({}));
  // §13.2, §27.1 : le compte vient de la session. Un `accountId` différent
  // dans le corps est une tentative de surcharge — refusée, jamais ignorée
  // en silence (garde `security/account-scope.ts`, jusqu'ici jamais appelée).
  try {
    assertNoClientAccountOverride((body as Record<string, unknown>)?.accountId, accountId);
  } catch (e) {
    if (e instanceof AccountScopeError) return NextResponse.json({ error: 'ACCOUNT_SCOPE_VIOLATION' }, { status: 403 });
    throw e;
  }
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
      // Rejeu fidèle (CA-29) : sources et actions relues en base.
      sourcesAvailable: deja.sourceCount > 0,
      sourceCount: deja.sourceCount,
      actions: deja.actions as AssistantApiResponse['actions'],
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

  // ══════════════════════════════════════════════════════════════════════
  // RÉSERVATION DE LA DEMANDE — AVANT tout traitement (§6.6, §7.8, §31.9)
  //
  // · même envoi déjà en cours (double clic) : 409, AUCUN second pipeline ;
  // · autre demande en cours dans ce fil : 409 REQUEST_IN_PROGRESS ;
  // · sinon : ligne `pending` → la demande est annulable dès maintenant
  //   (DELETE /api/verebona/requests/{requestId ou clientRequestId}).
  // Voir `request-lifecycle.service.ts`.
  // ══════════════════════════════════════════════════════════════════════
  let requestId: string | undefined;
  try {
    const r = await reserveRequest({
      accountId, userId: session.userId, conversationId, clientRequestId,
      staleAfterMs: cfg.totalTimeoutMs + 10_000,
    });
    if (r.kind === 'reserved') requestId = r.requestId;
    else if (r.kind === 'duplicate_finished') {
      return NextResponse.json(
        { requestId: r.requestId, status: r.status === 'cancelled' ? 'cancelled' : 'error',
          error: { code: r.status === 'cancelled' ? 'REQUEST_CANCELLED' : 'REQUEST_ALREADY_HANDLED', message: 'Cette demande a déjà été traitée.', recoverable: true } },
        { status: 409 },
      );
    } else {
      return NextResponse.json(
        { requestId: r.requestId, error: { code: 'REQUEST_IN_PROGRESS', message: 'Une demande est déjà en cours dans cette conversation. Patientez ou annulez-la.', recoverable: true } },
        { status: 409 },
      );
    }
  } catch (e) {
    // Base indisponible pour la réservation : on ne bloque pas l'utilisateur,
    // la demande suit le parcours historique (trace écrite à la fin).
    console.warn('[verebona] réservation de la demande impossible :', (e as Error).message);
  }

  const input: AssistantRequestInput = {
    accountId,
    userId: session.userId,
    // Offre dérivée des DROITS du compte, pas du planType du JWT : l'essai
    // 7 jours a le comportement Premium, IA comprise (§6.5).
    planType: assistantPlanFromEntitlements(entitlements, session.planType),
    message,
    // Contexte de page VALIDÉ (clés et formats connus) — §27.1, §27.6.
    pageContext: sanitizePageContext(body.pageContext),
    clientRequestId,
    requestId,
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
      // La reprise de clarification a sa propre trace : la réservation de ce
      // message est close pour libérer le fil.
      if (requestId && suite.kind !== 'abandoned') await closePendingRequest(requestId, suite.kind === 'result' ? 'ok' : 'error');
      if (suite.kind === 'result') return NextResponse.json(toApiPayload(suite.result, conversationId));
      if (suite.kind === 'rejected') {
        return NextResponse.json(
          { error: { code: suite.code, message: suite.message, recoverable: true } },
          { status: 409 },
        );
      }
    }

    const result = await runAssistant(input, ports);

    if (requestId) {
      // Annulée pendant le traitement : la réponse n'a pas été enregistrée et
      // n'est pas rendue (le client a déjà abandonné l'attente).
      if (result.finalState === 'CANCELLED' || await requestStatus(requestId) === 'cancelled') {
        return NextResponse.json(
          { requestId, status: 'cancelled', error: { code: 'REQUEST_CANCELLED', message: 'Demande annulée.', recoverable: true } },
          { status: 409 },
        );
      }
      // Persistance impossible (fil effacé entre-temps…) : la réservation ne
      // doit pas bloquer le fil jusqu'à son expiration.
      await closePendingRequest(requestId, result.error ? 'error' : 'ok', result.error?.code);
    }

    const payload: AssistantApiResponse = toApiPayload(result, conversationId);
    return NextResponse.json(payload);
  } catch (e) {
    if (requestId) await closePendingRequest(requestId, 'error', 'ASSISTANT_UNAVAILABLE');
    console.error('[POST /api/verebona/messages]', e);
    return NextResponse.json(
      { error: { code: 'ASSISTANT_UNAVAILABLE', message: 'Assistant momentanément indisponible.', recoverable: true } },
      { status: 500 },
    );
  }
}
