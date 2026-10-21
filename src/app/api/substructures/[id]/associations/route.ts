/**
 * GET /api/substructures/[id]/associations — tiroir Pièce (lot 75B) :
 * équipements de la pièce et liste CONSOLIDÉE de ses documents (directs et
 * « Via [équipement] », chacun une fois). Résolution centrale :
 * `services/rooms/room-scope.service.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listRoomDocuments, listRoomEquipments } from '@/services/rooms/room-scope.service';
import { resolveRoomRoute, roomRouteError } from '@/services/rooms/room-route';
import type { RoomAssociations } from '@/lib/rooms/room-associations';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveRoomRoute(request, (await params).id);
  if (ctx instanceof Response) return ctx;
  try {
    const [equipments, documents] = await Promise.all([
      listRoomEquipments(ctx.room),
      listRoomDocuments(ctx.accountId, ctx.room),
    ]);
    const body: RoomAssociations = { room: ctx.room, equipments, documents };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return roomRouteError('GET associations', e);
  }
}
