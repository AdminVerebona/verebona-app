/**
 * POST /api/search/intelligent
 * Recherche intelligente en langage naturel — CDC Verebona V1
 *
 * Body : { query, context_type?, context_id? }
 * Response : IntelligentSearchResponse
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { intelligentSearch } from '@/lib/intelligent-search';
import { ensureMigrations } from '@/db';

export async function POST(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }

    const accountId = session.currentAccountId;
    if (!accountId) {
      return NextResponse.json({ error: 'No account selected' }, { status: 400 });
    }

    await ensureMigrations();

    const body = await req.json().catch(() => ({}));
    const query = typeof body.query === 'string' ? body.query.trim() : '';

    if (!query || query.length < 3) {
      return NextResponse.json({ error: 'Query too short' }, { status: 400 });
    }
    if (query.length > 500) {
      return NextResponse.json({ error: 'Query too long' }, { status: 400 });
    }

    const result = await intelligentSearch({
      query,
      accountId,
      userId: session.userId ?? null,
      offerCode: session.planType ?? 'STANDARD',
      contextType: body.context_type ?? undefined,
      contextId: typeof body.context_id === 'number' ? body.context_id : undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[POST /api/search/intelligent]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
