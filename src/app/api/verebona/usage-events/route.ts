/**
 * POST /api/verebona/usage-events — indicateurs d'usage de l'assistant
 * (CDC Assistant §32.3 ; D-J7, lot 21).
 *
 * Corps : { events: [{ type, actionType?, sourceType?, intent?, value? }] }
 * (20 au plus par lot). Session exigée (seuls les utilisateurs de
 * l'application mesurent), mais RIEN de la session n'est stocké hormis
 * l'offre : ni compte, ni utilisateur. Valeurs hors catalogue ignorées.
 * Débit limité (famille « usage »). Corps de plus de 8 Ko refusé (413) avant
 * toute analyse. Réponse 204, même si rien n'est retenu.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { httpRequestId, mutationRateLimited, readBoundedJson, withRequestId } from '@/lib/verebona/api-guard';
import { normalizeUsageEvents, recordUsageEvents, usagePlan } from '@/services/verebona-assistant/core/usage-events';

/** 20 événements courts tiennent largement en 8 Ko. */
const USAGE_BODY_MAX_BYTES = 8 * 1024;

export async function POST(req: NextRequest) {
  const httpId = httpRequestId(req);
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return withRequestId(NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 }), httpId);
  const limite = await mutationRateLimited(session.userId, accountId, 'usage', httpId, req);
  if (limite) return limite;
  const lu = await readBoundedJson(req, USAGE_BODY_MAX_BYTES);
  if (lu.tooLarge) {
    return withRequestId(NextResponse.json({ error: 'PAYLOAD_TOO_LARGE' }, { status: 413 }), httpId);
  }
  const events = normalizeUsageEvents((lu.value as { events?: unknown } | null)?.events);
  if (events.length) {
    await ensureMigrations();
    await recordUsageEvents(events, usagePlan(session.planType));
  }
  return withRequestId(new NextResponse(null, { status: 204 }), httpId);
}
