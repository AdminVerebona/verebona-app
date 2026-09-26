/**
 * POST /api/verebona/commands/[planId]/cancel — refus d'une commande préparée.
 * Aucune écriture métier n'a lieu ; le refus est tracé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { areWriteCommandsEnabled, WRITE_COMMANDS_DISABLED_MESSAGE } from '@/services/verebona-assistant/config/assistant-config';
import { cancelCommandPlan } from '@/services/verebona-assistant/commands/plan.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  // Interrupteur VEREBONA_ASSISTANT_WRITE_COMMANDS coupé : même refus que la
  // confirmation (aucun plan ne doit plus être manipulé depuis le chat).
  // Rien n'a été écrit : le message le dit.
  if (!areWriteCommandsEnabled()) {
    return NextResponse.json(
      { error: { code: 'WRITE_COMMANDS_DISABLED', message: WRITE_COMMANDS_DISABLED_MESSAGE, recoverable: false } },
      { status: 403 },
    );
  }

  await ensureMigrations();
  const { planId } = await params;
  const cancelled = await cancelCommandPlan({ planId, accountId, userId: session.userId });
  if (!cancelled) return NextResponse.json({ error: { code: 'PLAN_ALREADY_HANDLED', message: 'Cette action a déjà été traitée.' } }, { status: 409 });
  return NextResponse.json({ planId, status: 'CANCELLED' });
}
