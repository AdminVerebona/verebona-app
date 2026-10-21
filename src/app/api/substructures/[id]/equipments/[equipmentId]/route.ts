/**
 * DELETE /api/substructures/[id]/equipments/[equipmentId] — dissocie
 * l'équipement de la pièce (lot 75B). L'équipement n'est JAMAIS supprimé :
 * seule sa pièce passe à « aucune ». 409 s'il n'est pas dans cette pièce.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-errors';
import { dissociateEquipmentFromRoom } from '@/services/rooms/room-scope.service';
import { parseId, resolveRoomRoute, roomRouteError, signalRoomChange } from '@/services/rooms/room-route';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; equipmentId: string }> }) {
  const p = await params;
  const ctx = await resolveRoomRoute(request, p.id, { write: true });
  if (ctx instanceof Response) return ctx;
  const equipmentId = parseId(p.equipmentId);
  if (!equipmentId) return apiError(400, 'INVALID_INPUT', 'Invalid equipment id');
  try {
    await dissociateEquipmentFromRoom(ctx.accountId, ctx.room, equipmentId);
    await signalRoomChange(ctx);
    return NextResponse.json({ dissociated: equipmentId });
  } catch (e) {
    return roomRouteError('DELETE equipment', e);
  }
}
