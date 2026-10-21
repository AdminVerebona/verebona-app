/**
 * Socle des routes `/api/substructures/[id]/…` du tiroir Pièce (lot 75B) :
 * session, compte, pièce du compte, gardes d'écriture standard.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { refuserSiModificationBiensSuspendue } from '@/lib/asset-quota-guard';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { getRoomInAccount, RoomAssociationError, type RoomRef } from './room-scope.service';

export type RoomRouteContext = { accountId: number; room: RoomRef };

/** Pièce du compte courant, ou la réponse d'erreur à renvoyer. */
export async function resolveRoomRoute(
  request: NextRequest,
  rawId: string,
  opts: { write?: boolean } = {},
): Promise<RoomRouteContext | Response> {
  let session;
  try {
    session = await SessionService.getSession(request);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  const accountId = session?.currentAccountId;
  if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');
  const roomId = Number.parseInt(rawId, 10);
  if (!Number.isSafeInteger(roomId) || roomId <= 0) return apiError(400, 'INVALID_INPUT', 'Invalid room id');
  const room = await getRoomInAccount(accountId, roomId);
  if (!room) return apiError(404, 'NOT_FOUND', 'Pièce introuvable');
  if (opts.write) {
    const refus = await refuserSiLectureSeule(accountId);
    if (refus) return refus;
    const quota = await refuserSiModificationBiensSuspendue(accountId);
    if (quota) return quota;
  }
  return { accountId, room };
}

/** Identifiant positif d'un segment d'URL, ou null. */
export function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 && String(n) === raw.trim() ? n : null;
}

/** Erreurs métier → réponses ; le reste est journalisé (500). */
export function roomRouteError(where: string, e: unknown): NextResponse {
  if (e instanceof RoomAssociationError) {
    if (e.code === 'NOT_FOUND') return apiError(404, 'NOT_FOUND', e.message);
    if (e.code === 'OTHER_ASSET') return apiError(400, 'INVALID_INPUT', e.message);
    return NextResponse.json({ error: 'NOT_DIRECT', message: e.message }, { status: 409 });
  }
  console.error(`[api/substructures] ${where}`, e);
  return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
}

/** Bien modifié (pièce, équipement) : même signal que les routes équipement / pièce. */
export async function signalRoomChange(ctx: RoomRouteContext, fileIds: readonly number[] = []): Promise<void> {
  await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: ctx.accountId, entityId: ctx.room.assetId });
  for (const id of fileIds) await emitBusinessEvent({ type: 'DOCUMENT_UPDATED', accountId: ctx.accountId, entityId: id });
}
