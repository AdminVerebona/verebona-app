/**
 * Clôture du compte (suppression volontaire différée de 30 jours) — partagé
 * par POST /api/users/me/deletion et DELETE /api/users/me (ancien point
 * d'entrée de la suppression immédiate, conservé pour les clients existants).
 *
 * Confirmation renforcée : texte « SUPPRIMER MON COMPTE » ET mot de passe
 * (même convention que le changement de mot de passe). Toutes les sessions
 * sont révoquées ; CET appareil reçoit une session neuve, au statut
 * PENDING_DELETION, qui ne donne accès qu'à l'écran « Compte en cours de
 * suppression » (annuler, exporter).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, getUserSessionCutoff, hashToken, revokeToken } from '@/db';
import { users } from '@/db/schema';
import { SessionService } from '@/lib/session-service';
import { issueSessionTokens, setSessionCookies } from '@/lib/auth/session-tokens';
import {
  CLOSURE_ERROR_STATUS,
  closeAccountForDeletion,
  toStatusView,
} from '@/services/account/voluntary-deletion.service';
import { PENDING_DELETION_PAGE } from '@/lib/auth/account-closure';
import { checkAuthRateLimit, getClientIp, resetAuthRateLimit } from '@/lib/rate-limiter';

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Rouvre une session sur cet appareil, émise strictement APRÈS la borne de
 * révocation (sinon elle serait refusée comme les autres), et révoque le
 * jeton de renouvellement présenté.
 */
export async function reopenSessionOnThisDevice(request: NextRequest, response: NextResponse, userId: number): Promise<void> {
  const cutoff = await getUserSessionCutoff(userId);
  if (cutoff) while (Date.now() <= cutoff.getTime()) await new Promise((r) => setTimeout(r, 1));
  const [user] = await db
    .select({ id: users.id, email: users.email, role: users.role, planType: users.planType, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (user) setSessionCookies(response, await issueSessionTokens(user));
  const presented = request.cookies.get('refresh_token')?.value;
  if (presented) {
    await revokeToken(await hashToken(presented), userId, new Date(Date.now() + REFRESH_TTL_MS))
      .catch((e) => console.error('[account-deletion] révocation du jeton présenté :', e));
  }
}

export async function handleCloseAccount(request: NextRequest): Promise<NextResponse> {
  let userId: number;
  try {
    userId = (await SessionService.getSession(request)).userId;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }

  // Vérification de mot de passe : même limiteur que la connexion (5 essais /
  // 15 min), par adresse IP ET par utilisateur — une session volée ne doit
  // pas servir à deviner le mot de passe. Désactivé en développement, comme
  // la connexion.
  if (process.env.NODE_ENV !== 'development') {
    const ip = getClientIp(request.headers);
    for (const key of [`account-deletion:ip:${ip}`, `account-deletion:user:${userId}`]) {
      const rl = checkAuthRateLimit(key);
      if (!rl.allowed) {
        return NextResponse.json(
          { error: 'RATE_LIMIT_EXCEEDED', message: `Trop de tentatives. Réessayez dans ${rl.retryAfterSeconds} secondes.` },
          { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } },
        );
      }
    }
  }

  const body = (await request.json().catch(() => ({}))) as { confirmation?: unknown; password?: unknown };
  const now = new Date();
  try {
    const result = await closeAccountForDeletion({
      userId,
      confirmation: typeof body.confirmation === 'string' ? body.confirmation : null,
      password: typeof body.password === 'string' ? body.password : null,
      now,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.code, message: result.message }, { status: CLOSURE_ERROR_STATUS[result.code] });
    }

    resetAuthRateLimit(`account-deletion:user:${userId}`);
    resetAuthRateLimit(`account-deletion:ip:${getClientIp(request.headers)}`);
    const response = NextResponse.json({
      success: true,
      deletion: toStatusView(result.schedule, now),
      stoppedSubscriptions: result.stoppedSubscriptions.length,
      redirectTo: PENDING_DELETION_PAGE,
    });
    await reopenSessionOnThisDevice(request, response, userId);
    return response;
  } catch (error) {
    console.error('[account-deletion] clôture :', error);
    return NextResponse.json(
      { error: 'ACCOUNT_CLOSURE_FAILED', message: 'La suppression n’a pas pu être programmée. Réessayez dans quelques instants.' },
      { status: 500 },
    );
  }
}
