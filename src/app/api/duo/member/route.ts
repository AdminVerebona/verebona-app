import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { removeDuoMember, type DuoExitError } from '@/services/duo/duo-exit.service';

const STATUS: Record<DuoExitError, number> = {
  DUO_NOT_FOUND: 404, NO_ACTIVE_MEMBER: 404, NOT_A_DUO_MEMBER: 404, OWNER_CANNOT_LEAVE: 409, DUO_UNPAID: 409,
};

/**
 * DELETE /api/duo/member
 * Le titulaire du Duo retire le second utilisateur (AID-DUO-006).
 * Conséquences : voir `services/duo/duo-exit.service.ts` — aucun bien supprimé.
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const result = await removeDuoMember(session.userId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, message: result.message }, { status: STATUS[result.error] });
    }
    return NextResponse.json({ success: true, status: result.status, cancelledRequests: result.cancelledRequests });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
