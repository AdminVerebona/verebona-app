import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { searchAgendaItems } from '@/services/agenda/AgendaQueryService';

export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    const q = new URL(req.url).searchParams.get('q') ?? '';
    const results = await searchAgendaItems(q, accountId);
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
