/**
 * POST /api/verebona/clarifications/[clarificationId]/answer — CDC §20 / §27.4.
 * Reprend la demande initiale avec le candidat choisi. Expiration 30 min (§20.4).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';

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

  // TODO(CDC §20.5) : recharger clarification_state_json, vérifier expiration + propriété compte,
  // reconstruire l'AssistantRequestInput avec l'entité choisie, puis rappeler runAssistant().
  return NextResponse.json({
    status: 'error',
    error: { code: 'CLARIFICATION_REQUIRED', message: 'Reprise de clarification à implémenter (Phase 2).', recoverable: true },
    clarificationId,
  });
}
