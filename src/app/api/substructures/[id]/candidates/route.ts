/**
 * GET /api/substructures/[id]/candidates?kind=equipment|document&q=… —
 * équipements ou documents du MÊME bien proposés à l'association depuis le
 * tiroir Pièce (lot 75B), avec leur pièce actuelle (réaffectation).
 */
import { NextRequest, NextResponse } from 'next/server';
import { listRoomCandidates } from '@/services/rooms/room-scope.service';
import { resolveRoomRoute, roomRouteError } from '@/services/rooms/room-route';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveRoomRoute(request, (await params).id);
  if (ctx instanceof Response) return ctx;
  const kind = request.nextUrl.searchParams.get('kind') === 'document' ? 'document' : 'equipment';
  const q = (request.nextUrl.searchParams.get('q') ?? '').slice(0, 100);
  try {
    const candidates = await listRoomCandidates(ctx.accountId, ctx.room, kind, q);
    return NextResponse.json({ candidates }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return roomRouteError('GET candidates', e);
  }
}
