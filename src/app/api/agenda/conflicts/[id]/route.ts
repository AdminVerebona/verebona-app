import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { resolveConflict } from '@/services/agenda/AgendaConflictService';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    const id = parseInt(params.id);
    if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const body = await req.json();
    const { decision } = body;
    const validDecisions = ['kept_existing', 'kept_new', 'declared_distinct', 'skipped'];
    if (!validDecisions.includes(decision)) {
      return NextResponse.json({ error: 'Invalid decision' }, { status: 400 });
    }

    const conflict = await resolveConflict(id, decision, accountId, session.userId);
    return NextResponse.json({ conflict });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: message === 'Conflict not found' ? 404 : 500 });
  }
}
