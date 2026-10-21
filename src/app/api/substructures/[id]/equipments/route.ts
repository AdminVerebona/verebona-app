/**
 * POST /api/substructures/[id]/equipments — associe des équipements
 * EXISTANTS du même bien à la pièce (lot 75B).
 *
 * Corps : `{ equipmentIds: number[], confirmReassign?: boolean }`.
 * Un équipement déjà dans une autre pièce (cardinalité : une pièce au plus)
 * n'est déplacé qu'avec `confirmReassign: true` ; sinon 409
 * `REASSIGN_CONFIRMATION` avec la liste des conflits, rien n'est écrit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-errors';
import { associateEquipmentsToRoom } from '@/services/rooms/room-scope.service';
import { resolveRoomRoute, roomRouteError, signalRoomChange } from '@/services/rooms/room-route';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveRoomRoute(request, (await params).id, { write: true });
  if (ctx instanceof Response) return ctx;
  const body = await request.json().catch(() => null) as { equipmentIds?: unknown; confirmReassign?: unknown } | null;
  const ids = Array.isArray(body?.equipmentIds) ? body!.equipmentIds.map(Number) : null;
  if (!ids || ids.length === 0 || ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
    return apiError(400, 'INVALID_INPUT', 'equipmentIds requis');
  }
  try {
    const r = await associateEquipmentsToRoom(ctx.accountId, ctx.room, ids, body?.confirmReassign === true);
    if (r.status === 'confirm') {
      // `details.conflicts` : lu par `apiClient` (ApiClientError.details).
      return NextResponse.json({
        error: 'REASSIGN_CONFIRMATION', code: 'REASSIGN_CONFIRMATION',
        message: 'Déjà associé à une autre pièce : confirmation requise',
        conflicts: r.conflicts, details: { conflicts: r.conflicts },
      }, { status: 409 });
    }
    await signalRoomChange(ctx);
    return NextResponse.json({ associated: r.associated });
  } catch (e) {
    return roomRouteError('POST equipments', e);
  }
}
