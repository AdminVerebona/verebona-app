import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { getAgendaItems } from '@/services/agenda/AgendaQueryService';
import { createAgendaItem } from '@/services/agenda/AgendaWriteService';

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

    const { searchParams } = new URL(req.url);
    const assetIds = searchParams.get('assetIds')
      ? searchParams.get('assetIds')!.split(',').map(Number).filter(Boolean)
      : undefined;
    const fileId = searchParams.get('fileId') ? Number(searchParams.get('fileId')) : undefined;
    const period = (searchParams.get('period') as 'all' | 'past' | 'today' | 'upcoming') ?? 'all';
    const includeCancelled = searchParams.get('includeCancelled') === 'true';
    const month = searchParams.get('month') ?? undefined;
    const year = searchParams.get('year') ?? undefined;
    const includeUndated = searchParams.get('includeUndated') !== 'false';

    const items = await getAgendaItems({ accountId, assetIds, fileId, period, includeCancelled, month, year, includeUndated });
    return NextResponse.json({ items }, {
      headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' },
    });
  } catch (err) {
    console.error('GET /api/agenda error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    const body = await req.json();
    const { title, description, startDate, startTime, endDate, endTime, manualStatus, assetIds, fileIds, substructureIds, equipmentIds } = body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return NextResponse.json({ error: 'title est requis' }, { status: 400 });
    }

    const validManualStatus = manualStatus === 'realise' || manualStatus === 'annule' ? manualStatus : null;

    const item = await createAgendaItem(
      { title: title.trim(), description, startDate, startTime, endDate, endTime, manualStatus: validManualStatus, assetIds, fileIds, substructureIds, equipmentIds },
      accountId,
      session.userId
    );
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.includes('Validation') || message.includes('Cohérence') ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
