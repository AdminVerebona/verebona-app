/**
 * Mon compte › Sécurité › Adresse e-mail — lot 96A (CDC 18 §11.3, EMAIL-03,
 * EMAIL-04 ; décision PO Q8). Voir `services/auth/email-change.service.ts`.
 *
 *   GET    — demande en attente ({ pending: { newEmail, expiresAt } | null }).
 *   POST   — { newEmail } : preuve de réauthentification fraîche de CETTE
 *            session exigée (403 REAUTH_REQUIRED / REAUTH_EXPIRED), non
 *            consommée et jamais prolongée. Réponse NEUTRE, identique que
 *            l'adresse soit libre ou déjà celle d'un autre compte.
 *   DELETE — annule la demande en attente (le lien déjà envoyé devient inutilisable).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireFreshReauth } from '@/lib/auth/reauth';
import {
  EMAIL_CHANGE_NEUTRAL_MESSAGE, cancelEmailChange, getPendingEmailChange, requestEmailChange,
} from '@/services/auth/email-change.service';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    return NextResponse.json({ pending: await getPendingEmailChange(session.userId) }, { headers: NO_STORE });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}

export async function POST(request: NextRequest) {
  const check = await requireFreshReauth(request, { action: 'email_change' });
  if (!check.ok) return check.response;
  const body = (await request.json().catch(() => ({}))) as { newEmail?: unknown };
  try {
    const r = await requestEmailChange({
      request, userId: check.session.userId, sid: check.session.sid, reauthMethod: check.proof.method, newEmail: body.newEmail,
    });
    if (!r.ok) {
      const status = r.code === 'RATE_LIMITED' ? 429 : 400;
      return NextResponse.json(
        { error: r.code, code: r.code, message: r.message, ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : {}) },
        { status, headers: r.retryAfterSeconds ? { 'Retry-After': String(r.retryAfterSeconds) } : undefined },
      );
    }
    // `delivered` (adresse prise ou non) n'est JAMAIS renvoyé : non énumérable.
    return NextResponse.json({ success: true, message: EMAIL_CHANGE_NEUTRAL_MESSAGE, pending: r.pending }, { headers: NO_STORE });
  } catch (error) {
    console.error('[email-change] demande :', (error as Error)?.message ?? error);
    return NextResponse.json({ error: 'EMAIL_CHANGE_FAILED', code: 'EMAIL_CHANGE_FAILED', message: 'La demande n’a pas pu être enregistrée. Réessayez.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const n = await cancelEmailChange(session.userId);
    return NextResponse.json({ success: true, cancelled: n > 0 }, { headers: NO_STORE });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
