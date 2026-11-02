/**
 * Mon compte › Confidentialité — opposition à l'utilisation des données du
 * compte pour l'amélioration de Verebona (lot 102D).
 *
 * GET /api/users/me/data-use — état du compte de la session (+ droit de
 *     retirer l'opposition, journal récent).
 * PUT /api/users/me/data-use — { optOut: boolean, channel?: 'web' | 'mobile' }.
 *
 * Droit d'opposition (RGPD) : possible dans TOUS les états du compte, lecture
 * seule comprise (exception motivée de la garde d'écriture, L85D). Opposer :
 * tout membre actif du compte ; retirer : titulaire ou auteur de
 * l'opposition (`canChangeImprovementOptOut`). Idempotent.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { effectiveAccountId, getSessionRole } from '@/services/account/membership.service';
import {
  getImprovementPreference, listImprovementEvents, setImprovementOptOut,
} from '@/services/privacy/improvement-opt-out';
import { canChangeImprovementOptOut } from '@/services/privacy/improvement-opt-out-rules';

async function context(request: NextRequest) {
  const session = await SessionService.getSession(request);
  const accountId = await effectiveAccountId(session);
  const role = accountId ? await getSessionRole(session) : null;
  return { session, accountId, role };
}

export async function GET(request: NextRequest) {
  try {
    const { session, accountId, role } = await context(request);
    if (!accountId) return NextResponse.json({ code: 'NO_ACCOUNT' }, { status: 404 });
    const preference = await getImprovementPreference(accountId);
    const events = await listImprovementEvents(accountId, 10);
    return NextResponse.json({
      preference: { optOut: preference.optOut, optedOutAt: preference.optedOutAt, withdrawnAt: preference.withdrawnAt },
      canWithdraw: canChangeImprovementOptOut({
        role, userId: session.userId, wantOptOut: false,
        current: { optOut: preference.optOut, optedOutByUserId: preference.optedOutByUserId },
      }),
      events: events.map((e) => ({ action: e.action, channel: e.channel, occurredAt: e.occurredAt, byMe: e.userId === session.userId })),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('AUTH_REQUIRED')) return SessionService.handleSessionError(error);
    console.error('[data-use GET]', (error as Error)?.message ?? error);
    return NextResponse.json({ code: 'INTERNAL_ERROR', message: 'Impossible de lire ce réglage.' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { session, accountId, role } = await context(request);
    if (!accountId) return NextResponse.json({ code: 'NO_ACCOUNT' }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    if (typeof body?.optOut !== 'boolean') {
      return NextResponse.json({ code: 'INVALID_BODY', message: 'Choix manquant.' }, { status: 400 });
    }
    const channel = body.channel === 'mobile' ? 'mobile' : 'web';
    const current = await getImprovementPreference(accountId);
    if (!canChangeImprovementOptOut({
      role, userId: session.userId, wantOptOut: body.optOut,
      current: { optOut: current.optOut, optedOutByUserId: current.optedOutByUserId },
    })) {
      return NextResponse.json({ code: 'FORBIDDEN', message: 'Seul le titulaire du compte, ou la personne qui a fait l’opposition, peut la retirer.' }, { status: 403 });
    }
    const r = await setImprovementOptOut({
      accountId, userId: session.userId, optOut: body.optOut, channel,
      userAgent: request.headers.get('user-agent'),
    });
    return NextResponse.json({
      changed: r.changed,
      preference: { optOut: r.preference.optOut, optedOutAt: r.preference.optedOutAt, withdrawnAt: r.preference.withdrawnAt },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('AUTH_REQUIRED')) return SessionService.handleSessionError(error);
    console.error('[data-use PUT]', (error as Error)?.message ?? error);
    return NextResponse.json({ code: 'INTERNAL_ERROR', message: 'Le réglage n’a pas pu être enregistré. Réessayez.' }, { status: 500 });
  }
}
