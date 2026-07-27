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
import {
  runAssistant,
  getAssistantConfig,
  type AssistantRequestInput,
} from '@/services/verebona-assistant';
import { buildOrchestratorPorts } from '@/services/verebona-assistant/core/ports';
import type { AssistantApiResponse } from '@/services/verebona-assistant/types/contracts';

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

  // 4. Éligibilité IA via l'existant (source de vérité serveur — §15.1).
  const entitlements = await getEntitlements(accountId);

  const input: AssistantRequestInput = {
    accountId,
    userId: session.userId,
    planType: entitlements.premiumFeatures ? session.planType : 'STANDARD',
    message,
    pageContext: body.pageContext ?? undefined,
    clientRequestId,
    locale: cfg.locale,
  };

  // 5. Orchestration.
  try {
    const ports = buildOrchestratorPorts();
    const result = await runAssistant(input, ports);

    const payload: AssistantApiResponse = {
      requestId: result.requestId,
      messageId: result.messageId,
      status: result.error ? 'error' : 'ready',
      intent: result.route?.intent ?? 'UNKNOWN',
      mode: result.mode,
      answer: result.answer,
      sourcesAvailable: result.sources.length > 0,
      sourceCount: result.sources.length,
      actions: result.actions,
      clarification: result.clarification
        ? {
            clarificationId: result.clarification.clarificationId,
            question: result.clarification.question,
            expiresAt: result.clarification.expiresAt,
            choices: result.clarification.candidates.map((c) => ({
              choiceId: c.id, label: c.label, secondaryLabel: c.secondaryLabel,
            })),
          }
        : null,
    };
    return NextResponse.json(payload);
  } catch (e) {
    console.error('[POST /api/verebona/messages]', e);
    return NextResponse.json(
      { error: { code: 'ASSISTANT_UNAVAILABLE', message: 'Assistant momentanément indisponible.', recoverable: true } },
      { status: 500 },
    );
  }
}
