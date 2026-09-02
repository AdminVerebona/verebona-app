import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { updateManualStatus } from '@/services/agenda/AgendaWriteService';

/** `params` est une promesse depuis Next.js 15 — cf. `../route.ts`. */
type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    const { id: rawId } = await context.params;
    const id = parseInt(rawId, 10);
    if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const body = await req.json();
    const { manualStatus } = body;

    if (manualStatus !== null && manualStatus !== 'realise' && manualStatus !== 'annule') {
      return NextResponse.json({ error: 'manualStatus must be null, "realise", or "annule"' }, { status: 400 });
    }

    const item = await updateManualStatus(id, manualStatus, accountId);
    return NextResponse.json({ item });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[api/agenda/:id/statut] PATCH', err);
    return NextResponse.json({ error: message }, { status: message === 'Item not found' ? 404 : 500 });
  }
}
