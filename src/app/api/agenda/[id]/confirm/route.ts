/**
 * POST /api/agenda/[id]/confirm — l'utilisateur confirme une occurrence
 * prévisionnelle telle quelle (elle devient « confirmée », sa date protégée).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { confirmForecastOccurrence } from '@/services/agenda/AgendaWriteService';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, context: RouteContext) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

  const refus = await refuserSiLectureSeule(accountId);
  if (refus) return refus;

  const id = parseInt((await context.params).id, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  try {
    const item = await confirmForecastOccurrence(id, accountId, session.userId);
    return NextResponse.json({ item });
  } catch (e) {
    const message = (e as Error).message;
    return NextResponse.json({ error: message }, { status: message === 'Item not found' ? 404 : 500 });
  }
}
