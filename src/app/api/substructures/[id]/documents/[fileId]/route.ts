/**
 * DELETE /api/substructures/[id]/documents/[fileId] — retire l'association
 * DIRECTE du document avec la pièce (lot 75B). Le document n'est JAMAIS
 * supprimé ; ses équipements et autres liens restent. Un document seulement
 * « Via [équipement] » : 409 `NOT_DIRECT`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-errors';
import { dissociateDocumentFromRoom } from '@/services/rooms/room-scope.service';
import { parseId, resolveRoomRoute, roomRouteError, signalRoomChange } from '@/services/rooms/room-route';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const p = await params;
  const ctx = await resolveRoomRoute(request, p.id, { write: true });
  if (ctx instanceof Response) return ctx;
  const fileId = parseId(p.fileId);
  if (!fileId) return apiError(400, 'INVALID_INPUT', 'Invalid file id');
  try {
    await dissociateDocumentFromRoom(ctx.accountId, ctx.room, fileId);
    await signalRoomChange(ctx, [fileId]);
    return NextResponse.json({ dissociated: fileId });
  } catch (e) {
    return roomRouteError('DELETE document', e);
  }
}
