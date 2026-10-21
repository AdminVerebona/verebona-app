/**
 * POST /api/substructures/[id]/documents — associe DIRECTEMENT des documents
 * existants du même bien à la pièce (lot 75B) : colonne
 * `asset_files.substructure_id`, celle du tiroir Document.
 *
 * Corps : `{ fileIds: number[], confirmReassign?: boolean }`. Document déjà
 * dans une autre pièce : 409 `REASSIGN_CONFIRMATION` sans confirmation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-errors';
import { associateDocumentsToRoom } from '@/services/rooms/room-scope.service';
import { resolveRoomRoute, roomRouteError, signalRoomChange } from '@/services/rooms/room-route';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveRoomRoute(request, (await params).id, { write: true });
  if (ctx instanceof Response) return ctx;
  const body = await request.json().catch(() => null) as { fileIds?: unknown; confirmReassign?: unknown } | null;
  const ids = Array.isArray(body?.fileIds) ? body!.fileIds.map(Number) : null;
  if (!ids || ids.length === 0 || ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
    return apiError(400, 'INVALID_INPUT', 'fileIds requis');
  }
  try {
    const r = await associateDocumentsToRoom(ctx.accountId, ctx.room, ids, body?.confirmReassign === true);
    if (r.status === 'confirm') {
      // `details.conflicts` : lu par `apiClient` (ApiClientError.details).
      return NextResponse.json({
        error: 'REASSIGN_CONFIRMATION', code: 'REASSIGN_CONFIRMATION',
        message: 'Déjà associé à une autre pièce : confirmation requise',
        conflicts: r.conflicts, details: { conflicts: r.conflicts },
      }, { status: 409 });
    }
    await signalRoomChange(ctx, r.associated);
    return NextResponse.json({ associated: r.associated });
  } catch (e) {
    return roomRouteError('POST documents', e);
  }
}
